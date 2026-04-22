// api/fleet-status.js
// Vercel serverless function — returns the current availability status of each
// fleet vehicle.
//
// Data source priority:
//   1. Supabase `vehicles` table  (rental_status: 'available' | 'reserved' |
//                                  'rented' | 'maintenance')
//   2. GitHub fleet-status.json   (legacy { vehicleId: { available: bool } } format)
//   3. Hard-coded defaults        (all available)
//
// Response: { slingshot: { available, rental_status, available_at? }, camry: { … }, … }
//
// available_at (ISO timestamp) is included when the vehicle is currently
// rented or within the 2-hour post-return buffer:
//   • If booking has actual_return_time (early/on-time return, buffer active):
//       available_at = actual_return_time + 2 h
//   • Else (active rental, no return recorded yet):
//       available_at = return_date + 1 day T00:00:00Z  (existing day-level logic)
// Logs [AVAILABILITY_COMPUTED_WITH_TIME] for every vehicle that has timing data.

import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_STATUS_PATH = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const ALL_VEHICLES = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
// 2-hour buffer applied after a vehicle is returned before showing it as available
const RETURN_BUFFER_MS = 2 * 60 * 60 * 1000;

const DEFAULT_STATUS = {
  slingshot:  { available: true,  rental_status: "available" },
  slingshot2: { available: true,  rental_status: "available" },
  slingshot3: { available: true,  rental_status: "available" },
  camry:      { available: true,  rental_status: "available" },
  camry2013:  { available: true,  rental_status: "available" },
};

/** Convert Supabase rental_status → boolean available for backwards compat */
function rentalStatusToAvailable(status) {
  return status === "available";
}

/**
 * Enriches each entry in `result` with an `available_at` ISO timestamp by
 * querying the bookings table.
 *
 * Priority (highest wins):
 *   1. Completed booking with actual_return_time on today's date (local calendar day):
 *        available_at = actual_return_time + RETURN_BUFFER_MS
 *      Any car returned today — even hours ago — shows time-based availability so
 *      the fleet page can display "Available Today at [time]".
 *   2. Active rental (status = 'active', no actual return yet):
 *        available_at = return_date + 1 day T00:00:00Z  (date-level, same as getNextAvailDate)
 *
 * Logs [AVAILABILITY_COMPUTED_WITH_TIME] for each vehicle that receives a value.
 * Non-fatal — silently skips on any error.
 *
 * @param {object} sb     - Supabase admin client
 * @param {object} result - per-vehicle status map (mutated in place)
 */
async function enrichWithAvailableAt(sb, result) {
  try {
    // Use midnight UTC of the current day so any return today is included,
    // regardless of how many hours ago it happened.
    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);
    const startOfTodayISO = todayUTC.toISOString();

    // Run both queries in parallel for performance
    const [activeRes, returnedRes] = await Promise.all([
      sb
        .from("bookings")
        .select("vehicle_id, return_date")
        .eq("status", "active")
        .in("vehicle_id", ALL_VEHICLES)
        .not("return_date", "is", null)
        .order("return_date", { ascending: true }),
      sb
        .from("bookings")
        .select("vehicle_id, actual_return_time")
        .eq("status", "completed")
        .not("actual_return_time", "is", null)
        .gte("actual_return_time", startOfTodayISO)
        .in("vehicle_id", ALL_VEHICLES)
        .order("actual_return_time", { ascending: false }),
    ]);

    const availableAtMap = {};

    // Lower priority: active rentals — day after scheduled return date
    for (const row of (activeRes.data || [])) {
      if (!row.vehicle_id || !row.return_date) continue;
      if (availableAtMap[row.vehicle_id]) continue; // keep earliest
      const nextDay = new Date(row.return_date + "T00:00:00Z");
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      availableAtMap[row.vehicle_id] = nextDay.toISOString();
    }

    // Higher priority: returned today — exact time known, apply 2h buffer
    for (const row of (returnedRes.data || [])) {
      if (!row.vehicle_id || !row.actual_return_time) continue;
      const availableAt = new Date(new Date(row.actual_return_time).getTime() + RETURN_BUFFER_MS);
      availableAtMap[row.vehicle_id] = availableAt.toISOString();
    }

    for (const [vid, availableAt] of Object.entries(availableAtMap)) {
      if (result[vid]) {
        result[vid].available_at = availableAt;
        console.log("[AVAILABILITY_COMPUTED_WITH_TIME]", {
          vehicle_id:  vid,
          available_at: availableAt,
        });
      }
    }
  } catch (err) {
    console.warn("fleet-status: available_at enrichment failed (non-fatal):", err.message);
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

  // Never cache — we need fresh data so status changes appear immediately.
  res.setHeader("Cache-Control", "no-store");

  // ── 1. Supabase (preferred) ─────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data: rows, error } = await sb
        .from("vehicles")
        .select("vehicle_id, rental_status")
        .in("vehicle_id", ALL_VEHICLES);

      if (!error && rows && rows.length > 0) {
        const result = { ...DEFAULT_STATUS };
        for (const row of rows) {
          if (row.vehicle_id) {
            result[row.vehicle_id] = {
              available:     rentalStatusToAvailable(row.rental_status),
              rental_status: row.rental_status || "available",
            };
          }
        }
        await enrichWithAvailableAt(sb, result);
        return res.status(200).json(result);
      }
      if (error) console.warn("fleet-status: Supabase error, falling back to GitHub:", error.message);
    } catch (sbErr) {
      console.warn("fleet-status: Supabase threw, falling back to GitHub:", sbErr.message);
    }
  }

  // ── 2. GitHub fleet-status.json fallback ────────────────────────────────
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const ghHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const ghRes = await fetch(apiUrl, { headers: ghHeaders });
    if (ghRes.ok) {
      const fileData = await ghRes.json();
      try {
        const content = JSON.parse(
          Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
        );
        // Merge GitHub data into default structure, adding rental_status field
        const result = { ...DEFAULT_STATUS };
        for (const [vid, val] of Object.entries(content)) {
          if (ALL_VEHICLES.includes(vid)) {
            const avail = typeof val.available === "boolean" ? val.available : true;
            result[vid] = {
              available:     avail,
              rental_status: val.rental_status || (avail ? "available" : "maintenance"),
            };
          }
        }
        return res.status(200).json(result);
      } catch (parseErr) {
        console.error("fleet-status: malformed JSON in file:", parseErr);
      }
    }
  } catch (ghErr) {
    console.error("fleet-status: GitHub fetch error:", ghErr.message);
  }

  // ── 3. Hard-coded defaults ──────────────────────────────────────────────
  return res.status(200).json(DEFAULT_STATUS);
}
