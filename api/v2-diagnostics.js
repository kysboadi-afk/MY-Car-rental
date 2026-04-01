// api/v2-diagnostics.js
// SLYTRANS Fleet Control v2 — System diagnostics endpoint.
// Returns a health report covering environment variables, Supabase connectivity,
// and table/view existence.  Admin-protected.
//
// POST /api/v2-diagnostics
// Body: { "secret": "<ADMIN_SECRET>" }
//
// Response shape:
// {
//   env: {
//     ADMIN_SECRET:             "ok" | "missing",
//     GITHUB_TOKEN:             "ok" | "missing",
//     SUPABASE_URL:             "ok" | "missing",
//     SUPABASE_SERVICE_ROLE_KEY:"ok" | "missing",
//     STRIPE_SECRET_KEY:        "ok" | "missing",
//     SMTP_HOST:                "ok" | "missing",
//     TEXTMAGIC_USERNAME:       "ok" | "missing",
//     OPENAI_API_KEY:           "ok" | "missing" | "not required",
//   },
//   supabase: {
//     connected: boolean,
//     error:     string | null,
//     tables: {
//       [tableName]: "ok" | "missing" | "error"
//     }
//   }
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// All tables that the v2 admin panel reads from or writes to.
const REQUIRED_TABLES = [
  "vehicles",
  "protection_plans",
  "system_settings",
  "revenue_records",
  "expenses",
  "customers",
  "sms_template_overrides",
  "bookings",
  "blocked_dates",
];

// Optional tables — present in the full schema but not strictly required for
// all v2 panel features.
const OPTIONAL_TABLES = [
  "booking_status_history",
  "payment_transactions",
  "site_settings",
  "content_blocks",
  "content_revisions",
];

/**
 * Check whether a table exists in the connected Supabase project by selecting
 * a single row with a zero-limit query.  Returns "ok", "missing", or "error".
 */
async function checkTable(sb, tableName) {
  try {
    const { error } = await sb.from(tableName).select("*").limit(1);
    if (!error) return "ok";
    const code = error.code || "";
    const msg  = error.message || "";
    if (
      code === "42P01" || code === "PGRST200" || code === "PGRST204" ||
      /relation .* does not exist|table .* not found/i.test(msg)
    ) {
      return "missing";
    }
    return "error";
  } catch {
    return "error";
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret } = req.body || {};
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Environment variable checks ──────────────────────────────────────────
  // Required variables return "ok" when set, "missing" when absent.
  // Optional variables (OPENAI_API_KEY) return "ok" when set, "optional" when absent,
  // so the UI can distinguish "you need to add this" from "this is fine to skip".
  const env = {
    ADMIN_SECRET:              process.env.ADMIN_SECRET              ? "ok" : "missing",
    GITHUB_TOKEN:              process.env.GITHUB_TOKEN              ? "ok" : "missing",
    SUPABASE_URL:              process.env.SUPABASE_URL              ? "ok" : "missing",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? "ok" : "missing",
    STRIPE_SECRET_KEY:         process.env.STRIPE_SECRET_KEY         ? "ok" : "missing",
    SMTP_HOST:                 process.env.SMTP_HOST                 ? "ok" : "missing",
    TEXTMAGIC_USERNAME:        process.env.TEXTMAGIC_USERNAME        ? "ok" : "missing",
    // Optional — only needed for the AI assistant feature.
    OPENAI_API_KEY:            process.env.OPENAI_API_KEY            ? "ok" : "optional",
    OPENAI_MODEL:              process.env.OPENAI_MODEL              || "gpt-5.4-mini (default)",
  };

  // ── Supabase connectivity and table checks ───────────────────────────────
  const supabaseResult = {
    connected: false,
    error:     null,
    tables:    {},
  };

  const sb = getSupabaseAdmin();
  if (!sb) {
    supabaseResult.error = "Supabase client not initialised — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.";
  } else {
    // Test connectivity with a lightweight query on a well-known table
    try {
      const { error: pingErr } = await sb.from("vehicles").select("vehicle_id").limit(1);
      if (pingErr && (pingErr.code !== "42P01" && pingErr.code !== "PGRST200" && pingErr.code !== "PGRST204")) {
        supabaseResult.error = pingErr.message;
      } else {
        supabaseResult.connected = true;
      }
    } catch (err) {
      supabaseResult.error = err.message || "Unexpected error connecting to Supabase";
    }

    if (supabaseResult.connected) {
      // Check all required tables
      for (const table of REQUIRED_TABLES) {
        supabaseResult.tables[table] = await checkTable(sb, table);
      }
      // Check optional tables
      for (const table of OPTIONAL_TABLES) {
        supabaseResult.tables[table] = await checkTable(sb, table);
      }
    }
  }

  return res.status(200).json({ env, supabase: supabaseResult });
}
