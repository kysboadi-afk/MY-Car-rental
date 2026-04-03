// lib/ai/mileage.js
// Mileage analysis engine — pure computation, no I/O.
//
// Applies only to Bouncie-tracked vehicles (bouncie_device_id set).
// Slingshots are excluded before this function is called by the callers.
//
// Maintenance thresholds (rideshare-optimised):
//   Oil change    : every 3,000–4,000 miles
//   Brakes check  : every 10,000 miles
//   Tires         : every 20,000–25,000 miles
//
// Usage alerts:
//   High daily usage: avg > 300 miles on active-trip days (last 30 days)
//   Idle vehicle    : no trips logged in the last 7 days

// ── Maintenance thresholds ────────────────────────────────────────────────────
const OIL_CHANGE_MILES       = 3000;
const OIL_CHANGE_MAX_MILES   = 4000;  // upper bound of oil change window (rideshare)
const OIL_CHANGE_WARN_MILES  = 2500;  // warn at 83 % of threshold
const BRAKES_MILES           = 10000;
const BRAKES_WARN_MILES      = 9000;
const TIRES_MILES            = 20000;
const TIRES_WARN_MILES       = 18000;

// Usage alert thresholds
const HIGH_DAILY_MILES = 300;  // miles per active-trip day
const IDLE_DAYS        = 7;    // no trips for this many days = "idle"

/**
 * Analyse fleet mileage data and return alerts + per-vehicle statistics.
 *
 * @param {Array}  mileageData  - one entry per tracked (non-slingshot) vehicle:
 *   { vehicle_id, vehicle_name?, total_mileage, last_service_mileage, last_synced_at }
 * @param {Array}  [recentTrips] - rows from trip_log (any window), each with:
 *   { vehicle_id, trip_distance, trip_at }
 * @returns {{ alerts: string[], stats: object[] }}
 */
export function analyzeMileage(mileageData = [], recentTrips = []) {
  const alerts = [];
  const stats  = [];
  const now    = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 86400000);
  const sevenDaysAgo  = new Date(now - IDLE_DAYS * 86400000);

  for (const row of mileageData) {
    const {
      vehicle_id,
      vehicle_name,
      total_mileage        = 0,
      last_service_mileage = 0,
      last_synced_at,
    } = row;

    const name              = vehicle_name || vehicle_id;
    const miles             = Number(total_mileage)        || 0;
    const lastService       = Number(last_service_mileage) || 0;
    const milesSinceService = Math.max(0, miles - lastService);

    // ── Maintenance alerts (most severe threshold checked first) ───────────
    const maintenanceAlert = buildMaintenanceAlert(name, milesSinceService);
    if (maintenanceAlert) alerts.push(maintenanceAlert);

    // ── Trip stats (last 30 days) ──────────────────────────────────────────
    const vehicleTrips30d  = recentTrips.filter(
      (t) => t.vehicle_id === vehicle_id && new Date(t.trip_at) >= thirtyDaysAgo
    );
    const totalDist30d     = vehicleTrips30d.reduce((s, t) => s + (Number(t.trip_distance) || 0), 0);
    const daysWithTrips    = new Set(vehicleTrips30d.map((t) => {
      try { return new Date(t.trip_at).toISOString().slice(0, 10); } catch { return ""; }
    }).filter(Boolean)).size;
    const avgDailyMiles    = daysWithTrips > 0 ? totalDist30d / daysWithTrips : 0;

    // ── High daily usage alert ─────────────────────────────────────────────
    if (avgDailyMiles > HIGH_DAILY_MILES) {
      alerts.push(
        `${name}: averaging ${Math.round(avgDailyMiles)} miles/day over active-trip days ` +
        `in the last 30 days — above threshold (${HIGH_DAILY_MILES} mi/day)`
      );
    }

    // ── Idle vehicle alert ─────────────────────────────────────────────────
    const tripsLast7d = recentTrips.filter(
      (t) => t.vehicle_id === vehicle_id && new Date(t.trip_at) >= sevenDaysAgo
    );
    if (tripsLast7d.length === 0 && vehicleTrips30d.length > 0) {
      // Only flag idle if there was recent activity (vehicle is in use, not parked)
      alerts.push(`${name}: no trips recorded in the last ${IDLE_DAYS} days — vehicle may be idle`);
    }

    // ── Compute next service info ──────────────────────────────────────────
    const { nextType, milesUntilService } = nextService(milesSinceService);

    stats.push({
      vehicle_id,
      name,
      total_mileage:           roundMi(miles),
      last_service_mileage:    roundMi(lastService),
      miles_since_service:     roundMi(milesSinceService),
      miles_until_service:     roundMi(milesUntilService),
      next_service_type:       nextType,
      trips_last_30d:          vehicleTrips30d.length,
      total_distance_last_30d: roundMi(totalDist30d),
      avg_daily_miles_30d:     roundMi(avgDailyMiles),
      last_synced_at:          last_synced_at ?? null,
    });
  }

  return { alerts, stats };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function roundMi(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function buildMaintenanceAlert(name, milesSinceService) {
  if (milesSinceService >= TIRES_MILES) {
    return `${name}: ${fmt(milesSinceService)} miles since last service — tire replacement due (every ${fmt(TIRES_MILES)} mi)`;
  }
  if (milesSinceService >= TIRES_WARN_MILES) {
    return `${name}: ${fmt(milesSinceService)} miles since last service — tires due soon (${fmt(TIRES_MILES)} mi interval)`;
  }
  if (milesSinceService >= BRAKES_MILES) {
    return `${name}: ${fmt(milesSinceService)} miles since last service — brake inspection due (every ${fmt(BRAKES_MILES)} mi)`;
  }
  if (milesSinceService >= BRAKES_WARN_MILES) {
    return `${name}: ${fmt(milesSinceService)} miles since last service — brakes due soon (${fmt(BRAKES_MILES)} mi interval)`;
  }
  if (milesSinceService >= OIL_CHANGE_MILES) {
    return `${name}: ${fmt(milesSinceService)} miles since last service — oil change due (every ${fmt(OIL_CHANGE_MILES)}–${fmt(OIL_CHANGE_MAX_MILES)} mi)`;
  }
  if (milesSinceService >= OIL_CHANGE_WARN_MILES) {
    return `${name}: ${fmt(milesSinceService)} miles since last service — oil change due soon`;
  }
  return null;
}

function nextService(milesSinceService) {
  const thresholds = [
    { limit: OIL_CHANGE_MILES, type: "oil change" },
    { limit: BRAKES_MILES,     type: "brake inspection" },
    { limit: TIRES_MILES,      type: "tire replacement" },
  ];
  for (const { limit, type } of thresholds) {
    if (milesSinceService < limit) {
      return { nextType: type, milesUntilService: limit - milesSinceService };
    }
  }
  return { nextType: "major service (overdue)", milesUntilService: 0 };
}

function fmt(n) {
  return Math.round(n).toLocaleString();
}

//
// Inputs:
//   mileageData  — rows from vehicle_mileage joined with vehicle names
//   recentTrips  — rows from trip_log (used for daily mileage trends)
//
// Outputs:
//   alerts — human-readable strings suitable for detectProblems() and ai_logs
