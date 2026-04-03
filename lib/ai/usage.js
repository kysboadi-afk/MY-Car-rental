// lib/ai/usage.js
// Usage monitoring engine — pure computation, no I/O.
//
// Applies only to Bouncie-tracked vehicles (bouncie_device_id set).
// Callers should pass trip_log rows for the vehicle (last 7 days at minimum).
//
// Thresholds:
//   🚨 Extreme daily usage : > 300 miles in last 24 h
//   ⚠️  High daily usage   : > 200 miles in last 24 h
//   🚨 Weekly overuse      : > 1,500 miles in last 7 days
//   💤 Idle vehicle        : 0 miles in last 24 h (but has trips in last 7 days)
//
// Driver classification (based on 7-day average):
//   ✅ Normal  : avg < 200 mi/day
//   ⚠️  High   : 200–300 mi/day
//   🚨 Extreme : > 300 mi/day

const EXTREME_DAILY_MILES  = 300;
const HIGH_DAILY_MILES     = 200;
const OVERUSE_WEEKLY_MILES = 1500;
const IDLE_HOURS           = 24;

/**
 * Analyze usage for a single tracked vehicle.
 *
 * @param {string} vehicleId
 * @param {string} vehicleName
 * @param {Array}  trips - rows from trip_log for any time window, each:
 *   { vehicle_id, trip_distance, trip_at }
 * @returns {{
 *   vehicle_id:   string,
 *   name:         string,
 *   miles_24h:    number,
 *   miles_7d:     number,
 *   avg_daily_7d: number,
 *   alerts:       string[],
 *   score:        { classification: string, label: string, avg_daily_miles: number }
 * }}
 */
export function analyzeUsage(vehicleId, vehicleName, trips) {
  const now    = Date.now();
  const h24ago = new Date(now - IDLE_HOURS * 3600000);
  const d7ago  = new Date(now - 7 * 86400000);

  const name = vehicleName || vehicleId;

  const trips24h = trips.filter(
    (t) => t.vehicle_id === vehicleId && new Date(t.trip_at) >= h24ago
  );
  const trips7d = trips.filter(
    (t) => t.vehicle_id === vehicleId && new Date(t.trip_at) >= d7ago
  );

  const miles24h  = trips24h.reduce((s, t) => s + (Number(t.trip_distance) || 0), 0);
  const miles7d   = trips7d.reduce((s, t) => s + (Number(t.trip_distance) || 0), 0);
  const avgDaily7d = miles7d / 7;

  const alerts = [];

  // 💤 Idle: no movement in 24 h but was active in last 7 days
  if (miles24h === 0 && trips7d.length > 0) {
    alerts.push(`💤 ${name} has not moved in 24h`);
  }

  // 🚨/⚠️ Daily usage alert
  if (miles24h > EXTREME_DAILY_MILES) {
    alerts.push(`🚨 ${name} driven ${fmt(miles24h)} miles in 24h`);
  } else if (miles24h > HIGH_DAILY_MILES) {
    alerts.push(`⚠️ ${name} driven ${fmt(miles24h)} miles in 24h (high usage)`);
  }

  // 🚨 Weekly overuse
  if (miles7d > OVERUSE_WEEKLY_MILES) {
    alerts.push(`🚨 ${name} exceeded ${fmt(miles7d)} miles this week`);
  }

  return {
    vehicle_id:   vehicleId,
    name,
    miles_24h:    round1(miles24h),
    miles_7d:     round1(miles7d),
    avg_daily_7d: round1(avgDaily7d),
    alerts,
    score:        scoreDriver(avgDaily7d),
  };
}

/**
 * Analyze usage for the entire fleet from a shared trip array.
 *
 * @param {Array} mileageData - vehicle rows (must have vehicle_id, vehicle_name)
 * @param {Array} recentTrips - trip_log rows (any window)
 * @returns {{ usageStats: object[], alerts: string[] }}
 */
export function analyzeFleetUsage(mileageData = [], recentTrips = []) {
  const usageStats = [];
  const alerts     = [];

  for (const row of mileageData) {
    const usage = analyzeUsage(
      row.vehicle_id,
      row.vehicle_name || row.vehicle_id,
      recentTrips
    );
    usageStats.push(usage);
    for (const a of usage.alerts) alerts.push(a);
  }

  return { usageStats, alerts };
}

/**
 * Classify a driver based on average daily mileage.
 *
 * @param {number} avgDailyMiles
 * @returns {{ classification: string, label: string, avg_daily_miles: number }}
 */
export function scoreDriver(avgDailyMiles) {
  const avg = Math.round(Number(avgDailyMiles) || 0);
  if (avg > EXTREME_DAILY_MILES) {
    return { classification: "extreme", label: "🚨 Extreme", avg_daily_miles: avg };
  }
  if (avg > HIGH_DAILY_MILES) {
    return { classification: "high",    label: "⚠️ High",    avg_daily_miles: avg };
  }
  return       { classification: "normal",  label: "✅ Normal",  avg_daily_miles: avg };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function fmt(n) {
  return Math.round(n).toLocaleString();
}
