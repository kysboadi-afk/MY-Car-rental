// api/_pricing.js
// Canonical vehicle pricing used by serverless functions.
// The server always recomputes charges from these constants;
// any client-supplied amount is intentionally ignored to prevent tampering.

export const CARS = {
  slingshot: { name: "Slingshot R", pricePerDay: 300, deposit: 150 },
  camry:     { name: "Camry 2012",  pricePerDay: 50,  weekly: 300, deposit: 0 },
};

/**
 * Compute the total charge for a rental.
 * @param {string} vehicleId - key from CARS
 * @param {string} pickup    - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-05"
 * @returns {number|null} total in dollars, or null if vehicleId is unknown
 */
export function computeAmount(vehicleId, pickup, returnDate) {
  const car = CARS[vehicleId];
  if (!car) return null;
  const days = Math.max(1, Math.ceil(
    (new Date(returnDate + "T00:00:00") - new Date(pickup + "T00:00:00")) / (1000 * 3600 * 24)
  ));
  let cost = 0;
  if (car.weekly && days >= 7) {
    const weeks = Math.floor(days / 7);
    const remaining = days % 7;
    cost = weeks * car.weekly + remaining * car.pricePerDay;
  } else {
    cost = days * car.pricePerDay;
  }
  return cost + (car.deposit || 0);
}
