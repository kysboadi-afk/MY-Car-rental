// api/waive-late-fee.js
// Admin-authenticated endpoint to apply full, partial, or complete fee waivers
// to a booking.  Supports three fee targets:
//   - late_fee       — the overdue return penalty
//   - rental_balance — the remaining base-rental balance owed
//   - all_fees       — late penalty + entire remaining balance (always full)
//
// Also supports action:"lookup" to return booking details without applying
// a waiver (used by the admin UI to preview the booking before acting).
//
// POST /api/waive-late-fee
// Body (lookup):
//   { secret, booking_id, action: "lookup" }
//
// Body (apply waiver):
//   {
//     secret, booking_id,
//     fee_type:     string,  // "late_fee" | "rental_balance" | "all_fees" (default: "late_fee")
//     waiver_type:  string,  // "full" | "partial" (ignored for all_fees — always full)
//     waived_amount: number, // required for partial waiver_type
//     reason:       string,  // mandatory explanation
//     waived_by:    string,  // optional admin identifier label
//   }
//
// Rules:
//   • Only admin roles can call this (ADMIN_SECRET guard).
//   • A reason is always required for apply actions.
//   • A waiver may be applied multiple times; each call replaces the previous
//     and is logged in booking_audit_log.
//   • Waivers do NOT trigger an automatic Stripe refund.
//   • Revenue adjustment records are inserted to keep the ledger accurate.

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin }  from "./_supabase.js";
import { writeAuditLog }     from "./_booking-automation.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Fixed late-fee constants — must match the values in extend-rental.js.
const SHORT_LATE_FEE    = 25;
const EXTENDED_LATE_FEE = 35;

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // ── Admin auth ─────────────────────────────────────────────────────────────
  const { action, secret, booking_id, fee_type, waiver_type, waived_amount, reason, waived_by } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Input validation ────────────────────────────────────────────────────────
  if (!booking_id || typeof booking_id !== "string" || !booking_id.trim()) {
    return res.status(400).json({ error: "booking_id is required" });
  }

  const bookingRef = booking_id.trim();

  // For apply actions (anything except lookup), validate waiver fields early
  // so callers get a meaningful 400 before we attempt a DB connection.
  let resolvedFeeType      = null;
  let effectiveWaiverType  = null;
  let trimmedReason        = null;
  let adminLabel           = null;

  if (action !== "lookup") {
    resolvedFeeType = fee_type || "late_fee";
    if (!["late_fee", "rental_balance", "all_fees"].includes(resolvedFeeType)) {
      return res.status(400).json({ error: 'fee_type must be "late_fee", "rental_balance", or "all_fees"' });
    }

    // all_fees is always a full waiver — no partial amount needed
    effectiveWaiverType = resolvedFeeType === "all_fees" ? "full" : waiver_type;
    if (!["full", "partial"].includes(effectiveWaiverType)) {
      return res.status(400).json({ error: 'waiver_type must be "full" or "partial"' });
    }

    trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (!trimmedReason) {
      return res.status(400).json({ error: "reason is required — every waiver must have an explanation" });
    }

    adminLabel = (typeof waived_by === "string" && waived_by.trim()) ? waived_by.trim() : "admin";
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  // ── Look up the booking ───────────────────────────────────────────────────
  const { data: booking, error: bkErr } = await sb
    .from("bookings")
    .select(
      "id, booking_ref, vehicle_id, customer_name, pickup_date, return_date, pickup_time, return_time, status, " +
      "total_price, deposit_paid, remaining_balance, " +
      "late_fee_waived, late_fee_waived_amount, late_fee_waived_reason, " +
      "late_fee_waived_by, late_fee_waived_at, " +
      "rental_balance_waived, rental_balance_waived_amount, rental_balance_waived_reason, " +
      "rental_balance_waived_by, rental_balance_waived_at"
    )
    .eq("booking_ref", bookingRef)
    .maybeSingle();

  if (bkErr) {
    return res.status(500).json({ error: `Booking lookup failed: ${bkErr.message}` });
  }
  if (!booking) {
    return res.status(404).json({ error: `Booking "${esc(bookingRef)}" not found` });
  }

  // ── Lookup action — return booking details without applying a waiver ──────
  if (action === "lookup") {
    return res.status(200).json({
      success:                      true,
      booking_ref:                  booking.booking_ref,
      customer_name:                booking.customer_name || "",
      vehicle_id:                   booking.vehicle_id || "",
      pickup_date:                  booking.pickup_date || "",
      return_date:                  booking.return_date || "",
      status:                       booking.status || "",
      total_price:                  Number(booking.total_price || 0),
      deposit_paid:                 Number(booking.deposit_paid || 0),
      remaining_balance:            Number(booking.remaining_balance || 0),
      late_fee_waived:              !!booking.late_fee_waived,
      late_fee_waived_amount:       Number(booking.late_fee_waived_amount || 0),
      rental_balance_waived:        !!booking.rental_balance_waived,
      rental_balance_waived_amount: Number(booking.rental_balance_waived_amount || 0),
    });
  }

  // ── Resolve waived amounts for each fee target ─────────────────────────────
  const maxLateFee = EXTENDED_LATE_FEE;
  let lateFeeWaivedAmount       = null; // null = not touching late fee
  let rentalBalanceWaivedAmount = null; // null = not touching rental balance
  let parsedAmount              = null;

  if (effectiveWaiverType === "partial") {
    const parsed = Number(waived_amount);
    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: "waived_amount must be a positive number for a partial waiver" });
    }
    parsedAmount = Math.round(parsed * 100) / 100;
  }

  if (resolvedFeeType === "late_fee" || resolvedFeeType === "all_fees") {
    lateFeeWaivedAmount = effectiveWaiverType === "full" ? maxLateFee : parsedAmount;
  }

  if (resolvedFeeType === "rental_balance" || resolvedFeeType === "all_fees") {
    const currentBalance = Number(booking.remaining_balance || 0);
    if (resolvedFeeType === "all_fees" || effectiveWaiverType === "full") {
      rentalBalanceWaivedAmount = currentBalance;
    } else {
      // Partial: cap at the current remaining balance so the balance can't go negative
      if (parsedAmount > currentBalance) {
        return res.status(400).json({
          error: `Partial rental balance waiver ($${parsedAmount}) cannot exceed the remaining balance ($${currentBalance})`,
        });
      }
      rentalBalanceWaivedAmount = parsedAmount;
    }
  }

  // ── Build the booking patch ────────────────────────────────────────────────
  const now = new Date().toISOString();
  const patch = { updated_at: now };
  const auditChanges = [];

  if (lateFeeWaivedAmount !== null) {
    const prevLateAmount = Number(booking.late_fee_waived_amount || 0);
    const isLateUpdate   = !!booking.late_fee_waived;
    patch.late_fee_waived        = true;
    patch.late_fee_waived_amount = lateFeeWaivedAmount;
    patch.late_fee_waived_reason = trimmedReason;
    patch.late_fee_waived_by     = adminLabel;
    patch.late_fee_waived_at     = now;
    auditChanges.push(
      { field: "late_fee_waived",        oldValue: String(isLateUpdate),                                    newValue: "true" },
      { field: "late_fee_waived_amount", oldValue: String(isLateUpdate ? prevLateAmount : 0),               newValue: String(lateFeeWaivedAmount) },
      { field: "late_fee_waived_reason", oldValue: isLateUpdate ? (booking.late_fee_waived_reason || "") : "", newValue: trimmedReason },
      { field: "late_fee_waived_by",     oldValue: isLateUpdate ? (booking.late_fee_waived_by || "")     : "", newValue: adminLabel },
    );
  }

  if (rentalBalanceWaivedAmount !== null) {
    const currentBalance    = Number(booking.remaining_balance || 0);
    const newBalance        = Math.max(0, currentBalance - rentalBalanceWaivedAmount);
    const prevRentalAmount  = Number(booking.rental_balance_waived_amount || 0);
    const isRentalUpdate    = !!booking.rental_balance_waived;
    patch.remaining_balance            = newBalance;
    patch.rental_balance_waived        = true;
    patch.rental_balance_waived_amount = rentalBalanceWaivedAmount;
    patch.rental_balance_waived_reason = trimmedReason;
    patch.rental_balance_waived_by     = adminLabel;
    patch.rental_balance_waived_at     = now;
    auditChanges.push(
      { field: "rental_balance_waived",        oldValue: String(isRentalUpdate),                                       newValue: "true" },
      { field: "rental_balance_waived_amount", oldValue: String(isRentalUpdate ? prevRentalAmount : 0),                newValue: String(rentalBalanceWaivedAmount) },
      { field: "remaining_balance",            oldValue: String(currentBalance),                                       newValue: String(newBalance) },
      { field: "rental_balance_waived_reason", oldValue: isRentalUpdate ? (booking.rental_balance_waived_reason || "") : "", newValue: trimmedReason },
    );
  }

  // ── Apply waiver to bookings row ──────────────────────────────────────────
  const { error: updateErr } = await sb
    .from("bookings")
    .update(patch)
    .eq("booking_ref", bookingRef);

  if (updateErr) {
    return res.status(500).json({ error: `Failed to apply waiver: ${updateErr.message}` });
  }

  // ── Insert revenue adjustment record(s) ───────────────────────────────────
  const adjustmentBase = {
    booking_id:          bookingRef,
    booking_ref:         bookingRef,
    original_booking_id: bookingRef,
    vehicle_id:          booking.vehicle_id || null,
    deposit_amount:      0,
    refund_amount:       0,
    payment_method:      "adjustment",
    payment_status:      "paid",
    is_no_show:          false,
    is_cancelled:        false,
    override_by_admin:   true,
    stripe_fee:          0,
  };

  const revenueInserts = [];
  if (lateFeeWaivedAmount !== null) {
    revenueInserts.push({
      ...adjustmentBase,
      gross_amount: -lateFeeWaivedAmount,
      stripe_net:   -lateFeeWaivedAmount,
      type:         "late_fee_waiver",
      notes:        `Late fee waiver (${effectiveWaiverType}): ${trimmedReason} — applied by ${adminLabel}`,
    });
  }
  if (rentalBalanceWaivedAmount !== null) {
    revenueInserts.push({
      ...adjustmentBase,
      gross_amount: -rentalBalanceWaivedAmount,
      stripe_net:   -rentalBalanceWaivedAmount,
      type:         "rental_balance_waiver",
      notes:        `Rental balance waiver (${effectiveWaiverType}): ${trimmedReason} — applied by ${adminLabel}`,
    });
  }

  try {
    for (const record of revenueInserts) {
      const { error: revErr } = await sb.from("revenue_records").insert(record);
      if (revErr) {
        console.error("waive-late-fee: revenue adjustment insert failed (non-fatal):", revErr.message);
      }
    }
  } catch (revCatchErr) {
    console.error("waive-late-fee: revenue adjustment threw (non-fatal):", revCatchErr.message);
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await writeAuditLog(bookingRef, auditChanges, adminLabel);

  // ── Response ───────────────────────────────────────────────────────────────
  const isUpdate = !!(booking.late_fee_waived || booking.rental_balance_waived);
  const newLateFee = lateFeeWaivedAmount !== null
    ? Math.max(0, maxLateFee - lateFeeWaivedAmount)
    : Math.max(0, maxLateFee - Number(booking.late_fee_waived_amount || 0));
  const newRemainingBalance = rentalBalanceWaivedAmount !== null
    ? Math.max(0, Number(booking.remaining_balance || 0) - rentalBalanceWaivedAmount)
    : Number(booking.remaining_balance || 0);

  console.log("[FEE_WAIVER]", {
    booking_ref:                 bookingRef,
    fee_type:                    resolvedFeeType,
    waiver_type:                 effectiveWaiverType,
    late_fee_waived_amount:      lateFeeWaivedAmount,
    rental_balance_waived_amount: rentalBalanceWaivedAmount,
    is_update:                   isUpdate,
    reason:                      trimmedReason,
    applied_by:                  adminLabel,
  });

  return res.status(200).json({
    success:                      true,
    booking_ref:                  bookingRef,
    fee_type:                     resolvedFeeType,
    waiver_type:                  effectiveWaiverType,
    waived_amount:                lateFeeWaivedAmount !== null ? lateFeeWaivedAmount : 0,
    late_fee_waived_amount:       lateFeeWaivedAmount,
    rental_balance_waived_amount: rentalBalanceWaivedAmount,
    total_waived:                 (lateFeeWaivedAmount || 0) + (rentalBalanceWaivedAmount || 0),
    new_late_fee:                 newLateFee,
    new_remaining_balance:        newRemainingBalance,
    is_update:                    isUpdate,
    applied_by:                   adminLabel,
    applied_at:                   now,
  });
}
