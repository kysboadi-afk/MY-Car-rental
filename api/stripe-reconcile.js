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
import { loadBookings } from "./_bookings.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";

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

  // booking_id stored in Stripe metadata by create-payment-intent.js
  const metadataBookingId = pi.metadata?.booking_id || null;

  return {
    payment_intent_id:   pi.id,
    stripe_charge_id:    chargeId,
    amount_gross:        amountGross,
    stripe_fee:          stripeFee,
    stripe_net:          stripeNet,
    created_at_unix:     pi.created,
    customer_email:      email,
    status:              pi.status,
    metadata_booking_id: metadataBookingId,
  };
}

/**
 * Deduplicate revenue_records.
 *
 * Two duplicate scenarios are handled:
 *   A) Two records share the same non-null payment_intent_id — the "stripe-xxx"
 *      auto-created record is the loser; the original booking record is kept.
 *   B) A "stripe-xxx" auto-created record whose payment_intent_id maps back to a
 *      real booking (via bookingsByPI) that already has its own revenue_record —
 *      the auto-created record is the loser.
 *
 * In both cases the winner is updated with any stripe fee/charge data it is
 * missing, then the loser is soft-deleted (sync_excluded = true).
 *
 * @param {object} sb - Supabase admin client
 * @param {Map<string,object>} bookingsByPI - paymentIntentId → booking from loadBookings()
 * @returns {Promise<{merged: number}>}
 */
