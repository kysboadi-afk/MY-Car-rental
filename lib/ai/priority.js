// lib/ai/priority.js
// Derives an operational priority level for a single vehicle.
// Pure function — no I/O, no side effects.
//
// Priority order (highest → lowest):
//   high   — maintenance overdue, or decision_status = "review_for_sale"
//   medium — decision_status = "needs_attention"
//   low    — no flags (monitor / keep)
//
// The caller optionally passes mileage stats from analyzeMileage() so that
// the "maintenance overdue" check can be made without re-running the engine.
//
// Usage:
//   import { computeVehiclePriority } from "../lib/ai/priority.js";
//   const { priority, reason } = computeVehiclePriority(vehicleEntry, mileageStats);

// Maintenance overdue thresholds (mirrors mileage.js constants)
const OIL_CHANGE_MILES = 3000;
const BRAKES_MILES     = 10000;
const TIRES_MILES      = 20000;

/**
 * Derive priority for a vehicle.
 *
 * @param {object} vehicle - vehicle record with optional fields:
 *   type, bouncie_device_id,
 *   decision_status ("review_for_sale" | "needs_attention" | null),
 *   action_status   ("pending" | "in_progress" | "resolved" | null)
 *
 * @param {object|null} [mileageStat] - optional entry from analyzeMileage() stats array:
 *   { miles_since_oil, miles_since_brakes, miles_since_tires }
 *   When provided, used to determine "maintenance overdue" status.
 *
 * @returns {{ priority: "high"|"medium"|"low", reason: string }}
 */
export function computeVehiclePriority(vehicle = {}, mileageStat = null) {
  const vType = vehicle.type || vehicle.vehicle_type || "";
  const isCar = vType !== "slingshot";

  // ── Maintenance overdue (cars with Bouncie only) ────────────────────────
  // Resolved actions don't re-trigger high priority for existing decisions.
  if (isCar && vehicle.bouncie_device_id && mileageStat) {
    const sinceOil    = Number(mileageStat.miles_since_oil)    || 0;
    const sinceBrakes = Number(mileageStat.miles_since_brakes) || 0;
    const sinceTires  = Number(mileageStat.miles_since_tires)  || 0;

    const overdueServices = [];
    if (sinceOil    >= OIL_CHANGE_MILES) overdueServices.push("oil change");
    if (sinceBrakes >= BRAKES_MILES)     overdueServices.push("brake inspection");
    if (sinceTires  >= TIRES_MILES)      overdueServices.push("tire replacement");

    if (overdueServices.length > 0) {
      return {
        priority: "high",
        reason:   `Maintenance overdue: ${overdueServices.join(", ")}`,
      };
    }
  }

  // ── Strategic decision status ────────────────────────────────────────────
  if (vehicle.decision_status === "review_for_sale") {
    return { priority: "high",   reason: "Flagged for review / potential sale" };
  }
  if (vehicle.decision_status === "needs_attention") {
    return { priority: "medium", reason: "Needs attention" };
  }

  // ── Default: no flags ────────────────────────────────────────────────────
  return { priority: "low", reason: "No active flags — monitor / keep" };
}

/**
 * Sort a list of { vehicleId, priority, ... } entries from highest to lowest
 * priority (high → medium → low).
 *
 * @param {Array} entries - array of objects that each have a `priority` field
 * @returns {Array} sorted copy
 */
export function sortByPriority(entries) {
  const ORDER = { high: 0, medium: 1, low: 2 };
  return [...entries].sort(
    (a, b) => (ORDER[a.priority] ?? 3) - (ORDER[b.priority] ?? 3)
  );
}

/**
 * Return true when the mileage stats for a vehicle show no overdue services.
 * Used by toolMarkMaintenance to decide whether to auto-resolve action_status.
 *
 * @param {object|null} mileageStat
 * @returns {boolean}
 */
export function hasNoOverdueMaintenance(mileageStat) {
  if (!mileageStat) return true; // no data → assume clear
  const sinceOil    = Number(mileageStat.miles_since_oil)    || 0;
  const sinceBrakes = Number(mileageStat.miles_since_brakes) || 0;
  const sinceTires  = Number(mileageStat.miles_since_tires)  || 0;
  return sinceOil < OIL_CHANGE_MILES && sinceBrakes < BRAKES_MILES && sinceTires < TIRES_MILES;
}
