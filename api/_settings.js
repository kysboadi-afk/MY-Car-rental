// api/_settings.js
// Dynamic pricing loader — reads live pricing from the Supabase system_settings
// table so the admin can update prices (e.g. for promotions) through the admin
// portal without requiring a code deployment.
//
// All functions fall back to the hardcoded constants in _pricing.js when
// Supabase is unavailable, so the system degrades gracefully.
//
// Usage:
//   import { loadPricingSettings, computeAmountFromSettings, ... } from "./_settings.js";
//   const settings = await loadPricingSettings();
//   const total    = computeAmountFromSettings(vehicleId, pickup, returnDate, settings);

import { getSupabaseAdmin } from "./_supabase.js";
import {
  LA_TAX_RATE,
  CARS,
  SLINGSHOT_BOOKING_DEPOSIT,
  CAMRY_BOOKING_DEPOSIT,
  PROTECTION_PLAN_BASIC,
  PROTECTION_PLAN_STANDARD,
  PROTECTION_PLAN_PREMIUM,
  PROTECTION_PLAN_DAILY,
  PROTECTION_PLAN_WEEKLY,
  PROTECTION_PLAN_BIWEEKLY,
  PROTECTION_PLAN_MONTHLY,
  computeRentalDays,
} from "./_pricing.js";

// Keys that live in the system_settings table and their hardcoded fallback values.
// These match the DEFAULT_SETTINGS seed in api/v2-system-settings.js.
export const PRICING_DEFAULTS = {
  la_tax_rate:                LA_TAX_RATE,
  // Camry / economy car rates
  camry_daily_rate:           CARS.camry.pricePerDay,
  camry_weekly_rate:          CARS.camry.weekly,
  camry_biweekly_rate:        CARS.camry.biweekly,
  camry_monthly_rate:         CARS.camry.monthly,
  // Slingshot tier rates (price before security deposit)
  slingshot_3hr_rate:         200,
  slingshot_6hr_rate:         250,
  slingshot_daily_rate:       350,  // 24 hr / 1 day
  slingshot_2day_rate:        700,
  slingshot_3day_rate:        1050,
  // Deposits / booking fees
  slingshot_security_deposit: CARS.slingshot.deposit,
  slingshot_booking_deposit:  SLINGSHOT_BOOKING_DEPOSIT,
  camry_booking_deposit:      CAMRY_BOOKING_DEPOSIT,
};

/**
 * Loads live pricing settings from the Supabase system_settings table.
 * Only rows with category = "pricing" or "tax" are fetched, keeping the
 * query narrow and fast.
 *
 * Falls back to PRICING_DEFAULTS for any key that is missing, zero, or
 * not a valid positive number, and falls back entirely if Supabase is
 * unavailable (e.g. during local development or a network outage).
 *
 * @returns {Promise<object>} A plain object whose keys match PRICING_DEFAULTS.
 */
export async function loadPricingSettings() {
  const sb = getSupabaseAdmin();
  if (!sb) return { ...PRICING_DEFAULTS };

  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("key, value")
      .in("category", ["pricing", "tax"]);

    if (error || !Array.isArray(data)) return { ...PRICING_DEFAULTS };

    const result = { ...PRICING_DEFAULTS };
    for (const row of data) {
      if (Object.hasOwn(result, row.key)) {
        const num = Number(row.value);
        // Only override when the admin-supplied value is a finite, positive number.
        if (Number.isFinite(num) && num > 0) result[row.key] = num;
      }
    }
    return result;
  } catch {
    // Never crash a payment request because of a settings lookup failure.
    return { ...PRICING_DEFAULTS };
  }
}

// ─── Compute helpers using dynamic settings ──────────────────────────────────

/**
 * Compute total pre-tax rental cost for a Camry / economy car using live rates.
 * Applies the same greedy monthly → biweekly → weekly → daily tier logic as
 * computeAmount() in _pricing.js.
 *
 * @param {string} vehicleId  - "camry" | "camry2013"
 * @param {string} pickup     - ISO date string, e.g. "2025-07-01"
 * @param {string} returnDate - ISO date string, e.g. "2025-07-08"
 * @param {object} settings   - result of loadPricingSettings()
 * @returns {number|null} pre-tax total in dollars, or null for unknown vehicle
 */
export function computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings) {
  if (vehicleId !== "camry" && vehicleId !== "camry2013") return null;

  const monthly  = settings.camry_monthly_rate;
  const biweekly = settings.camry_biweekly_rate;
  const weekly   = settings.camry_weekly_rate;
  const daily    = settings.camry_daily_rate;

  let remaining = computeRentalDays(pickup, returnDate);
  let cost = 0;

  if (monthly  && remaining >= 30) { const m = Math.floor(remaining / 30); cost += m * monthly;  remaining %= 30; }
  if (biweekly && remaining >= 14) { const b = Math.floor(remaining / 14); cost += b * biweekly; remaining %= 14; }
  if (weekly   && remaining >= 7)  { const w = Math.floor(remaining / 7);  cost += w * weekly;   remaining %= 7;  }
  cost += remaining * daily;

  return cost; // Camry has no security deposit
}

/**
 * Compute total pre-tax + deposit charge for a Slingshot rental using live rates.
 * Mirrors computeSlingshotAmount() in _pricing.js but uses system_settings rates.
 *
 * @param {number} durationHours - 3 | 6 | 24 | 48 | 72
 * @param {object} settings      - result of loadPricingSettings()
 * @returns {number|null} total in dollars (tier price + security deposit), or null
 */
