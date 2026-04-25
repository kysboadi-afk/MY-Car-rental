// api/_availability.js
// Shared helpers for checking vehicle date availability.
// Used by create-payment-intent.js and send-reservation-email.js.
//
// Single source of truth: Supabase `bookings` table.
// All availability checks query bookings directly — booked-dates.json is NOT used.
// Fails open (returns available=true) when Supabase is not configured or throws,
// so a transient DB outage does not permanently block new bookings.

// All booking statuses that mean the vehicle is occupied / unavailable.
// Keep aligned with fleet-status.js and v2-availability.js.
const ACTIVE_BOOKING_STATUSES = ["pending", "approved", "active", "reserved", "reserved_unpaid", "booked_paid", "active_rental"];

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

/**
 * Returns true if the ISO date range [from, to] overlaps any range in the array.
 * Overlap condition: from <= r.to && r.from <= to
 * Works with ISO date strings (YYYY-MM-DD) since they sort lexicographically.
 */
export function hasOverlap(ranges, from, to) {
  return ranges.some((r) => from <= r.to && r.from <= to);
}

/**
 * Parse a date string (YYYY-MM-DD) combined with an optional time string
 * ("H:MM AM/PM" or "HH:MM") into a numeric Unix-ms timestamp.
 * Falls back to midnight (00:00) when time is absent or unparseable.
 *
 * @param {string} date  - ISO date "YYYY-MM-DD"
 * @param {string} [time] - optional "3:00 PM" or "15:00"
 * @returns {number} Unix milliseconds
 */
export function parseDateTimeMs(date, time) {
  if (!date) return NaN;
  const base = new Date(date + "T00:00:00");
  if (time && typeof time === "string") {
    const t = time.trim();
    const ampm = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const p = ampm[3].toUpperCase();
      if (p === "PM" && h !== 12) h += 12;
      if (p === "AM" && h === 12) h = 0;
      base.setHours(h, m, 0, 0);
    } else {
      const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
      if (h24) base.setHours(parseInt(h24[1], 10), parseInt(h24[2], 10), 0, 0);
    }
  }
  return base.getTime();
}

/**
 * Number of hours the car is unavailable after a return before a new pickup
 * can begin.  Applied to the end boundary of every time-aware booked range so
 * that back-to-back same-day rentals respect the preparation window.
 */
const BOOKING_BUFFER_HOURS = 2;

/**
 * Returns true if the datetime range [fromDate+fromTime, toDate+toTime] overlaps
 * any range in the array.  Ranges in the array may carry optional `fromTime`/`toTime`
 * fields alongside the mandatory `from`/`to` date strings.
 *
 * Overlap condition (strict, with buffer on existing end):
 *   rangeStart < newEnd  AND  rangeEndWithBuffer > newStart
 *
 * When a range has `toTime`, BOOKING_BUFFER_HOURS is added to its end boundary so
 * that the car is given preparation time before the next booking can start.
 *
 * When no time is given for a return date the entire day is treated as occupied,
 * so the end boundary is midnight of the NEXT day (exclusive), matching the SQL
 * `booking_datetime` helper which uses `(d + interval '1 day')`.
 *
 * @param {Array<{from:string, to:string, fromTime?:string, toTime?:string}>} ranges
 * @param {string} fromDate  - YYYY-MM-DD
 * @param {string} toDate    - YYYY-MM-DD
 * @param {string} [fromTime] - optional "H:MM AM/PM"
 * @param {string} [toTime]   - optional "H:MM AM/PM"
 * @returns {boolean}
 */
export function hasDateTimeOverlap(ranges, fromDate, toDate, fromTime, toTime) {
  const newStart = parseDateTimeMs(fromDate, fromTime);
  // When no return time is given, use midnight of next day (exclusive end) so
  // that a booking returned on date D occupies the full day — consistent with
  // the Supabase booking_datetime SQL helper.
  const newEnd = toTime
    ? parseDateTimeMs(toDate, toTime)
    : (() => { const d = new Date(parseDateTimeMs(toDate)); d.setDate(d.getDate() + 1); return d.getTime(); })();

  return ranges.some((r) => {
    const rStart = parseDateTimeMs(r.from, r.fromTime);
    const rEndRaw = r.toTime
      ? parseDateTimeMs(r.to, r.toTime)
      : (() => { const d = new Date(parseDateTimeMs(r.to)); d.setDate(d.getDate() + 1); return d.getTime(); })();
    // Apply preparation buffer only to time-aware entries.  For legacy date-only
    // entries the day-boundary already provides a conservative block.
    const rEnd = r.toTime
      ? rEndRaw + BOOKING_BUFFER_HOURS * 60 * 60 * 1000
      : rEndRaw;
    // Strict overlap: one starts before the other ends
    return rStart < newEnd && rEnd > newStart;
  });
}

/**
 * Returns true if the dates [from, to] are available for the given vehicle.
 * Queries the Supabase bookings table directly — no static JSON files.
 * Fails open (returns true) when Supabase is not configured or on any error
 * so that transient issues do not permanently block payments.
 *
 * @param {string} vehicleId
 * @param {string} from - YYYY-MM-DD
 * @param {string} to   - YYYY-MM-DD
 * @returns {Promise<boolean>} true when available
 */
