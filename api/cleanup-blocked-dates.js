// api/cleanup-blocked-dates.js
// Vercel cron serverless function — auto-removes expired blocked_dates rows
// whose end_date is strictly in the past.
//
// Scheduled via vercel.json crons (daily at 02:00 UTC).
// Also callable manually:
//   GET /api/cleanup-blocked-dates
//   Authorization: Bearer <CRON_SECRET>
//
// Required environment variables:
//   CRON_SECRET  — shared secret to authenticate manual trigger calls
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — Supabase admin client

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function isCronAuthorized(req) {
  // Vercel cron requests include an Authorization header with the CRON_SECRET.
  const authHeader = req.headers?.authorization || "";
  const cronSecret = process.env.CRON_SECRET || "";
  if (!cronSecret) return false;
  return authHeader === `Bearer ${cronSecret}`;
}

export default async function handler(req, res) {
  const origin = req.headers?.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.warn("cleanup-blocked-dates: Supabase not configured — skipping");
    return res.status(200).json({ skipped: true, reason: "supabase_not_configured" });
  }

  // today in YYYY-MM-DD (UTC)
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { data, error } = await sb
      .from("blocked_dates")
      .delete()
      .lt("end_date", today)
      .select("id, vehicle_id, start_date, end_date, reason");

    if (error) {
      console.error("cleanup-blocked-dates: Supabase delete error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    const removed = (data || []).length;
    console.log(`cleanup-blocked-dates: removed ${removed} expired row(s) (before ${today})`);
    return res.status(200).json({ success: true, removed, before: today, rows: data || [] });
  } catch (err) {
    console.error("cleanup-blocked-dates: unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
