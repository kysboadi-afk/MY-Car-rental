// api/admin-ai-assist.js
// Safe AI assistant for the Admin CMS.
// The assistant can ONLY propose changes to allowlisted settings/block fields.
// No arbitrary code generation — all proposals are validated against the allowlist
// before being stored or returned.
//
// POST /api/admin-ai-assist
// Actions:
//   propose — { secret, action:"propose", message, context:{settings, blocks} }
//             Returns { proposal: { type, changes, explanation } }
//   apply   — { secret, action:"apply", proposal }
//             Applies a previously generated proposal (calls the DB directly).
//             Returns { ok, applied }

import crypto from "crypto";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { openAIErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// ── Allowlisted settings fields ──────────────────────────────────────────────
const ALLOWED_SETTINGS_KEYS = new Set([
  "business_name", "phone", "whatsapp", "email",
  "instagram_url", "facebook_url", "tiktok_url", "twitter_url",
  "promo_banner_enabled", "promo_banner_text",
  "hero_title", "hero_subtitle", "about_text",
  "policies_cancellation", "policies_damage", "policies_fuel", "policies_age",
  "service_area_notes", "pickup_instructions",
]);

// ── Allowlisted content block fields ────────────────────────────────────────
const ALLOWED_BLOCK_FIELDS = new Set([
  "type", "title", "body", "author_name", "author_location",
  "sort_order", "active", "expires_at",
]);

const ALLOWED_BLOCK_TYPES = new Set(["faq", "announcement", "testimonial"]);

// ── System prompt sent to OpenAI ─────────────────────────────────────────────
function buildSystemPrompt(context) {
  return `You are a helpful content editor assistant for the SLY Rides car rental website admin panel.

Your ONLY job is to propose changes to the website's site settings and content blocks (FAQs, announcements, testimonials).

STRICT RULES — you MUST follow these at all times:
1. You may ONLY propose changes to the fields listed below. Do not suggest code changes, template changes, config changes, or anything else.
2. Return your response as a single JSON object matching the schema below. No markdown, no prose outside the JSON.
3. Keep text professional, friendly, and appropriate for a car rental company.
4. When the admin hasn't given you enough context, ask a clarifying question in the "explanation" field and return empty "changes".

ALLOWED SETTINGS FIELDS (flat string values):
${[...ALLOWED_SETTINGS_KEYS].map((k) => `  - ${k}`).join("\n")}

ALLOWED CONTENT BLOCK TYPES: faq, announcement, testimonial
ALLOWED CONTENT BLOCK FIELDS (per block):
  - type (string, one of: faq | announcement | testimonial)
  - title (string)
  - body (string)
  - author_name (string — testimonials only)
  - author_location (string — testimonials only)
  - sort_order (number)
  - active (boolean)
  - expires_at (ISO date string or null — announcements only)

CURRENT SITE CONTENT (for context):
${JSON.stringify(context || {}, null, 2)}

RESPONSE SCHEMA (return exactly this shape):
{
  "type": "settings_update" | "block_create" | "block_update" | "block_delete" | "none",
  "explanation": "A plain-English description of the proposed change shown to the admin",
  "changes": {
    // For type="settings_update":
    "settings": { "key": "new_value", ... },   // only allowed keys

    // For type="block_create":
    "block": { "type": "faq", "title": "...", "body": "...", ... },

    // For type="block_update":
    "block_id": "<uuid>",
    "updates": { "title": "...", "body": "...", ... },

    // For type="block_delete":
    "block_id": "<uuid>",

    // For type="none": {}
  }
}`;
}

// Sanitize a proposal object so it only contains allowlisted fields.
function sanitizeProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return null;

  const type    = proposal.type;
  const changes = proposal.changes || {};
  const safe    = { type, explanation: String(proposal.explanation || ""), changes: {} };

  if (type === "settings_update") {
    const settings = changes.settings || {};
    const safeSettings = {};
    for (const [k, v] of Object.entries(settings)) {
      if (ALLOWED_SETTINGS_KEYS.has(k)) safeSettings[k] = v;
    }
    safe.changes.settings = safeSettings;
  } else if (type === "block_create") {
    const block = changes.block || {};
    if (!ALLOWED_BLOCK_TYPES.has(block.type)) return null;
    const safeBlock = {};
    for (const [k, v] of Object.entries(block)) {
      if (ALLOWED_BLOCK_FIELDS.has(k)) safeBlock[k] = v;
    }
    safe.changes.block = safeBlock;
  } else if (type === "block_update") {
    const block_id = changes.block_id;
    const updates  = changes.updates || {};
    if (!block_id) return null;
    const safeUpdates = {};
    for (const [k, v] of Object.entries(updates)) {
      if (ALLOWED_BLOCK_FIELDS.has(k)) safeUpdates[k] = v;
    }
    safe.changes.block_id = block_id;
    safe.changes.updates  = safeUpdates;
  } else if (type === "block_delete") {
    if (!changes.block_id) return null;
    safe.changes.block_id = changes.block_id;
  } else if (type === "none") {
    safe.changes = {};
  } else {
    return null;
  }

  return safe;
}

