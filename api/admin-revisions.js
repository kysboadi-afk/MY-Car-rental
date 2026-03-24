// api/admin-revisions.js
// Admin endpoint for viewing and rolling back content revisions.
//
// POST /api/admin-revisions
// Actions:
//   list     — { secret, action:"list", resource_type?, resource_id?, limit? }
//   rollback — { secret, action:"rollback", revision_id }

import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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
    return res.status(503).json({ error: "Supabase is not configured." });
  }

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === "list") {
    try {
      const limit = Math.min(parseInt(body.limit, 10) || 50, 200);
      let query = sb
        .from("content_revisions")
        .select("id, resource_type, resource_id, changed_keys, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (body.resource_type) query = query.eq("resource_type", body.resource_type);
      if (body.resource_id)   query = query.eq("resource_id",   body.resource_id);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return res.status(200).json({ revisions: data || [] });
    } catch (err) {
      console.error("[admin-revisions] list error:", err);
      return res.status(500).json({ error: "Failed to list revisions." });
    }
  }

  // ── rollback ──────────────────────────────────────────────────────────────
  if (action === "rollback") {
    const revision_id = body.revision_id;
    if (!revision_id) return res.status(400).json({ error: "revision_id is required." });

    try {
      const { data: rev, error: revErr } = await sb
        .from("content_revisions")
        .select("*")
        .eq("id", revision_id)
        .single();

      if (revErr || !rev) return res.status(404).json({ error: "Revision not found." });
      if (!rev.before) return res.status(400).json({ error: "This revision has no 'before' snapshot to roll back to (it was the initial creation)." });

      if (rev.resource_type === "site_settings") {
        // Re-upsert all keys from the before snapshot
        const upsertRows = Object.entries(rev.before)
          .filter(([k]) => k !== "source")
          .map(([key, value]) => ({
            key,
            value: value === null || value === undefined ? null : String(value),
            updated_at: new Date().toISOString(),
          }));

        const { error: upsertErr } = await sb
          .from("site_settings")
          .upsert(upsertRows, { onConflict: "key" });
        if (upsertErr) throw new Error(upsertErr.message);

        // Save new revision record for the rollback itself
        await sb.from("content_revisions").insert({
          resource_type: "site_settings",
          resource_id:   "global",
          before:        rev.after,
          after:         rev.before,
          changed_keys:  ["(rollback from revision " + revision_id + ")"],
          created_at:    new Date().toISOString(),
        });

        return res.status(200).json({ ok: true, restored: rev.before });
      }

      if (rev.resource_type === "content_blocks") {
        const block_id = rev.resource_id;
        const before   = rev.before;

        // Check if the block currently exists
        const { data: existing } = await sb
          .from("content_blocks").select("*").eq("block_id", block_id).maybeSingle();

        let afterState;
        if (existing) {
          // Update to previous state
          const { data, error: updErr } = await sb
            .from("content_blocks")
            .update({ ...before, updated_at: new Date().toISOString() })
            .eq("block_id", block_id)
            .select().single();
          if (updErr) throw new Error(updErr.message);
          afterState = data;
        } else {
          // Block was deleted — re-create it
          const { data, error: insErr } = await sb
            .from("content_blocks")
            .insert({ ...before, updated_at: new Date().toISOString() })
            .select().single();
          if (insErr) throw new Error(insErr.message);
          afterState = data;
        }

        await sb.from("content_revisions").insert({
          resource_type: "content_blocks",
          resource_id:   block_id,
          before:        rev.after || existing,
          after:         afterState,
          changed_keys:  ["(rollback from revision " + revision_id + ")"],
          created_at:    new Date().toISOString(),
        });

        return res.status(200).json({ ok: true, block: afterState });
      }

      return res.status(400).json({ error: `Rollback not supported for resource_type: ${rev.resource_type}` });
    } catch (err) {
      console.error("[admin-revisions] rollback error:", err);
      return res.status(500).json({ error: "Rollback failed." });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
