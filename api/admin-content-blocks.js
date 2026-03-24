// api/admin-content-blocks.js
// Admin endpoint for structured content blocks stored in Supabase.
// Block types: faq | announcement | testimonial
//
// POST /api/admin-content-blocks
// Actions:
//   list   — { secret, action:"list", type? }
//   create — { secret, action:"create", block:{type, title, body, ...} }
//   update — { secret, action:"update", block_id, updates:{...} }
//   delete — { secret, action:"delete", block_id }

import crypto from "crypto";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_TYPES   = ["faq", "announcement", "testimonial"];

// Fields allowed per block type
const ALLOWED_BLOCK_FIELDS = {
  faq:          ["type", "title", "body", "sort_order", "active"],
  announcement: ["type", "title", "body", "sort_order", "active", "expires_at"],
  testimonial:  ["type", "title", "body", "author_name", "author_location", "sort_order", "active"],
};

function sanitizeBlock(raw, type) {
  const allowed = ALLOWED_BLOCK_FIELDS[type] || [];
  const safe    = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) safe[k] = raw[k];
  }
  return safe;
}

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default async function handler(req, res) {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return res.status(204).set(headers).end();
  }
  if (req.method !== "POST") {
    return res.status(405).set(headers).json({ error: "Method not allowed" });
  }

  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, action } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your Vercel environment variables." });
  }

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === "list") {
    try {
      let query = sb.from("content_blocks").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true });
      if (body.type && ALLOWED_TYPES.includes(body.type)) {
        query = query.eq("type", body.type);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return res.status(200).json({ blocks: data || [] });
    } catch (err) {
      console.error("[admin-content-blocks] list error:", err);
      return res.status(500).json({ error: "Failed to list content blocks." });
    }
  }

  // ── create ────────────────────────────────────────────────────────────────
  if (action === "create") {
    const raw  = body.block || {};
    const type = raw.type;
    if (!ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid block type. Allowed: ${ALLOWED_TYPES.join(", ")}` });
    }
    const safe = sanitizeBlock(raw, type);
    safe.type       = type;
    safe.block_id   = crypto.randomUUID();
    safe.created_at = new Date().toISOString();
    safe.updated_at = safe.created_at;
    if (safe.active === undefined) safe.active = true;
    if (safe.sort_order === undefined) safe.sort_order = 0;

    try {
      const { data, error } = await sb.from("content_blocks").insert(safe).select().single();
      if (error) throw new Error(error.message);

      await sb.from("content_revisions").insert({
        resource_type: "content_blocks",
        resource_id:   safe.block_id,
        before:        null,
        after:         data,
        changed_keys:  Object.keys(safe),
        created_at:    new Date().toISOString(),
      });

      return res.status(201).json({ block: data });
    } catch (err) {
      console.error("[admin-content-blocks] create error:", err);
      return res.status(500).json({ error: "Failed to create content block." });
    }
  }

  // ── update ────────────────────────────────────────────────────────────────
  if (action === "update") {
    const block_id = body.block_id;
    if (!block_id) return res.status(400).json({ error: "block_id is required." });

    try {
      const { data: existing, error: fetchErr } = await sb
        .from("content_blocks").select("*").eq("block_id", block_id).single();
      if (fetchErr || !existing) {
        return res.status(404).json({ error: "Block not found." });
      }

      const safe = sanitizeBlock(body.updates || {}, existing.type);
      safe.updated_at = new Date().toISOString();

      const { data, error } = await sb
        .from("content_blocks").update(safe).eq("block_id", block_id).select().single();
      if (error) throw new Error(error.message);

      await sb.from("content_revisions").insert({
        resource_type: "content_blocks",
        resource_id:   block_id,
        before:        existing,
        after:         data,
        changed_keys:  Object.keys(safe).filter((k) => k !== "updated_at"),
        created_at:    new Date().toISOString(),
      });

      return res.status(200).json({ block: data });
    } catch (err) {
      console.error("[admin-content-blocks] update error:", err);
      return res.status(500).json({ error: "Failed to update content block." });
    }
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === "delete") {
    const block_id = body.block_id;
    if (!block_id) return res.status(400).json({ error: "block_id is required." });

    try {
      const { data: existing, error: fetchErr } = await sb
        .from("content_blocks").select("*").eq("block_id", block_id).single();
      if (fetchErr || !existing) {
        return res.status(404).json({ error: "Block not found." });
      }

      const { error } = await sb.from("content_blocks").delete().eq("block_id", block_id);
      if (error) throw new Error(error.message);

      await sb.from("content_revisions").insert({
        resource_type: "content_blocks",
        resource_id:   block_id,
        before:        existing,
        after:         null,
        changed_keys:  ["(deleted)"],
        created_at:    new Date().toISOString(),
      });

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[admin-content-blocks] delete error:", err);
      return res.status(500).json({ error: "Failed to delete content block." });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
