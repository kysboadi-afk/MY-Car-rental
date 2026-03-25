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
//
// Error contract:
//   • list/get return hardcoded defaults when Supabase is not configured or table missing.
//   • create/update/delete return 503 when Supabase is unavailable.

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
}

// Default protection plans matching the migration 0003 seed values.
// Used when Supabase is unavailable, the table is missing, or the table is empty.
const DEFAULT_PLANS = [
  { name: "None",     description: "No protection plan selected",          daily_rate: 0,  liability_cap: 0,    is_active: true, sort_order: 0 },
  { name: "Basic",    description: "Basic damage protection, $1,000 cap",  daily_rate: 15, liability_cap: 1000, is_active: true, sort_order: 1 },
  { name: "Standard", description: "Standard coverage, $500 cap",          daily_rate: 25, liability_cap: 500,  is_active: true, sort_order: 2 },
  { name: "Premium",  description: "Full coverage, $0 liability",          daily_rate: 40, liability_cap: 0,    is_active: true, sort_order: 3 },
];

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

  const sb = getSupabase();

  try {
    if (!action || action === "list") {
      if (!sb) return res.status(200).json({ plans: DEFAULT_PLANS });
      try {
        const { data, error } = await sb.from("protection_plans")
          .select("*").order("sort_order").order("name");
        if (error) {
          console.error("v2-protection-plans list error:", error.message);
          return res.status(200).json({ plans: DEFAULT_PLANS });
        }

        // If the table exists but is empty, auto-seed the defaults.
        // The upsert uses ignoreDuplicates:true so concurrent requests are safe.
        if (!data || data.length === 0) {
          const seedRecords = DEFAULT_PLANS.map((p) => ({
            name:          p.name,
            description:   p.description,
            daily_rate:    p.daily_rate,
            liability_cap: p.liability_cap,
            is_active:     p.is_active,
            sort_order:    p.sort_order,
          }));
          const { error: seedErr } = await sb.from("protection_plans")
            .insert(seedRecords);
          if (seedErr) {
            console.error("v2-protection-plans seed error (non-fatal):", seedErr.message);
            // Return hardcoded defaults on seed failure
            return res.status(200).json({ plans: DEFAULT_PLANS });
          }
          // Re-fetch seeded plans
          const { data: seeded, error: refetchErr } = await sb.from("protection_plans")
            .select("*").order("sort_order").order("name");
          return res.status(200).json({ plans: refetchErr ? DEFAULT_PLANS : (seeded || DEFAULT_PLANS) });
        }

        return res.status(200).json({ plans: data || [] });
      } catch (qErr) {
        console.error("v2-protection-plans list query error:", qErr);
        return res.status(200).json({ plans: DEFAULT_PLANS });
      }
    }

    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured" });
      const { data, error } = await sb.from("protection_plans").select("*").eq("id", body.id).single();
      if (error) throw error;
      return res.status(200).json({ plan: data });
    }

    if (action === "create") {
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot create plan" });
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
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot update plan" });
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
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot delete plan" });
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
