// api/v2-revenue-reconciliation.js
// SLYTRANS Fleet Control v2 — Revenue reconciliation audit endpoint.
// Returns rows from the revenue_reconciliation_audit Supabase view for
// in-UI diagnostics and CSV export.  The view covers every revenue_record
// and unlinked succeeded charge, annotating each row with whether it is
// included in the canonical Dashboard/Revenue/Fleet financial surfaces.
//
// POST /api/v2-revenue-reconciliation
// Body: { secret, action?, ...filters }
//
// Actions:
//   "audit"   (default) — returns paginated rows with a summary block
//   "summary"           — returns aggregated totals only (no row data)
//
// Filters (audit action):
//   vehicle_id    {string}  — filter by vehicle ID
//   booking_id    {string}  — filter by booking ID
//   source_table  {string}  — "revenue_records" | "charges"
//   included_only {boolean} — when true, return only canonical-included rows
//   limit         {number}  — max rows to return (default 500, cap 2000)
//   offset        {number}  — pagination offset (default 0)
//
// Response — audit action:
//   { rows: [...], total_rows: number, summary: { ... }, supabase: boolean }
//
// Response — summary action:
//   { summary: { ... }, supabase: boolean }
//
// When Supabase is not configured the endpoint returns an empty/zero response
// so the UI can degrade gracefully rather than crash.

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const MAX_LIMIT       = 2000;
const DEFAULT_LIMIT   = 500;

/** Compute an in-process summary block from an array of audit rows. */
function buildSummary(rows) {
  const summary = {
    total_rows:      rows.length,
    total_gross:     0,
    total_net:       0,
    total_fees:      0,
    total_refunds:   0,
    included_count:  0,
    excluded_count:  0,
    included_gross:  0,
    included_net:    0,
    excluded_gross:  0,
    excluded_net:    0,
    by_source: {
      revenue_records: { count: 0, gross: 0, net: 0, fees: 0, refunds: 0 },
      charges:         { count: 0, gross: 0, net: 0, fees: 0, refunds: 0 },
    },
  };

  for (const r of rows) {
    const gross    = Number(r.gross    || 0);
    const net      = Number(r.net      || 0);
    const fees     = Number(r.fees     || 0);
    const refunds  = Number(r.refunds  || 0);
    const included = Boolean(r.included_in_dashboard);
    const src      = r.source_table === "charges" ? "charges" : "revenue_records";

    summary.total_gross   += gross;
    summary.total_net     += net;
    summary.total_fees    += fees;
    summary.total_refunds += refunds;

    if (included) {
      summary.included_count++;
      summary.included_gross += gross;
      summary.included_net   += net;
    } else {
      summary.excluded_count++;
      summary.excluded_gross += gross;
      summary.excluded_net   += net;
    }

    summary.by_source[src].count++;
    summary.by_source[src].gross   += gross;
    summary.by_source[src].net     += net;
    summary.by_source[src].fees    += fees;
    summary.by_source[src].refunds += refunds;
  }

  // Round all numeric totals to 2 decimal places.
  const round = (n) => Math.round(n * 100) / 100;
  for (const key of ["total_gross","total_net","total_fees","total_refunds",
                     "included_gross","included_net","excluded_gross","excluded_net"]) {
    summary[key] = round(summary[key]);
  }
  for (const src of ["revenue_records", "charges"]) {
    const s = summary.by_source[src];
    for (const key of ["gross","net","fees","refunds"]) s[key] = round(s[key]);
  }

  return summary;
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
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const isSummaryOnly = action === "summary";
  const limit  = Math.min(Number(body.limit  || DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(Number(body.offset || 0), 0);

  // ── Supabase path ────────────────────────────────────────────────────────
  const sb = getSupabaseAdmin();

  if (sb) {
    try {
      let q = sb.from("revenue_reconciliation_audit").select("*");

      // Apply optional server-side filters.
      if (body.vehicle_id)   q = q.eq("vehicle_id",   body.vehicle_id);
      if (body.booking_id)   q = q.eq("booking_id",   body.booking_id);
      if (body.source_table) q = q.eq("source_table",  body.source_table);
      if (body.included_only === true || body.included_only === "true") {
        q = q.eq("included_in_dashboard", true);
      }

      if (!isSummaryOnly) {
        // Audit: apply ordering and pagination.
        q = q.order("booking_id", { ascending: true }).range(offset, offset + limit - 1);
      }

      const { data, error } = await q;

      if (error) {
        const code = error.code || "";
        const msg  = error.message || "";
        const isSchema = code === "42P01" || code === "PGRST200" || code === "PGRST204" ||
          /relation .* does not exist|table .* not found/i.test(msg);
        if (!isSchema) console.error("v2-revenue-reconciliation error:", msg);
        // Fall through to empty response below.
      } else {
        const rows    = data || [];
        const summary = buildSummary(rows);

        if (isSummaryOnly) {
          return res.status(200).json({ summary, supabase: true });
        }
        return res.status(200).json({ rows, total_rows: rows.length, summary, supabase: true });
      }
    } catch (err) {
      console.error("v2-revenue-reconciliation exception:", err.message || err);
    }
  }

  // ── Supabase not available — return empty/zero response ──────────────────
  const summary = buildSummary([]);
  if (isSummaryOnly) {
    return res.status(200).json({ summary, supabase: false });
  }
  return res.status(200).json({ rows: [], total_rows: 0, summary, supabase: false });
}
