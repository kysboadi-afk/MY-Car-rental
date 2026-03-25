// api/v2-revenue.js
// SLYTRANS Fleet Control v2 — Revenue records management endpoint.
// All operations are additive; existing booking and payment flows are unaffected.
//
// POST /api/v2-revenue
// Actions:
//   list        — { secret, action:"list", vehicleId?, startDate?, endDate?, status? }
//   get         — { secret, action:"get", id }
//   create      — { secret, action:"create", ...fields }
//   update      — { secret, action:"update", id, updates:{...} }
//   delete      — { secret, action:"delete", id }
//   summary     — { secret, action:"summary" } — per-vehicle aggregated stats
//
// Error contract:
//   • READ actions (list, get, summary) return empty state when Supabase is not
//     configured or the table does not yet exist, so the admin panel never crashes.
//   • WRITE actions (create, update, delete) return a clear 503 when Supabase is
//     unavailable so callers know the operation did not persist.

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
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

  const sb = getSupabase();

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      // Return empty state immediately when Supabase is not configured so the
      // admin Revenue page loads with an empty table rather than crashing.
      if (!sb) return res.status(200).json({ records: [] });
      try {
        let q = sb.from("revenue_records").select("*").order("created_at", { ascending: false });
        if (body.vehicleId)  q = q.eq("vehicle_id",    body.vehicleId);
        if (body.status)     q = q.eq("payment_status", body.status);
        if (body.startDate)  q = q.gte("pickup_date",   body.startDate);
        if (body.endDate)    q = q.lte("return_date",   body.endDate);
        if (body.limit)      q = q.limit(Number(body.limit));
        const { data, error } = await q;
        if (error) {
          // Table may not exist yet (migration not applied): return empty rather than crash
          console.error("v2-revenue list error:", error.message);
          return res.status(200).json({ records: [] });
        }
        return res.status(200).json({ records: data || [] });
      } catch (qErr) {
        console.error("v2-revenue list query error:", qErr);
        return res.status(200).json({ records: [] });
      }
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured" });
      const { data, error } = await sb.from("revenue_records").select("*").eq("id", body.id).single();
      if (error) throw error;
      return res.status(200).json({ record: data });
    }

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === "create") {
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot create revenue record" });
      const { booking_id, vehicle_id, gross_amount } = body;
      if (!booking_id || !vehicle_id || gross_amount == null)
        return res.status(400).json({ error: "booking_id, vehicle_id, gross_amount are required" });

      const record = {
        booking_id,
        vehicle_id,
        customer_name:     body.customer_name   || null,
        customer_phone:    body.customer_phone  || null,
        customer_email:    body.customer_email  || null,
        pickup_date:       body.pickup_date      || null,
        return_date:       body.return_date      || null,
        gross_amount:      Number(gross_amount),
        deposit_amount:    Number(body.deposit_amount  || 0),
        refund_amount:     Number(body.refund_amount   || 0),
        payment_method:    body.payment_method   || "stripe",
        payment_status:    body.payment_status   || "paid",
        protection_plan_id: body.protection_plan_id || null,
        notes:             body.notes            || null,
        is_no_show:        Boolean(body.is_no_show),
        is_cancelled:      Boolean(body.is_cancelled),
        override_by_admin: Boolean(body.override_by_admin),
      };

      const { data, error } = await sb.from("revenue_records").insert(record).select().single();
      if (error) throw error;
      return res.status(201).json({ record: data });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot update revenue record" });
      const allowed = [
        "gross_amount","deposit_amount","refund_amount","payment_method","payment_status",
        "protection_plan_id","notes","is_no_show","is_cancelled","override_by_admin",
        "customer_name","customer_phone","customer_email","pickup_date","return_date",
      ];
      const updates = {};
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      if (!Object.keys(updates).length)
        return res.status(400).json({ error: "No valid update fields provided" });

      const { data, error } = await sb.from("revenue_records").update(updates).eq("id", body.id).select().single();
      if (error) throw error;
      return res.status(200).json({ record: data });
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot delete revenue record" });
      const { error } = await sb.from("revenue_records").delete().eq("id", body.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ── SUMMARY (per-vehicle) ────────────────────────────────────────────────
    if (action === "summary") {
      // Return empty summary when Supabase is not configured
      if (!sb) return res.status(200).json({ summary: [] });
      try {
        const { data, error } = await sb.from("vehicle_revenue_summary").select("*");
        if (error) {
          // Fallback: aggregate manually if view not yet created
          const { data: recs, error: err2 } = await sb.from("revenue_records").select("*");
          if (err2) {
            console.error("v2-revenue summary fallback error:", err2.message);
            return res.status(200).json({ summary: [] });
          }
          const summary = {};
          for (const r of (recs || [])) {
            if (!summary[r.vehicle_id]) {
              summary[r.vehicle_id] = { vehicle_id: r.vehicle_id, booking_count:0, cancelled_count:0, no_show_count:0, total_gross:0, total_refunds:0, total_net:0, total_deposits:0 };
            }
            const s = summary[r.vehicle_id];
            if (r.is_cancelled) { s.cancelled_count++; continue; }
            if (r.is_no_show)   { s.no_show_count++;   continue; }
            s.booking_count++;
            s.total_gross    += Number(r.gross_amount   || 0);
            s.total_refunds  += Number(r.refund_amount  || 0);
            s.total_net      += Number(r.gross_amount   || 0) - Number(r.refund_amount || 0);
            s.total_deposits += Number(r.deposit_amount || 0);
          }
          return res.status(200).json({ summary: Object.values(summary) });
        }
        return res.status(200).json({ summary: data || [] });
      } catch (sumErr) {
        console.error("v2-revenue summary error:", sumErr);
        return res.status(200).json({ summary: [] });
      }
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-revenue error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
