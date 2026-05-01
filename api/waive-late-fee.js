// api/waive-late-fee.js
// Admin-authenticated endpoint that applies a full or partial late-fee waiver
// to a booking.  The waiver is stored on the booking row for transparency
// and surfaces as a 'late_fee_waiver' revenue adjustment record so the ledger
// stays accurate.
//
// POST /api/waive-late-fee
// Body: {
//   secret:       string,  // ADMIN_SECRET
//   booking_id:   string,  // booking_ref
//   waiver_type:  string,  // "full" | "partial"
//   waived_amount: number, // required for partial; full uses the full late fee
//   reason:       string,  // mandatory explanation (accident, emergency, …)
//   waived_by:    string,  // optional admin identifier label
// }
//
// Returns: { success, waived_amount, new_late_fee, booking_ref }
//
// Rules:
//   • Only admin roles can call this (ADMIN_SECRET guard).
//   • A reason is always required — no silent changes.
//   • A waiver may only be applied once; a second call replaces the previous
//     waiver and logs the change in booking_audit_log.
//   • The waiver does NOT trigger an automatic Stripe refund — if the
//     extension was already paid, the admin must issue a manual refund.
//   • Revenue adjustment record (type='late_fee_waiver', amount=-waived_amount)
//     is inserted so that accounting totals stay accurate.

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
  const { secret, booking_id, waiver_type, waived_amount, reason, waived_by } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Input validation ────────────────────────────────────────────────────────
  if (!booking_id || typeof booking_id !== "string" || !booking_id.trim()) {
    return res.status(400).json({ error: "booking_id is required" });
  }

  if (!["full", "partial"].includes(waiver_type)) {
    return res.status(400).json({ error: 'waiver_type must be "full" or "partial"' });
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (!trimmedReason) {
    return res.status(400).json({ error: "reason is required — every waiver must have an explanation" });
  }

  const adminLabel = (typeof waived_by === "string" && waived_by.trim()) ? waived_by.trim() : "admin";
  const bookingRef = booking_id.trim();

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  // ── Look up the booking ───────────────────────────────────────────────────
  const { data: booking, error: bkErr } = await sb
    .from("bookings")
    .select(
      "id, booking_ref, vehicle_id, return_time, status, " +
      "late_fee_waived, late_fee_waived_amount, late_fee_waived_reason, " +
      "late_fee_waived_by, late_fee_waived_at"
    )
    .eq("booking_ref", bookingRef)
    .maybeSingle();

  if (bkErr) {
    return res.status(500).json({ error: `Booking lookup failed: ${bkErr.message}` });
  }
  if (!booking) {
    return res.status(404).json({ error: `Booking "${esc(bookingRef)}" not found` });
  }

  // ── Determine the full late fee for this booking ──────────────────────────
  // The maximum possible late fee is EXTENDED_LATE_FEE because that is the
  // highest fixed amount the system can assess.
  const maxLateFee = EXTENDED_LATE_FEE;

  // Resolve the waived amount.
  let resolvedWaivedAmount;
  if (waiver_type === "full") {
    // Full waiver: waive the entire maximum late fee.
    resolvedWaivedAmount = maxLateFee;
  } else {
    // Partial waiver: caller must provide the amount.
    const parsed = Number(waived_amount);
    if (isNaN(parsed) || parsed <= 0) {
      return res.status(400).json({ error: "waived_amount must be a positive number for a partial waiver" });
    }
    if (parsed > maxLateFee) {
      return res.status(400).json({
        error: `waived_amount (${parsed}) cannot exceed the maximum late fee ($${maxLateFee})`,
      });
    }
    resolvedWaivedAmount = Math.round(parsed * 100) / 100;
  }

  // ── Track whether this is replacing an existing waiver ───────────────────
  const previousWaivedAmount = Number(booking.late_fee_waived_amount || 0);
  const isUpdate = !!booking.late_fee_waived;

  // ── Apply waiver to bookings row ──────────────────────────────────────────
  const now = new Date().toISOString();
  const patch = {
    late_fee_waived:        true,
    late_fee_waived_amount: resolvedWaivedAmount,
    late_fee_waived_reason: trimmedReason,
    late_fee_waived_by:     adminLabel,
    late_fee_waived_at:     now,
    updated_at:             now,
  };

  const { error: updateErr } = await sb
    .from("bookings")
    .update(patch)
    .eq("booking_ref", bookingRef);

  if (updateErr) {
    return res.status(500).json({ error: `Failed to apply waiver: ${updateErr.message}` });
  }

  // ── Insert revenue adjustment record ─────────────────────────────────────
  // type = 'late_fee_waiver', amount = -resolvedWaivedAmount
  // This keeps accounting totals accurate without triggering a Stripe refund.
  try {
    const adjustmentRecord = {
      booking_id:          bookingRef,
      original_booking_id: bookingRef,
      vehicle_id:          booking.vehicle_id || null,
      gross_amount:        -resolvedWaivedAmount,
      deposit_amount:      0,
      refund_amount:       0,
      payment_method:      "adjustment",
      payment_status:      "paid",
      type:                "late_fee_waiver",
      notes:               `Late fee waiver (${waiver_type}): ${trimmedReason} — applied by ${adminLabel}`,
      is_no_show:          false,
      is_cancelled:        false,
      override_by_admin:   true,
      stripe_fee:          0,
      stripe_net:          -resolvedWaivedAmount,
    };

    const { error: revErr } = await sb
      .from("revenue_records")
      .insert(adjustmentRecord);

    if (revErr) {
      // Non-fatal: waiver already applied to booking; log and continue.
      console.error("waive-late-fee: revenue adjustment insert failed (non-fatal):", revErr.message);
    }
  } catch (revCatchErr) {
    console.error("waive-late-fee: revenue adjustment threw (non-fatal):", revCatchErr.message);
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Every waiver must be logged — no silent changes.
  const auditChanges = [
    {
      field:    "late_fee_waived",
      oldValue: String(isUpdate ? true : false),
      newValue: "true",
    },
    {
      field:    "late_fee_waived_amount",
      oldValue: isUpdate ? String(previousWaivedAmount) : "0",
      newValue: String(resolvedWaivedAmount),
    },
    {
      field:    "late_fee_waived_reason",
      oldValue: isUpdate ? (booking.late_fee_waived_reason || "") : "",
      newValue: trimmedReason,
    },
    {
      field:    "late_fee_waived_by",
      oldValue: isUpdate ? (booking.late_fee_waived_by || "") : "",
      newValue: adminLabel,
    },
  ];

  await writeAuditLog(bookingRef, auditChanges, adminLabel);

  // ── Response ───────────────────────────────────────────────────────────────
  // Return info the admin UI needs: how much was waived and the resulting max
  // late fee that can now be assessed on this booking.
  const newLateFee = Math.max(0, maxLateFee - resolvedWaivedAmount);

  console.log("[LATE_FEE_WAIVER]", {
    booking_ref:    bookingRef,
    waiver_type,
    waived_amount:  resolvedWaivedAmount,
    previous_waived: previousWaivedAmount,
    is_update:      isUpdate,
    new_late_fee:   newLateFee,
    reason:         trimmedReason,
    applied_by:     adminLabel,
  });

  return res.status(200).json({
    success:        true,
    booking_ref:    bookingRef,
    waiver_type,
    waived_amount:  resolvedWaivedAmount,
    new_late_fee:   newLateFee,
    is_update:      isUpdate,
    applied_by:     adminLabel,
    applied_at:     now,
  });
}
