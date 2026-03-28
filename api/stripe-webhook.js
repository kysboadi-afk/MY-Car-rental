// api/stripe-webhook.js
// Vercel serverless function — Stripe webhook handler.
//
// Handles the payment_intent.succeeded event fired when a PaymentIntent
// (created by create-payment-intent.js or pay-balance.js) is confirmed.
// This is the server-side authoritative fallback for availability updates —
// it runs even if the user closes the browser before success.html completes.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY      — starts with sk_live_ or sk_test_
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe dashboard
//     (Stripe CLI for local testing: stripe listen --forward-to localhost:3000/api/stripe-webhook)
//
// Register this endpoint in the Stripe dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://sly-rides.vercel.app/api/stripe-webhook
//   Events: payment_intent.succeeded

import Stripe from "stripe";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { updateBooking, loadBookings, saveBookings, normalizePhone, appendBooking } from "./_bookings.js";
import { sendSms } from "./_textmagic.js";
import { render, EXTEND_CONFIRMED_SLINGSHOT, EXTEND_CONFIRMED_ECONOMY, DEFAULT_LOCATION } from "./_sms-templates.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { hasOverlap } from "./_availability.js";
import { autoCreateRevenueRecord, autoUpsertCustomer, autoUpsertBooking, autoCreateBlockedDate } from "./_booking-automation.js";

// Disable Vercel's built-in body parser so we can pass the raw request body
// to stripe.webhooks.constructEvent() for signature verification.
export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const FLEET_STATUS_PATH = "fleet-status.json";

