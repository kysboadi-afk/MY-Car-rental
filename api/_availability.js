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
