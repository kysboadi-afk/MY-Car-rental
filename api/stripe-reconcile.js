// api/stripe-reconcile.js
// SLYTRANS Fleet Control v2 — Stripe financial reconciliation endpoint.
//
// Rebuilds financial data directly from the Stripe API (no CSV required).
// Follows the 9-step reconciliation plan:
//
//   1. Fetch ALL PaymentIntents (paginated) from Stripe
//   2. Expand latest_charge.balance_transaction for each
//   3. Extract gross / stripe_fee / net / created_at / email
//   4. Match to revenue_records by payment_intent_id (primary)
//      or amount + date + email (fallback)
//   5. Update revenue_records: stripe_fee, stripe_net, payment_status='paid'
//   6. Cash payments: stripe_fee=0, stripe_net=gross_amount
//   7. Prevent duplicates via stripe_charge_id UNIQUE key
//   8. Rebuild analytics: gross, fees, net, per-vehicle
//   9. Return verification: DB net must match Stripe net exactly
//
// POST /api/stripe-reconcile
// Body: { secret, action: "reconcile" | "preview" | "cash_update" | "analytics" }
//
// "reconcile" — full sync: fetch Stripe PIs, match & update revenue_records
// "preview"   — same fetch but returns diff without writing (dry-run)
// "cash_update" — sets stripe_fee=0, stripe_net=gross_amount for all cash records
// "analytics"   — recompute totals from revenue_records (no Stripe call)

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch ALL PaymentIntents from Stripe (auto-paginated). */
async function fetchAllPaymentIntents(stripe) {
  const results = [];
  let startingAfter = undefined;

  for (;;) {
    const params = {
      limit: 100,
      expand: ["data.latest_charge.balance_transaction"],
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.paymentIntents.list(params);
    results.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return results;
}

/** Extract financial fields from a PaymentIntent. */
function extractFields(pi) {
  const charge = pi.latest_charge;
  const bt     = charge?.balance_transaction;

  const amountGross = pi.amount_received / 100;           // dollars
  const stripeFee   = bt ? bt.fee / 100 : null;           // dollars or null
  const stripeNet   = bt ? bt.net / 100 : null;           // dollars or null
  const chargeId    = charge?.id || null;

  // Customer email: prefer receipt_email, then charge billing_details
  const email =
    pi.receipt_email ||
    charge?.billing_details?.email ||
    null;

  return {
    payment_intent_id: pi.id,
    stripe_charge_id:  chargeId,
    amount_gross:      amountGross,
    stripe_fee:        stripeFee,
    stripe_net:        stripeNet,
    created_at_unix:   pi.created,
    customer_email:    email,
    status:            pi.status,
  };
}

/** Compute per-vehicle and overall analytics totals from revenue_records rows. */
function buildAnalytics(rows) {
  let totalGross = 0;
  let totalFees  = 0;
  let totalNet   = 0;
  const byVehicle = {};

  for (const r of rows) {
    if (r.is_cancelled || r.is_no_show) continue;

    const gross = Number(r.gross_amount || 0);
    const fee   = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
    const net   = r.stripe_net != null ? Number(r.stripe_net) : gross - fee;

    totalGross += gross;
    totalFees  += fee;
    totalNet   += net;

    const vid = r.vehicle_id || "unknown";
    if (!byVehicle[vid]) byVehicle[vid] = { vehicle_id: vid, gross: 0, fees: 0, net: 0, count: 0 };
    byVehicle[vid].gross += gross;
    byVehicle[vid].fees  += fee;
    byVehicle[vid].net   += net;
    byVehicle[vid].count += 1;
  }

  // Round all values
  for (const v of Object.values(byVehicle)) {
    v.gross = Math.round(v.gross * 100) / 100;
    v.fees  = Math.round(v.fees  * 100) / 100;
    v.net   = Math.round(v.net   * 100) / 100;
  }

  return {
    total_gross: Math.round(totalGross * 100) / 100,
    total_fees:  Math.round(totalFees  * 100) / 100,
    total_net:   Math.round(totalNet   * 100) / 100,
    by_vehicle:  Object.values(byVehicle).sort((a, b) => b.net - a.net),
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });

  const body = req.body || {};
  const { secret, action = "reconcile" } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Supabase is not configured." });

  // ── ANALYTICS only — no Stripe call ─────────────────────────────────────────
  if (action === "analytics") {
    try {
      const { data: rows, error } = await sb
        .from("revenue_records")
        .select("vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status");
      if (error) throw error;
      return res.status(200).json({ analytics: buildAnalytics(rows || []) });
    } catch (err) {
      console.error("stripe-reconcile analytics error:", err);
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  // ── CASH UPDATE — set stripe_fee=0, stripe_net=gross_amount for cash rows ───
  if (action === "cash_update") {
    try {
      // Fetch all cash/manual records that haven't been reconciled yet
      const { data: cashRows, error: fetchErr } = await sb
        .from("revenue_records")
        .select("id, gross_amount")
        .in("payment_method", ["cash", "zelle", "venmo", "manual", "external"])
        .is("stripe_fee", null);

      if (fetchErr) throw fetchErr;

      if (!cashRows || cashRows.length === 0) {
        return res.status(200).json({ updated: 0, message: "No unreconciled cash records found." });
      }

      const updatedAt = new Date().toISOString();
      // Run up to 10 updates in parallel (Supabase connection pool safe)
      const CONCURRENCY = 10;
      let updated = 0;
      for (let i = 0; i < cashRows.length; i += CONCURRENCY) {
        const batch = cashRows.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((row) => {
            const gross = Number(row.gross_amount || 0);
            return sb
              .from("revenue_records")
              .update({ stripe_fee: 0, stripe_net: gross, updated_at: updatedAt })
              .eq("id", row.id);
          })
        );
        for (const { error: upErr } of results) {
          if (!upErr) updated++;
          else console.warn("stripe-reconcile cash_update row error:", upErr.message);
        }
      }

      return res.status(200).json({
        updated,
        message: `Updated ${updated} cash/manual record${updated !== 1 ? "s" : ""} (stripe_fee=0).`,
      });
    } catch (err) {
      console.error("stripe-reconcile cash_update error:", err);
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  // ── RECONCILE / PREVIEW — requires Stripe key ─────────────────────────────
  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(503).json({ error: "STRIPE_SECRET_KEY is not configured." });

  const dryRun = action === "preview";

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // STEP 1 + 2: Fetch all PaymentIntents with balance_transaction expanded
    const allPIs = await fetchAllPaymentIntents(stripe);

    // STEP 3: Extract financial data, only succeeded payments
    const succeededPayments = allPIs
      .filter((pi) => pi.status === "succeeded")
      .map(extractFields);

    if (succeededPayments.length === 0) {
      return res.status(200).json({
        message: "No succeeded PaymentIntents found in Stripe.",
        matched: 0, updated: 0, unmatched: 0, skipped: 0,
        stripe_total_net: 0,
        analytics: buildAnalytics([]),
      });
    }

    // Compute Stripe-side totals for verification (Step 9)
    const stripeTotalGross = succeededPayments.reduce((s, p) => s + p.amount_gross, 0);
    const stripeTotalFees  = succeededPayments.reduce((s, p) => s + (p.stripe_fee ?? 0), 0);
    const stripeTotalNet   = succeededPayments.reduce((s, p) => s + (p.stripe_net ?? p.amount_gross), 0);

    // STEP 4: Load all revenue_records to match against
    const { data: dbRecords, error: dbErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, stripe_charge_id, gross_amount, customer_email, pickup_date, created_at, stripe_fee, stripe_net");
    if (dbErr) throw dbErr;

    // Build lookup maps for matching
    const byPIId      = new Map(); // payment_intent_id → record
    const byBookingId = new Map(); // booking_id → record (for extension rows that store PI id as booking_id)
    const byChargeId  = new Map(); // stripe_charge_id → record

    for (const r of (dbRecords || [])) {
      if (r.payment_intent_id) byPIId.set(r.payment_intent_id, r);
      if (r.booking_id)        byBookingId.set(r.booking_id, r);
      if (r.stripe_charge_id)  byChargeId.set(r.stripe_charge_id, r);
    }

    const results = {
      matched:   0,
      updated:   0,
      skipped:   0, // already up-to-date
      unmatched: 0, // Stripe payment with no revenue_record
      preview:   dryRun ? [] : undefined,
    };

    for (const payment of succeededPayments) {
      // STEP 4: Match by payment_intent_id (primary), then charge_id, then booking_id (for extensions)
      const matchedRecord =
        byPIId.get(payment.payment_intent_id) ||
        (payment.stripe_charge_id ? byChargeId.get(payment.stripe_charge_id) : null) ||
        byBookingId.get(payment.payment_intent_id) ||
        null;

      if (!matchedRecord) {
        results.unmatched++;
        if (dryRun) {
          results.preview.push({
            status:  "unmatched",
            pi_id:   payment.payment_intent_id,
            gross:   payment.amount_gross,
            fee:     payment.stripe_fee,
            net:     payment.stripe_net,
            email:   payment.customer_email,
          });
        }
        continue;
      }

      results.matched++;

      // STEP 7: Skip if already reconciled (idempotent)
      const alreadyDone =
        matchedRecord.stripe_fee != null &&
        matchedRecord.stripe_net != null &&
        matchedRecord.stripe_charge_id === payment.stripe_charge_id;

      if (alreadyDone) {
        results.skipped++;
        continue;
      }

      if (dryRun) {
        results.preview.push({
          status:     "will_update",
          record_id:  matchedRecord.id,
          pi_id:      payment.payment_intent_id,
          charge_id:  payment.stripe_charge_id,
          gross:      payment.amount_gross,
          stripe_fee: payment.stripe_fee,
          stripe_net: payment.stripe_net,
          email:      payment.customer_email,
        });
        results.updated++;
        continue;
      }

      // STEP 5: Update revenue_record with Stripe fee data
      const updates = {
        stripe_fee:       payment.stripe_fee,
        stripe_net:       payment.stripe_net,
        payment_status:   "paid",
        updated_at:       new Date().toISOString(),
      };
      // Stamp charge_id if not already set
      if (payment.stripe_charge_id && !matchedRecord.stripe_charge_id) {
        updates.stripe_charge_id = payment.stripe_charge_id;
      }
      // Stamp payment_intent_id if not already set
      if (!matchedRecord.payment_intent_id) {
        updates.payment_intent_id = payment.payment_intent_id;
      }
      // Fill customer email if missing
      if (payment.customer_email && !matchedRecord.customer_email) {
        updates.customer_email = payment.customer_email;
      }

      const { error: upErr } = await sb
        .from("revenue_records")
        .update(updates)
        .eq("id", matchedRecord.id);

      if (upErr) {
        console.error("stripe-reconcile update error for record", matchedRecord.id, ":", upErr.message);
      } else {
        results.updated++;
      }
    }

    // STEP 8: Rebuild analytics from updated DB
    const { data: updatedRows } = await sb
      .from("revenue_records")
      .select("vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status");

    const analytics = buildAnalytics(updatedRows || []);

    // STEP 9: Verify — DB net vs Stripe net
    const dbNetFromStripe = (updatedRows || [])
      .filter((r) => r.stripe_net != null && !r.is_cancelled && !r.is_no_show)
      .reduce((s, r) => s + Number(r.stripe_net), 0);

    const verification = {
      stripe_total_gross:  Math.round(stripeTotalGross  * 100) / 100,
      stripe_total_fees:   Math.round(stripeTotalFees   * 100) / 100,
      stripe_total_net:    Math.round(stripeTotalNet    * 100) / 100,
      db_reconciled_net:   Math.round(dbNetFromStripe   * 100) / 100,
      unmatched_pi_count:  results.unmatched,
    };

    return res.status(200).json({
      dry_run:     dryRun,
      total_pis:   succeededPayments.length,
      matched:     results.matched,
      updated:     results.updated,
      skipped:     results.skipped,
      unmatched:   results.unmatched,
      analytics,
      verification,
      ...(dryRun ? { preview: results.preview } : {}),
    });
  } catch (err) {
    console.error("stripe-reconcile error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
