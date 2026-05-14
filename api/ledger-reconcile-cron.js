// api/ledger-reconcile-cron.js
// Phase 4.8 — Nightly reconciliation + anomaly detection.
//
// Intended to be called by Vercel Cron or a scheduled webhook.
// Authorization: Bearer <CRON_SECRET> header (same pattern as scheduled-reminders.js).
//
// GET or POST /api/ledger-reconcile-cron
//
// Runs the following anomaly checks and persists a snapshot:
//   1. Negative net balances     — ledger credit total exceeds debit total
//   2. Duplicate source IDs       — multiple ledger rows with the same (source_type, source_id)
//   3. Unusually large balances   — single booking net balance > LARGE_BALANCE_THRESHOLD
//   4. Ledger/revenue mismatches  — ledger payment credits differ from revenue_records.gross_amount (> $0.01 tolerance)
//   5. Orphaned Stripe events     — revenue_records or charges with a payment_intent_id that
//                                   has NO matching ledger row
//
// Output:
//   Persists a ledger_reconcile_snapshots row of run_type='nightly'.
//   Returns a JSON summary.

import { getSupabaseAdmin } from "./_supabase.js";
import { saveReconcileSnapshot } from "./ledger-reconcile-report.js";

const LARGE_BALANCE_THRESHOLD = 500; // USD — flag balances above this amount
const MATCH_TOLERANCE = 0.01;

