// api/stripe-replay.js
// SLYTRANS Fleet Control v2 — Single-PaymentIntent replay endpoint.
//
// Safely replays one missed Stripe PaymentIntent through the FULL webhook
// pipeline, including booking persistence, calendar blocking, fleet-status
// update, and notification emails to the owner and customer.
//
// This endpoint exists for operational recovery of payments that succeeded in
// Stripe but were never persisted (e.g. due to a webhook delivery gap before
// the routing fix was deployed).  It calls the identical code paths used by
// stripe-webhook.js's generic handler for full_payment / reservation_deposit:
//
//   1. saveWebhookBookingRecord(pi)               → persistBooking (idempotent)
//   2. blockBookedDates(vehicleId, from, to)       → booked-dates.json on GitHub
//   3. markVehicleUnavailable(vehicleId)           → fleet-status.json on GitHub
//   4. sendWebhookNotificationEmails(pi)           → owner + customer emails
//
// Idempotency:
//   Before running any step, the endpoint checks whether the payment_intent_id
//   already exists in revenue_records.  If found, it returns immediately with
//   status "already_processed" — no writes, no emails.
//   persistBooking() is also inherently idempotent (upsert semantics), so
//   calling it twice for the same PI is always safe.
//
// Routing guard:
//   Payment types handled by webhook's specialised branches (rental_extension,
//   balance_payment, slingshot_balance_payment) are rejected — they must never
//   be replayed as new bookings.  Only payment types that create a new booking
//   record (full_payment, reservation_deposit, slingshot_security_deposit, or
//   an unrecognised type with complete metadata) are accepted.
//
// POST /api/stripe-replay
// Body: {
//   secret:    string,    // ADMIN_SECRET
//   pi_id:     string,    // Stripe PaymentIntent ID (e.g. "pi_3TNCvX...")
//   dry_run?:  boolean,   // default false — preview routing without writing
// }
//
// Response: {
//   pi_id:          string,
//   status:         "already_processed" | "would_process" | "processed" | "error",
//   payment_type:   string,
//   vehicle_id:     string,
//   booking_id?:    string,   // set when processed
//   steps?:         object,   // step-level success/error flags when processed
//   reason?:        string,   // set when skipped or error
// }

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  saveWebhookBookingRecord,
  blockBookedDates,
  markVehicleUnavailable,
  sendWebhookNotificationEmails,
} from "./stripe-webhook.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Payment types handled by webhook specialised branches that mutate an existing
// booking rather than creating a new one — these must not be replayed here.
const REJECT_PAYMENT_TYPES = new Set([
  "rental_extension",
  "balance_payment",
  "slingshot_balance_payment",
]);

/**
 * Check whether this PaymentIntent's id is already present in revenue_records.
 * Returns true when already recorded (idempotency pass — do nothing).
 */
