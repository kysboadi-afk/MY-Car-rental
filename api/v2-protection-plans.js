// api/v2-protection-plans.js
// SLYTRANS Fleet Control v2 — Protection plan configuration endpoint.
// Admins can manage coverage tiers that are attached to bookings/revenue.
//
// POST /api/v2-protection-plans
// Actions:
//   list    — { secret, action:"list" }
//   get     — { secret, action:"get", id }
//   create  — { secret, action:"create", name, description?, daily_rate, liability_cap? }
//   update  — { secret, action:"update", id, updates:{...} }
//   delete  — { secret, action:"delete", id }

import { createClient } from "@supabase/supabase-js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
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
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });

  const body = req.body || {};
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  let sb;
  try { sb = getSupabase(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    if (!action || action === "list") {
      const { data, error } = await sb.from("protection_plans")
        .select("*").order("sort_order").order("name");
      if (error) throw error;
      return res.status(200).json({ plans: data || [] });
    }

    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const { data, error } = await sb.from("protection_plans").select("*").eq("id", body.id).single();
      if (error) throw error;
      return res.status(200).json({ plan: data });
    }

    if (action === "create") {
      const { name, daily_rate } = body;
      if (!name || daily_rate == null)
        return res.status(400).json({ error: "name and daily_rate are required" });
      const record = {
        name:          String(name).trim(),
        description:   body.description   || null,
        daily_rate:    Number(daily_rate),
        liability_cap: body.liability_cap != null ? Number(body.liability_cap) : 1000,
        is_active:     body.is_active !== false,
        sort_order:    body.sort_order != null ? Number(body.sort_order) : 99,
      };
      const { data, error } = await sb.from("protection_plans").insert(record).select().single();
      if (error) throw error;
      return res.status(201).json({ plan: data });
    }

    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const allowed = ["name","description","daily_rate","liability_cap","is_active","sort_order"];
      const updates = { updated_at: new Date().toISOString() };
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      const { data, error } = await sb.from("protection_plans").update(updates).eq("id", body.id).select().single();
      if (error) throw error;
      return res.status(200).json({ plan: data });
    }

    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const { error } = await sb.from("protection_plans").delete().eq("id", body.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-protection-plans error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
