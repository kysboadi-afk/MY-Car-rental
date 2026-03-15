// api/_pricing.js
// Canonical vehicle pricing used by serverless functions.
// The server always recomputes charges from these constants;
// any client-supplied amount is intentionally ignored to prevent tampering.

export const CARS = {
  slingshot:  { name: "Slingshot R",    pricePerDay: 300, deposit: 150 },
  camry:      { name: "Camry 2012",     pricePerDay: 50,  weekly: 320, biweekly: 600, monthly: 1250, deposit: 0 },
  camry2013:  { name: "Camry 2013 SE",  pricePerDay: 55,  weekly: 350, biweekly: 650, monthly: 1300, deposit: 0 },
};

/**
 * Compute the total charge for a rental.
 * Applies the best discount tier greedily: monthly → biweekly → weekly → daily.
 * @param {string} vehicleId - key from CARS
 * @param {string} pickup    - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-05"
 * @returns {number|null} total in dollars, or null if vehicleId is unknown
 */
export function computeAmount(vehicleId, pickup, returnDate) {
  const car = CARS[vehicleId];
  if (!car) return null;
  let remaining = Math.max(1, Math.ceil(
    (new Date(returnDate + "T00:00:00") - new Date(pickup + "T00:00:00")) / (1000 * 3600 * 24)
  ));
  let cost = 0;
  if (car.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost += months * car.monthly;
    remaining = remaining % 30;
  }
  if (car.biweekly && remaining >= 14) {
    const twoWeekPeriods = Math.floor(remaining / 14);
    cost += twoWeekPeriods * car.biweekly;
    remaining = remaining % 14;
  }
  if (car.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost += weeks * car.weekly;
    remaining = remaining % 7;
  }
  cost += remaining * car.pricePerDay;
  return cost + (car.deposit || 0);
}
