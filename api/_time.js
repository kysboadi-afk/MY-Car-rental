export const DEFAULT_RETURN_TIME = "10:00";

/**
 * Convert an HH:MM (24-hour) or "HH:MM:SS" time string to a human-readable
 * 12-hour format suitable for SMS templates (e.g. "16:00" → "4:00 PM").
 * Returns the original value unchanged when it cannot be parsed, so callers
 * never lose data on unexpected input.
 *
 * @param {string} hhmm  - e.g. "08:00", "16:00", or "16:00:00"
 * @returns {string}      - e.g. "8:00 AM", "4:00 PM"
 */
export function formatTime12h(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return hhmm || "";
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return hhmm;
  const h = parseInt(m[1], 10);
  const mins = m[2];
  if (h === 0)  return `12:${mins} AM`;
  if (h < 12)   return `${h}:${mins} AM`;
  if (h === 12) return `12:${mins} PM`;
  return `${h - 12}:${mins} PM`;
}

export function normalizeClockTime(rawTime) {
  const val = rawTime ? String(rawTime).trim() : "";
  if (!val) return "";

  const twentyFour = val.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFour) {
    return `${String(Number(twentyFour[1])).padStart(2, "0")}:${twentyFour[2]}`;
  }

  const twelveHour = val.match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const mins = twelveHour[2];
    const period = twelveHour[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${mins}`;
  }

  return "";
}

export function deriveReturnTime(pickupDate, pickupTime, returnTime, durationHours) {
  const normalizedReturnTime = normalizeClockTime(returnTime);
  if (normalizedReturnTime) return normalizedReturnTime;

  const normalizedPickupTime = normalizeClockTime(pickupTime);
  if (!normalizedPickupTime) return "";

  const hours = Number(durationHours);
  // Fallback behavior: when duration is not usable (or date missing), keep
  // return_time aligned to pickup_time so booking windows still stay anchored.
  if (!pickupDate || !Number.isFinite(hours) || hours <= 0) {
    return normalizedPickupTime;
  }

  const [pY, pM, pD] = pickupDate.split("-").map(Number);
  const [pH, pMin]   = normalizedPickupTime.split(":").map(Number);
  // Use the multi-argument constructor so the Date is created in the server's
  // local timezone (UTC on Vercel) without ISO-string UTC mis-interpretation.
  const pickupMoment = new Date(pY, pM - 1, pD, pH, pMin || 0);
  if (Number.isNaN(pickupMoment.getTime())) return normalizedPickupTime;
  const returnMoment = new Date(pickupMoment.getTime() + (hours * 60 * 60 * 1000));
  return `${String(returnMoment.getHours()).padStart(2, "0")}:${String(returnMoment.getMinutes()).padStart(2, "0")}`;
}