async function callOpenAI(systemPrompt, userMessage) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  console.log(`[admin-ai-assist] using model: ${model}`);

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: "system",  content: systemPrompt },
        { role: "user",    content: userMessage  },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json();
  const raw  = json.choices?.[0]?.message?.content || "{}";
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, action } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── propose ───────────────────────────────────────────────────────────────
  if (action === "propose") {
    if (!(process.env.OPENAI_API_KEY || "").trim()) {
      return res.status(503).json({
        error:    "AI assistant is not available: OPENAI_API_KEY is not configured.",
        disabled: true,
      });
    }

    const userMessage = String(body.message || "").slice(0, 2000);
    if (!userMessage.trim()) {
      return res.status(400).json({ error: "message is required." });
    }

    const context = body.context || {};
    const systemPrompt = buildSystemPrompt(context);

    try {
      const raw      = await callOpenAI(systemPrompt, userMessage);
      const proposal = sanitizeProposal(raw);
      if (!proposal) {
        return res.status(200).json({
          proposal: { type: "none", explanation: "The AI response could not be understood or contained disallowed fields. Please rephrase your request.", changes: {} },
        });
      }
      return res.status(200).json({ proposal });
    } catch (err) {
      console.error("[admin-ai-assist] propose error:", err);
      return res.status(500).json({ error: openAIErrorMessage(err, process.env.OPENAI_MODEL || "gpt-5.4-mini") });
    }
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  if (action === "apply") {
    const proposal = sanitizeProposal(body.proposal);
    if (!proposal || proposal.type === "none") {
      return res.status(400).json({ error: "No valid proposal to apply." });
    }

    const sb = getSupabaseAdmin();
    if (!sb) {
      return res.status(503).json({ error: "Supabase is not configured." });
    }

    try {
      if (proposal.type === "settings_update") {
        const settings = proposal.changes.settings || {};
        if (Object.keys(settings).length === 0) {
          return res.status(400).json({ error: "No settings changes in proposal." });
        }

        // Fetch current for revision snapshot
        const { data: currentRows } = await sb.from("site_settings").select("key, value");
        const before = {};
        for (const row of (currentRows || [])) before[row.key] = row.value;

        const upsertRows = Object.entries(settings).map(([key, value]) => ({
          key,
          value: value === null || value === undefined ? null : String(value),
          updated_at: new Date().toISOString(),
        }));
        const { error: upsertErr } = await sb
          .from("site_settings")
          .upsert(upsertRows, { onConflict: "key" });
        if (upsertErr) throw new Error(upsertErr.message);

        const after = { ...before, ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v === null ? null : String(v)])) };
        await sb.from("content_revisions").insert({
          resource_type: "site_settings",
          resource_id:   "global",
          before,
          after,
          changed_keys:  Object.keys(settings),
          created_at:    new Date().toISOString(),
        });

        return res.status(200).json({ ok: true, applied: proposal });
      }

      if (proposal.type === "block_create") {
        const block      = proposal.changes.block;
        const block_id   = crypto.randomUUID();
        const now        = new Date().toISOString();
        const toInsert   = { ...block, block_id, created_at: now, updated_at: now };
        if (toInsert.active === undefined) toInsert.active = true;
        if (toInsert.sort_order === undefined) toInsert.sort_order = 0;

        const { data, error } = await sb.from("content_blocks").insert(toInsert).select().single();
        if (error) throw new Error(error.message);

        await sb.from("content_revisions").insert({
          resource_type: "content_blocks",
          resource_id:   block_id,
          before:        null,
          after:         data,
          changed_keys:  Object.keys(toInsert),
          created_at:    now,
        });
        return res.status(200).json({ ok: true, applied: proposal, block: data });
      }

      if (proposal.type === "block_update") {
        const { block_id, updates } = proposal.changes;
        const { data: existing, error: fetchErr } = await sb
          .from("content_blocks").select("*").eq("block_id", block_id).single();
        if (fetchErr || !existing) return res.status(404).json({ error: "Block not found." });

        const safe = { ...updates, updated_at: new Date().toISOString() };
        const { data, error } = await sb
          .from("content_blocks").update(safe).eq("block_id", block_id).select().single();
        if (error) throw new Error(error.message);

        await sb.from("content_revisions").insert({
          resource_type: "content_blocks",
          resource_id:   block_id,
          before:        existing,
          after:         data,
          changed_keys:  Object.keys(updates),
          created_at:    new Date().toISOString(),
        });
        return res.status(200).json({ ok: true, applied: proposal, block: data });
      }

      if (proposal.type === "block_delete") {
        const { block_id } = proposal.changes;
        const { data: existing, error: fetchErr } = await sb
          .from("content_blocks").select("*").eq("block_id", block_id).single();
        if (fetchErr || !existing) return res.status(404).json({ error: "Block not found." });

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
        return res.status(200).json({ ok: true, applied: proposal });
      }

      return res.status(400).json({ error: `Unsupported proposal type: ${proposal.type}` });
    } catch (err) {
      console.error("[admin-ai-assist] apply error:", err);
      return res.status(500).json({ error: "Failed to apply proposal." });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
