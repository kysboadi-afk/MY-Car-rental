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
import { hasDateTimeOverlap } from "./_availability.js";
import { normalizeVehicleId } from "./_vehicle-id.js";
import { buildDateTimeLA, computeFinalReturnDate, PREP_BUFFER_MS } from "./_final-return-date.js";
import { FLEET_VEHICLE_IDS } from "./_pricing.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = FLEET_VEHICLE_IDS;
const ACTIVE_STATUSES  = ["pending", "approved", "active", "reserved", "reserved_unpaid", "booked_paid", "active_rental", "overdue"];

/**
 * Check availability for one vehicle against the Supabase bookings table.
 * Supabase is the sole source of truth; if it is not configured or encounters
 * an error, an exception is thrown so the caller can return 503/500.
 * When fromTime/toTime are provided the check is time-aware so back-to-back
 * bookings sharing a return/pickup date at the same time are correctly allowed.
 *
 * @param {object} sb         - Supabase admin client (must not be null)
 * @param {string} vehicleId
 * @param {string} from       - YYYY-MM-DD
 * @param {string} to         - YYYY-MM-DD
 * @param {string} [fromTime] - optional "H:MM AM/PM" pickup time
 * @param {string} [toTime]   - optional "H:MM AM/PM" return time
 * @returns {{ available: boolean, conflicts: object[], source: string }}
 */
async function checkVehicleAvailability(sb, vehicleId, from, to, fromTime, toTime) {
  const dbVehicleId = normalizeVehicleId(vehicleId);
  console.log("[VEHICLE_ID_LOOKUP]", JSON.stringify({ vehicleId_ui: vehicleId, vehicleId_db: dbVehicleId, from, to }));
  if (sb) {
    try {
      // Active rental override: if the vehicle has an active_rental booking whose
      // finalReturnDate (accounting for paid extensions) extends into or past the
      // requested range, it is unavailable.  If the final return + prep buffer is
      // strictly before the requested start, fall through to the date-range check
      // so that future bookings are allowed once the rental has physically ended.
      // Note: a composite index on (vehicle_id, status) in the bookings table is
      // recommended so this single-row lookup stays fast as the table grows.
      const { data: activeRentals, error: activeRentalError } = await sb
        .from("bookings")
        .select("booking_ref, return_date, return_time")
        .eq("vehicle_id", dbVehicleId)
        .in("status", ["active_rental", "overdue"])
        .limit(1);
      if (!activeRentalError && activeRentals && activeRentals.length > 0) {
        const ar         = activeRentals[0];
        const arRef      = ar.booking_ref || null;
        const arBaseDate = ar.return_date ? String(ar.return_date).split("T")[0] : "";
        const arBaseTime = ar.return_time ? String(ar.return_time).substring(0, 5) : "";

        // Incorporate any paid extensions so the block window reflects the true
        // final return date (non-fatal: falls back to booking's own return_date).
        const { date: finalDate, time: finalTime } = await computeFinalReturnDate(
          sb, arRef, arBaseDate, arBaseTime
        );

        // Compute millisecond timestamps anchored to Los Angeles wall-clock time
        // so DST transitions are handled correctly.
        const finalReturnMs    = buildDateTimeLA(finalDate, finalTime || "00:00").getTime();
        const requestedStartMs = buildDateTimeLA(from, fromTime || "00:00").getTime();

        if (requestedStartMs < finalReturnMs + PREP_BUFFER_MS) {
          // Requested window starts before the final return + prep buffer → blocked.
          return { available: false, conflicts: activeRentals, source: "supabase" };
        }
        // Otherwise, the rental has ended (possibly including extensions) and the
        // requested start is after the prep buffer — fall through to the date-range
        // check so genuinely future bookings are correctly allowed.
      }

      // Query Supabase bookings for any active booking that overlaps [from, to].
      // Overlap condition: pickup_date <= to AND return_date >= from
      const { data: rows, error } = await sb
        .from("bookings")
        .select("booking_ref, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, customer_id")
        .eq("vehicle_id", dbVehicleId)
        .in("status", ACTIVE_STATUSES)
        .lte("pickup_date", to)
        .gte("return_date", from);

      if (error) {
        console.error(`v2-availability: Supabase query error for ${vehicleId}:`, error.message);
        throw new Error(`v2-availability: Supabase query failed for ${vehicleId}: ${error.message}`);
      }
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
    } catch (err) {
      console.error(`v2-availability: Supabase exception for ${vehicleId}:`, err.message);
      throw err;
    }
  }

  // Supabase must be configured — no fallback.
  throw new Error("v2-availability: Supabase is not configured; cannot check availability");
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
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured; availability check unavailable" });
  }

  if (vehicleId) {
    // Single vehicle check
    try {
      const result = await checkVehicleAvailability(sb, vehicleId, from, to, fromTime, toTime);
      return res.status(200).json({
        vehicleId,
        from,
        to,
        available:  result.available,
        conflicts:  result.conflicts,
        source:     result.source,
      });
    } catch (err) {
      console.error(`v2-availability: checkVehicleAvailability error for ${vehicleId}:`, err.message);
      return res.status(500).json({ error: "availability check failed" });
    }
  }

  // All vehicles
  const results = {};
  for (const vid of ALLOWED_VEHICLES) {
    try {
      const result = await checkVehicleAvailability(sb, vid, from, to, fromTime, toTime);
      results[vid] = {
        available: result.available,
        conflicts: result.conflicts,
        source:    result.source,
      };
    } catch (err) {
      console.error(`v2-availability: checkVehicleAvailability error for ${vid}:`, err.message);
      results[vid] = { available: false, conflicts: [], source: "error", error: err.message };
    }
  }

  return res.status(200).json({ from, to, vehicles: results });
}
