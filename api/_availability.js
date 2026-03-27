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
 * Returns true if the datetime range [fromDate+fromTime, toDate+toTime] overlaps
 * any range in the array.  Ranges in the array may carry optional `fromTime`/`toTime`
 * fields alongside the mandatory `from`/`to` date strings.
 *
 * Overlap condition (strict):
 *   rangeStart < newEnd  AND  rangeEnd > newStart
 *
 * This correctly handles back-to-back bookings where one ends at 5 PM and the
 * next starts at 6 PM on the same day — they do NOT overlap.
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
    const rEnd   = r.toTime
      ? parseDateTimeMs(r.to, r.toTime)
      : (() => { const d = new Date(parseDateTimeMs(r.to)); d.setDate(d.getDate() + 1); return d.getTime(); })();
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
 * Returns true if the vehicle is currently marked available in fleet-status.json.
 * Fails open (returns true) on any fetch error so transient issues do not
 * permanently block payments.
 */
export async function isVehicleAvailable(vehicleId) {
  try {
    const status = await fetchFleetStatus();
    if (!status) return true; // can't verify — allow through
    const entry = status[vehicleId];
    if (!entry) return true; // vehicle not listed — assume available
    return entry.available !== false;
  } catch {
    return true; // fail open on transient errors
  }
}
