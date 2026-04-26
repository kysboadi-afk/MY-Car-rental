// api/fleet-status.js
// Vercel serverless function — returns the current availability status of each
// fleet vehicle.
//
// Single source of truth: Supabase `blocked_dates` table.
//
// A vehicle is unavailable if it has a blocked_dates row whose end_date is
// today or in the future.  availability is never read from fleet-status.json,
// vehicles.rental_status, or the bookings table directly.
//
// vehicles.rental_status = 'maintenance' is still respected as a manual
// override so the fleet manager can take a vehicle offline for servicing
// even when it has no active blocks.
//
// Response: { vehicle_id: { available, rental_status, available_at,
//                           next_available_display }, ... }
//
//   available_at          — always null (blocked_dates has no time column).
//   next_available_display — human-readable date string, e.g. "Apr 27, 2026"
//                           (always set for unavailable vehicles).

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
 * Build a lookup of the maximum blocked end_date per vehicle_id from a set of
 * blocked_dates rows already filtered to end_date >= today.
 *
 * @param {object[]} rows - blocked_dates rows with vehicle_id and end_date
 * @returns {{ [vehicleId]: string }} vehicleId → YYYY-MM-DD string
 */
function computeMaxEndByVehicle(rows) {
  const maxEndByVehicle = {};
  for (const row of (rows || [])) {
    if (!row?.vehicle_id || !row?.end_date) continue;
    const existing = maxEndByVehicle[row.vehicle_id];
    if (!existing || row.end_date > existing) {
      maxEndByVehicle[row.vehicle_id] = row.end_date;
    }
  }
  return maxEndByVehicle;
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
      // Use MAX(end_date) per vehicle to determine if a vehicle has an active
      // or upcoming block.  Only rows with end_date >= today are considered;
      // expired rows are cleaned up by the cleanup-blocked-dates cron.
      //
      // Use LA timezone for "today" to match how end_date is interpreted: a
      // booking that returns on Apr 27 LA time should remain blocked until the
      // LA calendar date rolls to Apr 28, not until UTC midnight.
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()); // YYYY-MM-DD in LA timezone
      const { data: blockedRows, error: blockedError } = await sb
        .from("blocked_dates")
        .select("vehicle_id, end_date")
        .in("vehicle_id", vehicleIds)
        .gte("end_date", today);

      if (blockedError) throw new Error(blockedError.message || "blocked_dates query failed");

      // ── 3. Derive max end_date per vehicle ────────────────────────────────
      const maxEndByVehicle = computeMaxEndByVehicle(blockedRows || []);

      // ── 4. Build response ─────────────────────────────────────────────────
      const result = {};
      for (const vid of vehicleIds) {
        const maxEnd = maxEndByVehicle[vid]; // YYYY-MM-DD or undefined
        const isMaintenance = maintenanceVehicles.has(vid);
        const hasActiveBlock = !!maxEnd;

        // Availability: no active block + not in maintenance = available.
        const available = !hasActiveBlock && !isMaintenance;

        const entry = {
          available,
          rental_status: isMaintenance ? "maintenance" : (hasActiveBlock ? "rented" : "available"),
          // blocked_dates has no time column — available_at is always null.
          available_at: null,
          next_available_display: null,
        };

        if (!available && maxEnd) {
          // Format the end date as "Apr 27, 2026" (date only — no time component).
          // buildDateTimeLA is called with 12:00 (noon LA) so that toLocaleDateString
          // never crosses a date boundary due to the UTC-to-LA timezone offset.
          const endDateObj = buildDateTimeLA(maxEnd, "12:00");
          entry.next_available_display = formatForDisplay(endDateObj, false);

          console.log("[AVAILABLE_AT_COMPUTED]", {
            vehicle_id: vid,
            return_datetime: null,
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
