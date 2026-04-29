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
import { loadBookings, saveBookings } from "./_bookings.js";
import { sendExtensionConfirmationEmails } from "./_extension-email.js";
import { autoUpsertBooking, autoCreateBlockedDate, extendBlockedDateForBooking, parseTime12h } from "./_booking-automation.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { normalizeClockTime, DEFAULT_RETURN_TIME } from "./_time.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";

/**
 * Add or extend a booking date range in booked-dates.json.
 * Mirrors the same logic in stripe-webhook.js so both paths keep the file consistent.
 */
async function blockBookedDates(_vehicleId, _from, _to) {
  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  console.log("send-extension-confirmation: blockBookedDates() called but writes are disabled (Phase 4)");
}

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
    if (meta.payment_type !== "rental_extension" && meta.type !== "rental_extension") {
      return res.status(400).json({ error: "Not a rental extension payment." });
    }

    const {
      vehicle_id,
      booking_id:          meta_booking_id,   // canonical booking_ref (primary)
      original_booking_id,                    // legacy fallback for historical PIs
      renter_name,
      renter_email,
      extension_label,
      new_return_date,
    } = meta;

    // Use canonical booking_id; fall back to original_booking_id for historical PIs.
    const bookingRef = meta_booking_id || original_booking_id;

    if (!vehicle_id || !bookingRef) {
      console.error("send-extension-confirmation: missing vehicle_id or booking_id in PI metadata", pi.id);
      return res.status(422).json({ error: "Extension metadata is incomplete. Please contact us at (213) 916-6606." });
    }

    // ── Load booking ───────────────────────────────────────────────────────
    // TODO (Phase 3 — pending Supabase schema): migrate to Supabase primary once
    // extensionPendingPayment is stored in the bookings table. The field is
    // currently written to bookings.json only and is required below.
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicle_id] || [];
    const idx = vehicleBookings.findIndex(
      (b) => b.bookingId === bookingRef || b.paymentIntentId === bookingRef
    );

    if (idx === -1) {
      // Booking not in bookings.json — update Supabase directly so the admin
      // dashboard is kept in sync, then attempt emails using PI metadata.
      console.warn(`send-extension-confirmation: booking ${bookingRef} not found in bookings.json — using Supabase direct update fallback`);

      if (new_return_date) {
        try {
          const sb = getSupabaseAdmin();
          if (sb) {
            const pgTime = parseTime12h(DEFAULT_RETURN_TIME);
            const { error: sbDirectErr } = await sb
              .from("bookings")
              .update({
                return_date: new_return_date,
                return_time: pgTime,
                updated_at:  new Date().toISOString(),
              })
              .eq("booking_ref", bookingRef);
            if (sbDirectErr) {
              console.error("send-extension-confirmation: Supabase direct update error:", sbDirectErr.message);
            } else {
              console.log(`send-extension-confirmation: Supabase direct update succeeded for booking ${bookingRef} → ${new_return_date}`);
            }
          }
        } catch (fbErr) {
          console.error("send-extension-confirmation: Supabase direct update threw:", fbErr.message);
        }
      }

      // Still attempt email delivery if we have enough metadata
      if (new_return_date && renter_email) {
        try {
          const syntheticBooking = {
            phone:      "",
            pickupDate: "",
            pickupTime: "",
            returnDate: "",
          };
          await sendExtensionConfirmationEmails({
            paymentIntent:      pi,
            booking:            syntheticBooking,
            updatedReturnDate:  new_return_date,
            updatedReturnTime:  DEFAULT_RETURN_TIME,
            extensionLabel:     extension_label || "",
            vehicleId:          vehicle_id,
            renterEmail:        renter_email,
            renterName:         renter_name || "",
            originalReturnDate: "",
            extensionCount:     1,
          });
        } catch (emailErr) {
          console.error("send-extension-confirmation: email failed for not-found booking (non-fatal):", emailErr.message);
          return res.status(200).json({ ok: true, emailWarning: true });
        }
        return res.status(200).json({ ok: true });
      }

      // Stripe webhook will handle the update — return success to avoid customer-facing error
      return res.status(200).json({ ok: true });
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
    const normalizedBookingReturnTime = normalizeClockTime(booking.returnTime);
    const resolvedReturnTime = normalizedBookingReturnTime || DEFAULT_RETURN_TIME;
    const ext = booking.extensionPendingPayment || (new_return_date ? {
      newReturnDate: new_return_date,
      newReturnTime: resolvedReturnTime,
      label:         extension_label || "",
    } : null);

    if (!ext) {
      console.error(`send-extension-confirmation: no extension data for PI ${pi.id}`);
      return res.status(422).json({ error: "Extension details are unavailable. Please contact us at (213) 916-6606." });
    }

    const updatedReturnDate = ext.newReturnDate || booking.returnDate;
    const updatedReturnTime = resolvedReturnTime;
    const oldReturnDate     = booking.returnDate;
    const resolvedLabel     = ext.label || extension_label || "";

    // ── Update booking record with new return date (if not already done) ───
    // The Stripe webhook also does this, so guard against overwriting a newer
    // value by only updating if the return date hasn't changed yet.
    const needsReturnDateUpdate = updatedReturnDate && updatedReturnDate !== booking.returnDate;
    const needsReturnTimePersist = !booking.returnTime || booking.returnTime !== updatedReturnTime;
    const newExtensionCount     = (booking.extensionCount || 0) + (needsReturnDateUpdate ? 1 : 0);

    try {
      // Use updateJsonFileWithRetry directly so we can clear nested smsSentAt markers
      // (which updateBooking's shallow spread cannot do).
      await updateJsonFileWithRetry({
        load:  loadBookings,
        apply: (data) => {
          if (!Array.isArray(data[vehicle_id])) return;
          const i = data[vehicle_id].findIndex(
            (b) => b.bookingId === bookingRef || b.paymentIntentId === bookingRef
          );
          if (i === -1) return;
          const cur = data[vehicle_id][i];
          if (needsReturnDateUpdate || needsReturnTimePersist) {
            if (needsReturnDateUpdate) {
              cur.returnDate = updatedReturnDate;
              cur.extensionCount = newExtensionCount;
            }
            cur.returnTime = updatedReturnTime;
            // Clear late-return and end-of-rental SMS markers so they re-fire
            // for the new return date. Without this, stale markers block the
            // late-fee and return-reminder automation after an extension.
            if (cur.smsSentAt) {
              delete cur.smsSentAt.late_warning_30min;
              delete cur.smsSentAt.late_at_return;
              delete cur.smsSentAt.late_grace_expired;
              delete cur.smsSentAt.late_fee_pending;
              delete cur.smsSentAt.active_1h;
              delete cur.smsSentAt.active_15min;
            }
            delete cur.lateFeeApplied;
          }
          cur.extensionPendingPayment = null;
          cur.extensionEmailSent      = true;
        },
        save:    saveBookings,
        message: `Confirm extension for booking ${bookingRef}`,
      });
    } catch (updateErr) {
      // Non-fatal: still attempt to send emails even if the update fails.
      console.warn("send-extension-confirmation: could not update booking (non-fatal):", updateErr.message);
    }

    // ── Supabase sync ──────────────────────────────────────────────────────
    try {
      const updatedBooking = {
        ...booking,
        ...(needsReturnDateUpdate || needsReturnTimePersist ? {
          ...(needsReturnDateUpdate ? {
            returnDate: updatedReturnDate,
            extensionCount: newExtensionCount,
          } : {}),
          returnTime: updatedReturnTime,
        } : {}),
        extensionPendingPayment: null,
        extensionEmailSent:      true,
      };
      await autoUpsertBooking(updatedBooking);
    } catch (syncErr) {
      console.error("send-extension-confirmation: Supabase sync error (non-fatal):", syncErr.message);
    }

    // ── Update availability: blocked_dates (Supabase) + booked-dates.json ──
    // Ensures vehicle availability reflects the extended return date immediately,
    // regardless of whether the Stripe webhook has fired yet.
    if (needsReturnDateUpdate && booking.pickupDate && updatedReturnDate) {
      try {
        await blockBookedDates(vehicle_id, booking.pickupDate, updatedReturnDate);
        console.log(`send-extension-confirmation: booked-dates.json updated for extension ${vehicle_id}: ${booking.pickupDate} → ${updatedReturnDate}`);
      } catch (bdErr) {
        console.error("send-extension-confirmation: booked-dates.json extension update failed (non-fatal):", bdErr.message);
      }
      try {
        await extendBlockedDateForBooking(vehicle_id, bookingRef, updatedReturnDate, updatedReturnTime || null);
        console.log(`send-extension-confirmation: Supabase blocked_dates updated for extension ${vehicle_id}: ${booking.pickupDate} → ${updatedReturnDate}`);
      } catch (sbBlockErr) {
        console.error("send-extension-confirmation: Supabase blocked_dates extension update failed (non-fatal):", sbBlockErr.message);
      }
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
