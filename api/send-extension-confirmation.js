// api/send-extension-confirmation.js
// Vercel serverless function — client-triggered extension confirmation.
//
// Called from success.html immediately after a rental extension payment
// is confirmed by Stripe.  Retrieves the PaymentIntent, finds the booking,
// sends confirmation emails to the owner and renter (with updated rental
// agreement PDF), and updates the booking record and Supabase.
//
// This is the primary email-delivery path for extension payments.  The
// Stripe webhook (stripe-webhook.js) also attempts email delivery but uses
// an idempotency flag (extensionEmailSent) to skip if this endpoint already
// handled it, preventing duplicate emails.
//
// POST /api/send-extension-confirmation
// Body: { paymentIntentId }
//
// Returns: { ok: true } or { error: "..." }
//
// Required environment variables:
//   STRIPE_SECRET_KEY
//   SMTP_HOST, SMTP_USER, SMTP_PASS   (for email sending)
//   GITHUB_TOKEN, GITHUB_REPO          (for bookings.json read/write)

import Stripe from "stripe";
import { loadBookings, updateBooking } from "./_bookings.js";
import { sendExtensionConfirmationEmails } from "./_extension-email.js";
import { autoUpsertBooking } from "./_booking-automation.js";

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

  const { paymentIntentId } = req.body || {};
  if (!paymentIntentId || typeof paymentIntentId !== "string") {
    return res.status(400).json({ error: "paymentIntentId is required." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("send-extension-confirmation: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  try {
    // ── Retrieve and verify the PaymentIntent ──────────────────────────────
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (stripeErr) {
      console.error("send-extension-confirmation: Stripe retrieve error:", stripeErr.message);
      return res.status(400).json({ error: "Could not retrieve payment record." });
    }

    if (!pi || pi.status !== "succeeded") {
      return res.status(400).json({ error: "Payment has not been confirmed yet." });
    }

    const meta = pi.metadata || {};
    if (meta.payment_type !== "rental_extension") {
      return res.status(400).json({ error: "Not a rental extension payment." });
    }

    const {
      vehicle_id,
      original_booking_id,
      renter_name,
      renter_email,
      extension_label,
      new_return_date,
      new_return_time,
    } = meta;

    if (!vehicle_id || !original_booking_id) {
      console.error("send-extension-confirmation: missing vehicle_id or original_booking_id in PI metadata", pi.id);
      return res.status(422).json({ error: "Extension metadata is incomplete. Please contact us at (213) 916-6606." });
    }

    // ── Load booking ───────────────────────────────────────────────────────
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicle_id] || [];
    const idx = vehicleBookings.findIndex(
      (b) => b.bookingId === original_booking_id || b.paymentIntentId === original_booking_id
    );

    if (idx === -1) {
      console.error(`send-extension-confirmation: booking not found for vehicle ${vehicle_id} / id ${original_booking_id}`);
      return res.status(404).json({ error: "Booking not found. Please contact us at (213) 916-6606." });
    }

    const booking = vehicleBookings[idx];

    // ── Idempotency: skip if emails were already sent ──────────────────────
    if (booking.extensionEmailSent) {
      console.log(`send-extension-confirmation: emails already sent for PI ${pi.id} — skipping`);
      return res.status(200).json({ ok: true, alreadySent: true });
    }

    // ── Resolve extension data ─────────────────────────────────────────────
    // Prefer data stored in extensionPendingPayment (most complete); fall back
    // to PI metadata for the new return date and label.
    const ext = booking.extensionPendingPayment || (new_return_date ? {
      newReturnDate: new_return_date,
      newReturnTime: new_return_time || "",
      label:         extension_label || "",
    } : null);

    if (!ext) {
      console.error(`send-extension-confirmation: no extension data for PI ${pi.id}`);
      return res.status(422).json({ error: "Extension details are unavailable. Please contact us at (213) 916-6606." });
    }

    const updatedReturnDate = ext.newReturnDate || booking.returnDate;
    const updatedReturnTime = ext.newReturnTime || booking.returnTime || "";
    const oldReturnDate     = booking.returnDate;
    const resolvedLabel     = ext.label || extension_label || "";

    // ── Update booking record with new return date (if not already done) ───
    // The Stripe webhook also does this, so guard against overwriting a newer
    // value by only updating if the return date hasn't changed yet.
    const needsReturnDateUpdate = updatedReturnDate && updatedReturnDate !== booking.returnDate;
    const newExtensionCount     = (booking.extensionCount || 0) + (needsReturnDateUpdate ? 1 : 0);

    try {
      await updateBooking(vehicle_id, original_booking_id, {
        ...(needsReturnDateUpdate ? {
          returnDate:     updatedReturnDate,
          returnTime:     updatedReturnTime,
          extensionCount: newExtensionCount,
        } : {}),
        extensionPendingPayment: null,
        extensionEmailSent:      true,
      });
    } catch (updateErr) {
      // Non-fatal: still attempt to send emails even if the update fails.
      console.warn("send-extension-confirmation: could not update booking (non-fatal):", updateErr.message);
    }

    // ── Supabase sync ──────────────────────────────────────────────────────
    try {
      const updatedBooking = {
        ...booking,
        ...(needsReturnDateUpdate ? {
          returnDate:     updatedReturnDate,
          returnTime:     updatedReturnTime,
          extensionCount: newExtensionCount,
        } : {}),
        extensionPendingPayment: null,
        extensionEmailSent:      true,
      };
      await autoUpsertBooking(updatedBooking);
    } catch (syncErr) {
      console.error("send-extension-confirmation: Supabase sync error (non-fatal):", syncErr.message);
    }

    // ── Send confirmation emails ───────────────────────────────────────────
    try {
      await sendExtensionConfirmationEmails({
        paymentIntent:      pi,
        booking,
        updatedReturnDate,
        updatedReturnTime,
        extensionLabel:     resolvedLabel,
        vehicleId:          vehicle_id,
        renterEmail:        booking.email || renter_email || "",
        renterName:         booking.name  || renter_name  || "",
        originalReturnDate: oldReturnDate,
        extensionCount:     newExtensionCount || (booking.extensionCount || 1),
      });
    } catch (emailErr) {
      console.error("send-extension-confirmation: email failed (non-fatal):", emailErr.message);
      // Return a partial-success so the caller knows emails may not have gone
      return res.status(200).json({ ok: true, emailWarning: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-extension-confirmation: unexpected error:", err);
    return res.status(500).json({ error: "Unexpected error. Please contact us at (213) 916-6606." });
  }
}