export async function isDatesAvailable(vehicleId, from, to) {
  try {
    const { getSupabaseAdmin } = await import("./_supabase.js");
    const sb = getSupabaseAdmin();
    if (!sb) return true; // Supabase not configured — fail open
    const { data, error } = await sb
      .from("bookings")
      .select("booking_ref")
      .eq("vehicle_id", vehicleId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .lte("pickup_date", to)
      .gte("return_date", from)
      .limit(1);
    if (error) return true; // fail open on query error
    return !data || data.length === 0;
  } catch {
    return true; // fail open on transient errors
  }
}

/**
 * Returns true if the datetime range [from+fromTime, to+toTime] is available
 * for the given vehicle.  Queries the Supabase bookings table directly.
 *
 * When times are provided the check is time-aware so back-to-back bookings
 * sharing a return/pickup date at the same time are correctly allowed, while
 * any minute-level overlap is rejected.
 *
 * Fails open (returns true) when Supabase is not configured or on any error
 * so that transient issues do not permanently block payments.
 *
 * @param {string} vehicleId
 * @param {string} from      - YYYY-MM-DD pickup date
 * @param {string} to        - YYYY-MM-DD return date
 * @param {string} [fromTime] - optional "H:MM AM/PM" pickup time
 * @param {string} [toTime]   - optional "H:MM AM/PM" return time
 * @returns {Promise<boolean>} true when available
 */
export async function isDatesAndTimesAvailable(vehicleId, from, to, fromTime, toTime) {
  try {
    const { getSupabaseAdmin } = await import("./_supabase.js");
    const sb = getSupabaseAdmin();
    if (!sb) return true; // Supabase not configured — fail open

    // Active rental override: if the vehicle has ANY active_rental booking it is
    // unavailable regardless of dates (overdue bookings must still block new ones).
    const { data: activeRentals, error: activeRentalError } = await sb
      .from("bookings")
      .select("booking_ref")
      .eq("vehicle_id", vehicleId)
      .eq("status", "active_rental")
      .limit(1);
    if (activeRentalError) return true; // fail open on query error
    if (activeRentals && activeRentals.length > 0) return false;

    // Query for date-range overlaps: pickup_date <= to AND return_date >= from
    const { data: rows, error } = await sb
      .from("bookings")
      .select("pickup_date, return_date, pickup_time, return_time")
      .eq("vehicle_id", vehicleId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .lte("pickup_date", to)
      .gte("return_date", from);
    if (error) return true; // fail open on query error

    const conflicts = rows || [];
    if (conflicts.length === 0) return true;

    // When times are provided, refine the date-level hits with a time-aware
    // overlap check so back-to-back same-date bookings work correctly.
    if (fromTime && toTime) {
      const sbRanges = conflicts.map((r) => ({
        from:     r.pickup_date,
        to:       r.return_date,
        fromTime: pgTimeTo12h(r.pickup_time),
        toTime:   pgTimeTo12h(r.return_time),
      }));
      return !hasDateTimeOverlap(sbRanges, from, to, fromTime, toTime);
    }

    return false;
  } catch {
    return true; // fail open on transient errors
  }
}

// All Slingshot unit IDs. The customer books a generic "Slingshot" and the
// server assigns whichever unit is free — customers never choose a specific unit.
export const SLINGSHOT_UNIT_IDS = ["slingshot", "slingshot2", "slingshot3"];

/**
 * Find the first Slingshot unit that is both datetime-available and fleet-available
 * for the given pickup→return window.  When pickup/return times are provided the
 * check is time-aware so back-to-back same-date bookings work correctly.
 *
 * @param {string} pickup       - ISO date "YYYY-MM-DD"
 * @param {string} returnDate   - ISO date "YYYY-MM-DD"
 * @param {string} [pickupTime] - optional "H:MM AM/PM" pickup time
 * @param {string} [returnTime] - optional "H:MM AM/PM" computed return time
 * @returns {Promise<string|null>} unit ID (e.g. "slingshot2") or null if all busy
 */
export async function findAvailableSlingshotUnit(pickup, returnDate, pickupTime, returnTime) {
  for (const unitId of SLINGSHOT_UNIT_IDS) {
    const [datesOk, fleetOk] = await Promise.all([
      isDatesAndTimesAvailable(unitId, pickup, returnDate, pickupTime, returnTime),
      isVehicleAvailable(unitId),
    ]);
    if (datesOk && fleetOk) return unitId;
  }
  return null;
}

/**
 * Returns true if the vehicle is NOT in maintenance mode.
 * Queries the Supabase `vehicles` table: rental_status = 'maintenance' → false.
 * Booking-based availability is NOT checked here — that is handled by
 * isDatesAndTimesAvailable / v2-availability.js.
 * Fails open (returns true) on any fetch error so transient issues do not
 * permanently block payments.
 */
export async function isVehicleAvailable(vehicleId) {
  try {
    const { getSupabaseAdmin } = await import("./_supabase.js");
    const sb = getSupabaseAdmin();
    if (!sb) return true; // Supabase not configured — fail open
    const { data, error } = await sb
      .from("vehicles")
      .select("rental_status")
      .eq("vehicle_id", vehicleId)
      .single();
    if (error) return true; // fail open on query error
    return data?.rental_status !== "maintenance";
  } catch {
    return true; // fail open on transient errors
  }
}
