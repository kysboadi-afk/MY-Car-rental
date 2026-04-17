// api/v2-availability.js
// SLYTRANS FLEET CONTROL v2 — Real-time availability endpoint.
//
// Checks vehicle availability directly from the Supabase `bookings` table so
// that availability always reflects actual bookings, not just the static
// booked-dates.json file.
//
// GET /api/v2-availability?vehicleId=camry&from=2026-05-01&to=2026-05-07
//   Returns: { available: boolean, conflicts: [...] }
//
// GET /api/v2-availability?from=2026-05-01&to=2026-05-07
//   Returns: { vehicles: { camry: true/false, ... } }  (all vehicles)
//
// POST /api/v2-availability  { vehicleId?, from, to }
//   Same as GET but accepts JSON body.

import { getSupabaseAdmin } from "./_supabase.js";
import { hasOverlap, hasDateTimeOverlap } from "./_availability.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
const ACTIVE_STATUSES  = ["pending", "approved", "active", "reserved_unpaid", "booked_paid", "active_rental"];
const GITHUB_REPO      = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";

/**
 * Fetch booked-dates.json from GitHub as a fallback when Supabase is not
 * configured.  Returns {} on any error.
 */
async function fetchGitHubBookedDates() {
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/booked-dates.json`;
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const resp = await fetch(apiUrl, { headers });
    if (!resp.ok) return {};
    const fileData = await resp.json();
    return JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

/**
 * Check availability for one vehicle against the Supabase bookings table.
 * Falls back to booked-dates.json when Supabase is not configured.
 * When fromTime/toTime are provided the check is time-aware so back-to-back
 * bookings sharing a return/pickup date at the same time are correctly allowed.
 *
 * @param {object} sb         - Supabase admin client (may be null)
 * @param {object} fallback   - booked-dates.json data (fallback)
 * @param {string} vehicleId
 * @param {string} from       - YYYY-MM-DD
 * @param {string} to         - YYYY-MM-DD
 * @param {string} [fromTime] - optional "H:MM AM/PM" pickup time
 * @param {string} [toTime]   - optional "H:MM AM/PM" return time
 * @returns {{ available: boolean, conflicts: object[], source: string }}
 */
async function checkVehicleAvailability(sb, fallback, vehicleId, from, to, fromTime, toTime) {
  if (sb) {
    try {
      // Query Supabase bookings for any active booking that overlaps [from, to].
      // Overlap condition: pickup_date <= to AND return_date >= from
      const { data: rows, error } = await sb
        .from("bookings")
        .select("booking_ref, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, customer_id")
        .eq("vehicle_id", vehicleId)
        .in("status", ACTIVE_STATUSES)
        .lte("pickup_date", to)
        .gte("return_date", from);

      if (error) {
        console.error(`v2-availability: Supabase query error for ${vehicleId}:`, error.message);
        // Fall through to JSON fallback
      } else {
        // If times were provided, refine the date-level hits with time-aware checking.
        // Supabase stores times as "HH:MM:SS" (24-hour); convert them to "H:MM AM/PM"
        // for hasDateTimeOverlap which uses parseDateTimeMs from _availability.js.
        let conflicts = rows || [];
        if (fromTime && toTime && conflicts.length > 0) {
          // Build ranges array from Supabase rows and run the datetime overlap check.
          const sbRanges = conflicts.map((r) => ({
            from:     r.pickup_date,
            to:       r.return_date,
            fromTime: pgTimeTo12h(r.pickup_time),
            toTime:   pgTimeTo12h(r.return_time),
          }));
          const overlaps = hasDateTimeOverlap(sbRanges, from, to, fromTime, toTime);
          if (!overlaps) {
            // Time-level check shows no actual overlap — vehicle is available.
            return { available: true, conflicts: [], source: "supabase" };
          }
        }
        return {
          available: conflicts.length === 0,
          conflicts,
          source: "supabase",
        };
      }
    } catch (err) {
      console.error(`v2-availability: Supabase exception for ${vehicleId}:`, err.message);
    }
  }

  // Fallback: booked-dates.json (time-aware when both fromTime and toTime are provided)
  const ranges = (fallback[vehicleId] || []);
  const available = (fromTime && toTime)
    ? !hasDateTimeOverlap(ranges, from, to, fromTime, toTime)
    : !hasOverlap(ranges, from, to);
  return { available, conflicts: available ? [] : ranges.filter((r) => from <= r.to && r.from <= to), source: "booked-dates-json" };
}

/**
 * Convert a PostgreSQL time string "HH:MM:SS" to 12-hour "H:MM AM/PM" format.
 * Returns null when the input is absent or unparseable.
 *
 * @param {string|null} pgTime - e.g. "09:00:00" or "13:30:00"
 * @returns {string|null}
 */
function pgTimeTo12h(pgTime) {
  if (!pgTime || typeof pgTime !== "string") return null;
  const m = pgTime.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${mins} ${ampm}`;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Accept params from query string (GET) or JSON body (POST)
  const params = req.method === "GET" ? req.query : (req.body || {});
  const { vehicleId, from, to, fromTime, toTime } = params;

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !ISO_DATE.test(from)) {
    return res.status(400).json({ error: "from must be YYYY-MM-DD" });
  }
  if (!to || !ISO_DATE.test(to)) {
    return res.status(400).json({ error: "to must be YYYY-MM-DD" });
  }
  if (to < from) {
    return res.status(400).json({ error: "to must not be before from" });
  }
  if (vehicleId && !ALLOWED_VEHICLES.includes(vehicleId)) {
    return res.status(400).json({ error: "Invalid vehicleId" });
  }

  const sb = getSupabaseAdmin();
  // Always pre-fetch booked-dates.json so that if Supabase IS configured but a
  // query fails we still return accurate data instead of treating every vehicle
  // as available (which could allow double-bookings during Supabase outages).
  const fallback = await fetchGitHubBookedDates();

  if (vehicleId) {
    // Single vehicle check
    const result = await checkVehicleAvailability(sb, fallback, vehicleId, from, to, fromTime, toTime);
    return res.status(200).json({
      vehicleId,
      from,
      to,
      available:  result.available,
      conflicts:  result.conflicts,
      source:     result.source,
    });
  }

  // All vehicles
  const results = {};
  for (const vid of ALLOWED_VEHICLES) {
    const result = await checkVehicleAvailability(sb, fallback, vid, from, to, fromTime, toTime);
    results[vid] = {
      available: result.available,
      conflicts: result.conflicts,
      source:    result.source,
    };
  }

  return res.status(200).json({ from, to, vehicles: results });
}
