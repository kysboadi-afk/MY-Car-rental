// api/stripe-reconcile-cron.js
// Vercel cron — automated Stripe ↔ DB reconciliation.
//
// Runs every 8 hours (see vercel.json: "0 */8 * * *").
// Calls runSyncRecent with a 48-hour lookback window so that consecutive
// 8-hour runs always overlap, guaranteeing no payment falls through the gap.
//
// Auth:
//   GET  — called by Vercel cron scheduler (no auth required from Vercel)
//   POST — manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_SECRET or CRON_SECRET  (POST only)
//   SMTP_*  + OWNER_EMAIL        (optional — enables admin alert emails)
//
// Response (always HTTP 200 except auth failures):
// {
//   ok:             boolean,
//   lookback_hours: number,
//   total:          number,
//   processed:      number,
//   recovered:      number,
//   errors:         number,
//   details:        { processed, recovered, errors },
//   duration_ms:    number,
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { runSyncRecent } from "./stripe-reconcile.js";

// How far back to scan on each cron run.  48 h > 8 h cron interval so
// consecutive runs always overlap — no PI can slip through the gap.
const LOOKBACK_HOURS = 48;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Manual POST requires ADMIN_SECRET or CRON_SECRET
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const token      = authHeader.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const startedAt = Date.now();

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(200).json({
      skipped:     true,
      reason:      "STRIPE_SECRET_KEY is not configured",
      duration_ms: Date.now() - startedAt,
    });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({
      skipped:     true,
      reason:      "Supabase is not configured",
      duration_ms: Date.now() - startedAt,
    });
  }

  try {
    const result = await runSyncRecent(sb, LOOKBACK_HOURS);
    return res.status(200).json({
      ...result,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("stripe-reconcile-cron error:", err);
    // Return 200 so Vercel does not mark the cron as failed and retry
    // aggressively; the error detail is included in the response body.
    return res.status(200).json({
      ok:          false,
      error:       err.message || String(err),
      duration_ms: Date.now() - startedAt,
    });
  }
}
