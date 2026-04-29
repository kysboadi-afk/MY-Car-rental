// api/open-dates.js
// Vercel serverless function — removes a blocked date range from booked-dates.json
// so that previously unavailable dates become bookable again (e.g. after a cancellation).
//
// Required environment variables:
//   GITHUB_TOKEN  — personal access token with contents:write on the repo
//   ADMIN_SECRET  — a secret string the caller must supply to authorise the request
//
// Request body (JSON):
//   {
//     "secret":    "<ADMIN_SECRET value>",
//     "vehicleId": "camry" | "camry2013",
//     "from":      "YYYY-MM-DD",
//     "to":        "YYYY-MM-DD"
//   }
//
// The endpoint removes every stored range whose [from, to] overlaps the
// requested range.

import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Guard: ADMIN_SECRET must be configured
  if (!process.env.ADMIN_SECRET) {
    console.error("ADMIN_SECRET environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  // Guard: GITHUB_TOKEN must be configured to write the file
  // (Phase 4: JSON write disabled, guard kept for compatibility but no longer blocks)

  const { secret, vehicleId, from, to } = req.body || {};

  // Authenticate the caller
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validate inputs
  if (!vehicleId || typeof vehicleId !== "string") {
    return res.status(400).json({ error: "vehicleId is required" });
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !ISO_DATE.test(from)) {
    return res.status(400).json({ error: "from must be a date in YYYY-MM-DD format" });
  }
  if (!to || !ISO_DATE.test(to)) {
    return res.status(400).json({ error: "to must be a date in YYYY-MM-DD format" });
  }
  if (from > to) {
    return res.status(400).json({ error: "from must not be after to" });
  }

  // Phase 4: booked-dates.json writes disabled — Supabase is the only write source.
  // The JSON load/save infrastructure is removed; Supabase is written directly.
  try {
    let removed = 0;
    let locked = 0;
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        const { count: lockedCount, error: countErr } = await sb
          .from("blocked_dates")
          .select("id", { head: true, count: "exact" })
          .eq("vehicle_id", vehicleId)
          .lte("start_date", to)
          .gte("end_date", from)
          .eq("reason", "booking");
        if (!countErr) locked = Number(lockedCount || 0);

        const { error: sbErr } = await sb
          .from("blocked_dates")
          .delete()
          .eq("vehicle_id", vehicleId)
          .lte("start_date", to)
          .gte("end_date", from)
          .or("reason.is.null,reason.neq.booking");
        if (sbErr) {
          console.warn("open-dates: Supabase delete failed (non-fatal):", sbErr.message);
        } else {
          removed = 1;
        }
      }
    } catch (sbErr) {
      console.warn("open-dates: Supabase sync failed (non-fatal):", sbErr.message);
    }

    return res.status(200).json({ success: true, removed, locked });
  } catch (err) {
    console.error("open-dates endpoint error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
