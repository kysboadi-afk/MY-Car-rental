// api/_pricing.js
// Canonical vehicle pricing used by serverless functions.
// The server always recomputes charges from these constants;
// any client-supplied amount is intentionally ignored to prevent tampering.

// Los Angeles, CA combined sales tax rate applied to every rental.
// Business is operated in the City of Los Angeles; tax is always collected
// at this rate regardless of the renter's home address.
// Combined City of Los Angeles rate: CA state 7.25% + LA county 2.25% + LA city 0.75% = 10.25%
export const LA_TAX_RATE = 0.1025;

// Non-refundable reservation deposit for Camry "Reserve Now" mode.
// Renters who choose "Reserve Now" pay this upfront; the remaining rental balance is due at pickup.
export const CAMRY_BOOKING_DEPOSIT = 50;

export const CARS = {
  camry:      { name: "Camry 2012",     pricePerDay: 55,  weekly: 350, biweekly: 650, monthly: 1300, deposit: 0 },
  camry2013:  { name: "Camry 2013 SE",  pricePerDay: 55,  weekly: 350, biweekly: 650, monthly: 1300, deposit: 0 },
};

// Canonical vehicle IDs derived from the CARS registry above.
// Adding a new vehicle to CARS automatically adds it here, which propagates to
// every endpoint that validates or iterates over the fleet — no manual list updates needed.
export const FLEET_VEHICLE_IDS = Object.keys(CARS);

// Damage Protection Plan rates — must stay in sync with car.js client-side constants.
// Legacy tiered rates (used for backward-compatibility and PDF display).
export const PROTECTION_PLAN_WEEKLY   = 85;   // $85/week  (7-day block)
export const PROTECTION_PLAN_BIWEEKLY = 150;  // $150/2 weeks (14-day block)
export const PROTECTION_PLAN_MONTHLY  = 295;  // $295/month (30-day block)
// Legacy daily rate derived from weekly (used when no tier is specified).
export const PROTECTION_PLAN_DAILY    = Math.ceil(PROTECTION_PLAN_WEEKLY / 7); // ≈ $13/day

// Economy car protection plan tiers (flat daily rates — no weekly/monthly discount).
export const PROTECTION_PLAN_BASIC    = 15;  // $15/day — limits liability to $2,500
export const PROTECTION_PLAN_STANDARD = 30;  // $30/day — limits liability to $1,000
export const PROTECTION_PLAN_PREMIUM  = 50;  // $50/day — limits liability to $500

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
 *
 * When `tier` is "basic", "standard", or "premium" (Economy car tiers), a flat
 * daily rate is applied for all days.
 *
 * When `tier` is null/undefined (legacy callers and PDF display), the greedy
 * monthly → biweekly → weekly → daily algorithm is used.
 *
 * @param {number} days  - number of rental days (min 1)
 * @param {string|null} [tier=null] - "basic" | "standard" | "premium" | null
 * @returns {number} protection plan cost in dollars
 */
