// lib/ai/mileage.js
// Mileage analysis engine — pure computation, no I/O.
//
// Inputs:
//   mileageData  — rows from vehicle_mileage joined with vehicle names
//   recentTrips  — rows from trip_log (used for daily mileage trends)
//
// Outputs:
//   alerts — human-readable strings suitable for detectProblems() and ai_logs
//   stats  — per-vehicle statistics for the dashboard

// ── Maintenance thresholds (miles since last recorded service) ───────────────
const OIL_CHANGE_MILES    = 3000;
const TIRE_ROTATION_MILES = 5000;
const MAJOR_SERVICE_MILES = 12000;

// Average daily mileage (over active-trip days) that warrants a flag
const HIGH_DAILY_MILES = 100;

/**
 * Analyse fleet mileage data and return alerts + per-vehicle statistics.
 *
 * @param {Array}  mileageData   - rows from vehicle_mileage, each with:
 *   { vehicle_id, vehicle_name?, total_mileage, last_service_mileage, last_trip_at, last_synced_at }
 * @param {Array}  [recentTrips] - rows from trip_log (any window), each with:
 *   { vehicle_id, trip_distance, trip_at }
 * @returns {{ alerts: string[], stats: object[] }}
 */
export function analyzeMileage(mileageData = [], recentTrips = []) {
  const alerts = [];
  const stats  = [];
  const now    = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 86400000);

  for (const row of mileageData) {
    const {
      vehicle_id,
      vehicle_name,
      total_mileage       = 0,
      last_service_mileage = 0,
    } = row;

    const name              = vehicle_name || vehicle_id;
    const milesSinceService = Math.max(0, (total_mileage || 0) - (last_service_mileage || 0));

    // ── Maintenance alerts (most severe threshold wins) ───────────────────
    if (milesSinceService >= MAJOR_SERVICE_MILES) {
      alerts.push(
        `${name}: ${Math.round(milesSinceService).toLocaleString()} miles since last service — ` +
        `major service overdue (${MAJOR_SERVICE_MILES.toLocaleString()} mi interval)`
      );
    } else if (milesSinceService >= TIRE_ROTATION_MILES) {
      alerts.push(
        `${name}: ${Math.round(milesSinceService).toLocaleString()} miles since last service — ` +
        `tire rotation recommended (${TIRE_ROTATION_MILES.toLocaleString()} mi interval)`
      );
    } else if (milesSinceService >= OIL_CHANGE_MILES) {
      alerts.push(
        `${name}: ${Math.round(milesSinceService).toLocaleString()} miles since last service — ` +
        `oil change due (${OIL_CHANGE_MILES.toLocaleString()} mi interval)`
      );
    }

    // ── Per-vehicle trip stats (last 30 days) ─────────────────────────────
    const vehicleTrips = recentTrips.filter(
      (t) => t.vehicle_id === vehicle_id && new Date(t.trip_at) >= thirtyDaysAgo
    );

    const totalDistance30d = vehicleTrips.reduce((s, t) => s + (Number(t.trip_distance) || 0), 0);
    const daysWithTrips    = new Set(vehicleTrips.map((t) => (t.trip_at || "").slice(0, 10))).size;
    const avgDailyMiles    = daysWithTrips > 0 ? totalDistance30d / daysWithTrips : 0;

    if (avgDailyMiles > HIGH_DAILY_MILES) {
      alerts.push(
        `${name}: averaging ${Math.round(avgDailyMiles)} miles/day over active-trip days ` +
        `in the last 30 days — above normal usage`
      );
    }

    // ── Maintenance prediction ─────────────────────────────────────────────
    // "Miles until next service" across the nearest threshold
    const nextThreshold = [OIL_CHANGE_MILES, TIRE_ROTATION_MILES, MAJOR_SERVICE_MILES]
      .find((t) => milesSinceService < t) ?? MAJOR_SERVICE_MILES;
    const milesUntilService = Math.max(0, nextThreshold - milesSinceService);

    stats.push({
      vehicle_id,
      name,
      total_mileage:           roundMiles(total_mileage),
      last_service_mileage:    roundMiles(last_service_mileage),
      miles_since_service:     roundMiles(milesSinceService),
      miles_until_service:     roundMiles(milesUntilService),
      next_service_type:       nextServiceType(milesSinceService),
      trips_last_30d:          vehicleTrips.length,
      total_distance_last_30d: roundMiles(totalDistance30d),
      avg_daily_miles_30d:     roundMiles(avgDailyMiles),
      last_trip_at:            row.last_trip_at  ?? null,
      last_synced_at:          row.last_synced_at ?? null,
    });
  }

  return { alerts, stats };
}

function roundMiles(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function nextServiceType(milesSinceService) {
  if (milesSinceService >= MAJOR_SERVICE_MILES) return "major service (overdue)";
  if (milesSinceService >= TIRE_ROTATION_MILES) return "tire rotation (overdue)";
  if (milesSinceService >= OIL_CHANGE_MILES)    return "oil change (overdue)";
  if (milesSinceService >= OIL_CHANGE_MILES * 0.8) return "oil change (due soon)";
  return "oil change";
}
