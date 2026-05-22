// api/cancel-pending-booking.js
// Public endpoint to cancel a pre-payment ("pending") booking that was
// created by create-payment-intent.js but
// was never paid.
//
// This is called client-side when a renter clicks "Cancel" on the Stripe
// payment form or navigates away before completing payment.  It is intentionally
// unauthenticated because:
//   • Only bookings with status='pending' can be cancelled (paid rows are safe).
//   • The bookingId is a cryptographically random token ("bk-" + 12 hex chars)
//     that cannot be guessed by an attacker.
//
// POST /api/cancel-pending-booking
// Body: { bookingId }
// Returns: { ok: true } on success (even if the booking was already cancelled
//          or did not exist — idempotent by design).

import { getSupabaseAdmin } from "./_supabase.js";
import { CHECKOUT_PENDING_PREPAY_DB_STATUSES, toDbBookingStatus } from "./_booking-status.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const ALLOWED_TARGET_STATUSES = new Set(["abandoned_checkout", "upload_failed", "payment_failed"]);

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  let bookingId;
  let targetStatus = "abandoned_checkout";
  let reason = "client_cleanup";
  let source = "client";
  try {
    const body = req.body || {};
    bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
    if (typeof body.targetStatus === "string" && ALLOWED_TARGET_STATUSES.has(body.targetStatus.trim())) {
      targetStatus = body.targetStatus.trim();
    }
    if (typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 120);
    }
    if (typeof body.source === "string" && body.source.trim()) {
      source = body.source.trim().slice(0, 80);
    }
  } catch {
    return res.status(400).json({ error: "Invalid request body." });
  }

  // Validate format — must be exactly "bk-" followed by 12 lowercase hex chars.
  if (!bookingId || !/^bk-[0-9a-f]{12}$/.test(bookingId)) {
    return res.status(400).json({ error: "Invalid bookingId." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    // Non-fatal — client can ignore; stale cleanup will catch it.
    return res.status(503).json({ error: "Database unavailable." });
  }

  try {
    // Only transition if the booking is still in the pre-payment checkout state.
    // The double filter (pending/pending_checkout + payment_status≠paid) prevents
    // this endpoint from ever touching a paid or confirmed booking.
    const { data: updatedRows, error: updateErr } = await sb
      .from("bookings")
      .update({ status: toDbBookingStatus(targetStatus), updated_at: new Date().toISOString() })
      .eq("booking_ref", bookingId)
      .in("status", Array.from(CHECKOUT_PENDING_PREPAY_DB_STATUSES))
      .neq("payment_status", "paid")
      .select("booking_ref, vehicle_id, status, payment_intent_id");

    if (updateErr) {
      console.error("[CANCEL_PENDING_BOOKING] update error:", updateErr.message);
      return res.status(500).json({ ok: false, error: "Failed to cancel booking." });
    }

    console.log("[CHECKOUT_CLEANUP]", {
      bookingId,
      toStatus: targetStatus,
      reason,
      source,
      affectedRows: (updatedRows || []).length,
      releasedTemporaryHold: (updatedRows || []).length > 0,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[CANCEL_PENDING_BOOKING] unexpected error:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to cancel booking." });
  }
}
