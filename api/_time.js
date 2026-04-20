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

  const pickupMoment = new Date(`${pickupDate}T${normalizedPickupTime}:00`);
  if (Number.isNaN(pickupMoment.getTime())) return normalizedPickupTime;
  const returnMoment = new Date(pickupMoment.getTime() + (hours * 60 * 60 * 1000));
  return `${String(returnMoment.getHours()).padStart(2, "0")}:${String(returnMoment.getMinutes()).padStart(2, "0")}`;
}
