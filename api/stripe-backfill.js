// api/stripe-backfill.js
// SLYTRANS Fleet Control v2 — One-time Stripe payment backfill endpoint.
//
// Fetches historical Stripe PaymentIntents and routes each one through the
// centralised booking pipeline (persistBooking) so that any past Stripe payments
// that were never persisted as bookings (e.g. due to browser crashes before
// success.html completed, or pre-webhook deployments) are backfilled correctly.
//
// Routing follows the SAME rules as stripe-webhook.js — a PI is processed here
// if and only if the webhook would have created/persisted a new booking for it:
//
//   PROCESSED (creates/upserts booking via persistBooking):
//     - full_payment            — standard full rental payment
//     - reservation_deposit     — Camry deposit-only; booking saved as reserved_unpaid
//     - slingshot_security_deposit — Slingshot deposit-only; saved as reserved_unpaid
//     - unrecognised / missing payment_type with complete metadata (safe fallback)
//
//   SKIPPED (webhook mutates an existing booking, not a new one):
//     - rental_extension        — updates existing booking's return date; own revenue row
//     - balance_payment         — updates existing booking to booked_paid; no new booking
//     - slingshot_balance_payment — finalises existing slingshot booking; no new booking
//     - PIs without vehicle_id / pickup_date / return_date in metadata
//
// Other design principles:
//   • Uses payment_intent_id as the idempotency key — skips PIs already present
//     in revenue_records (via the existing autoCreateRevenueRecord dedup guard).
//   • Never inserts revenue without a booking — all writes go through persistBooking.
//   • Does NOT send emails, SMS, or fire any side-effects — backfill only.
//   • Supports dry_run mode — returns what would be processed without writing anything.
//
// POST /api/stripe-backfill
// Body: {
//   secret:        string,           // ADMIN_SECRET
//   dry_run?:      boolean,          // default false — set true for a safe preview
//   created_after?: number,          // Unix timestamp — only fetch PIs created after this
//   created_before?: number,         // Unix timestamp — only fetch PIs created before this
// }
//
// Response: {
//   dry_run:    boolean,
//   total:      number,   // total succeeded PIs in date range
//   skipped:    number,   // already in revenue_records or unsupported type
//   processed:  number,   // ran through persistBooking (dry_run: would have been)
//   errors:     number,   // pipeline failures
//   details:    Array<{ pi, vehicle_id, status, reason? }>
// }

import Stripe from "stripe";
import crypto from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { normalizePhone } from "./_bookings.js";
import { DEFAULT_LOCATION } from "./_sms-templates.js";
import { persistBooking } from "./_booking-pipeline.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Payment types that should NOT be backfilled as new bookings.
// These match the payment types handled by specialized branches in stripe-webhook.js
// that mutate an existing booking rather than creating a new one.
const SKIP_PAYMENT_TYPES = new Set([
  "rental_extension",           // updates existing booking's return date; own revenue row per extension
  "balance_payment",            // updates existing reserved_unpaid booking to booked_paid; no new booking
  "slingshot_balance_payment",  // finalises existing slingshot booking; no new booking
]);

// Payment types that represent deposit-only (partial) bookings where the renter
// still owes the balance. We backfill these so the booking record exists, but
// mark them reserved_unpaid so operators know the balance hasn't been paid.
const DEPOSIT_PAYMENT_TYPES = new Set([
  "reservation_deposit",
  "slingshot_security_deposit",
]);

/**
 * Fetch all succeeded PaymentIntents from Stripe within an optional date range.
 * Automatically paginates through all results.
 */