async function deduplicateRevenueRecords(sb, bookingsByPI) {
  const { data: records, error } = await sb
    .from("revenue_records")
    .select("id, booking_id, payment_intent_id, stripe_fee, stripe_net, stripe_charge_id, customer_email, vehicle_id, gross_amount")
    .eq("sync_excluded", false);

  if (error || !records?.length) return { merged: 0 };

  let merged = 0;
  const updatedAt = new Date().toISOString();
  const excludedIds = new Set();

  // ── Scenario A: same non-null payment_intent_id on multiple records ──────────
  const byPiId = {};
  for (const r of records) {
    if (!r.payment_intent_id) continue;
    if (!byPiId[r.payment_intent_id]) byPiId[r.payment_intent_id] = [];
    byPiId[r.payment_intent_id].push(r);
  }

  for (const group of Object.values(byPiId)) {
    if (group.length < 2) continue;

    // Prefer the record whose booking_id is NOT a "stripe-xxx" auto-created key
    // (it carries real booking context: customer name, vehicle, dates).
    const winner = group.find((r) => !r.booking_id?.startsWith("stripe-")) || group[0];
    const losers = group.filter((r) => r.id !== winner.id && !excludedIds.has(r.id));
    if (!losers.length) continue;

    // Collect stripe fields from whichever record has them
    const src = group.find((r) => r.stripe_fee != null && r.stripe_net != null) || group[0];
    const updates = { updated_at: updatedAt };
    if (winner.stripe_fee    == null && src.stripe_fee    != null) updates.stripe_fee    = src.stripe_fee;
    if (winner.stripe_net    == null && src.stripe_net    != null) updates.stripe_net    = src.stripe_net;
    if (!winner.stripe_charge_id    && src.stripe_charge_id)       updates.stripe_charge_id = src.stripe_charge_id;
    if (!winner.customer_email      && src.customer_email)         updates.customer_email   = src.customer_email;

    if (Object.keys(updates).length > 1) {
      await sb.from("revenue_records").update(updates).eq("id", winner.id);
    }
    for (const loser of losers) {
      await sb.from("revenue_records")
        .update({ sync_excluded: true, updated_at: updatedAt })
        .eq("id", loser.id);
      excludedIds.add(loser.id);
      merged++;
    }
  }

  // ── Scenario B: "stripe-xxx" record whose PI maps to an existing booking record ─
  // bookingsByPI maps paymentIntentId → booking object; each booking has .bookingId.
  const dbByBookingId = new Map(records.map((r) => [r.booking_id, r]));

  const stripeAutoRecords = records.filter(
    (r) => r.booking_id?.startsWith("stripe-") && r.payment_intent_id && !excludedIds.has(r.id)
  );

  for (const stripeRec of stripeAutoRecords) {
    const booking = bookingsByPI?.get(stripeRec.payment_intent_id);
    if (!booking?.bookingId) continue;

    const originalRec = dbByBookingId.get(booking.bookingId);
    if (!originalRec || excludedIds.has(originalRec.id)) continue;

    // Only merge when the amounts are the same (within 1 cent) to avoid false matches
    if (Math.abs(Number(originalRec.gross_amount) - Number(stripeRec.gross_amount)) > 0.01) continue;

    const updates = { payment_intent_id: stripeRec.payment_intent_id, updated_at: updatedAt };
    if (originalRec.stripe_fee    == null && stripeRec.stripe_fee    != null) updates.stripe_fee    = stripeRec.stripe_fee;
    if (originalRec.stripe_net    == null && stripeRec.stripe_net    != null) updates.stripe_net    = stripeRec.stripe_net;
    if (!originalRec.stripe_charge_id    && stripeRec.stripe_charge_id)       updates.stripe_charge_id = stripeRec.stripe_charge_id;
    if (!originalRec.customer_email      && stripeRec.customer_email)         updates.customer_email   = stripeRec.customer_email;

    await sb.from("revenue_records").update(updates).eq("id", originalRec.id);
    await sb.from("revenue_records")
      .update({ sync_excluded: true, updated_at: updatedAt })
      .eq("id", stripeRec.id);
    excludedIds.add(stripeRec.id);
    merged++;
  }

  return { merged };
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

  // ── CLEANUP ORPHANS — fix NULL/unknown vehicle_id by re-linking to bookings ──
  // Finds revenue records whose vehicle_id is NULL or the legacy string "unknown",
  // attempts to backfill vehicle_id from bookings.json via booking_id, and marks
  // any unresolvable records as sync_excluded so they are hidden from analytics.
  if (action === "cleanup_orphans") {
    try {
      // Fetch records with NULL or 'unknown' vehicle_id that are not already excluded
      const { data: orphans, error: fetchErr } = await sb
        .from("revenue_records")
        .select("id, booking_id, vehicle_id")
        .or("vehicle_id.is.null,vehicle_id.eq.unknown")
        .eq("sync_excluded", false);
      if (fetchErr) throw fetchErr;

      if (!orphans || orphans.length === 0) {
        return res.status(200).json({
          total: 0, linked: 0, excluded: 0,
          message: "No orphan records found — data is already clean.",
        });
      }

      // Collect only the booking_ids that are actually referenced by orphans
      // to avoid loading the entire bookings file unnecessarily.
      const neededIds = new Set(orphans.map((r) => r.booking_id).filter(Boolean));
      const bookingVehicleMap = {};
      if (neededIds.size > 0) {
        const { data: bookingsData } = await loadBookings();
        for (const list of Object.values(bookingsData)) {
          for (const b of (list || [])) {
            if (b.bookingId && neededIds.has(b.bookingId)) {
              bookingVehicleMap[b.bookingId] = b.vehicleId || null;
            }
          }
        }
      }

      // Split orphans into those that can be linked and true orphans
      const toLink    = []; // { id, vehicleId }
      const toExclude = []; // ids

      for (const r of orphans) {
        const vehicleId = r.booking_id ? (bookingVehicleMap[r.booking_id] || null) : null;
        if (vehicleId) {
          toLink.push({ id: r.id, vehicleId });
        } else {
          toExclude.push(r.id);
        }
      }

      const now = new Date().toISOString();

      // Batch: exclude unresolvable orphans in one query
      if (toExclude.length > 0) {
        const { error: exclErr } = await sb
          .from("revenue_records")
          .update({ sync_excluded: true, updated_at: now })
          .in("id", toExclude);
        if (exclErr) throw exclErr;
      }

      // Link: vehicle_id values may differ per record, so group by vehicleId and batch
      const byVehicle = {};
      for (const { id, vehicleId } of toLink) {
        if (!byVehicle[vehicleId]) byVehicle[vehicleId] = [];
        byVehicle[vehicleId].push(id);
      }
      for (const [vehicleId, ids] of Object.entries(byVehicle)) {
        const { error: linkErr } = await sb
          .from("revenue_records")
          .update({ vehicle_id: vehicleId, updated_at: now })
          .in("id", ids);
        if (linkErr) throw linkErr;
      }

      return res.status(200).json({
        total:    orphans.length,
        linked:   toLink.length,
        excluded: toExclude.length,
        message:  `Cleanup complete — linked ${toLink.length} record(s) to vehicles, excluded ${toExclude.length} unresolvable orphan(s).`,
      });
    } catch (err) {
      console.error("stripe-reconcile cleanup_orphans error:", err);
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  // ── DEDUP — merge duplicate revenue_records ──────────────────────────────────
  if (action === "dedup") {
    try {
      let bookingsByPI = new Map();
      try {
        const { data: bookingsData } = await loadBookings();
        for (const list of Object.values(bookingsData)) {
          for (const b of (list || [])) {
            if (b.paymentIntentId) bookingsByPI.set(b.paymentIntentId, b);
          }
        }
      } catch (_) { /* non-fatal */ }

      const result = await deduplicateRevenueRecords(sb, bookingsByPI);
      return res.status(200).json({
        merged:  result.merged,
        message: `Removed ${result.merged} duplicate revenue record${result.merged !== 1 ? "s" : ""}.`,
      });
    } catch (err) {
      console.error("stripe-reconcile dedup error:", err);
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  // ── ANALYTICS only — no Stripe call ─────────────────────────────────────────
  if (action === "analytics") {
    try {
      const { data: rows, error } = await sb
        .from("revenue_records")
        .select("vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status")
        .eq("sync_excluded", false);
      if (error) throw error;
      return res.status(200).json({ analytics: buildAnalytics(rows || []) });
    } catch (err) {
      if (isSchemaError(err)) {
        return res.status(503).json({ error: "Database schema is missing columns required for Stripe analytics. Please apply all Supabase migrations (run migration 0046 or use COMPLETE_SETUP.sql)." });
      }
      console.error("stripe-reconcile analytics error:", err);
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  // ── CASH UPDATE — set stripe_fee=0, stripe_net=gross_amount for cash rows ───
  if (action === "cash_update") {
    try {
      // Fetch all cash/manual records that haven't been reconciled yet (exclude soft-deleted)
      const { data: cashRows, error: fetchErr } = await sb
        .from("revenue_records")
        .select("id, gross_amount")
        .in("payment_method", ["cash", "zelle", "venmo", "manual", "external"])
        .is("stripe_fee", null)
        .eq("sync_excluded", false);

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
      if (isSchemaError(err)) {
        return res.status(503).json({ error: "Database schema is missing columns required for Stripe cash update. Please apply all Supabase migrations (run migration 0046 or use COMPLETE_SETUP.sql)." });
      }
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

    // STEP 4: Load all revenue_records to match against (exclude soft-deleted rows)
    const { data: dbRecords, error: dbErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, stripe_charge_id, gross_amount, customer_email, pickup_date, created_at, stripe_fee, stripe_net")
      .eq("sync_excluded", false);
    if (dbErr) throw dbErr;

    // Load bookings.json so we can populate revenue records for unmatched PIs
    // that carry a metadata booking_id linking them to a known booking.
    let bookingsByBookingId = new Map();
    let bookingsByPI       = new Map();
    try {
      const { data: bookingsData } = await loadBookings();
      for (const list of Object.values(bookingsData)) {
        for (const b of (list || [])) {
          if (b.bookingId)       bookingsByBookingId.set(b.bookingId,       b);
          if (b.paymentIntentId) bookingsByPI.set(b.paymentIntentId, b);
        }
      }
    } catch (_) {
      // Non-fatal — if bookings.json is unavailable we still create stub records.
    }

    // Build lookup maps for matching
    const byPIId      = new Map(); // payment_intent_id → record
    const byBookingId = new Map(); // booking_id → record (for extension rows that store PI id as booking_id)
    const byChargeId  = new Map(); // stripe_charge_id → record
    // Fallback: email (lowercase) + exact amount → record, for records lacking PI IDs.
    // Only index Stripe-method records to avoid accidentally matching cash rows.
    const byEmailAndAmount = new Map();

    for (const r of (dbRecords || [])) {
      if (r.payment_intent_id) byPIId.set(r.payment_intent_id, r);
      if (r.booking_id)        byBookingId.set(r.booking_id, r);
      if (r.stripe_charge_id)  byChargeId.set(r.stripe_charge_id, r);
      // Index ALL records with customer_email+amount for the email+amount fallback.
      // Records that already have a payment_intent_id are still preferred via byPIId
      // (matched first above), but if that PI ID lookup fails — e.g. the stored ID is
      // stale/wrong — the email+amount fallback will still find and update the record.
      // The matchedRecordIds set prevents the same record from being claimed twice.
      if (r.customer_email && r.gross_amount != null) {
        const key = `${r.customer_email.toLowerCase()}:${Number(r.gross_amount).toFixed(2)}`;
        if (!byEmailAndAmount.has(key)) byEmailAndAmount.set(key, r);
      }
    }

    // Track which DB record IDs have already been matched to prevent double-matching
    // when two Stripe PIs share the same email+amount (rare but possible).
    const matchedRecordIds = new Set();

    const results = {
      matched:   0,
      updated:   0,
      skipped:   0, // already up-to-date
      created:   0, // new revenue records auto-created from Stripe data
      unmatched: 0, // Stripe payment with no revenue_record (after auto-create attempt)
      preview:   dryRun ? [] : undefined,
    };

    for (const payment of succeededPayments) {
      // STEP 4: Match by payment_intent_id (primary), then charge_id,
      // then booking_id (for extensions where booking_id === PI ID),
      // then metadata.booking_id (stored by create-payment-intent.js —
      //   always a "bk-…" string, never a "pi_…" PI ID, so no key collision),
      // then email+amount (fallback for records created before PI IDs were stored).
      let matchedRecord =
        byPIId.get(payment.payment_intent_id) ||
        (payment.stripe_charge_id ? byChargeId.get(payment.stripe_charge_id) : null) ||
        byBookingId.get(payment.payment_intent_id) ||
        (payment.metadata_booking_id ? byBookingId.get(payment.metadata_booking_id) : null) ||
        null;

      // Email+amount fallback: only used when primary keys failed and the Stripe
      // payment has a customer email to match against.
      if (!matchedRecord && payment.customer_email) {
        const key = `${payment.customer_email.toLowerCase()}:${payment.amount_gross.toFixed(2)}`;
        const candidate = byEmailAndAmount.get(key);
        if (candidate && !matchedRecordIds.has(candidate.id)) {
          matchedRecord = candidate;
        }
      }

      if (!matchedRecord) {
        // AUTO-CREATE: build a new revenue_record from Stripe + booking data
        // so the payment appears in the Revenue Tracker without manual intervention.
        const booking =
          (payment.metadata_booking_id ? bookingsByBookingId.get(payment.metadata_booking_id) : null) ||
          bookingsByPI.get(payment.payment_intent_id) ||
          null;

        // Derive a stable, unique booking_id — prefer the one from metadata/bookings.
        const newBookingId =
          (booking?.bookingId) ||
          payment.metadata_booking_id ||
          ("stripe-" + payment.payment_intent_id);

        // Mark as orphan when booking_id is a synthetic "stripe-<pi>" key — no real
        // booking row was found in either bookings.json or Stripe metadata.
        // Real "bk-…" refs from metadata or bookings.json are left as is_orphan=false
        // so the DB trigger enforces they have a matching bookings row.
        const isOrphanAutoCreate = newBookingId.startsWith("stripe-");

        if (dryRun) {
          results.preview.push({
            status:     "will_create",
            pi_id:      payment.payment_intent_id,
            booking_id: newBookingId,
            gross:      payment.amount_gross,
            fee:        payment.stripe_fee,
            net:        payment.stripe_net,
            email:      payment.customer_email,
            is_orphan:  isOrphanAutoCreate,
          });
          results.created++;
          continue;
        }

        const paymentDate = new Date(payment.created_at_unix * 1000).toISOString().slice(0, 10);

        const newRecord = {
          booking_id:        newBookingId,
          vehicle_id:        booking?.vehicleId    || null,
          customer_name:     booking?.name         || null,
          customer_phone:    booking?.phone        || null,
          customer_email:    payment.customer_email || booking?.email || null,
          pickup_date:       booking?.pickupDate   || paymentDate,
          return_date:       booking?.returnDate   || null,
          gross_amount:      payment.amount_gross,
          deposit_amount:    0,
          refund_amount:     0,
          payment_method:    "stripe",
          payment_status:    "paid",
          payment_intent_id: payment.payment_intent_id,
          stripe_charge_id:  payment.stripe_charge_id || null,
          stripe_fee:        payment.stripe_fee,
          stripe_net:        payment.stripe_net,
          is_no_show:        false,
          is_cancelled:      false,
          override_by_admin: false,
          sync_excluded:     false,
          // Synthetic booking_id (no matching booking found) → flag as orphan so it
          // is excluded from financial reporting and passes the booking_ref integrity
          // trigger added by migration 0060.
          is_orphan:         isOrphanAutoCreate,
          created_at:        new Date().toISOString(),
          updated_at:        new Date().toISOString(),
        };

        const { error: insertErr } = await sb
          .from("revenue_records")
          .insert(newRecord);

        if (insertErr) {
          console.error("stripe-reconcile auto-create error for PI", payment.payment_intent_id, ":", insertErr.message);
          results.unmatched++;
        } else {
          results.created++;
        }
        continue;
      }

      // Mark this DB record as claimed so the fallback map can't re-use it
      matchedRecordIds.add(matchedRecord.id);
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
      .select("vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status")
      .eq("sync_excluded", false);

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

    // STEP 10: Auto-dedup — collapse any duplicate records created in prior runs
    // (e.g. "stripe-pi_xxx" auto-creates that overlap with booking-synced "bk-xxx" records).
    let deduped = 0;
    if (!dryRun) {
      try {
        const { merged } = await deduplicateRevenueRecords(sb, bookingsByPI);
        deduped = merged;
      } catch (dedupErr) {
        console.warn("stripe-reconcile: auto-dedup failed (non-fatal):", dedupErr.message);
      }
    }

    return res.status(200).json({
      dry_run:     dryRun,
      total_pis:   succeededPayments.length,
      matched:     results.matched,
      updated:     results.updated,
      skipped:     results.skipped,
      created:     results.created,
      unmatched:   results.unmatched,
      deduped,
      analytics,
      verification,
      ...(dryRun ? { preview: results.preview } : {}),
    });
  } catch (err) {
    if (isSchemaError(err)) {
      return res.status(503).json({ error: "Database schema is missing columns required for Stripe reconciliation. Please apply all Supabase migrations (run migration 0046 or use COMPLETE_SETUP.sql)." });
    }
    console.error("stripe-reconcile error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
