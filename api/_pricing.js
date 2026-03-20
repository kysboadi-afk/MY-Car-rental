// api/_pricing.js
// Canonical vehicle pricing used by serverless functions.
// The server always recomputes charges from these constants;
// any client-supplied amount is intentionally ignored to prevent tampering.

// Los Angeles, CA combined sales tax rate applied to every rental.
// Business is operated in the City of Los Angeles; tax is always collected
// at this rate regardless of the renter's home address.
// Combined City of Los Angeles rate: CA state 7.25% + LA county 2.25% + LA city 0.75% = 10.25%
export const LA_TAX_RATE = 0.1025;

export const CARS = {
  slingshot:  {
    name: "Slingshot R",
    deposit: 150,
    // Slingshot uses hourly tier pricing — no daily/weekly/monthly rates.
    // Tiers: $200 / 3 hrs · $250 / 6 hrs · $350 / 24 hrs
    hourlyTiers: [
      { hours: 3,  price: 200 },
      { hours: 6,  price: 250 },
      { hours: 24, price: 350 },
    ],
  },
  slingshot2: {
    name: "Slingshot R",
    deposit: 150,
    // Same hourly tier pricing as slingshot — different unit with different photos.
    hourlyTiers: [
      { hours: 3,  price: 200 },
      { hours: 6,  price: 250 },
      { hours: 24, price: 350 },
    ],
  },
  camry:      { name: "Camry 2012",     pricePerDay: 50,  weekly: 350, biweekly: 650, monthly: 1300, deposit: 0 },
  camry2013:  { name: "Camry 2013 SE",  pricePerDay: 55,  weekly: 350, biweekly: 650, monthly: 1300, deposit: 0 },
};

// Damage Protection Plan rates — must stay in sync with car.js client-side constants.
export const PROTECTION_PLAN_WEEKLY   = 85;   // $85/week  (7-day block)
export const PROTECTION_PLAN_BIWEEKLY = 150;  // $150/2 weeks (14-day block)
export const PROTECTION_PLAN_MONTHLY  = 295;  // $295/month (30-day block)
// Daily rate is auto-derived from the weekly rate so it stays proportional.
export const PROTECTION_PLAN_DAILY    = Math.ceil(PROTECTION_PLAN_WEEKLY / 7); // ≈ $13/day

/**
 * Compute the total charge for an hourly-tier rental (Slingshot vehicles).
 * The security deposit is always included.
 * @param {number} durationHours - rental duration in hours (must be 3, 6, or 24)
 * @param {string} [vehicleId="slingshot"] - key from CARS for the vehicle
 * @returns {number|null} total in dollars (rental + deposit), or null if invalid
 */
export function computeSlingshotAmount(durationHours, vehicleId = "slingshot") {
  const car = CARS[vehicleId];
  if (!car || !car.hourlyTiers) return null;
  const tier = car.hourlyTiers.find(t => t.hours === durationHours);
  if (!tier) return null;
  return tier.price + car.deposit;
}

/**
 * Compute the number of rental days from two ISO date strings.
 * Always returns at least 1 (same-day pickup/return counts as 1 day).
 * @param {string} pickup     - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-05"
 * @returns {number} rental days (min 1)
 */
export function computeRentalDays(pickup, returnDate) {
  return Math.max(1, Math.ceil(
    (new Date(returnDate + "T00:00:00") - new Date(pickup + "T00:00:00")) / (1000 * 3600 * 24)
  ));
}

/**
 * Compute the Damage Protection Plan cost for a given number of rental days.
 * Uses the same greedy tier logic: monthly → weekly → daily.
 * @param {number} days - number of rental days (min 1)
 * @returns {number} protection plan cost in dollars
 */
