// lib/ai/priority-alerts.js
// Determines which high-priority vehicles require automatic owner/driver alerts.
// Pure function — no I/O, no side effects.
//
// Only vehicles whose priority = "high" are eligible for auto-actions.
// Auto-actions are deduped: a vehicle is skipped when:
//   • last_auto_action_reason === current reason  (same issue, already alerted)
// A vehicle IS re-triggered when:
//   • last_auto_action_reason differs (new or changed issue)
//   • last_auto_action_at is null (never alerted)
//
// Safety policy (never auto-execute):
//   • vehicle status changes
//   • destructive / availability changes
// Only allowed auto-actions:
//   • send owner SMS alert
//   • send owner email alert
//   • send driver SMS (maintenance-related issues only, requires active booking)
//   • set action_status = "in_progress" (only when currently "pending")
//
// Usage:
//   import { computePriorityAlerts } from "../lib/ai/priority-alerts.js";
//   const alerts = computePriorityAlerts({ vehicles, mileageStatMap, activeBookingByVehicle });

import { computeVehiclePriority } from "./priority.js";

/**
 * Compute the list of priority auto-alerts to fire.
 *
 * @param {object} params
 * @param {object} params.vehicles
 *   Map of vehicleId → vehicle object (with bouncie_device_id, decision_status,
 *   action_status, last_auto_action_at, last_auto_action_reason, type, vehicle_name)
 * @param {object} params.mileageStatMap
 *   Map of vehicleId → mileage stats object from analyzeMileage()
 *   ({ miles_since_oil, miles_since_brakes, miles_since_tires })
 * @param {object} params.activeBookingByVehicle
 *   Map of vehicleId → active booking ({ name, phone, bookingId })
 *
 * @returns {Array<PriorityAlert>}
 */
export function computePriorityAlerts({ vehicles = {}, mileageStatMap = {}, activeBookingByVehicle = {} }) {
  const alerts = [];

  for (const [vehicleId, v] of Object.entries(vehicles)) {
    const mileageStat = mileageStatMap[vehicleId] || null;
    const { priority, reason } = computeVehiclePriority(v, mileageStat);

    // Only high-priority vehicles trigger auto-actions
    if (priority !== "high") continue;

    const lastReason = v.last_auto_action_reason || null;

    // Deduplication: skip if the reason hasn't changed (same issue already alerted)
    if (lastReason === reason) continue;

    const isMaintenance = reason.startsWith("Maintenance overdue");
    const activeBooking = activeBookingByVehicle[vehicleId] || null;

    alerts.push({
      vehicleId,
      name:            v.vehicle_name || v.name || vehicleId,
      priority,
      reason,
      isMaintenance,
      // Only set in_progress when action_status is currently "pending"
      setInProgress:   v.action_status === "pending",
      // Driver SMS only for maintenance issues and only when there's an active booking
      alertDriver:     isMaintenance && !!activeBooking,
      driverPhone:     activeBooking?.phone   || null,
      driverName:      activeBooking?.name    || null,
      bookingId:       activeBooking?.bookingId || null,
    });
  }

  return alerts;
}
