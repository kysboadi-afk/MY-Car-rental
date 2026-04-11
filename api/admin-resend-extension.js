// api/admin-resend-extension.js
// Vercel serverless function — admin-only endpoint to manually resend
// rental extension confirmation emails (owner + renter) with an updated
// rental agreement PDF.
//
// Use this when the automatic email flow fails (webhook didn't fire, SMTP
// was misconfigured at the time of payment, etc.) or when you need to
// resend the confirmation for an existing extension.
//
// POST /api/admin-resend-extension
// Body (JSON):
// {
//   "secret":              "<ADMIN_SECRET>",
//   "vehicle_id":          "camry",
//   "vehicle_name":        "Camry 2012",       (optional, falls back to CARS lookup)
//   "original_booking_id": "<bookingId>",
//   "renter_name":         "David Agbebaku",
//   "renter_email":        "customer@email.com",
//   "renter_phone":        "3463814616",        (optional)
//   "extension_label":     "+3 days",
//   "new_return_date":     "2026-04-14",
//   "new_return_time":     "11:30 AM",          (optional)
//   "amount":              165,                 (optional, dollars — shown in email)
//   "payment_intent_id":   "pi_xxx",            (optional — shown in agreement)
// }
//
// Returns: { ok: true } on success or { error: "..." } on failure.

import { loadBookings, updateBooking } from "./_bookings.js";
import { autoUpsertBooking } from "./_booking-automation.js";
import { sendExtensionConfirmationEmails } from "./_extension-email.js";

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

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const {
    secret,
    vehicle_id,
    vehicle_name,
    original_booking_id,
    renter_name,
    renter_email,
    renter_phone,
    extension_label,
    new_return_date,
    new_return_time,
    amount,
    payment_intent_id,
  } = req.body || {};

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Validation ────────────────────────────────────────────────────────────
  if (!vehicle_id) {
    return res.status(400).json({ error: "vehicle_id is required." });
  }
  if (!original_booking_id) {
    return res.status(400).json({ error: "original_booking_id is required." });
  }
  if (!renter_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(renter_email)) {
    return res.status(400).json({ error: "A valid renter_email is required." });
  }
  if (!new_return_date || !/^\d{4}-\d{2}-\d{2}$/.test(new_return_date)) {
    return res.status(400).json({ error: "new_return_date must be in YYYY-MM-DD format." });
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(500).json({ error: "SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in Vercel." });
  }

  try {
    // ── Load booking to get pickup dates, phone, etc. ─────────────────────
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicle_id] || [];
    const booking = vehicleBookings.find(
      (b) => b.bookingId === original_booking_id || b.paymentIntentId === original_booking_id
    ) || null;

    // Build a lean booking object, falling back to request body when the
    // record is not found (e.g. the booking hasn't synced yet).
    const bookingRecord = booking || {
      phone:      renter_phone || "",
      pickupDate: "",
      pickupTime: "",
      returnDate: "",
    };

    if (renter_phone && !bookingRecord.phone) {
      bookingRecord.phone = renter_phone;
    }

    // ── Build a synthetic PaymentIntent-like object ────────────────────────
    // sendExtensionConfirmationEmails() reads pi.amount, pi.id, and
    // pi.metadata.vehicle_name.  We construct a minimal compatible object
    // from the supplied body fields.
    const amountCents = amount ? Math.round(Number(amount) * 100) : 0;
    const syntheticPi = {
      id:       payment_intent_id || ("manual-resend-" + Date.now()),
      amount:   amountCents,
      metadata: {
        vehicle_name: vehicle_name || vehicle_id,
      },
    };

    const oldReturnDate = booking ? booking.returnDate : "";
    const needsReturnDateUpdate = new_return_date && new_return_date !== (booking ? booking.returnDate : "");
    const newExtensionCount = (booking ? (booking.extensionCount || 0) : 0) + (needsReturnDateUpdate ? 1 : 0);

    // ── Update booking record (bookings.json + Supabase) ──────────────────
    // This is what makes the admin dashboard and AI assistant see the new
    // return date immediately without waiting for the Stripe webhook.
    if (booking) {
      try {
        await updateBooking(vehicle_id, original_booking_id, {
          ...(needsReturnDateUpdate ? {
            returnDate:     new_return_date,
            returnTime:     new_return_time || booking.returnTime || "",
            extensionCount: newExtensionCount,
          } : {}),
        });
      } catch (updateErr) {
        console.warn("admin-resend-extension: bookings.json update failed (non-fatal):", updateErr.message);
      }

      try {
        const updatedBooking = {
          ...booking,
          ...(needsReturnDateUpdate ? {
            returnDate:     new_return_date,
            returnTime:     new_return_time || booking.returnTime || "",
            extensionCount: newExtensionCount,
          } : {}),
        };
        await autoUpsertBooking(updatedBooking);
      } catch (syncErr) {
        console.warn("admin-resend-extension: Supabase sync failed (non-fatal):", syncErr.message);
      }
    }

    // ── Send emails ────────────────────────────────────────────────────────
    await sendExtensionConfirmationEmails({
      paymentIntent:      syntheticPi,
      booking:            bookingRecord,
      updatedReturnDate:  new_return_date,
      updatedReturnTime:  new_return_time || "",
      extensionLabel:     extension_label || "",
      vehicleId:          vehicle_id,
      renterEmail:        renter_email,
      renterName:         renter_name || "",
      originalReturnDate: oldReturnDate,
      extensionCount:     newExtensionCount || (booking ? (booking.extensionCount || 1) : 1),
    });

    console.log(`admin-resend-extension: emails sent for booking ${original_booking_id} (${vehicle_id})`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin-resend-extension: error:", err);
    return res.status(500).json({ error: err.message || "Unexpected error sending extension emails." });
  }
}
