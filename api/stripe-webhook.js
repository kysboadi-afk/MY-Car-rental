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
import { updateBooking, loadBookings, saveBookings, normalizePhone } from "./_bookings.js";
import { sendSms } from "./_textmagic.js";
import { render, EXTEND_CONFIRMED_SLINGSHOT, EXTEND_CONFIRMED_ECONOMY } from "./_sms-templates.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { hasOverlap } from "./_availability.js";

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

                // Send extension confirmed SMS
                if (booking.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
                  const isSlingshot = vehicle_id === "slingshot" || vehicle_id === "slingshot2";
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
  }

  return res.status(200).json({ received: true });
}
