// api/booked-dates.js
// Vercel serverless function — serves booked-dates.json merged with real-time
// Supabase booking data.
//
// When Supabase is configured, this endpoint merges date ranges from:
//   1. booked-dates.json  (GitHub)         — legacy static blocked ranges
//   2. Supabase bookings table             — active bookings (pickup/return dates)
//   3. Supabase blocked_dates table        — manual admin blocks / maintenance
//
// The merged result guarantees that any booking saved to Supabase immediately
// appears on the calendar, even before booked-dates.json is updated.
//
// When Supabase is not configured the endpoint falls back to reading only from
// booked-dates.json as before.
//
// GitHub Pages CDN caches static files for several minutes after a commit,
// so fetching booked-dates.json directly from the Pages URL gives stale data.
// This endpoint reads the file from the GitHub Contents API on every request
// so the calendar always reflects the latest blocked ranges immediately after
// a booking is confirmed.
//
// Optional environment variable:
//   GITHUB_TOKEN  — increases the GitHub API rate limit from 60 to 5 000
//                   requests/hour.  Not required but recommended.
//   GITHUB_REPO   — repo in "owner/name" format (defaults to kysboadi-afk/SLY-RIDES)

import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
// Statuses that mean the vehicle is actually occupied / unavailable
const ACTIVE_STATUSES = ["pending", "approved", "active", "reserved_unpaid", "booked_paid", "active_rental"];

/**
 * Merge date ranges for a vehicle without adding duplicates.
 * @param {Array} existing  - array of {from, to} ranges already in the map
 * @param {string} from     - YYYY-MM-DD
 * @param {string} to       - YYYY-MM-DD
 */
function mergeRange(existing, from, to) {
  if (!from || !to) return;
  const already = existing.some((r) => r.from === from && r.to === to);
  if (!already) existing.push({ from, to });
}

/**
 * Load active bookings from Supabase and add their date ranges to the map.
 * Non-fatal — returns without modifying the map on any error.
 */
async function mergeSupabaseBookings(sb, map) {
  try {
    const { data: rows, error } = await sb
      .from("bookings")
      .select("vehicle_id, pickup_date, return_date")
      .in("status", ACTIVE_STATUSES)
      .not("pickup_date", "is", null)
      .not("return_date", "is", null);

    if (error) {
      console.warn("booked-dates: Supabase bookings query error (non-fatal):", error.message);
      return;
    }
    for (const row of rows || []) {
      const vid = row.vehicle_id;
      if (!vid) continue;
      if (!map[vid]) map[vid] = [];
      mergeRange(map[vid], row.pickup_date, row.return_date);
    }
  } catch (err) {
    console.warn("booked-dates: Supabase bookings merge error (non-fatal):", err.message);
  }
}

/**
 * Load blocked_dates from Supabase and add them to the map.
 * Non-fatal — returns without modifying the map on any error.
 */
async function mergeSupabaseBlockedDates(sb, map) {
  try {
    const { data: rows, error } = await sb
      .from("blocked_dates")
      .select("vehicle_id, start_date, end_date");

    if (error) {
      console.warn("booked-dates: Supabase blocked_dates query error (non-fatal):", error.message);
      return;
    }
    for (const row of rows || []) {
      const vid = row.vehicle_id;
      if (!vid) continue;
      if (!map[vid]) map[vid] = [];
      mergeRange(map[vid], row.start_date, row.end_date);
    }
  } catch (err) {
    console.warn("booked-dates: Supabase blocked_dates merge error (non-fatal):", err.message);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // Never cache — we need fresh data on every request so blocked dates appear
  // immediately after a booking is confirmed.
  res.setHeader("Cache-Control", "no-store");

  // ── 1. Load static booked-dates.json from GitHub ─────────────────────────
  let map = {};
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const ghRes = await fetch(apiUrl, { headers });
    if (ghRes.ok) {
      const fileData = await ghRes.json();
      map = JSON.parse(
        Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
      );
      if (typeof map !== "object" || Array.isArray(map)) map = {};
    } else {
      console.warn(`booked-dates: GitHub Contents API returned ${ghRes.status} for ${BOOKED_DATES_PATH}`);
    }
  } catch (err) {
    console.error("booked-dates: GitHub fetch error (non-fatal):", err.message);
  }

  // ── 2. Merge Supabase data when configured ────────────────────────────────
  try {
    const sb = getSupabaseAdmin();
    if (sb) {
      await mergeSupabaseBookings(sb, map);
      await mergeSupabaseBlockedDates(sb, map);
    }
  } catch (err) {
    console.warn("booked-dates: Supabase client init error (non-fatal):", err.message);
  }

  return res.status(200).json(map);
}

