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
// Response: { vehicle_id: { available, rental_status, available_at }, ... }
//
// available_at is computed from the latest active booking return datetime in
// America/Los_Angeles for vehicles currently marked unavailable.
// When no active booking applies, available_at is explicitly null.

import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_STATUS_PATH = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const FALLBACK_VEHICLE_IDS = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
const BUSINESS_TZ = "America/Los_Angeles";
// Keep aligned with booked-dates/v2 availability "active" statuses so vehicles
// blocked by active reservations still surface next availability consistently.
const ACTIVE_BOOKING_STATUSES = ["pending", "approved", "active", "reserved", "reserved_unpaid", "booked_paid", "active_rental"];

function buildDefaultStatus(vehicleIds = FALLBACK_VEHICLE_IDS) {
  const map = {};
  for (const vehicleId of vehicleIds) {
    map[vehicleId] = { available: true, rental_status: "available" };
  }
  return map;
}

/** Convert Supabase rental_status → boolean available for backwards compat */
function rentalStatusToAvailable(status) {
  return status === "available";
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
 * Enriches each entry in `result` with an `available_at` ISO timestamp by
 * querying active bookings and selecting each vehicle's latest return datetime.
 *
 * Rules:
 *   - If vehicle is currently booked (available=false) and has an active booking,
 *     available_at = latest booking return_date + return_time (LA)
 *   - If vehicle has no active booking, available_at = null
 */
async function enrichWithAvailableAt(sb, result) {
  try {
    const { data: activeRows, error } = await sb
      .from("bookings")
      .select("vehicle_id, return_date, return_time, status")
      .in("status", ACTIVE_BOOKING_STATUSES)
      .not("return_date", "is", null)
      .order("return_date", { ascending: false })
      .order("return_time", { ascending: false });

    if (error) throw new Error(error.message || "bookings query failed");

    const latestByVehicle = {};

    for (const row of (activeRows || [])) {
      if (!row?.vehicle_id || !row?.return_date) continue;

      if (!row.return_time) {
        console.error("[AVAILABLE_AT_RETURN_TIME_MISSING]", {
          vehicle_id: row.vehicle_id,
          status: row.status || null,
          return_date: row.return_date,
        });
        continue;
      }

      const returnDateTime = buildDateTimeLA(row.return_date, row.return_time);
      const returnDateTimeMs = returnDateTime.getTime();

      if (!Number.isFinite(returnDateTimeMs)) {
        console.error("[AVAILABLE_AT_INVALID_RETURN_DATETIME]", {
          vehicle_id: row.vehicle_id,
          return_date: row.return_date,
          return_time: row.return_time,
        });
        continue;
      }

      const existing = latestByVehicle[row.vehicle_id];
      if (!existing || returnDateTimeMs > existing.returnDateTimeMs) {
        latestByVehicle[row.vehicle_id] = { returnDateTimeMs, returnDateTime };
      }
    }

    for (const [vehicleId, vehicleStatus] of Object.entries(result)) {
      const latest = latestByVehicle[vehicleId];
      if (!vehicleStatus || vehicleStatus.available !== false || !latest) {
        if (vehicleStatus) vehicleStatus.available_at = null;
        continue;
      }

      const returnDateTime = formatDateTimeLA(latest.returnDateTime);
      vehicleStatus.available_at = returnDateTime;

      console.log("[AVAILABLE_AT_COMPUTED]", {
        vehicle_id: vehicleId,
        return_datetime: returnDateTime,
      });
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
        .select("vehicle_id, rental_status");

      if (!error && rows && rows.length > 0) {
        const result = buildDefaultStatus();
        for (const row of rows) {
          if (row.vehicle_id) {
            result[row.vehicle_id] = {
              available: rentalStatusToAvailable(row.rental_status),
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
        const result = buildDefaultStatus();
        for (const [vid, val] of Object.entries(content)) {
          const avail = typeof val?.available === "boolean" ? val.available : true;
          result[vid] = {
            available: avail,
            rental_status: val?.rental_status || (avail ? "available" : "maintenance"),
          };
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
  return res.status(200).json(buildDefaultStatus());
}
