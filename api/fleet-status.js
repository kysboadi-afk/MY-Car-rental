// api/fleet-status.js
// Vercel serverless function — returns the current availability status of each
// fleet vehicle.
//
// Single source of truth: Supabase `blocked_dates` table.
//
// A vehicle is unavailable if it has a blocked_dates row whose end_date is
// today or in the future, AND (when end_time is set) the end_time has not yet
// passed in Los Angeles wall-clock time.
//
// vehicles.rental_status = 'maintenance' is still respected as a manual
// override so the fleet manager can take a vehicle offline for servicing
// even when it has no active blocks.
//
// Response: { vehicle_id: { available, rental_status, available_at,
//                           next_available_display }, ... }
//
//   available_at          — ISO 8601 UTC string when end_time is set;
//                           null for legacy date-only blocks.
//   next_available_display — human-readable string, e.g.
//                           "Apr 27, 2026 at 5:00 PM" (time-aware) or
//                           "Apr 27, 2026" (date-only for legacy rows).

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const FALLBACK_VEHICLE_IDS = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
const BUSINESS_TZ = "America/Los_Angeles";


function buildDefaultStatus() {
  const map = {};
  for (const vehicleId of FALLBACK_VEHICLE_IDS) {
    map[vehicleId] = { available: true, rental_status: "available", available_at: null, next_available_display: null };
  }
  return map;
}

function buildDateTimeLA(date, time) {
  if (!date || !time) return new Date(NaN);

  const datePart = String(date).trim().split("T")[0];
  const rawTime = String(time).trim();

  const h24 = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const ampm = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);

  let hours = 0;
  let mins = 0;
  let secs = 0;

  if (ampm) {
    hours = parseInt(ampm[1], 10);
    mins = parseInt(ampm[2], 10);
    secs = parseInt(ampm[3] || "0", 10);
    const period = ampm[4].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
  } else if (h24) {
    hours = parseInt(h24[1], 10);
    mins = parseInt(h24[2], 10);
    secs = parseInt(h24[3] || "0", 10);
  } else {
    return new Date(NaN);
  }

  const hh = String(hours).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const naiveISO = `${datePart}T${hh}:${mm}:${ss}`;
  const approxUtcDate = new Date(`${naiveISO}Z`);

  const tzOffsetStr = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(approxUtcDate).find((p) => p.type === "timeZoneName")?.value ?? "GMT-7:00";

  const offsetMatch = tzOffsetStr.match(/GMT([+-])(\d+):(\d+)/);
  const sign = offsetMatch ? offsetMatch[1] : "-";
  const offsetMin = offsetMatch
    ? (sign === "+" ? 1 : -1) * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3], 10))
    : -420;

  return new Date(approxUtcDate.getTime() - offsetMin * 60 * 1000);
}

function formatDateTimeLA(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const tzOffsetStr = lookup.timeZoneName || "GMT-7:00";
  const offsetMatch = tzOffsetStr.match(/GMT([+-])(\d+):(\d+)/);
  const offsetSign = offsetMatch ? offsetMatch[1] : "-";
  const offsetHour = offsetMatch ? offsetMatch[2].padStart(2, "0") : "07";
  const offsetMin = offsetMatch ? offsetMatch[3].padStart(2, "0") : "00";

  return `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}:${lookup.second}${offsetSign}${offsetHour}:${offsetMin}`;
}

/**
 * Format a Date object as a human-readable string in the LA timezone.
 * Returns "Apr 25, 2026 at 8:00 AM" (with time) or "Apr 25, 2026" (date only).
 * Used to populate `next_available_display` so the frontend never needs to
 * reformat dates — it just renders the pre-built string.
 */
