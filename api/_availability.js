// api/_availability.js
// Shared helpers for reading and checking vehicle date availability.
// Used by create-payment-intent.js and send-reservation-email.js.

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const FLEET_STATUS_PATH = "fleet-status.json";

/**
 * Fetch and decode a JSON file from the GitHub Contents API.
 * Returns the parsed object, or null on any error.
 * @param {string} filePath - repo-relative path (e.g. "booked-dates.json")
 */
async function fetchGitHubFile(filePath) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const resp = await fetch(apiUrl, { headers });
  if (!resp.ok) return null;
  const fileData = await resp.json();
  return JSON.parse(
    Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
  );
}

/**
 * Fetch the current booked-dates.json from the GitHub Contents API.
 * Returns the parsed object, or null on any error.
 */
export async function fetchBookedDates() {
  return fetchGitHubFile(BOOKED_DATES_PATH);
}

/**
 * Fetch the current fleet-status.json from the GitHub Contents API.
 * Returns the parsed object, or null on any error.
 */
export async function fetchFleetStatus() {
  return fetchGitHubFile(FLEET_STATUS_PATH);
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
 * Fails open (returns true) when the GitHub token is absent or on fetch errors
 * so that transient issues do not permanently block payments.
 */
export async function isDatesAvailable(vehicleId, from, to) {
  try {
    const data = await fetchBookedDates();
    if (!data) return true; // can't verify — allow through
    const ranges = data[vehicleId] || [];
    return !hasOverlap(ranges, from, to);
  } catch {
    return true; // fail open on transient errors
  }
}

/**
 * Returns true if the datetime range [from+fromTime, to+toTime] is available
 * for the given vehicle.  Uses the time-aware hasDateTimeOverlap so that
 * back-to-back bookings sharing a return/pickup date at the same time are
 * correctly allowed, while any minute-level overlap is rejected.
 *
 * Falls back to full-day blocking (no time precision) when times are absent,
 * which is the conservative safe behaviour for legacy booked-date entries.
 *
 * Fails open (returns true) on transient fetch errors so a GitHub outage does
 * not permanently prevent bookings.
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
    const data = await fetchBookedDates();
    if (!data) return true; // can't verify — allow through
    const ranges = data[vehicleId] || [];
    return !hasDateTimeOverlap(ranges, from, to, fromTime, toTime);
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
