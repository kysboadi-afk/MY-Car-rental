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

import { createClient } from "@supabase/supabase-js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function getSupabase() {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase not configured (missing SUPABASE_URL or key)");
  return createClient(url, key);
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

  let sb;
  try { sb = getSupabase(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      let q = sb.from("revenue_records").select("*").order("created_at", { ascending: false });
      if (body.vehicleId)  q = q.eq("vehicle_id",     body.vehicleId);
      if (body.status)     q = q.eq("payment_status",  body.status);
      if (body.startDate)  q = q.gte("pickup_date",    body.startDate);
      if (body.endDate)    q = q.lte("return_date",    body.endDate);
      if (body.limit)      q = q.limit(Number(body.limit));
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json({ records: data || [] });
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const { data, error } = await sb.from("revenue_records").select("*").eq("id", body.id).single();
      if (error) throw error;
      return res.status(200).json({ record: data });
    }

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === "create") {
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
      const { error } = await sb.from("revenue_records").delete().eq("id", body.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ── SUMMARY (per-vehicle) ────────────────────────────────────────────────
    if (action === "summary") {
      const { data, error } = await sb.from("vehicle_revenue_summary").select("*");
      if (error) {
        // Fallback: aggregate manually if view not yet created
        const { data: recs, error: err2 } = await sb.from("revenue_records").select("*");
        if (err2) throw err2;
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
          // note: view includes deposits for non-cancelled only; fallback matches that behaviour
        }
        return res.status(200).json({ summary: Object.values(summary) });
      }
      return res.status(200).json({ summary: data || [] });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-revenue error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