/**
 * Read booked-dates.json from GitHub and block the given date range.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function blockBookedDates(vehicleId, from, to) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping date blocking");
    return;
  }
  if (!vehicleId || !from || !to) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadBookedDates() {
    const resp = await fetch(apiUrl, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      return { data: {}, sha: null }; // non-fatal: don't throw, keep existing dates
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch {
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveBookedDates(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:  loadBookedDates,
    apply: (data) => {
      if (!data[vehicleId]) data[vehicleId] = [];
      // Skip if this exact range is already recorded (idempotency guard)
      if (!hasOverlap(data[vehicleId], from, to)) {
        data[vehicleId].push({ from, to });
      }
    },
    save:    saveBookedDates,
    message: `Block dates for ${vehicleId}: ${from} to ${to} (webhook)`,
  });
}

/**
 * Mark a vehicle as unavailable in fleet-status.json on GitHub.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function markVehicleUnavailable(vehicleId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping fleet-status update");
    return;
  }
  if (!vehicleId) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadFleetStatus() {
    const resp = await fetch(apiUrl, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      return { data: {}, sha: null }; // non-fatal
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch (parseErr) {
      console.error("stripe-webhook: malformed JSON in fleet-status.json, resetting:", parseErr);
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveFleetStatus(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:  loadFleetStatus,
    apply: (data) => {
      if (!data[vehicleId]) data[vehicleId] = {};
      data[vehicleId].available = false;
    },
    save:    saveFleetStatus,
    message: `Mark ${vehicleId} unavailable after confirmed booking (webhook)`,
  });
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Save a booking record to bookings.json from PaymentIntent metadata.
 *
 * This is the guaranteed server-side fallback for the browser-side record
 * creation in send-reservation-email.js.  appendBooking() is idempotent:
 * it deduplicates by paymentIntentId so a double-save is always safe.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function saveWebhookBookingRecord(paymentIntent) {
  const meta = paymentIntent.metadata || {};
  const {
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    email,
    payment_type,
  } = meta;

  if (!vehicle_id || !pickup_date || !return_date) {
    console.log("stripe-webhook: skipping booking record — missing vehicle/dates in metadata");
    return;
  }

  const amountPaid = paymentIntent.amount ? Math.round(paymentIntent.amount) / 100 : 0;
  const status = payment_type === "reservation_deposit" ? "reserved_unpaid" : "booked_paid";

  const bookingRecord = {
    bookingId:       "wh-" + crypto.randomBytes(8).toString("hex"),
    name:            renter_name || "",
    phone:           renter_phone ? normalizePhone(renter_phone) : "",
    email:           email || "",
    vehicleId:       vehicle_id,
    vehicleName:     vehicle_name || vehicle_id,
    pickupDate:      pickup_date,
    pickupTime:      "",
    returnDate:      return_date,
    returnTime:      "",
    location:        DEFAULT_LOCATION,
    status,
    amountPaid,
    paymentIntentId: paymentIntent.id,
    paymentMethod:   "stripe",
    smsSentAt:       {},
    createdAt:       new Date().toISOString(),
    source:          "stripe_webhook",
  };

  try {
    await appendBooking(bookingRecord);
    console.log(`stripe-webhook: booking record saved for PI ${paymentIntent.id} (${vehicle_id})`);
  } catch (err) {
    console.error("stripe-webhook: saveWebhookBookingRecord error:", err.message);
  }

  // Non-fatal Supabase sync
  try {
    await autoCreateRevenueRecord(bookingRecord);
    await autoUpsertCustomer(bookingRecord, false);
    await autoUpsertBooking(bookingRecord);
    if (bookingRecord.pickupDate && bookingRecord.returnDate) {
      await autoCreateBlockedDate(bookingRecord.vehicleId, bookingRecord.pickupDate, bookingRecord.returnDate, "booking");
    }
  } catch (err) {
    console.error("stripe-webhook: Supabase sync error:", err.message);
  }
}

/**
 * Send a server-side fallback notification email to the owner and customer
 * using data extracted from the PaymentIntent metadata.
 *
 * This is the guaranteed backup path that fires even when the customer's
 * browser loses sessionStorage during a 3DS redirect and never calls
 * send-reservation-email.js.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function sendWebhookNotificationEmails(paymentIntent) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("stripe-webhook: SMTP not configured — skipping fallback email");
    return;
  }

  const meta = paymentIntent.metadata || {};
  const {
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    email,
    payment_type,
    full_rental_amount,
    balance_at_pickup,
  } = meta;

  const amountDollars = paymentIntent.amount ? (paymentIntent.amount / 100).toFixed(2) : "N/A";
  const isDepositMode = payment_type === "reservation_deposit";
  const totalLabel    = isDepositMode ? "Booking Deposit Charged" : "Total Charged";
  const totalDisplay  = isDepositMode
    ? `$${amountDollars} (non-refundable deposit — balance due at pickup)`
    : `$${amountDollars}`;

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // ── Owner notification ────────────────────────────────────────────────────
  const ownerSubject = `💰 Payment Confirmed – New Booking: ${esc(vehicle_name || vehicle_id)} (Server Backup)`;
  const ownerHtml = `
    <h2>💰 Payment Confirmed – New Booking (Server-Side Backup Notification)</h2>
    <p><strong>⚠️ This is an automatic server-side backup email.</strong> It fires whenever a payment succeeds on Stripe, regardless of what happened in the customer's browser. If you already received a separate "Payment Confirmed" email with the signed rental agreement, this duplicate can be ignored.</p>
    <table style="border-collapse:collapse;width:100%;margin-top:16px">
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Stripe Payment ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentIntent.id)}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicle_name || vehicle_id || "N/A")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renter_name || "Not provided")}</td></tr>
      ${renter_phone ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renter_phone)}</td></tr>` : ""}
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email || "Not provided")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup_date || "N/A")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(return_date || "N/A")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalDisplay)}</strong></td></tr>
      ${isDepositMode && full_rental_amount ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(full_rental_amount)}</td></tr>` : ""}
      ${isDepositMode && balance_at_pickup  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balance_at_pickup)}</strong></td></tr>` : ""}
    </table>
    <p style="margin-top:16px">⚠️ <strong>Action required:</strong> The signed rental agreement, renter's ID, and insurance documents are only attached to the full confirmation email sent from the customer's browser. If that email did not arrive, please contact the customer directly at ${esc(email || "the email above")} to collect a signed agreement.</p>
    <p>Dates have been automatically blocked on the booking calendar.</p>
  `;

  try {
    await transporter.sendMail({
      from:    `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:      OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject: ownerSubject,
      text:    [
        "Payment Confirmed – New Booking (Server-Side Backup Notification)",
        "",
        "NOTE: This is a server-side backup email. It fires on every confirmed Stripe payment.",
        "If you already received a full confirmation with the signed agreement, this can be ignored.",
        "",
        `Stripe Payment ID  : ${paymentIntent.id}`,
        `Vehicle            : ${vehicle_name || vehicle_id || "N/A"}`,
        `Renter Name        : ${renter_name || "Not provided"}`,
        renter_phone ? `Phone              : ${renter_phone}` : "",
        `Customer Email     : ${email || "Not provided"}`,
        `Pickup Date        : ${pickup_date || "N/A"}`,
        `Return Date        : ${return_date || "N/A"}`,
        `${totalLabel.padEnd(19)}: ${totalDisplay}`,
        isDepositMode && full_rental_amount ? `Full Rental Cost   : $${full_rental_amount}` : "",
        isDepositMode && balance_at_pickup  ? `Balance at Pickup  : $${balance_at_pickup}` : "",
      ].filter(Boolean).join("\n"),
      html: ownerHtml,
    });
    console.log(`stripe-webhook: backup owner email sent for PI ${paymentIntent.id}`);
  } catch (emailErr) {
    console.error("stripe-webhook: backup owner email failed:", emailErr.message);
  }

  // ── Customer confirmation ─────────────────────────────────────────────────
  if (email) {
    const customerSubject = "Your Booking is Confirmed – Sly Transportation Services LLC";
    const customerHtml = `
      <h2>✅ Payment Confirmed – Sly Transportation Services LLC</h2>
      <p>Hi ${esc(renter_name ? renter_name.split(" ")[0] : "there")}, your payment has been received and your booking is confirmed!</p>
      <table style="border-collapse:collapse;width:100%;margin-top:12px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicle_name || vehicle_id || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup_date || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(return_date || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalDisplay)}</strong></td></tr>
        ${isDepositMode && full_rental_amount ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(full_rental_amount)}</td></tr>` : ""}
        ${isDepositMode && balance_at_pickup  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balance_at_pickup)}</strong></td></tr>` : ""}
      </table>
      <p style="margin-top:16px">We will be in touch shortly to confirm your rental pick-up details.</p>
      <p>If you have any questions, please contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
      <p><strong>Sly Transportation Services LLC 🚗</strong></p>
    `;
    try {
      await transporter.sendMail({
        from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: customerSubject,
        text:    [
          "Payment Confirmed – Sly Transportation Services LLC",
          "",
          `Hi ${renter_name ? renter_name.split(" ")[0] : "there"}, your payment has been received and your booking is confirmed!`,
          "",
          `Vehicle            : ${vehicle_name || vehicle_id || "N/A"}`,
          `Pickup Date        : ${pickup_date || "N/A"}`,
          `Return Date        : ${return_date || "N/A"}`,
          `${totalLabel.padEnd(19)}: ${totalDisplay}`,
          isDepositMode && full_rental_amount ? `Full Rental Cost   : $${full_rental_amount}` : "",
          isDepositMode && balance_at_pickup  ? `Balance at Pickup  : $${balance_at_pickup}` : "",
          "",
          "We will be in touch shortly to confirm your rental pick-up details.",
          `If you have any questions contact us at ${OWNER_EMAIL} or call (213) 916-6606.`,
          "",
          "Sly Transportation Services LLC",
        ].filter(Boolean).join("\n"),
        html: customerHtml,
      });
      console.log(`stripe-webhook: backup customer email sent to ${email} for PI ${paymentIntent.id}`);
    } catch (custErr) {
      console.error("stripe-webhook: backup customer email failed:", custErr.message);
    }
  }
}

/**
 * Read the raw request body from a Node.js IncomingMessage stream.
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).send("Server configuration error");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET environment variable is not set");
    return res.status(500).send("Server configuration error");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;

    // Handle rental extension payment confirmations.
    if ((paymentIntent.metadata || {}).payment_type === "rental_extension") {
      const { vehicle_id, original_booking_id } = paymentIntent.metadata || {};
      if (vehicle_id && original_booking_id) {
        try {
          const { data, sha } = await loadBookings();
          if (Array.isArray(data[vehicle_id])) {
            const idx = data[vehicle_id].findIndex(
              (b) => b.bookingId === original_booking_id || b.paymentIntentId === original_booking_id
            );
            if (idx !== -1) {
              const booking = data[vehicle_id][idx];
              const ext = booking.extensionPendingPayment;
              if (ext) {
                data[vehicle_id][idx].returnDate = ext.newReturnDate || booking.returnDate;
                data[vehicle_id][idx].returnTime = ext.newReturnTime || booking.returnTime;
                data[vehicle_id][idx].extensionPendingPayment = null;
                data[vehicle_id][idx].extensionCount = (booking.extensionCount || 0) + 1;
                await saveBookings(data, sha, `Confirm extension for booking ${original_booking_id}`);

                // Sync updated return date to Supabase bookings table
                try {
                  await autoUpsertBooking(data[vehicle_id][idx]);
                } catch (syncErr) {
                  console.error("stripe-webhook: Supabase extension sync error (non-fatal):", syncErr.message);
                }

                // Send extension confirmed SMS
                if (booking.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
                  const isSlingshot = vehicle_id && vehicle_id.startsWith("slingshot");
                  const template = isSlingshot ? EXTEND_CONFIRMED_SLINGSHOT : EXTEND_CONFIRMED_ECONOMY;
                  const vars = {
                    return_time: ext.newReturnTime || "",
                    return_date: ext.newReturnDate || "",
                  };
                  try {
                    await sendSms(normalizePhone(booking.phone), render(template, vars));
                  } catch (smsErr) {
                    console.error("stripe-webhook: extension confirmed SMS failed:", smsErr.message);
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("stripe-webhook: extension confirmation error:", err);
        }
      }
      return res.status(200).json({ received: true });
    }

    // Skip balance payments — dates were already blocked when the deposit was paid.
    if ((paymentIntent.metadata || {}).payment_type === "balance_payment") {
      console.log(
        `stripe-webhook: balance_payment for PaymentIntent ${paymentIntent.id} — skipping date blocking`
      );
      // Update booking status to booked_paid when full balance is paid
      const { vehicle_id } = paymentIntent.metadata || {};
      const originalPiId = (paymentIntent.metadata || {}).original_payment_intent_id ||
        (paymentIntent.metadata || {}).deposit_payment_intent_id;
      if (vehicle_id && originalPiId) {
        try {
          await updateBooking(vehicle_id, originalPiId, { status: "booked_paid" });
          // Sync the status change to Supabase bookings table
          const { data: updatedData } = await loadBookings();
          const updatedBooking = (updatedData[vehicle_id] || []).find(
            (b) => b.bookingId === originalPiId || b.paymentIntentId === originalPiId
          );
          if (updatedBooking) {
            await autoUpsertBooking(updatedBooking);
          }
        } catch (err) {
          console.error("stripe-webhook: updateBooking (balance) error:", err);
        }
      }
      return res.status(200).json({ received: true });
    }

    const { vehicle_id, pickup_date, return_date } = paymentIntent.metadata || {};

    console.log(
      `stripe-webhook: payment_intent.succeeded — vehicle=${vehicle_id} ` +
      `pickup=${pickup_date} return=${return_date} pi=${paymentIntent.id}`
    );

    // Block the booked dates and mark the vehicle unavailable.
    if (vehicle_id && pickup_date && return_date) {
      try {
        await blockBookedDates(vehicle_id, pickup_date, return_date);
      } catch (err) {
        console.error("stripe-webhook: blockBookedDates error:", err);
      }
      try {
        await markVehicleUnavailable(vehicle_id);
      } catch (err) {
        console.error("stripe-webhook: markVehicleUnavailable error:", err);
      }
    }

    // Send server-side backup notification emails to the owner and customer.
    // These fire on every confirmed payment as a guaranteed fallback for the
    // browser-side send-reservation-email call (which can fail if the customer's
    // sessionStorage is lost during a 3DS redirect or if the browser is closed
    // before success.html completes).
    try {
      await sendWebhookNotificationEmails(paymentIntent);
    } catch (emailErr) {
      console.error("stripe-webhook: sendWebhookNotificationEmails error:", emailErr.message);
    }

    // Save a booking record from PI metadata — fallback for when success.html
    // never completes (lost sessionStorage, browser closed, 3DS redirect).
    // appendBooking() is idempotent (deduplicates on paymentIntentId), so a
    // double-save with the browser-side record is always safe.
    try {
      await saveWebhookBookingRecord(paymentIntent);
    } catch (bookingErr) {
      console.error("stripe-webhook: saveWebhookBookingRecord error:", bookingErr.message);
    }
  }

  return res.status(200).json({ received: true });
}