function formatForDisplay(dateObj, includeTime = true) {
  if (!dateObj || !Number.isFinite(dateObj.getTime())) return null;
  const dateStr = dateObj.toLocaleDateString("en-US", {
    timeZone: BUSINESS_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!includeTime) return dateStr;
  const timeStr = dateObj.toLocaleTimeString("en-US", {
    timeZone: BUSINESS_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${dateStr} at ${timeStr}`;
}

/**
 * Build a lookup of the latest blocked end per vehicle_id from a set of
 * blocked_dates rows already filtered to end_date >= today.
 *
 * Returns each vehicle's latest block as { end_date, end_time } where
 * end_time may be null for legacy rows that predate the end_time column.
 * When multiple rows exist for the same vehicle the one with the latest
 * end_date wins; ties are broken by end_time (later time wins, null last).
 *
 * @param {object[]} rows - blocked_dates rows with vehicle_id, end_date[, end_time]
 * @returns {{ [vehicleId]: { end_date: string, end_time: string|null } }}
 */
function computeLatestBlockByVehicle(rows) {
  const latest = {};
  for (const row of (rows || [])) {
    if (!row?.vehicle_id || !row?.end_date) continue;
    const endDate = String(row.end_date).split("T")[0];
    const endTime = row.end_time ? String(row.end_time).substring(0, 5) : null; // "HH:MM"

    const existing = latest[row.vehicle_id];
    if (!existing) {
      latest[row.vehicle_id] = { end_date: endDate, end_time: endTime };
      continue;
    }

    if (endDate > existing.end_date) {
      latest[row.vehicle_id] = { end_date: endDate, end_time: endTime };
    } else if (endDate === existing.end_date) {
      // Same date — prefer the later time; null < any time string.
      const newMins  = endTime       ? parseInt(endTime.replace(":", ""), 10)       : -1;
      const exstMins = existing.end_time ? parseInt(existing.end_time.replace(":", ""), 10) : -1;
      if (newMins > exstMins) {
        latest[row.vehicle_id] = { end_date: endDate, end_time: endTime };
      }
    }
  }
  return latest;
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

  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      // ── 1. Get vehicle IDs + maintenance flags from the vehicles table ────
      // The vehicles table is queried ONLY to know which vehicles exist and
      // whether any are in maintenance mode.  It is NOT used to determine
      // booking-based availability.
      const maintenanceVehicles = new Set();
      const vehicleIds = [...FALLBACK_VEHICLE_IDS];

      const { data: vehicleRows, error: vehicleError } = await sb
        .from("vehicles")
        .select("vehicle_id, rental_status");

      if (!vehicleError && vehicleRows && vehicleRows.length > 0) {
        for (const row of vehicleRows) {
          if (!row.vehicle_id) continue;
          if (!vehicleIds.includes(row.vehicle_id)) vehicleIds.push(row.vehicle_id);
          if (row.rental_status === "maintenance") maintenanceVehicles.add(row.vehicle_id);
        }
      } else if (vehicleError) {
        console.warn("fleet-status: vehicles query error (non-fatal):", vehicleError.message);
      }

      // ── 2. Query blocked_dates — source of truth for availability ────────
      // Fetch rows with end_date >= today (expired rows are cleaned up by the
      // cleanup-blocked-dates cron).  Also select end_time so the handler can
      // provide an accurate "available at" timestamp and correctly expire
      // time-aware blocks mid-day.
      //
      // Use LA timezone for "today" so a booking that returns on Apr 27 LA
      // time stays blocked until the LA calendar rolls to Apr 28.
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()); // YYYY-MM-DD in LA timezone

      // Current time in LA as minutes-since-midnight for robust mid-day block expiry checks.
      const nowLA = new Date();
      const nowMinutesLA = (() => {
        const h = parseInt(nowLA.toLocaleString("en-US", { timeZone: BUSINESS_TZ, hour: "2-digit", hour12: false }), 10);
        const m = parseInt(nowLA.toLocaleString("en-US", { timeZone: BUSINESS_TZ, minute: "2-digit" }), 10);
        return h * 60 + m;
      })();

      /** Convert "HH:MM" end_time to minutes-since-midnight. Returns -1 on failure. */
      function endTimeToMinutes(t) {
        if (!t || typeof t !== "string") return -1;
        const parts = String(t).substring(0, 5).split(":");
        if (parts.length < 2) return -1;
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
        return h * 60 + m;
      }

      const { data: blockedRows, error: blockedError } = await sb
        .from("blocked_dates")
        .select("vehicle_id, end_date, end_time")
        .in("vehicle_id", vehicleIds)
        .gte("end_date", today);

      if (blockedError) throw new Error(blockedError.message || "blocked_dates query failed");

      // ── 3. Derive latest block per vehicle, then expire time-aware blocks ─
      const latestByVehicle = computeLatestBlockByVehicle(blockedRows || []);

      // Post-filter: if a block's end_date is today and its end_time has
      // already passed (in LA time), the vehicle is available again even
      // though end_date >= today still matches the Supabase query.
      for (const [vid, block] of Object.entries(latestByVehicle)) {
        if (block.end_time && block.end_date === today) {
          const blockMins = endTimeToMinutes(block.end_time);
          if (blockMins >= 0 && blockMins <= nowMinutesLA) {
            delete latestByVehicle[vid];
          }
        }
      }

      // ── 4. Build response ─────────────────────────────────────────────────
      const result = {};
      for (const vid of vehicleIds) {
        const block = latestByVehicle[vid]; // { end_date, end_time } or undefined
        const isMaintenance = maintenanceVehicles.has(vid);
        const hasActiveBlock = !!block;

        // Availability: no active block + not in maintenance = available.
        const available = !hasActiveBlock && !isMaintenance;

        const entry = {
          available,
          rental_status: isMaintenance ? "maintenance" : (hasActiveBlock ? "rented" : "available"),
          available_at: null,
          next_available_display: null,
        };

        if (!available && block) {
          if (block.end_time) {
            // Time-aware block: show exact "available at" datetime.
            const endDateObj = buildDateTimeLA(block.end_date, block.end_time);
            entry.available_at       = endDateObj.toISOString();
            entry.next_available_display = formatForDisplay(endDateObj, true);
          } else {
            // Legacy date-only block: show date only.
            // buildDateTimeLA uses noon so the date never shifts due to UTC offset.
            const endDateObj = buildDateTimeLA(block.end_date, "12:00");
            entry.available_at       = null;
            entry.next_available_display = formatForDisplay(endDateObj, false);
          }

          console.log("[AVAILABLE_AT_COMPUTED]", {
            vehicle_id:             vid,
            return_datetime:        entry.available_at,
            next_available_display: entry.next_available_display,
          });
        }

        result[vid] = entry;
      }

      return res.status(200).json(result);
    } catch (err) {
      console.warn("fleet-status: Supabase error, falling back to defaults:", err.message);
    }
  }

  // ── Hard-coded defaults (all available) — only reached when Supabase is
  // not configured or throws during startup.
  return res.status(200).json(buildDefaultStatus());
}
