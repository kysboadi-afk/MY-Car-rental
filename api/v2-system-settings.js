// api/v2-system-settings.js
// SLYTRANS Fleet Control v2 — System settings management endpoint.
// Admin-controlled key/value configuration. Old booking/payment flows are unaffected.
//
// POST /api/v2-system-settings
// Actions:
//   list    — { secret, action:"list", category? }
//   get     — { secret, action:"get", key }
//   set     — { secret, action:"set", key, value, description?, category? }
//   delete  — { secret, action:"delete", key }

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
      let q = sb.from("system_settings").select("*").order("category").order("key");
      if (body.category) q = q.eq("category", body.category);
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json({ settings: data || [] });
    }

    if (action === "get") {
      if (!body.key) return res.status(400).json({ error: "key is required" });
      const { data, error } = await sb.from("system_settings").select("*").eq("key", body.key).single();
      if (error) throw error;
      return res.status(200).json({ setting: data });
    }

    if (action === "set") {
      const { key, value } = body;
      if (!key || value === undefined) return res.status(400).json({ error: "key and value are required" });
      const record = {
        key:         String(key).trim(),
        value,
        updated_at:  new Date().toISOString(),
        updated_by:  "admin",
      };
      if (body.description) record.description = body.description;
      if (body.category)    record.category    = body.category;

      const { data, error } = await sb.from("system_settings")
        .upsert(record, { onConflict: "key" }).select().single();
      if (error) throw error;
      return res.status(200).json({ setting: data });
    }

    if (action === "delete") {
      if (!body.key) return res.status(400).json({ error: "key is required" });
      const { error } = await sb.from("system_settings").delete().eq("key", body.key);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-system-settings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
