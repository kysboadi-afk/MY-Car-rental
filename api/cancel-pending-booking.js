// api/cancel-pending-booking.js
// Public endpoint to cancel a pre-payment ("pending") booking that was
// created by create-slingshot-booking.js (or create-payment-intent.js) but
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

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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
  try {
    const body = req.body || {};
    bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  } catch {
    return res.status(400).json({ error: "Invalid request body." });
  }

  // Validate format — must look like a real booking ref.
  if (!bookingId || !bookingId.startsWith("bk-") || bookingId.length < 6) {
    return res.status(400).json({ error: "Invalid bookingId." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    // Non-fatal — client can ignore; stale cleanup will catch it.
    return res.status(503).json({ error: "Database unavailable." });
  }

  try {
    // Only cancel if the booking is still in the pre-payment state.
    // The double filter (status=pending + payment_status≠paid) prevents
    // this endpoint from ever touching a paid or confirmed booking.
    const { error: updateErr } = await sb
      .from("bookings")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("booking_ref", bookingId)
      .eq("status", "pending")
      .neq("payment_status", "paid");

    if (updateErr) {
      console.error("[CANCEL_PENDING_BOOKING] update error:", updateErr.message);
      // Return 200 anyway — the client doesn't need to retry.
      return res.status(200).json({ ok: true, warn: "db_update_failed" });
    }

    console.log("[CANCEL_PENDING_BOOKING]", { bookingId });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[CANCEL_PENDING_BOOKING] unexpected error:", err.message);
    return res.status(200).json({ ok: true, warn: "unexpected_error" });
  }
}
