// api/_availability.js
// Shared helpers for reading and checking vehicle date availability.
// Used by create-payment-intent.js and send-reservation-email.js.

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";

/**
 * Fetch the current booked-dates.json from the GitHub Contents API.
 * Returns the parsed object, or null on any error.
 */
export async function fetchBookedDates() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
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
