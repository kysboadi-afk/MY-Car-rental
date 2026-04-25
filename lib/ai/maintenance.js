// lib/ai/maintenance.js
// Maintenance status computation — pure functions, no I/O.
//
// Computes OK / DUE_SOON / OVERDUE for each tracked vehicle based on:
//   miles_since_service = current_mileage - last_service_mileage
//
// Thresholds (using vehicle.maintenance_interval, default 5000 mi):
//   OK        → miles_since_service < 80 % of interval
//   DUE_SOON  → miles_since_service >= 80 % of interval
//   OVERDUE   → miles_since_service >= 100 % of interval
//
// This is a simplified, vehicle-level status that complements the more
// granular per-service tracking in lib/ai/mileage.js (oil/brakes/tires).
// It is stored in the maintenance table (migration 0029) and used by
// updateMaintenanceStatus() (api/update-maintenance-status.js).

export const MAINTENANCE_STATUS = {
  OK:        "OK",
  DUE_SOON:  "DUE_SOON",
  OVERDUE:   "OVERDUE",
};

const DEFAULT_INTERVAL = 5000;  // miles
const DUE_SOON_PCT     = 0.8;   // warn at 80 % of interval

/**
 * Compute maintenance status for a single vehicle.
 *
 * @param {object} vehicle
 * @param {number|null} vehicle.mileage           - current odometer reading
 * @param {number|null} vehicle.last_service_mileage - odometer at last service
 *                                                    (may come from data JSONB or top-level)
 * @param {number}      [vehicle.maintenance_interval=5000] - service interval in miles
 * @returns {{
 *   status:             string,   // OK | DUE_SOON | OVERDUE
 *   miles_since_service: number,
 *   interval:            number,
 *   miles_until_service: number,  // negative when overdue
 *   pct_used:            number,  // 0–1+ fraction of interval consumed
 * }}
 */
export function computeMaintenanceStatus(vehicle) {
  const currentMileage     = Number(vehicle.mileage) || 0;
  const lastServiceMileage = Number(vehicle.last_service_mileage ?? vehicle.data?.last_service_mileage) || 0;
  const interval           = Number(vehicle.maintenance_interval) || DEFAULT_INTERVAL;

  const milesSince = Math.max(0, currentMileage - lastServiceMileage);
  const pctUsed    = interval > 0 ? milesSince / interval : 0;
  const milesUntil = interval - milesSince;

  let status;
  if (pctUsed >= 1.0) {
    status = MAINTENANCE_STATUS.OVERDUE;
  } else if (pctUsed >= DUE_SOON_PCT) {
    status = MAINTENANCE_STATUS.DUE_SOON;
  } else {
    status = MAINTENANCE_STATUS.OK;
  }

  return {
    status,
    miles_since_service: Math.round(milesSince * 10) / 10,
    interval,
    miles_until_service: Math.round(milesUntil * 10) / 10,
    pct_used:            Math.round(pctUsed * 1000) / 1000,
  };
}

/**
 * Compute maintenance status for every tracked vehicle in the fleet.
 * Returns structured alerts for admin / AI consumption.
 *
 * @param {object[]|object} vehicles
 *   Array or map of vehicle objects. Each must have:
 *   - vehicle_id, mileage (optional), last_service_mileage / data.last_service_mileage,
 *     maintenance_interval, is_tracked
 * @returns {{
 *   results:  Array<{ vehicle_id, vehicle_name, status, miles_since_service, interval, miles_until_service, pct_used }>,
 *   alerts:   Array<{ level: "critical"|"warning", vehicle_id, vehicle_name, message, status }>,
 *   overdue:  number,
 *   due_soon: number,
 *   ok:       number,
 * }}
 */
export function computeFleetAlerts(vehicles) {
  const rows = Array.isArray(vehicles) ? vehicles : Object.values(vehicles);

  const results = [];
  const alerts  = [];
  let overdue   = 0;
  let dueSoon   = 0;
  let ok        = 0;

  for (const v of rows) {
    // Only process vehicles flagged for tracking
    if (!v.is_tracked && v.bouncie_device_id == null) continue;

    const vehicleId   = v.vehicle_id || v.id || "(unknown)";
    const vehicleName = v.vehicle_name || v.data?.vehicle_name || v.data?.name || vehicleId;

    const computed = computeMaintenanceStatus(v);
    const result   = { vehicle_id: vehicleId, vehicle_name: vehicleName, ...computed };
    results.push(result);

    if (computed.status === MAINTENANCE_STATUS.OVERDUE) {
      overdue++;
      alerts.push({
        level:       "critical",
        vehicle_id:  vehicleId,
        vehicle_name: vehicleName,
        status:      computed.status,
        message:     `${vehicleName} is OVERDUE for service — ${computed.miles_since_service} mi since last service (interval: ${computed.interval} mi). Block from new bookings until serviced.`,
      });
    } else if (computed.status === MAINTENANCE_STATUS.DUE_SOON) {
      dueSoon++;
      alerts.push({
        level:       "warning",
        vehicle_id:  vehicleId,
        vehicle_name: vehicleName,
        status:      computed.status,
        message:     `${vehicleName} is DUE_SOON for service — ${computed.miles_since_service} mi since last service, ${Math.abs(computed.miles_until_service)} mi remaining (interval: ${computed.interval} mi). Consider scheduling maintenance or adding a surcharge.`,
      });
    } else {
      ok++;
    }
  }

  return { results, alerts, overdue, due_soon: dueSoon, ok };
}