export function computeProtectionPlanCost(days, tier = null) {
  const d = Math.max(1, days);
  if (tier === "basic")    return d * PROTECTION_PLAN_BASIC;
  if (tier === "standard") return d * PROTECTION_PLAN_STANDARD;
  if (tier === "premium")  return d * PROTECTION_PLAN_PREMIUM;
  // Legacy / null tier: greedy monthly → biweekly → weekly → daily
  let remaining = d;
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
 * Get the current active vehicle IDs, merging the static FLEET_VEHICLE_IDS list with
 * any vehicles registered in the Supabase `vehicles` table.  Falls back to the static
 * list when Supabase is unavailable or the query fails, so cold-start / no-DB paths
 * are unaffected.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @returns {Promise<string[]>} deduped list of vehicle IDs
 */
export async function getActiveVehicleIds(supabase) {
  if (!supabase) return FLEET_VEHICLE_IDS;
  try {
    const { data, error } = await supabase
      .from("vehicles")
      .select("vehicle_id, data");
    if (error || !data?.length) return FLEET_VEHICLE_IDS;
    const dynamic = data
      .filter(row => !row.data?.status || row.data.status === "active")
      .map(row => row.vehicle_id);
    return [...new Set([...FLEET_VEHICLE_IDS, ...dynamic])];
  } catch {
    return FLEET_VEHICLE_IDS;
  }
}

/**
 * Get all known vehicle IDs (active, inactive, and maintenance), merging the
 * static FLEET_VEHICLE_IDS list with every vehicle registered in the Supabase
 * `vehicles` table.  Used by admin-only endpoints (v2-bookings, v2-dashboard)
 * so historical bookings for retired vehicles remain visible.  Falls back to
 * the static list when Supabase is unavailable.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @returns {Promise<string[]>} deduped list of all known vehicle IDs
 */
export async function getAllVehicleIds(supabase) {
  if (!supabase) return FLEET_VEHICLE_IDS;
  try {
    const { data, error } = await supabase
      .from("vehicles")
      .select("vehicle_id");
    if (error || !data?.length) return FLEET_VEHICLE_IDS;
    const dynamic = data.map(row => row.vehicle_id);
    return [...new Set([...FLEET_VEHICLE_IDS, ...dynamic])];
  } catch {
    return FLEET_VEHICLE_IDS;
  }
}

/**
 * Fetch pricing data for a single vehicle.
 *
 * Resolution order:
 *   1. vehicle_pricing table — the canonical source for all known vehicles.
 *   2. vehicles.data JSONB — fallback for dynamically added vehicles whose
 *      vehicle_pricing row was not yet created (e.g. the upsert failed silently
 *      at creation time or pricing was not entered when the vehicle was added).
 *
 * Throws only when neither source has usable pricing data.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} vehicleId - vehicle_id value stored in the DB
 * @returns {Promise<object>} a pricing object compatible with computeAmountFromPricing()
 */
export async function getVehiclePricing(supabase, vehicleId) {
  const { data, error } = await supabase
    .from('vehicle_pricing')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .single();

  // Happy path — vehicle_pricing row exists.
  if (!error) return data;

  // PGRST116 = "no rows" — try the vehicle's own JSONB data blob as a fallback.
  // Any other error (network, schema, etc.) should still be surfaced immediately.
  if (error.code !== 'PGRST116') {
    console.error('[pricing] fetch failed', { vehicleId, error });
    throw new Error(`Failed to load pricing for vehicle: ${vehicleId}`);
  }

  // Fallback: read pricing from vehicles.data JSONB (populated by v2-vehicles create).
  const { data: vehicleRow, error: vehicleErr } = await supabase
    .from('vehicles')
    .select('data')
    .eq('vehicle_id', vehicleId)
    .single();

  if (!vehicleErr && vehicleRow?.data) {
    const vdata = vehicleRow.data;
    const dailyPrice    = vdata.daily_price    ? Number(vdata.daily_price)    : null;
    const weeklyPrice   = vdata.weekly_price   ? Number(vdata.weekly_price)   : null;
    const biweeklyPrice = vdata.biweekly_price ? Number(vdata.biweekly_price) : null;
    const monthlyPrice  = vdata.monthly_price  ? Number(vdata.monthly_price)  : null;

    if (dailyPrice) {
      console.warn('[pricing] vehicle_pricing row missing — falling back to vehicles.data JSONB', { vehicleId });
      return {
        vehicle_id:     vehicleId,
        daily_price:    dailyPrice,
        weekly_price:   weeklyPrice   || dailyPrice * 7,
        biweekly_price: biweeklyPrice || dailyPrice * 14,
        monthly_price:  monthlyPrice  || dailyPrice * 28,
      };
    }
  }

  console.error('[pricing] fetch failed — no vehicle_pricing row and no JSONB fallback', { vehicleId, error });
  throw new Error(`Failed to load pricing for vehicle: ${vehicleId}`);
}

/**
 * Compute the rental cost from a vehicle_pricing row and a day count.
 * Applies flat tier pricing (no greedy chain):
 *   7 days  → weekly_price
 *   14 days → biweekly_price
 *   ≥28 days → monthly_price
 *   else    → daily_price × days
 *
 * @param {object} pricing  - vehicle_pricing row from getVehiclePricing()
 * @param {number} days     - number of rental days (min 1)
 * @returns {number} rental cost in dollars (pre-tax, no DPP)
 */
export function computeAmountFromPricing(pricing, days) {
  if (days === 7)       return pricing.weekly_price;
  if (days === 14)      return pricing.biweekly_price;
  if (days >= 28)       return pricing.monthly_price;
  return pricing.daily_price * days;
}

/**
 * Compute human-readable pricing breakdown lines for a daily/weekly rental.
 * Uses the same greedy tier logic as computeAmount.
 * @param {string} vehicleId   - key from CARS
 * @param {string} pickup      - ISO date string
 * @param {string} returnDate  - ISO date string
 * @param {boolean} [protectionPlan=false] - whether the renter opted in to DPP
 * @param {string|null} [protectionPlanTier=null] - "basic"|"standard"|"premium"|null
 * @returns {string[]|null} array of plain-text line items, or null if vehicleId unknown
 *
 * Example output for a 10-day camry rental with DPP:
 *   ["1 × Weekly ($350/week): $350", "3 × Daily ($55/day): $165",
 *    "Damage Protection Plan: $98", "Total: $613"]
 */
export function computeBreakdownLines(vehicleId, pickup, returnDate, protectionPlan = false, protectionPlanTier = null) {
  const car = CARS[vehicleId];
  if (!car) return null;

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
    const dppCost = computeProtectionPlanCost(days, protectionPlanTier);
    const tierLabel = protectionPlanTier ? ` (${protectionPlanTier.charAt(0).toUpperCase() + protectionPlanTier.slice(1)})` : "";
    lines.push(`Damage Protection Plan${tierLabel}: $${dppCost}`);
  }

  const totalDays = computeRentalDays(pickup, returnDate);
  const rentalCost = computeAmount(vehicleId, pickup, returnDate);
  const dppCost = protectionPlan ? computeProtectionPlanCost(totalDays, protectionPlanTier) : 0;
  const preTax = rentalCost + dppCost;
  const taxAmount = Math.round(preTax * LA_TAX_RATE * 100) / 100;
  const total = Math.round((preTax + taxAmount) * 100) / 100;
  lines.push(`Sales Tax (${(LA_TAX_RATE * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`);
  // NOTE: send-reservation-email.js checks startsWith("Total:") to apply bold styling.
  // Keep this prefix consistent if the format ever changes.
  lines.push(`Total: $${total.toFixed(2)}`);

  return lines;
}
