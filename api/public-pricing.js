// api/public-pricing.js
// Public GET endpoint — returns the current rental pricing from Supabase
// system_settings so the website frontend (fleet page, chatbot) can display
// live, admin-configurable prices without requiring a code deployment.
//
// No authentication required — these are exactly the prices customers see.
// Falls back to _pricing.js defaults when Supabase is unavailable.
//
// GET /api/public-pricing
// Response: { slingshot: {...}, economy: {...}, tax_rate }

import { loadPricingSettings, PRICING_DEFAULTS } from "./_settings.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache pricing for up to 5 minutes (s-maxage=300) so the CDN doesn't hammer
  // Supabase on every page load. stale-while-revalidate=60 allows serving the
  // cached value for an additional 60 seconds while the CDN refreshes in the
  // background — so the total maximum staleness is 6 minutes (5 min fresh + 1 min stale).
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const s = await loadPricingSettings();
    return res.status(200).json({
      slingshot: {
        "3hr":             s.slingshot_3hr_rate,
        "6hr":             s.slingshot_6hr_rate,
        "24hr":            s.slingshot_daily_rate,
        "48hr":            s.slingshot_2day_rate,
        "72hr":            s.slingshot_3day_rate,
        security_deposit:  s.slingshot_security_deposit,
        booking_deposit:   s.slingshot_booking_deposit,
      },
      economy: {
        daily:           s.camry_daily_rate,
        weekly:          s.camry_weekly_rate,
        biweekly:        s.camry_biweekly_rate,
        monthly:         s.camry_monthly_rate,
        booking_deposit: s.camry_booking_deposit,
      },
      tax_rate: s.la_tax_rate,
    });
  } catch (err) {
    console.error("public-pricing error:", err);
    // Fall back to hardcoded defaults so the page always renders something
    return res.status(200).json({
      slingshot: {
        "3hr":             PRICING_DEFAULTS.slingshot_3hr_rate,
        "6hr":             PRICING_DEFAULTS.slingshot_6hr_rate,
        "24hr":            PRICING_DEFAULTS.slingshot_daily_rate,
        "48hr":            PRICING_DEFAULTS.slingshot_2day_rate,
        "72hr":            PRICING_DEFAULTS.slingshot_3day_rate,
        security_deposit:  PRICING_DEFAULTS.slingshot_security_deposit,
        booking_deposit:   PRICING_DEFAULTS.slingshot_booking_deposit,
      },
      economy: {
        daily:           PRICING_DEFAULTS.camry_daily_rate,
        weekly:          PRICING_DEFAULTS.camry_weekly_rate,
        biweekly:        PRICING_DEFAULTS.camry_biweekly_rate,
        monthly:         PRICING_DEFAULTS.camry_monthly_rate,
        booking_deposit: PRICING_DEFAULTS.camry_booking_deposit,
      },
      tax_rate: PRICING_DEFAULTS.la_tax_rate,
    });
  }
}