export function computeSlingshotAmountFromSettings(durationHours, settings) {
  const tierMap = {
    3:  settings.slingshot_3hr_rate,
    6:  settings.slingshot_6hr_rate,
    24: settings.slingshot_daily_rate,
    48: settings.slingshot_2day_rate,
    72: settings.slingshot_3day_rate,
  };
  const tierPrice = tierMap[Number(durationHours)];
  if (tierPrice == null) return null;
  return tierPrice + settings.slingshot_security_deposit;
}

/**
 * Compute the total rental amount for any vehicle using live settings.
 * Routes to the appropriate helper based on whether the vehicle uses hourly tiers
 * (Slingshot) or daily/weekly tiers (Camry / economy).
 *
 * @param {string} vehicleId     - key in CARS
 * @param {string} pickup        - ISO date string
 * @param {string} returnDate    - ISO date string
 * @param {object} settings      - result of loadPricingSettings()
 * @param {number} [slingshotDurationHours] - required for Slingshot vehicles
 * @returns {number|null}
 */
export function computeAmountFromSettings(vehicleId, pickup, returnDate, settings, slingshotDurationHours) {
  const car = CARS[vehicleId];
  if (!car) return null;
  if (car.hourlyTiers) {
    return computeSlingshotAmountFromSettings(slingshotDurationHours, settings);
  }
  return computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings);
}

/**
 * Compute Damage Protection Plan cost.
 * DPP rates are fixed by contract and are not stored in system_settings, so this
 * function delegates to the same logic used in _pricing.js (but is kept here so
 * payment endpoints only need to import from one place).
 *
 * @param {number}      days - rental days (min 1)
 * @param {string|null} tier - "basic" | "standard" | "premium" | null
 * @returns {number}
 */
export function computeDppCostFromSettings(days, tier) {
  const d = Math.max(1, days);
  if (tier === "basic")    return d * PROTECTION_PLAN_BASIC;
  if (tier === "standard") return d * PROTECTION_PLAN_STANDARD;
  if (tier === "premium")  return d * PROTECTION_PLAN_PREMIUM;
  // Legacy / Slingshot Option B greedy logic
  let remaining = d, cost = 0;
  if (remaining >= 30) { const m = Math.floor(remaining / 30); cost += m * PROTECTION_PLAN_MONTHLY; remaining %= 30; }
  if (remaining >= 14) { const b = Math.floor(remaining / 14); cost += b * PROTECTION_PLAN_BIWEEKLY; remaining %= 14; }
  if (remaining >= 7)  { const w = Math.floor(remaining / 7);  cost += w * PROTECTION_PLAN_WEEKLY;  remaining %= 7;  }
  cost += remaining * PROTECTION_PLAN_DAILY;
  return cost;
}

/**
 * Apply sales tax to a pre-tax amount using the live tax rate.
 * @param {number} preTax   - pre-tax amount in dollars
 * @param {object} settings - result of loadPricingSettings()
 * @returns {number} after-tax amount rounded to the nearest cent
 */
export function applyTax(preTax, settings) {
  return Math.round(preTax * (1 + settings.la_tax_rate) * 100) / 100;
}

/**
 * Compute human-readable pricing breakdown lines for a Camry / economy rental
 * using live settings, for use in email receipts.
 * Mirrors computeBreakdownLines() in _pricing.js but uses dynamic rates.
 *
 * @param {string}      vehicleId          - "camry" | "camry2013"
 * @param {string}      pickup             - ISO date string
 * @param {string}      returnDate         - ISO date string
 * @param {object}      settings           - result of loadPricingSettings()
 * @param {boolean}     [protectionPlan]   - whether DPP was selected
 * @param {string|null} [protectionPlanTier] - "basic"|"standard"|"premium"|null
 * @returns {string[]|null}
 */
export function computeBreakdownLinesFromSettings(vehicleId, pickup, returnDate, settings, protectionPlan = false, protectionPlanTier = null) {
  if (vehicleId !== "camry" && vehicleId !== "camry2013") return null;

  const monthly  = settings.camry_monthly_rate;
  const biweekly = settings.camry_biweekly_rate;
  const weekly   = settings.camry_weekly_rate;
  const daily    = settings.camry_daily_rate;

  const lines = [];
  let remaining = computeRentalDays(pickup, returnDate);

  if (monthly  && remaining >= 30) { const m = Math.floor(remaining / 30); lines.push(`${m} × Monthly ($${monthly}/month): $${m * monthly}`); remaining %= 30; }
  if (biweekly && remaining >= 14) { const b = Math.floor(remaining / 14); lines.push(`${b} × Bi-weekly ($${biweekly}/2 weeks): $${b * biweekly}`); remaining %= 14; }
  if (weekly   && remaining >= 7)  { const w = Math.floor(remaining / 7);  lines.push(`${w} × Weekly ($${weekly}/week): $${w * weekly}`); remaining %= 7;  }
  if (remaining > 0)               { lines.push(`${remaining} × Daily ($${daily}/day): $${remaining * daily}`); }

  const totalDays    = computeRentalDays(pickup, returnDate);
  const rentalCost   = computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings);
  const dppCost      = protectionPlan ? computeDppCostFromSettings(totalDays, protectionPlanTier) : 0;

  if (protectionPlan) {
    const tierLabel = protectionPlanTier
      ? ` (${protectionPlanTier.charAt(0).toUpperCase() + protectionPlanTier.slice(1)})`
      : "";
    lines.push(`Damage Protection Plan${tierLabel}: $${dppCost}`);
  }

  const preTax    = rentalCost + dppCost;
  const taxAmount = Math.round(preTax * settings.la_tax_rate * 100) / 100;
  const total     = Math.round((preTax + taxAmount) * 100) / 100;

  lines.push(`Sales Tax (${(settings.la_tax_rate * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`);
  // NOTE: send-reservation-email.js checks startsWith("Total:") for bold styling.
  lines.push(`Total: $${total.toFixed(2)}`);

  return lines;
}
