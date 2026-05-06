// api/_slingshot-packages.js
// Canonical Slingshot rental package definitions.
// Slingshots are priced in fixed hourly packages — no day-rate pricing.
//
// Rules:
//   • 24hr packages may end at any time (no business-hours restriction).
//   • All other packages must return the vehicle by 8:00 PM Los Angeles time.
//   • A $500 refundable security deposit is collected at booking time.
//   • No sales tax is applied to slingshot bookings.

/** All valid slingshot rental packages. */
export const SLINGSHOT_PACKAGES = {
  "2hr":  { hours: 2,  price: 150, label: "2 Hours" },
  "3hr":  { hours: 3,  price: 200, label: "3 Hours" },
  "6hr":  { hours: 6,  price: 250, label: "6 Hours" },
  "24hr": { hours: 24, price: 350, label: "24 Hours" },
};

/** Refundable security deposit charged on every slingshot booking. */
export const SLINGSHOT_DEPOSIT = 500;

/** Los Angeles business closing hour (24-hour clock). Non-24hr packages must return by this hour. */
export const BUSINESS_CLOSE_HOUR = 20; // 8 PM

/**
 * Return the package definition for a given key, or null if unrecognised.
 * @param {string} key - "2hr" | "3hr" | "6hr" | "24hr"
 * @returns {{ hours: number, price: number, label: string }|null}
 */
export function getSlingshotPackage(key) {
  return Object.prototype.hasOwnProperty.call(SLINGSHOT_PACKAGES, key)
    ? SLINGSHOT_PACKAGES[key]
    : null;
}

/**
 * Compute the absolute return Date from a pickup Date and package key.
 * @param {Date}   pickupDateTime - absolute Date representing pickup moment
 * @param {string} packageKey
 * @returns {Date|null}
 */
export function computeSlingshotReturn(pickupDateTime, packageKey) {
  const pkg = getSlingshotPackage(packageKey);
  if (!pkg) return null;
  return new Date(pickupDateTime.getTime() + pkg.hours * 3_600_000);
}

/**
 * Get the hour (0–23) in Los Angeles time for a given absolute Date.
 * @param {Date} dt
 * @returns {number}
 */
function laHourOf(dt) {
  return parseInt(
    dt.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
    }),
    10
  );
}

/**
 * Get the minute (0–59) in Los Angeles time for a given absolute Date.
 * @param {Date} dt
 * @returns {number}
 */
function laMinuteOf(dt) {
  return parseInt(
    dt.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      minute: "numeric",
    }),
    10
  );
}

/**
 * Check whether a return datetime is within business hours for the given package.
 * 24hr packages are always allowed.
 * All other packages must return at or before 8:00 PM (20:00) Los Angeles time.
 *
 * @param {string} packageKey
 * @param {Date}   returnDateTime - absolute Date for the return moment
 * @returns {boolean} true if the return is within business hours
 */
export function isReturnWithinBusinessHours(packageKey, returnDateTime) {
  if (packageKey === "24hr") return true;
  const h = laHourOf(returnDateTime);
  const m = laMinuteOf(returnDateTime);
  // Must be at or before exactly 20:00 LA time.
  return h < BUSINESS_CLOSE_HOUR || (h === BUSINESS_CLOSE_HOUR && m === 0);
}

/**
 * Split a Date into its YYYY-MM-DD date and HH:MM time components as seen in
 * Los Angeles local time.
 *
 * @param {Date} dt
 * @returns {{ date: string, time: string }}
 */
export function splitDatetimeLA(dt) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year:   "numeric",
    month:  "2-digit",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";

  const year  = get("year");
  const month = get("month");
  const day   = get("day");
  let   hour  = get("hour");
  const min   = get("minute");

  // Some platforms return "24" instead of "00" at midnight.
  if (hour === "24") hour = "00";

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${min}`,
  };
}