export default async function handler(req, res) {
  // Auth: CRON_SECRET in Authorization header.
  const authHeader = req.headers.authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable." });
  }

  const startMs = Date.now();
  const anomalies = [];

  // ── 1. Negative net balances ──────────────────────────────────────────────────
  try {
    const { data: rows, error } = await sb
      .from("renter_balance_ledger_summary")
      .select("booking_id, customer_id, net_balance")
      .lt("net_balance", 0);
    if (error) throw new Error(error.message);
    for (const row of rows || []) {
      anomalies.push({
        type: "negative_balance",
        booking_id: row.booking_id,
        customer_id: row.customer_id || null,
        detail: `net_balance = ${row.net_balance}`,
        severity: "warning",
      });
    }
    if ((rows || []).length > 0) {
      console.warn(`[ledger-reconcile-cron] ${rows.length} negative balance(s) detected`);
    }
  } catch (err) {
    console.error("[ledger-reconcile-cron] negative balance check failed:", err.message);
  }

  // ── 2. Duplicate source IDs ───────────────────────────────────────────────────
  // The unique index prevents exact dupes on (source_type, source_id), but we
  // look for cases where the same stripe PI was booked under different source_types.
  try {
    const { data: rows, error } = await sb
      .from("renter_balance_ledger")
      .select("source_id, source_type, booking_id")
      .not("source_id", "is", null)
      .not("source_type", "is", null)
      .limit(10000);
    if (error) throw new Error(error.message);

    const seen = {};
    for (const row of rows || []) {
      const key = row.source_id;
      if (!seen[key]) seen[key] = [];
      seen[key].push({ source_type: row.source_type, booking_id: row.booking_id });
    }
    for (const [sourceId, entries] of Object.entries(seen)) {
      const types = [...new Set(entries.map((e) => e.source_type))];
      if (types.length > 1) {
        anomalies.push({
          type: "duplicate_source_id",
          source_id: sourceId,
          detail: `source_id appears under multiple source_types: ${types.join(", ")}`,
          severity: "error",
        });
      }
    }
  } catch (err) {
    console.error("[ledger-reconcile-cron] duplicate source ID check failed:", err.message);
  }

  // ── 3. Unusually large balances ───────────────────────────────────────────────
  try {
    const { data: rows, error } = await sb
      .from("renter_balance_ledger_summary")
      .select("booking_id, customer_id, net_balance")
      .gt("net_balance", LARGE_BALANCE_THRESHOLD);
    if (error) throw new Error(error.message);
    for (const row of rows || []) {
      anomalies.push({
        type: "large_balance",
        booking_id: row.booking_id,
        customer_id: row.customer_id || null,
        detail: `net_balance = ${row.net_balance} exceeds threshold $${LARGE_BALANCE_THRESHOLD}`,
        severity: "warning",
      });
    }
  } catch (err) {
    console.error("[ledger-reconcile-cron] large balance check failed:", err.message);
  }

  // ── 4. Ledger/revenue mismatches ──────────────────────────────────────────────
  try {
    // Build ledger payment totals per booking.
    const { data: ledgerRows, error: lErr } = await sb
      .from("renter_balance_ledger")
      .select("booking_id, amount, direction, transaction_type")
      .eq("transaction_type", "payment")
      .eq("direction", "credit");
    if (lErr) throw new Error(lErr.message);

    const ledgerTotals = {};
    for (const r of ledgerRows || []) {
      ledgerTotals[r.booking_id] = (ledgerTotals[r.booking_id] || 0) + Number(r.amount || 0);
    }

    // Build revenue totals per booking.
    const { data: rrRows, error: rrErr } = await sb
      .from("revenue_records")
      .select("booking_id, gross_amount")
      .eq("payment_status", "paid");
    if (rrErr) throw new Error(rrErr.message);

    const revenueTotals = {};
    for (const r of rrRows || []) {
      revenueTotals[r.booking_id] = (revenueTotals[r.booking_id] || 0) + Number(r.gross_amount || 0);
    }

    // Compare.
    const allIds = new Set([...Object.keys(ledgerTotals), ...Object.keys(revenueTotals)]);
    for (const bookingId of allIds) {
      const ledger = ledgerTotals[bookingId] || 0;
      const revenue = revenueTotals[bookingId] || 0;
      const discrepancy = Math.abs(ledger - revenue);
      if (discrepancy > MATCH_TOLERANCE && (ledger > 0 || revenue > 0)) {
        anomalies.push({
          type: "ledger_revenue_mismatch",
          booking_id: bookingId,
          detail: `ledger_credits=${ledger.toFixed(2)} revenue_gross=${revenue.toFixed(2)} discrepancy=${discrepancy.toFixed(2)}`,
          severity: discrepancy > 10 ? "error" : "warning",
        });
      }
    }
  } catch (err) {
    console.error("[ledger-reconcile-cron] ledger/revenue mismatch check failed:", err.message);
  }

  // ── 5. Orphaned Stripe events ──────────────────────────────────────────────────
  try {
    // Fetch all paid revenue_records with a payment_intent_id.
    const { data: rrRows, error: rrErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id")
      .not("payment_intent_id", "is", null)
      .eq("payment_status", "paid")
      .limit(5000);
    if (rrErr) throw new Error(rrErr.message);

    if (rrRows && rrRows.length > 0) {
      // Build lookup set of all payment_intent_ids present in the ledger for stripe_payment source_type.
      const piIds = [...new Set(rrRows.map((r) => r.payment_intent_id))];
      const { data: ledgerPiRows, error: ledgerPiErr } = await sb
        .from("renter_balance_ledger")
        .select("source_id")
        .eq("source_type", "stripe_payment")
        .in("source_id", piIds);
      if (ledgerPiErr) throw new Error(ledgerPiErr.message);

      const ledgerPiSet = new Set((ledgerPiRows || []).map((r) => r.source_id));

      for (const row of rrRows) {
        if (!row.payment_intent_id) continue;
        if (!ledgerPiSet.has(row.payment_intent_id)) {
          anomalies.push({
            type: "orphaned_stripe_event",
            booking_id: row.booking_id,
            source_id: row.payment_intent_id,
            detail: `revenue_record ${row.id} has payment_intent_id ${row.payment_intent_id} with no matching ledger row`,
            severity: "warning",
          });
        }
      }
    }
  } catch (err) {
    console.error("[ledger-reconcile-cron] orphaned Stripe events check failed:", err.message);
  }

  // ── Persist snapshot ──────────────────────────────────────────────────────────
  const durationMs = Date.now() - startMs;
  const anomalyTypes = [...new Set(anomalies.map((a) => a.type))];

  const snapshotId = await saveReconcileSnapshot(sb, {
    run_type: "nightly",
    bookings_checked: 0, // per-booking reconcile handled in separate report
    matched_count: 0,
    matched_pct: null,
    unresolved_count: anomalies.length,
    discrepancy_total: 0,
    largest_mismatches: [],
    anomalies_count: anomalies.length,
    anomaly_types: anomalyTypes,
    anomaly_detail: anomalies.slice(0, 500),
    details_json: [],
    date_from: null,
    date_to: null,
    duration_ms: durationMs,
    created_by: "nightly_cron",
  });

  console.log(`[ledger-reconcile-cron] done. ${anomalies.length} anomaly(ies) detected. snapshot=${snapshotId}`);

  return res.status(200).json({
    ok: true,
    anomalies_count: anomalies.length,
    anomaly_types: anomalyTypes,
    anomalies: anomalies.slice(0, 100),
    snapshot_id: snapshotId,
    duration_ms: durationMs,
  });
}
