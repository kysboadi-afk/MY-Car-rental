// api/fleet-status.js
// Vercel serverless function — returns the current availability status of each
// fleet vehicle.
//
// Single source of truth: Supabase `bookings` table.
//
// A vehicle is unavailable if any booking with an ACTIVE_BOOKING_STATUS exists
// for that vehicle.  availability is never read from fleet-status.json or
// vehicles.rental_status — it is always derived from live bookings.
//
// vehicles.rental_status = 'maintenance' is still respected as a manual
// override so the fleet manager can take a vehicle offline for servicing
// even when it has no active bookings.
//
// Response: { vehicle_id: { available, rental_status, available_at,
//                           next_available_display }, ... }
//
//   available_at          — ISO-8601 LA-offset timestamp of the latest active
//                           booking's return datetime, or null when return_time
//                           is unknown.
//   next_available_display — human-readable LA-tz string, e.g.
//                           "Apr 30, 2026 at 6:00 PM" (always set for
//                           unavailable vehicles, even when return_time is absent).

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const FALLBACK_VEHICLE_IDS = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
const BUSINESS_TZ = "America/Los_Angeles";
// All booking statuses that mean the vehicle is occupied / unavailable.
// Keep aligned with v2-availability.js and booked-dates.js.
const ACTIVE_BOOKING_STATUSES = ["pending", "approved", "active", "reserved", "reserved_unpaid", "booked_paid", "active_rental"];

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
 * Build the latest-return-datetime lookup keyed by vehicle_id from a set of
 * booking rows already filtered to ACTIVE_BOOKING_STATUSES.
 * Logs a warning when return_time is absent.
 *
 * @param {object[]} rows - booking rows with vehicle_id, return_date, return_time, status
 * @returns {{ [vehicleId]: { returnDateTime: Date, hasTime: boolean } }}
 */
function computeLatestByVehicle(rows) {
  const latestByVehicle = {};

  for (const row of (rows || [])) {
    if (!row?.vehicle_id || !row?.return_date) continue;

    let returnDateTime;
    let hasTime = false;

    if (!row.return_time) {
      console.warn("[AVAILABLE_AT_RETURN_TIME_MISSING]", {
        vehicle_id: row.vehicle_id,
        status: row.status || null,
        return_date: row.return_date,
      });
      // Midnight is used ONLY for internal date ordering so the latest booking
      // per vehicle is still selected correctly.  hasTime = false ensures no
      // time component is shown to customers via next_available_display, and
      // available_at remains null (no synthetic timestamp is exposed).
      returnDateTime = buildDateTimeLA(row.return_date, "00:00");
    } else {
      returnDateTime = buildDateTimeLA(row.return_date, row.return_time);
      hasTime = true;
    }

    const returnDateTimeMs = returnDateTime.getTime();
    if (!Number.isFinite(returnDateTimeMs)) {
      console.error("[AVAILABLE_AT_INVALID_RETURN_DATETIME]", {
        vehicle_id: row.vehicle_id,
        return_date: row.return_date,
        return_time: row.return_time || null,
      });
      continue;
    }

    const existing = latestByVehicle[row.vehicle_id];
    if (!existing || returnDateTimeMs > existing.returnDateTimeMs) {
      latestByVehicle[row.vehicle_id] = { returnDateTimeMs, returnDateTime, hasTime };
    }
  }

  return latestByVehicle;
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

      // ── 2. Single bookings query — source of truth for availability ───────
      const { data: bookingRows, error: bookingError } = await sb
        .from("bookings")
        .select("vehicle_id, return_date, return_time, status")
        .in("vehicle_id", vehicleIds)
        .in("status", ACTIVE_BOOKING_STATUSES)
        .not("return_date", "is", null)
        .order("return_date", { ascending: false })
        .order("return_time", { ascending: false });

      if (bookingError) throw new Error(bookingError.message || "bookings query failed");

      // ── 3. Derive latest return datetime per vehicle ───────────────────────
      const latestByVehicle = computeLatestByVehicle(bookingRows || []);

      // ── 4. Build response ─────────────────────────────────────────────────
      const result = {};
      for (const vid of vehicleIds) {
        const latest = latestByVehicle[vid];
        const isMaintenance = maintenanceVehicles.has(vid);
        const hasActiveBooking = !!latest;

        // Availability: absent booking + not in maintenance = available.
        const available = !hasActiveBooking && !isMaintenance;

        const entry = {
          available,
          rental_status: isMaintenance ? "maintenance" : (hasActiveBooking ? "rented" : "available"),
          available_at: null,
          next_available_display: null,
        };

        if (!available && latest) {
          // available_at is set only when return_time is known (trustworthy ISO timestamp).
          if (latest.hasTime) {
            entry.available_at = formatDateTimeLA(latest.returnDateTime);
          }
          // next_available_display is always set for unavailable vehicles.
          entry.next_available_display = formatForDisplay(latest.returnDateTime, latest.hasTime);

          console.log("[AVAILABLE_AT_COMPUTED]", {
            vehicle_id: vid,
            return_datetime: entry.available_at,
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