async function fetchSucceededPaymentIntents(stripe, { createdAfter, createdBefore } = {}) {
  const results = [];
  let startingAfter = undefined;

  for (;;) {
    const params = {
      limit: 100,
      // Only fetch intents that completed successfully
      // (amount_received > 0 filter happens client-side — Stripe doesn't support it here)
    };

    // Apply date filters when provided
    if (createdAfter !== undefined || createdBefore !== undefined) {
      params.created = {};
      if (createdAfter  !== undefined) params.created.gte = createdAfter;
      if (createdBefore !== undefined) params.created.lte = createdBefore;
    }

    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.paymentIntents.list(params);
    results.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  // Keep only succeeded intents with an amount received
  return results.filter((pi) => pi.status === "succeeded" && pi.amount_received > 0);
}

/**
 * Look up a set of payment_intent_ids that are already present in revenue_records.
 * Returns a Set of known pi IDs so we can skip them efficiently.
 */
async function fetchExistingPiIds(sb, piIds) {
  if (!piIds.length) return new Set();

  // Supabase .in() accepts up to 500 values safely; for a backfill this is fine.
  const { data, error } = await sb
    .from("revenue_records")
    .select("payment_intent_id")
    .in("payment_intent_id", piIds);

  if (error) throw new Error(`revenue_records lookup failed: ${error.message}`);
  return new Set((data || []).map((r) => r.payment_intent_id).filter(Boolean));
}

/**
 * Determine whether a PaymentIntent should be skipped and why.
 * Returns null when the PI should be processed, or a reason string when skipping.
 * Mirrors the routing decisions in stripe-webhook.js handler.
 */
function skipReason(pi) {
  const meta = pi.metadata || {};
  const paymentType = meta.payment_type || "";

  // Skip payment types that mutate an existing booking (webhook has specialized
  // handlers for these that update rather than create a booking record).
  if (SKIP_PAYMENT_TYPES.has(paymentType)) {
    return `payment_type=${paymentType} is handled by webhook specialized branch (not a new booking)`;
  }

  // Skip PIs with no booking-relevant metadata — cannot create a booking without these.
  if (!meta.vehicle_id)  return "no vehicle_id in metadata";
  if (!meta.pickup_date) return "no pickup_date in metadata";
  if (!meta.return_date) return "no return_date in metadata";

  return null; // should be processed
}

/**
 * Build persistBooking opts from a Stripe PaymentIntent.
 */
function buildPersistOpts(pi) {
  const meta = pi.metadata || {};
  const {
    booking_id,
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    email,
    payment_type,
    full_rental_amount,
    protection_plan_tier,
  } = meta;

  // amount_received is in cents (Stripe integer); divide by 100 to get dollars.
  const amountPaid = pi.amount_received ? pi.amount_received / 100 : 0;
  // full_rental_amount is stored as a dollar string in PI metadata (e.g. "300.00").
  // Round to 2 decimal places to avoid floating-point drift.
  const totalPrice = full_rental_amount
    ? Math.round(parseFloat(full_rental_amount) * 100) / 100
    : amountPaid;

  // Determine booking status — deposits leave the booking in reserved_unpaid
  const status = DEPOSIT_PAYMENT_TYPES.has(payment_type)
    ? "reserved_unpaid"
    : "booked_paid";

  return {
    bookingId:             booking_id || ("backfill-" + crypto.randomBytes(8).toString("hex")),
    name:                  renter_name  || "",
    phone:                 renter_phone ? normalizePhone(renter_phone) : "",
    email:                 email        || pi.receipt_email || "",
    vehicleId:             vehicle_id,
    vehicleName:           vehicle_name || vehicle_id,
    pickupDate:            pickup_date,
    pickupTime:            pickup_time  || "",
    returnDate:            return_date,
    returnTime:            return_time  || "",
    location:              DEFAULT_LOCATION,
    status,
    amountPaid,
    totalPrice,
    paymentIntentId:       pi.id,
    paymentMethod:         "stripe",
    source:                "stripe_backfill",
    stripeCustomerId:      pi.customer        || null,
    stripePaymentMethodId: pi.payment_method  || null,
    ...(protection_plan_tier ? { protectionPlanTier: protection_plan_tier } : {}),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

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

  const body = req.body || {};
  const { secret, dry_run = false, created_after, created_before } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured." });
  }

  // Validate optional date range parameters
  if (created_after !== undefined && typeof created_after !== "number") {
    return res.status(400).json({ error: "created_after must be a Unix timestamp (number)." });
  }
  if (created_before !== undefined && typeof created_before !== "number") {
    return res.status(400).json({ error: "created_before must be a Unix timestamp (number)." });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // ── Step 1: Fetch all succeeded PaymentIntents ────────────────────────────
    console.log(
      `stripe-backfill: fetching succeeded PIs` +
      (created_after  ? ` after=${created_after}`  : "") +
      (created_before ? ` before=${created_before}` : "") +
      (dry_run ? " [DRY RUN]" : "")
    );

    const paymentIntents = await fetchSucceededPaymentIntents(stripe, {
      createdAfter:  created_after,
      createdBefore: created_before,
    });

    console.log(`stripe-backfill: found ${paymentIntents.length} succeeded PI(s)`);

    if (paymentIntents.length === 0) {
      return res.status(200).json({
        dry_run,
        total:     0,
        skipped:   0,
        processed: 0,
        errors:    0,
        details:   [],
        message:   "No succeeded PaymentIntents found in the specified date range.",
      });
    }

    // ── Step 2: Bulk-check which PI ids are already in revenue_records ────────
    const allPiIds = paymentIntents.map((pi) => pi.id);
    const existingPiIds = await fetchExistingPiIds(sb, allPiIds);
    console.log(`stripe-backfill: ${existingPiIds.size} PI(s) already in revenue_records — will skip`);

    // ── Step 3: Process each PaymentIntent ───────────────────────────────────
    const details = [];
    let skipped   = 0;
    let processed = 0;
    let errors    = 0;

    for (const pi of paymentIntents) {
      const paymentType = (pi.metadata || {}).payment_type || "";
      const vehicleId   = (pi.metadata || {}).vehicle_id   || "<missing>";
      const bookingId   = (pi.metadata || {}).booking_id   || "<missing>";

      // Log every PI received — mirrors webhook's logPaymentIntentReceived.
      console.log(
        `stripe-backfill: processing PI ${pi.id}` +
        ` payment_type=${paymentType || "unspecified"}` +
        ` vehicle_id=${vehicleId}` +
        ` booking_id=${bookingId}` +
        ` amount=${pi.amount_received}`
      );

      // Skip if already recorded
      if (existingPiIds.has(pi.id)) {
        console.log(`stripe-backfill: skipping PI ${pi.id} — already in revenue_records`);
        details.push({ pi: pi.id, payment_type: paymentType, status: "skipped", reason: "already in revenue_records" });
        skipped++;
        continue;
      }

      // Skip unsupported payment types or missing metadata
      const reason = skipReason(pi);
      if (reason) {
        console.log(`stripe-backfill: skipping PI ${pi.id} — ${reason}`);
        details.push({ pi: pi.id, payment_type: paymentType, status: "skipped", reason });
        skipped++;
        continue;
      }

      const opts = buildPersistOpts(pi);

      // Dry run — record what would be done without writing
      if (dry_run) {
        details.push({
          pi:             pi.id,
          payment_type:   paymentType,
          vehicle_id:     opts.vehicleId,
          booking_id:     opts.bookingId,
          status:         "would_process",
          amount:         opts.amountPaid,
          pickup:         opts.pickupDate,
          return:         opts.returnDate,
          booking_status: opts.status,
        });
        processed++;
        continue;
      }

      // Live run — route through the full booking pipeline
      try {
        const result = await persistBooking(opts);

        if (result.ok) {
          details.push({
            pi:             pi.id,
            payment_type:   paymentType,
            vehicle_id:     opts.vehicleId,
            booking_id:     result.bookingId,
            status:         "processed",
            booking_status: opts.status,
          });
          processed++;
          console.log(`stripe-backfill: processed PI ${pi.id} → booking ${result.bookingId} (${opts.vehicleId})`);
        } else {
          details.push({
            pi:           pi.id,
            payment_type: paymentType,
            vehicle_id:   opts.vehicleId,
            status:       "error",
            reason:       result.errors.join("; "),
          });
          errors++;
          console.error(`stripe-backfill: pipeline failed for PI ${pi.id}: ${result.errors.join("; ")}`);
        }
      } catch (pipelineErr) {
        details.push({
          pi:           pi.id,
          payment_type: paymentType,
          status:       "error",
          reason:       pipelineErr.message,
        });
        errors++;
        console.error(`stripe-backfill: unexpected error for PI ${pi.id}: ${pipelineErr.message}`);
      }
    }

    console.log(
      `stripe-backfill: done — total=${paymentIntents.length} ` +
      `skipped=${skipped} processed=${processed} errors=${errors}` +
      (dry_run ? " [DRY RUN]" : "")
    );

    return res.status(200).json({
      dry_run,
      total:     paymentIntents.length,
      skipped,
      processed,
      errors,
      details,
    });
  } catch (err) {
    console.error("stripe-backfill: fatal error:", err.message);
    return res.status(500).json({ error: `Backfill failed: ${err.message}` });
  }
}
