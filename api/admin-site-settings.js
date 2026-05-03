// api/admin-site-settings.js
// Admin endpoint for site-wide settings stored in Supabase.
//
// POST /api/admin-site-settings
// Actions:
//   get    — { secret, action:"get" }
//   update — { secret, action:"update", settings:{...} }
//
// Allowed setting keys are defined in ALLOWED_KEYS below.
// Any key not in ALLOWED_KEYS is silently stripped before persisting.

import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Allowlist of mutable settings keys (flat string keys only).
const ALLOWED_KEYS = new Set([
  "business_name",
  "logo_url",
  "phone",
  "whatsapp",
  "email",
  "instagram_url",
  "facebook_url",
  "tiktok_url",
  "twitter_url",
  "promo_banner_enabled",
  "promo_banner_text",
  "hero_image_url",
  "hero_title",
  "hero_subtitle",
  "about_text",
  "policies_cancellation",
  "policies_damage",
  "policies_fuel",
  "policies_age",
  "service_area_notes",
  "pickup_instructions",
]);

// Default values returned when Supabase is not configured.
const DEFAULT_SETTINGS = {
  business_name:          "SLY Transportation Services",
  logo_url:               "",
  phone:                  "",
  whatsapp:               "",
  email:                  "",
  instagram_url:          "",
  facebook_url:           "",
  tiktok_url:             "",
  twitter_url:            "",
  promo_banner_enabled:   false,
  promo_banner_text:      "",
  hero_image_url:         "",
  hero_title:             "Explore LA in Style",
  hero_subtitle:          "Affordable car rentals in Los Angeles",
  about_text:             "",
  policies_cancellation:  "",
  policies_damage:        "",
  policies_fuel:          "",
  policies_age:           "",
  service_area_notes:     "",
  pickup_instructions:    "",
};

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

  const body   = req.body || {};
  const { secret, action } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();

  if (action === "get") {
    if (!sb) {
      return res.status(200).json({ settings: DEFAULT_SETTINGS, source: "default" });
    }
    try {
      const { data, error } = await sb
        .from("site_settings")
        .select("key, value")
        .order("key");

      if (error) throw new Error(error.message);

      const settings = { ...DEFAULT_SETTINGS };
      for (const row of (data || [])) {
        if (ALLOWED_KEYS.has(row.key)) {
          settings[row.key] = row.value;
        }
      }
      return res.status(200).json({ settings, source: "supabase" });
    } catch (err) {
      console.error("[admin-site-settings] get error:", err);
      return res.status(500).json({ error: "Failed to load settings." });
    }
  }

  if (action === "update") {
    const incoming = body.settings || {};
    // Strip keys not in the allowlist
    const safe = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (ALLOWED_KEYS.has(k)) safe[k] = v;
    }
    if (Object.keys(safe).length === 0) {
      return res.status(400).json({ error: "No valid settings keys provided." });
    }

    if (!sb) {
      return res.status(503).json({ error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your Vercel environment variables." });
    }

    try {
      // Fetch current settings for revision snapshot
      const { data: currentRows } = await sb
        .from("site_settings")
        .select("key, value");

      const snapshot = { ...DEFAULT_SETTINGS };
      for (const row of (currentRows || [])) {
        if (ALLOWED_KEYS.has(row.key)) snapshot[row.key] = row.value;
      }

      // Upsert updated keys
      const upsertRows = Object.entries(safe).map(([key, value]) => ({
        key,
        value: value === null || value === undefined ? null : String(value),
        updated_at: new Date().toISOString(),
      }));
      const { error: upsertErr } = await sb
        .from("site_settings")
        .upsert(upsertRows, { onConflict: "key" });
      if (upsertErr) throw new Error(upsertErr.message);

      // Save revision
      const after = { ...snapshot, ...Object.fromEntries(Object.entries(safe).map(([k, v]) => [k, v === null ? null : String(v)])) };
      await sb.from("content_revisions").insert({
        resource_type: "site_settings",
        resource_id:   "global",
        before:        snapshot,
        after,
        changed_keys:  Object.keys(safe),
        created_at:    new Date().toISOString(),
      });

      return res.status(200).json({ ok: true, updated: Object.keys(safe) });
    } catch (err) {
      console.error("[admin-site-settings] update error:", err);
      return res.status(500).json({ error: "Failed to save settings." });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
