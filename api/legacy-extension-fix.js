// api/legacy-extension-fix.js
// Backfill endpoint for rental_extension PaymentIntents created before the
// booking_id metadata fix.
//
// Targets only Stripe PaymentIntents where ALL three conditions are true:
//   metadata.payment_type = "rental_extension"
//   metadata.booking_id is absent / empty
//   metadata.original_booking_id is present
//
// For each matched PI this script:
//   1. Resolves bookingRef = metadata.original_booking_id
//   2. Skips if a revenue record already exists for that payment_intent_id
//   3. Resolves Stripe fee / net from the expanded balance_transaction
//   4. Inserts an extension revenue record via autoCreateRevenueRecord
//   5. Logs [LEGACY_EXTENSION_FIXED] { payment_intent_id, booking_ref }
//
// Does NOT touch: webhook logic, SMS logic, availability / blocked-dates system.
//
// POST /api/legacy-extension-fix
// Body: {
//   secret:          string,   // ADMIN_SECRET (required)
//   dry_run?:        boolean,  // default false — safe preview without writes
//   created_after?:  number,   // Unix timestamp — only fetch PIs created after this
//   created_before?: number,   // Unix timestamp — only fetch PIs created before this
// }
//
// Response: {
//   dry_run:  boolean,
//   total:    number,   // total succeeded PIs in the date range
//   legacy:   number,   // legacy extension PIs found
//   skipped:  number,   // already in revenue_records
//   fixed:    number,   // revenue records created (dry_run: would have been)
//   errors:   number,   // failures
//   details:  Array<{ pi, booking_ref, vehicle_id, amount?, status, reason? }>
// }

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import { autoCreateRevenueRecord } from "./_booking-automation.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/**
 * Fetch all succeeded PaymentIntents from Stripe within an optional date range.
 * Expands latest_charge.balance_transaction so fee data is available inline,
 * avoiding extra per-PI round-trips at reconcile time.
 */