async function isAlreadyRecorded(sb, piId) {
  try {
    const { data, error } = await sb
      .from("revenue_records")
      .select("id")
      .eq("payment_intent_id", piId)
      .maybeSingle();
    if (error) {
      console.error(`stripe-replay: revenue_records lookup error: ${error.message}`);
      return false; // Treat lookup failure as "not recorded" — proceed cautiously.
    }
    return !!data;
  } catch (err) {
    console.error(`stripe-replay: revenue_records lookup threw: ${err.message}`);
    return false;
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body     = req.body || {};
  const { secret, pi_id, dry_run = false } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!pi_id || typeof pi_id !== "string" || !pi_id.startsWith("pi_")) {
    return res.status(400).json({ error: "pi_id must be a valid Stripe PaymentIntent ID (starts with 'pi_')." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured." });
  }

  console.log(`stripe-replay: request to replay PI ${pi_id}${dry_run ? " [DRY RUN]" : ""}`);

  try {
    // ── Step 1: Fetch the PaymentIntent from Stripe ───────────────────────────
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(pi_id);
    } catch (stripeErr) {
      console.error(`stripe-replay: Stripe retrieve failed for ${pi_id}:`, stripeErr.message);
      return res.status(404).json({
        pi_id,
        status: "error",
        reason: `Stripe retrieve failed: ${stripeErr.message}`,
      });
    }

    const meta        = pi.metadata || {};
    const paymentType = meta.payment_type || "";
    const vehicleId   = meta.vehicle_id   || "";
    const pickupDate  = meta.pickup_date  || "";
    const returnDate  = meta.return_date  || "";

    console.log(
      `stripe-replay: PI ${pi_id}` +
      ` status=${pi.status}` +
      ` payment_type=${paymentType || "unspecified"}` +
      ` vehicle_id=${vehicleId || "<missing>"}` +
      ` pickup_date=${pickupDate || "<missing>"}` +
      ` return_date=${returnDate || "<missing>"}` +
      ` amount_received=${pi.amount_received}`
    );

    // ── Step 2: Validate the PaymentIntent ────────────────────────────────────
    if (pi.status !== "succeeded" || !pi.amount_received) {
      return res.status(422).json({
        pi_id,
        status: "error",
        reason: `PaymentIntent is not in succeeded state (status=${pi.status}, amount_received=${pi.amount_received || 0}).`,
      });
    }

    // Reject payment types handled by specialised webhook branches — replaying
    // them through the generic path would create a phantom duplicate booking.
    if (REJECT_PAYMENT_TYPES.has(paymentType)) {
      return res.status(422).json({
        pi_id,
        payment_type: paymentType,
        status:       "error",
        reason:       `payment_type=${paymentType} is handled by a specialised webhook branch (mutates an existing booking). Do not replay as a new booking.`,
      });
    }

    // Require complete booking metadata.
    if (!vehicleId || !pickupDate || !returnDate) {
      return res.status(422).json({
        pi_id,
        payment_type: paymentType,
        status:       "error",
        reason:       `Incomplete metadata — vehicle_id=${vehicleId || "<missing>"} pickup_date=${pickupDate || "<missing>"} return_date=${returnDate || "<missing>"}. Cannot create booking without all three.`,
      });
    }

    // ── Step 3: Idempotency check ─────────────────────────────────────────────
    const alreadyRecorded = await isAlreadyRecorded(sb, pi_id);
    if (alreadyRecorded) {
      console.log(`stripe-replay: PI ${pi_id} already in revenue_records — skipping`);
      return res.status(200).json({
        pi_id,
        payment_type: paymentType,
        vehicle_id:   vehicleId,
        status:       "already_processed",
        reason:       "payment_intent_id already exists in revenue_records — no writes performed.",
      });
    }

    // ── Step 4: Dry run — report what would happen without writing ────────────
    if (dry_run) {
      console.log(`stripe-replay: dry_run — would replay PI ${pi_id} (${paymentType} / ${vehicleId})`);
      return res.status(200).json({
        pi_id,
        payment_type:   paymentType,
        vehicle_id:     vehicleId,
        pickup_date:    pickupDate,
        return_date:    returnDate,
        amount_received: pi.amount_received,
        status:         "would_process",
        steps:          {
          saveWebhookBookingRecord:        "would_run",
          blockBookedDates:                "would_run",
          markVehicleUnavailable:          "would_run",
          sendWebhookNotificationEmails:   "would_run",
        },
      });
    }

    // ── Step 5: Run the full webhook generic pipeline ─────────────────────────
    // This is byte-for-byte identical to the code in stripe-webhook.js at the
    // end of the payment_intent.succeeded handler (the generic / full_payment branch).
    const steps = {};

    // 5a. Persist booking + revenue record (idempotent via upsert semantics).
    console.log(`stripe-replay: step 1 — saveWebhookBookingRecord for PI ${pi_id}`);
    try {
      await saveWebhookBookingRecord(pi);
      steps.saveWebhookBookingRecord = "ok";
      console.log(`stripe-replay: step 1 succeeded`);
    } catch (bookingErr) {
      steps.saveWebhookBookingRecord = `error: ${bookingErr.message}`;
      console.error(`stripe-replay: step 1 saveWebhookBookingRecord error:`, bookingErr);
      // Non-fatal — continue to remaining steps so dates/emails still fire.
    }

    // 5b. Block the booked dates in booked-dates.json.
    console.log(`stripe-replay: step 2 — blockBookedDates ${vehicleId} ${pickupDate}→${returnDate}`);
    try {
      await blockBookedDates(vehicleId, pickupDate, returnDate);
      steps.blockBookedDates = "ok";
      console.log(`stripe-replay: step 2 succeeded`);
    } catch (datesErr) {
      steps.blockBookedDates = `error: ${datesErr.message}`;
      console.error(`stripe-replay: step 2 blockBookedDates error:`, datesErr.message);
    }

    // 5c. Mark vehicle unavailable in fleet-status.json.
    console.log(`stripe-replay: step 3 — markVehicleUnavailable ${vehicleId}`);
    try {
      await markVehicleUnavailable(vehicleId);
      steps.markVehicleUnavailable = "ok";
      console.log(`stripe-replay: step 3 succeeded`);
    } catch (fleetErr) {
      steps.markVehicleUnavailable = `error: ${fleetErr.message}`;
      console.error(`stripe-replay: step 3 markVehicleUnavailable error:`, fleetErr.message);
    }

    // 5d. Send owner + customer notification emails.
    console.log(`stripe-replay: step 4 — sendWebhookNotificationEmails for PI ${pi_id}`);
    try {
      await sendWebhookNotificationEmails(pi);
      steps.sendWebhookNotificationEmails = "ok";
      console.log(`stripe-replay: step 4 succeeded`);
    } catch (emailErr) {
      steps.sendWebhookNotificationEmails = `error: ${emailErr.message}`;
      console.error(`stripe-replay: step 4 sendWebhookNotificationEmails error:`, emailErr.message);
    }

    const allOk = Object.values(steps).every((v) => v === "ok");
    console.log(
      `stripe-replay: done — PI ${pi_id} ${allOk ? "fully processed" : "processed with some step errors"}`
    );

    return res.status(200).json({
      pi_id,
      payment_type: paymentType,
      vehicle_id:   vehicleId,
      status:       "processed",
      steps,
    });

  } catch (err) {
    console.error(`stripe-replay: fatal error for PI ${pi_id}:`, err.message);
    return res.status(500).json({
      pi_id,
      status: "error",
      reason: `Fatal error: ${err.message}`,
    });
  }
}
