// api/_bookings.js
// Helper module for reading and writing bookings.json on GitHub.
//
// bookings.json stores all active and completed rental records so the
// scheduled-reminders job can send SMS at the right times.
//
// Schema:
// {
//   "<vehicleId>": [
//     {
//       bookingId:        string  (crypto random hex),
//       name:             string,
//       phone:            string  (E.164 or raw — normalized before SMS send),
//       email:            string,
//       vehicleId:        string,
//       vehicleName:      string,
//       pickupDate:       string  (YYYY-MM-DD),
//       pickupTime:       string  (e.g. "3:00 PM"),
//       returnDate:       string  (YYYY-MM-DD),
//       returnTime:       string  (e.g. "5:00 PM"),
//       location:         string,
//       status:           "reserved_unpaid"|"booked_paid"|"active_rental"|"completed_rental",
//       paymentIntentId:  string,
//       paymentLink:      string,
//       smsSentAt:        { [key: string]: string }  ISO timestamps of sent reminders,
//       createdAt:        string  ISO timestamp,
//       completedAt?:     string  ISO timestamp (set when rental is returned),
//       lateFeeApplied?:  number  (dollars),
//       extensionCount?:  number,
//     }
//   ]
// }

const GITHUB_REPO         = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH  = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKINGS_PATH       = "bookings.json";
const EMPTY_BOOKINGS      = { camry: [], camry2013: [] };

import { updateJsonFileWithRetry } from "./_github-retry.js";

/**
 * Build standard GitHub API headers.
 * @returns {Record<string,string>}
 */
function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Load bookings.json from the GitHub repo.
 * Returns { data, sha } or { data: EMPTY_BOOKINGS, sha: null } on missing file.
 * @returns {Promise<{ data: object, sha: string|null }>}
 */
export async function loadBookings() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKINGS_PATH}`;
  const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });

  if (!resp.ok) {
    if (resp.status === 404) {
      return { data: { ...EMPTY_BOOKINGS }, sha: null };
    }
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET bookings.json failed: ${resp.status} ${text}`);
  }

  const file = await resp.json();
  let data;
  try {
    data = JSON.parse(
      Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8")
    );
  } catch {
    data = { ...EMPTY_BOOKINGS };
  }

  // Ensure every vehicle key exists
  for (const key of Object.keys(EMPTY_BOOKINGS)) {
    if (!Array.isArray(data[key])) data[key] = [];
  }

  return { data, sha: file.sha };
}

/**
 * Save bookings.json back to the GitHub repo.
 * @param {object} data   - full bookings object
 * @param {string|null} sha - current file sha (null when creating for first time)
 * @param {string} message  - commit message
 */
export async function saveBookings(_data, _sha, _message) {
  // Phase 4: bookings.json writes disabled — Supabase is the only write source.
  console.log("_bookings: saveBookings() called but writes are disabled (Phase 4)");
}

/**
 * Append a new booking record to bookings.json.
 * @param {object} booking - booking record (must include vehicleId)
 * @returns {Promise<void>}
 */
export async function appendBooking(_booking) {
  // Phase 4: bookings.json writes disabled — Supabase is the only write source.
  console.log("_bookings: appendBooking() called but writes are disabled (Phase 4)");
}

export async function updateBooking(_vehicleId, _id, _updates) {
  // Phase 4: bookings.json writes disabled — Supabase is the only write source.
  console.log("_bookings: updateBooking() called but writes are disabled (Phase 4)");
  return false;
}

export async function markReminderSent(_vehicleId, _id, _reminderKey) {
  // Phase 4: bookings.json writes disabled — Supabase is the only write source.
}

/**
 * Returns true when an error indicates a network-level failure (Supabase is
 * unreachable), as opposed to a query-logic or schema error.
 *
 * Used to gate bookings.json fallback behaviour: only fall back to JSON when
 * Supabase cannot be reached.  Callers must NEVER fall back for:
 *   - Empty result sets (data = [])
 *   - Query/schema errors (bad filter, missing column, etc.)
 *   - Application errors thrown after a successful Supabase response
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNetworkError(err) {
  if (!err) return false;
  const code = err.code ? String(err.code) : "";
  const msg  = err.message ? String(err.message).toLowerCase() : "";
  return (
    code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("connection")
  );
}

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX for US numbers).
 * Already-E.164 numbers are returned unchanged.
 * Non-US / malformed numbers are returned as-is for TextMagic to handle.
 * @param {string} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  if (!phone) return phone;
  // Already E.164
  if (/^\+\d{7,15}$/.test(phone)) return phone;
  // Strip non-digits
  const digits = phone.replace(/\D/g, "");
  // US 10-digit
  if (digits.length === 10) return `+1${digits}`;
  // US 11-digit starting with 1
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return phone; // return as-is for non-US numbers
}
