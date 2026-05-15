// api/ledger-reconcile-report.js
// Phase 4.2 — On-demand reconciliation report.
//
// Compares per-booking ledger totals (renter_balance_ledger) against the
// source-of-truth financial tables (revenue_records, charges, tickets) and
// surfaces discrepancies.
//
// POST /api/ledger-reconcile-report  (admin secret required)
//
// Body:
//   {
//     secret,
//     date_from?,        // ISO date — filter revenue_records.created_at
//     date_to?,          // ISO date
//     status?,           // "matched"|"over"|"under"|"missing" — filter results
//     limit?,            // default 200
//     offset?,           // default 0
//     save_snapshot?     // bool — persist result to ledger_reconcile_snapshots (default true)
//   }
//
// Tolerance: discrepancy ≤ $0.01 → "matched"
//
// Response aggregates:
//   bookings_checked, matched_count, matched_pct,
//   unresolved_count, discrepancy_total,
//   largest_mismatches (top 10),
//   results (per-booking list, filtered by status param)

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const MATCH_TOLERANCE = 0.01;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const TOP_MISMATCHES = 10;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  const dateFrom = body.date_from || null;
  const dateTo = body.date_to || null;
  const statusFilter = body.status || null;
  const batchLimit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const batchOffset = Math.max(Number(body.offset) || 0, 0);
  const saveSnapshot = body.save_snapshot !== false;

  const startMs = Date.now();

  try {
    // ── Step 1: Source totals per booking (revenue_records + charges + tickets) ──
    const sourceTotals = await buildSourceTotals(sb, { dateFrom, dateTo });

    // ── Step 2: Ledger totals per booking ──────────────────────────────────────
    const ledgerTotals = await buildLedgerTotals(sb, { dateFrom, dateTo });

    // ── Step 3: Merge and classify ──────────────────────────────────────────────
    const allBookingIds = new Set([
      ...Object.keys(sourceTotals),
      ...Object.keys(ledgerTotals),
    ]);

    const results = [];
    for (const bookingId of allBookingIds) {
      const sourceTotal = sourceTotals[bookingId] || 0;
      const ledgerTotal = ledgerTotals[bookingId] || 0;
      const discrepancy = Math.abs(ledgerTotal - sourceTotal);
      let status;
      if (!(bookingId in ledgerTotals)) {
        status = "missing";
      } else if (discrepancy <= MATCH_TOLERANCE) {
        status = "matched";
      } else if (ledgerTotal > sourceTotal) {
        status = "over";
      } else {
        status = "under";
      }
      results.push({
        booking_ref: bookingId,
        source_total: round2(sourceTotal),
        ledger_total: round2(ledgerTotal),
        discrepancy: round2(discrepancy),
        status,
      });
    }

    // Sort by discrepancy desc for useful default ordering.
    results.sort((a, b) => b.discrepancy - a.discrepancy);

    // ── Step 4: Aggregates ──────────────────────────────────────────────────────
    const bookingsChecked = results.length;
    const matchedCount = results.filter((r) => r.status === "matched").length;
    const matchedPct = bookingsChecked > 0 ? round2((matchedCount / bookingsChecked) * 100) : 100;
    const unresolvedCount = results.filter((r) => r.status !== "matched").length;
    const discrepancyTotal = round2(results.reduce((s, r) => s + r.discrepancy, 0));
    const largestMismatches = results
      .filter((r) => r.status !== "matched")
      .slice(0, TOP_MISMATCHES);

    // ── Step 5: Enrich with booking metadata ───────────────────────────────────
    const pagedResults = applyFilter(results, statusFilter).slice(batchOffset, batchOffset + batchLimit);
    await enrichWithBookingMeta(sb, pagedResults);

    const durationMs = Date.now() - startMs;

    // ── Step 6: Persist snapshot ────────────────────────────────────────────────
    let snapshotId = null;
    if (saveSnapshot) {
      snapshotId = await saveReconcileSnapshot(sb, {
        run_type: "manual",
        bookings_checked: bookingsChecked,
        matched_count: matchedCount,
        matched_pct: matchedPct,
        unresolved_count: unresolvedCount,
        discrepancy_total: discrepancyTotal,
        largest_mismatches: largestMismatches,
        anomalies_count: 0,
        anomaly_types: [],
        anomaly_detail: [],
        details_json: results.slice(0, 1000),
        date_from: dateFrom,
        date_to: dateTo,
        duration_ms: durationMs,
        created_by: "admin",
      });
    }

    return res.status(200).json({
      ok: true,
      snapshot_id: snapshotId,
      bookings_checked: bookingsChecked,
      matched_count: matchedCount,
      matched_pct: matchedPct,
      unresolved_count: unresolvedCount,
      discrepancy_total: discrepancyTotal,
      largest_mismatches: largestMismatches,
      results: pagedResults,
      total_results: applyFilter(results, statusFilter).length,
      duration_ms: durationMs,
    });
  } catch (err) {
    console.error("[ledger-reconcile-report] error:", err.message);
    return res.status(500).json({ error: "Reconciliation report failed.", detail: err.message });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function applyFilter(results, statusFilter) {
  if (!statusFilter) return results;
  return results.filter((r) => r.status === statusFilter);
}

async function buildSourceTotals(sb, { dateFrom, dateTo }) {
  const totals = {};

  // revenue_records (gross_amount for paid records)
  let rrQ = sb
    .from("revenue_records")
    .select("booking_id, gross_amount")
    .eq("payment_status", "paid")
    .not("booking_id", "is", null);
  if (dateFrom) rrQ = rrQ.gte("created_at", dateFrom);
  if (dateTo) rrQ = rrQ.lte("created_at", dateTo + "T23:59:59Z");
  const { data: rrRows, error: rrErr } = await rrQ;
  if (rrErr) throw new Error(`source totals revenue_records: ${rrErr.message}`);
  for (const r of rrRows || []) {
    totals[r.booking_id] = (totals[r.booking_id] || 0) + Number(r.gross_amount || 0);
  }

  // charges (stripe-charged only)
  let cQ = sb
    .from("charges")
    .select("booking_id, amount")
    .not("stripe_payment_intent_id", "is", null)
    .not("booking_id", "is", null);
  if (dateFrom) cQ = cQ.gte("created_at", dateFrom);
  if (dateTo) cQ = cQ.lte("created_at", dateTo + "T23:59:59Z");
  const { data: cRows, error: cErr } = await cQ;
  if (cErr) throw new Error(`source totals charges: ${cErr.message}`);
  for (const r of cRows || []) {
    totals[r.booking_id] = (totals[r.booking_id] || 0) + Number(r.amount || 0);
  }

  // tickets (stripe-charged only)
  let tQ = sb
    .from("tickets")
    .select("booking_id, amount")
    .not("payment_intent_id", "is", null)
    .not("booking_id", "is", null);
  if (dateFrom) tQ = tQ.gte("created_at", dateFrom);
  if (dateTo) tQ = tQ.lte("created_at", dateTo + "T23:59:59Z");
  const { data: tRows, error: tErr } = await tQ;
  if (tErr) throw new Error(`source totals tickets: ${tErr.message}`);
  for (const r of tRows || []) {
    totals[r.booking_id] = (totals[r.booking_id] || 0) + Number(r.amount || 0);
  }

  return totals;
}

async function buildLedgerTotals(sb, { dateFrom, dateTo }) {
  const totals = {};
  // Only count debit (charge) transactions to compare against source revenue/charge totals.
  let q = sb
    .from("renter_balance_ledger")
    .select("booking_id, amount, direction, transaction_type")
    .in("transaction_type", ["payment", "extension", "late_fee", "ticket", "damage", "repair", "deductible", "smoking", "cleaning", "towing", "misc"]);
  if (dateFrom) q = q.gte("created_at", dateFrom);
  if (dateTo) q = q.lte("created_at", dateTo + "T23:59:59Z");
  const { data: rows, error } = await q;
  if (error) throw new Error(`ledger totals: ${error.message}`);
  for (const r of rows || []) {
    // Count credits (payments) for cross-comparison with source totals.
    if (r.direction === "credit" && r.transaction_type === "payment") {
      totals[r.booking_id] = (totals[r.booking_id] || 0) + Number(r.amount || 0);
    }
  }
  return totals;
}

async function enrichWithBookingMeta(sb, rows) {
  if (!rows || rows.length === 0) return;
  const ids = rows.map((r) => r.booking_ref);
  const { data: bookings } = await sb
    .from("bookings")
    .select("booking_ref, customer_email, customer_name, vehicle_id")
    .in("booking_ref", ids);
  const bkMap = {};
  for (const bk of bookings || []) bkMap[bk.booking_ref] = bk;
  for (const row of rows) {
    const bk = bkMap[row.booking_ref] || {};
    row.customer_email = bk.customer_email || null;
    row.customer_name = bk.customer_name || null;
    row.vehicle_id = bk.vehicle_id || null;
  }
}

export async function saveReconcileSnapshot(sb, data) {
  try {
    const { data: row, error } = await sb
      .from("ledger_reconcile_snapshots")
      .insert({
        run_type: data.run_type || "manual",
        bookings_checked: data.bookings_checked || 0,
        matched_count: data.matched_count || 0,
        matched_pct: data.matched_pct ?? null,
        unresolved_count: data.unresolved_count || 0,
        discrepancy_total: data.discrepancy_total || 0,
        largest_mismatches: data.largest_mismatches || [],
        anomalies_count: data.anomalies_count || 0,
        anomaly_types: data.anomaly_types || [],
        anomaly_detail: data.anomaly_detail || [],
        details_json: data.details_json || [],
        date_from: data.date_from || null,
        date_to: data.date_to || null,
        duration_ms: data.duration_ms || null,
        created_by: data.created_by || "system",
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[ledger-reconcile-report] snapshot save failed (non-fatal):", error.message);
      return null;
    }
    return row ? row.id : null;
  } catch (err) {
    console.warn("[ledger-reconcile-report] snapshot save error (non-fatal):", err.message);
    return null;
  }
}