async function fetchSucceededPaymentIntents(stripe, { createdAfter, createdBefore } = {}) {
  const results = [];
  let startingAfter = undefined;

  for (;;) {
    const params = {
      limit:  100,
      expand: ["data.latest_charge.balance_transaction"],
    };
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

  return results.filter((pi) => pi.status === "succeeded" && pi.amount_received > 0);
}

/**
 * Returns true if this PaymentIntent is a legacy extension PI:
 *   - payment_type = "rental_extension"
 *   - booking_id is absent / empty  (pre-fix metadata)
 *   - original_booking_id is present (the canonical booking reference)
 */
function isLegacyExtensionPI(pi) {
  const meta = pi.metadata || {};
  return (
    meta.payment_type === "rental_extension" &&
    !meta.booking_id &&
    !!meta.original_booking_id
  );
}

/**
 * Extract stripe_fee and stripe_net from an already-expanded PaymentIntent.
 * Returns { stripeFee, stripeNet } on success, or throws on missing data.
 */
function extractFeeFields(pi) {
  const charge = pi.latest_charge;
  const bt = charge && typeof charge === "object" ? charge.balance_transaction : null;
  if (!bt || typeof bt !== "object") {
    throw new Error(`missing latest_charge.balance_transaction for PI ${pi.id}`);
  }
  const rawFee = bt.fee != null ? Number(bt.fee) / 100 : null;
  const rawNet = bt.net != null ? Number(bt.net) / 100 : null;
  if (!Number.isFinite(rawFee) || rawFee < 0) {
    throw new Error(`invalid stripe fee for PI ${pi.id}: ${bt.fee}`);
  }
  return {
    stripeFee: Math.round(rawFee * 100) / 100,
    stripeNet: Number.isFinite(rawNet) ? Math.round(rawNet * 100) / 100 : null,
  };
}

/**
 * Resolve a Supabase customer id from email or phone.
 * Non-fatal — returns null when not found or on error.
 */
async function resolveCustomerId(sb, { email, phone } = {}) {
  try {
    if (email && email.trim()) {
      const { data } = await sb
        .from("customers")
        .select("id")
        .eq("email", email.trim().toLowerCase())
        .maybeSingle();
      if (data?.id) return data.id;
    }
    if (phone && phone.trim()) {
      const { data } = await sb
        .from("customers")
        .select("id")
        .eq("phone", phone.trim())
        .maybeSingle();
      if (data?.id) return data.id;
    }
  } catch {
    // Non-fatal — extension revenue record created without customer_id.
  }
  return null;
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
  if (!sb) return res.status(503).json({ error: "Supabase is not configured." });

  if (created_after !== undefined && typeof created_after !== "number") {
    return res.status(400).json({ error: "created_after must be a Unix timestamp (number)." });
  }
  if (created_before !== undefined && typeof created_before !== "number") {
    return res.status(400).json({ error: "created_before must be a Unix timestamp (number)." });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // ── Step 1: Fetch all succeeded PIs (with fee data expanded) ─────────────
    console.log(
      `legacy-extension-fix: fetching PIs` +
      (created_after  ? ` after=${created_after}`  : "") +
      (created_before ? ` before=${created_before}` : "") +
      (dry_run ? " [DRY RUN]" : "")
    );

    const allPIs = await fetchSucceededPaymentIntents(stripe, {
      createdAfter:  created_after,
      createdBefore: created_before,
    });

    // ── Step 2: Filter to legacy extension PIs ────────────────────────────────
    const legacyPIs = allPIs.filter(isLegacyExtensionPI);

    console.log(
      `legacy-extension-fix: ${allPIs.length} total succeeded PI(s), ` +
      `${legacyPIs.length} legacy extension PI(s) identified`
    );

    if (legacyPIs.length === 0) {
      return res.status(200).json({
        dry_run,
        total:   allPIs.length,
        legacy:  0,
        skipped: 0,
        fixed:   0,
        errors:  0,
        details: [],
        message: "No legacy extension PaymentIntents found.",
      });
    }

    // ── Step 3: Bulk-check which PIs already have revenue records ─────────────
    const piIds = legacyPIs.map((pi) => pi.id);
    const { data: existingRows, error: existingErr } = await sb
      .from("revenue_records")
      .select("payment_intent_id")
      .in("payment_intent_id", piIds);

    if (existingErr) {
      return res.status(500).json({ error: `revenue_records lookup failed: ${existingErr.message}` });
    }

    const existingPiIds = new Set(
      (existingRows || []).map((r) => r.payment_intent_id).filter(Boolean)
    );

    // ── Step 4: Process each legacy PI ───────────────────────────────────────
    const details = [];
    let skipped = 0;
    let fixed   = 0;
    let errors  = 0;

    for (const pi of legacyPIs) {
      const meta       = pi.metadata || {};
      const bookingRef = meta.original_booking_id;
      const vehicleId  = meta.vehicle_id || null;
      const amountPaid = pi.amount_received / 100;

      console.log(
        `legacy-extension-fix: PI ${pi.id}` +
        ` booking_ref=${bookingRef}` +
        ` vehicle_id=${vehicleId || "<missing>"}` +
        ` amount=${amountPaid}`
      );

      // Already recorded — nothing to do.
      if (existingPiIds.has(pi.id)) {
        console.log(`legacy-extension-fix: PI ${pi.id} already in revenue_records — skipping`);
        details.push({
          pi:          pi.id,
          booking_ref: bookingRef,
          vehicle_id:  vehicleId,
          status:      "skipped",
          reason:      "already in revenue_records",
        });
        skipped++;
        continue;
      }

      // Dry-run: report what would happen without writing anything.
      if (dry_run) {
        details.push({
          pi:          pi.id,
          booking_ref: bookingRef,
          vehicle_id:  vehicleId,
          amount:      amountPaid,
          status:      "would_fix",
        });
        fixed++;
        continue;
      }

      // Extract Stripe fee / net from the expanded PI.
      // If the balance_transaction is unavailable (edge case), continue without
      // fee data — stripe-reconcile.js will backfill it on the next run.
      let feeFields = { stripeFee: null, stripeNet: null };
      try {
        feeFields = extractFeeFields(pi);
      } catch (feeErr) {
        console.warn(
          `legacy-extension-fix: fee extraction warning for PI ${pi.id} (non-fatal): ${feeErr.message}`
        );
      }

      // Resolve customer id (non-fatal — revenue record created without it on failure).
      const customerId = await resolveCustomerId(sb, {
        email: meta.renter_email || pi.receipt_email || "",
        phone: meta.renter_phone || "",
      });

      try {
        await autoCreateRevenueRecord({
          bookingId:       bookingRef,
          paymentIntentId: pi.id,
          vehicleId,
          customerId,
          name:            meta.renter_name  || "",
          phone:           meta.renter_phone || "",
          email:           meta.renter_email || pi.receipt_email || "",
          pickupDate:      null,                       // not present in extension metadata
          returnDate:      meta.new_return_date || null,
          amountPaid,
          paymentMethod:   "stripe",
          type:            "extension",
          stripeFee:       feeFields.stripeFee,
          stripeNet:       feeFields.stripeNet,
        }, {
          strict:           true,
          requireStripeFee: false, // fees may be missing; reconcile will fill them in
        });

        console.log("[LEGACY_EXTENSION_FIXED]", {
          payment_intent_id: pi.id,
          booking_ref:       bookingRef,
        });

        details.push({
          pi:          pi.id,
          booking_ref: bookingRef,
          vehicle_id:  vehicleId,
          amount:      amountPaid,
          status:      "fixed",
        });
        fixed++;
      } catch (createErr) {
        console.error(
          `legacy-extension-fix: failed to create revenue record for PI ${pi.id}:`,
          createErr.message
        );
        details.push({
          pi:          pi.id,
          booking_ref: bookingRef,
          vehicle_id:  vehicleId,
          status:      "error",
          reason:      createErr.message,
        });
        errors++;
      }
    }

    console.log(
      `legacy-extension-fix: done — legacy=${legacyPIs.length} ` +
      `skipped=${skipped} fixed=${fixed} errors=${errors}` +
      (dry_run ? " [DRY RUN]" : "")
    );

    return res.status(200).json({
      dry_run,
      total:   allPIs.length,
      legacy:  legacyPIs.length,
      skipped,
      fixed,
      errors,
      details,
    });
  } catch (err) {
    console.error("legacy-extension-fix: fatal error:", err.message);
    return res.status(500).json({ error: `Legacy extension fix failed: ${err.message}` });
  }
}