export function computeProtectionPlanCost(days) {
  let remaining = Math.max(1, days);
  let cost = 0;
  if (remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost += months * PROTECTION_PLAN_MONTHLY;
    remaining = remaining % 30;
  }
  if (remaining >= 14) {
    const twoWeeks = Math.floor(remaining / 14);
    cost += twoWeeks * PROTECTION_PLAN_BIWEEKLY;
    remaining = remaining % 14;
  }
  if (remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost += weeks * PROTECTION_PLAN_WEEKLY;
    remaining = remaining % 7;
  }
  cost += remaining * PROTECTION_PLAN_DAILY;
  return cost;
}

/**
 * Compute the total charge for a rental.
 * Applies the best discount tier greedily: monthly → biweekly → weekly → daily.
 * The security deposit (if any) is always included — it is never waived.
 * @param {string} vehicleId - key from CARS
 * @param {string} pickup    - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-05"
 * @returns {number|null} total in dollars, or null if vehicleId is unknown
 */
export function computeAmount(vehicleId, pickup, returnDate) {
  const car = CARS[vehicleId];
  if (!car) return null;
  let remaining = computeRentalDays(pickup, returnDate);
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

/**
 * Compute human-readable pricing breakdown lines for a daily/weekly rental.
 * Uses the same greedy tier logic as computeAmount.
 * @param {string} vehicleId   - key from CARS
 * @param {string} pickup      - ISO date string
 * @param {string} returnDate  - ISO date string
 * @param {boolean} [protectionPlan=false] - whether the renter opted in to DPP
 * @returns {string[]|null} array of plain-text line items, or null if vehicleId unknown
 *
 * Example output for a 10-day camry rental with DPP:
 *   ["1 × Weekly ($350/week): $350", "3 × Daily ($50/day): $150",
 *    "Damage Protection Plan: $98", "Total: $598"]
 */
export function computeBreakdownLines(vehicleId, pickup, returnDate, protectionPlan = false) {
  const car = CARS[vehicleId];
  if (!car) return null;
  // Hourly-tier vehicles (Slingshot) do not use daily/weekly pricing
  if (car.hourlyTiers) return null;

  const lines = [];
  let remaining = computeRentalDays(pickup, returnDate);

  if (car.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    const subtotal = months * car.monthly;
    lines.push(`${months} × Monthly ($${car.monthly}/month): $${subtotal}`);
    remaining = remaining % 30;
  }
  if (car.biweekly && remaining >= 14) {
    const twoWeeks = Math.floor(remaining / 14);
    const subtotal = twoWeeks * car.biweekly;
    lines.push(`${twoWeeks} × Bi-weekly ($${car.biweekly}/2 weeks): $${subtotal}`);
    remaining = remaining % 14;
  }
  if (car.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    const subtotal = weeks * car.weekly;
    lines.push(`${weeks} × Weekly ($${car.weekly}/week): $${subtotal}`);
    remaining = remaining % 7;
  }
  if (remaining > 0) {
    const subtotal = remaining * car.pricePerDay;
    lines.push(`${remaining} × Daily ($${car.pricePerDay}/day): $${subtotal}`);
  }

  if (car.deposit) {
    lines.push(`Security Deposit: $${car.deposit}`);
  }

  if (protectionPlan) {
    const days = computeRentalDays(pickup, returnDate);
    const dppCost = computeProtectionPlanCost(days);
    lines.push(`Damage Protection Plan: $${dppCost}`);
  }

  const totalDays = computeRentalDays(pickup, returnDate);
  const rentalCost = computeAmount(vehicleId, pickup, returnDate);
  const dppCost = protectionPlan ? computeProtectionPlanCost(totalDays) : 0;
  const preTax = rentalCost + dppCost;
  const tax = Math.round(preTax * LA_TAX_RATE * 100) / 100;
  const total = Math.round((preTax + tax) * 100) / 100;
  lines.push(`Tax (${(LA_TAX_RATE * 100).toFixed(2)}% LA): $${tax.toFixed(2)}`);
  lines.push(`Total: $${total.toFixed(2)}`);

  return lines;
}
