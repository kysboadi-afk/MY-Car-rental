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

const GITHUB_REPO     = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKINGS_PATH   = "bookings.json";
const EMPTY_BOOKINGS  = { slingshot: [], slingshot2: [], camry: [], camry2013: [] };

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
  const resp = await fetch(apiUrl, { headers: ghHeaders() });

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
export async function saveBookings(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("_bookings: GITHUB_TOKEN not set — bookings.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKINGS_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;

  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT bookings.json failed: ${resp.status} ${text}`);
  }
}

/**
 * Append a new booking record to bookings.json.
 * @param {object} booking - booking record (must include vehicleId)
 * @returns {Promise<void>}
 */
export async function appendBooking(booking) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("_bookings: GITHUB_TOKEN not set — booking will not be persisted");
    return;
  }
  const vehicleId = booking.vehicleId;
  await updateJsonFileWithRetry({
    load:  loadBookings,
    apply: (data) => {
      if (!Array.isArray(data[vehicleId])) data[vehicleId] = [];
      // Guard: don't duplicate by paymentIntentId
      if (
        booking.paymentIntentId &&
        data[vehicleId].some((b) => b.paymentIntentId === booking.paymentIntentId)
      ) {
        console.log(`_bookings: booking ${booking.paymentIntentId} already exists — skipping`);
        return;
      }
      data[vehicleId].push(booking);
    },
    save:    saveBookings,
    message: `Add booking for ${vehicleId}: ${booking.name} (${booking.bookingId})`,
  });
}

/**
 * Update a specific booking record in place (matched by bookingId or paymentIntentId).
 * @param {string} vehicleId
 * @param {string} id - bookingId or paymentIntentId
 * @param {Partial<object>} updates - fields to merge
 * @returns {Promise<boolean>} true if found and updated
 */
export async function updateBooking(vehicleId, id, updates) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("_bookings: GITHUB_TOKEN not set — booking update skipped");
    return false;
  }
  let found = false;
  try {
    await updateJsonFileWithRetry({
      load:  loadBookings,
      apply: (data) => {
        if (!Array.isArray(data[vehicleId])) return;
        const idx = data[vehicleId].findIndex(
          (b) => b.bookingId === id || b.paymentIntentId === id
        );
        if (idx === -1) return;
        data[vehicleId][idx] = { ...data[vehicleId][idx], ...updates };
        found = true;
      },
      save:    saveBookings,
      message: `Update booking ${id} for ${vehicleId}: ${JSON.stringify(Object.keys(updates))}`,
    });
  } catch (err) {
    console.error(`_bookings: updateBooking failed for ${id}:`, err);
    return false;
  }
  return found;
}

/**
 * Mark a reminder as sent by recording the current timestamp.
 * Non-fatal: logs on failure so the reminder is not re-sent unnecessarily.
 * @param {string} vehicleId
 * @param {string} id - bookingId or paymentIntentId
 * @param {string} reminderKey - e.g. "pickup_24h", "active_mid"
 */
export async function markReminderSent(vehicleId, id, reminderKey) {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    await updateJsonFileWithRetry({
      load:  loadBookings,
      apply: (data) => {
        if (!Array.isArray(data[vehicleId])) return;
        const idx = data[vehicleId].findIndex(
          (b) => b.bookingId === id || b.paymentIntentId === id
        );
        if (idx === -1) return;
        if (!data[vehicleId][idx].smsSentAt) data[vehicleId][idx].smsSentAt = {};
        data[vehicleId][idx].smsSentAt[reminderKey] = new Date().toISOString();
      },
      save:    saveBookings,
      message: `Mark reminder ${reminderKey} sent for booking ${id}`,
    });
  } catch (err) {
    console.error(`_bookings: markReminderSent failed for ${id}/${reminderKey}:`, err);
  }
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
