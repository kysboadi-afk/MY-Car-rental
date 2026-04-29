// api/site-content.js
// Public read endpoint for site settings + active content blocks.
// Uses the Supabase service-role key server-side with a short cache header.
// Falls back to safe hardcoded defaults when Supabase is not configured.
//
// GET  /api/site-content           — all settings + all active blocks
// GET  /api/site-content?type=faq  — settings + blocks filtered by type

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const CACHE_SECONDS   = 60; // public CDN/browser cache

const DEFAULT_SETTINGS = {
  business_name:          "SLY Transportation Services",
  phone:                  "",
  whatsapp:              "",
  email:                 "",
  instagram_url:         "",
  facebook_url:          "",
  tiktok_url:            "",
  twitter_url:           "",
  promo_banner_enabled:  false,
  promo_banner_text:     "",
  hero_title:            "Explore LA in Style",
  hero_subtitle:         "Affordable car rentals in Los Angeles",
  about_text:            "",
  policies_cancellation: "",
  policies_damage:       "",
  policies_fuel:         "",
  policies_age:          "",
  service_area_notes:    "",
  pickup_instructions:   "",
};

const ALLOWED_BLOCK_TYPES = ["faq", "announcement", "testimonial"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=120`);

  const typeFilter = req.query?.type;
  const sb         = getSupabaseAdmin();

  if (!sb) {
    // Graceful fallback — Supabase not configured
    return res.status(200).json({
      settings: DEFAULT_SETTINGS,
      blocks:   [],
      source:   "default",
    });
  }

  try {
    const [settingsResult, blocksQuery] = await Promise.all([
      sb.from("site_settings").select("key, value"),
      (() => {
        let q = sb
          .from("content_blocks")
          .select("*")
          .eq("active", true)
          .order("sort_order", { ascending: true })
          .order("created_at",  { ascending: true });

        if (typeFilter && ALLOWED_BLOCK_TYPES.includes(typeFilter)) {
          q = q.eq("type", typeFilter);
        }
        // Only return non-expired announcements
        q = q.or("expires_at.is.null,expires_at.gt." + new Date().toISOString());
        return q;
      })(),
    ]);

    if (settingsResult.error) throw new Error(settingsResult.error.message);
    if (blocksQuery.error)    throw new Error(blocksQuery.error.message);

    const settings = { ...DEFAULT_SETTINGS };
    for (const row of (settingsResult.data || [])) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) {
        settings[row.key] = row.value;
      }
    }
    // Coerce the boolean promo_banner_enabled
    if (typeof settings.promo_banner_enabled === "string") {
      settings.promo_banner_enabled = settings.promo_banner_enabled === "true";
    }

    return res.status(200).json({
      settings,
      blocks: blocksQuery.data || [],
      source: "supabase",
    });
  } catch (err) {
    console.error("[site-content] error:", err);
    // Return defaults rather than a hard error so the public site never breaks
    return res.status(200).json({
      settings: DEFAULT_SETTINGS,
      blocks:   [],
      source:   "default",
    });
  }
}
