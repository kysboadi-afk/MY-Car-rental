// lib/ai/monitor.js
// Problem detection engine — pure computation, no I/O.
// Analyses booking + vehicle data and returns a list of detected issues.

/**
 * Detect operational problems from current data.
 *
 * @param {object} params
 * @param {Array}  params.allBookings    - flat array of all booking objects
 * @param {object} params.vehicles       - { [vehicleId]: vehicleObj }
 * @param {Function} params.revenueFromBooking - (booking) => number
 * @param {object} [params.insights]     - optional pre-computed insights from insights.js
 * @returns {string[]} Array of human-readable problem descriptions
 */
export function detectProblems({ allBookings, vehicles, revenueFromBooking, insights }) {
  const problems = [];
  const now      = new Date();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  // ── 1. No new bookings in last 3 days ────────────────────────────────────
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);
  const recentBookings = allBookings.filter(
    (b) => new Date(b.createdAt || b.pickupDate || 0) >= threeDaysAgo
  );
  if (recentBookings.length === 0) {
    problems.push("No new bookings in the last 3 days");
  }

  // ── 2. Vehicles with zero total bookings ─────────────────────────────────
  for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
    if (vehicle.status === "inactive") continue;
    const vBookings = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));
    if (vBookings.length === 0) {
      const name = vehicle.vehicle_name || vehicleId;
      problems.push(`${name} has zero paid bookings`);
    }
  }

  // ── 3. Vehicles with no bookings in last 30 days ─────────────────────────
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
    if (vehicle.status === "inactive") continue;
    const total = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status)).length;
    if (total === 0) continue; // already flagged above
    const recent = allBookings.filter(
      (b) => b.vehicleId === vehicleId &&
        paidStatuses.has(b.status) &&
        new Date(b.pickupDate || b.createdAt || 0) >= thirtyDaysAgo
    );
    if (recent.length === 0) {
      const name = vehicle.vehicle_name || vehicleId;
      problems.push(`${name} has had no bookings in the last 30 days`);
    }
  }

  // ── 4. Revenue drop week-over-week ───────────────────────────────────────
  if (insights?.revenue?.weeklyChangePct !== null && insights?.revenue?.weeklyChangePct !== undefined) {
    const drop = insights.revenue.weeklyChangePct;
    if (drop <= -30) {
      problems.push(`Revenue dropped ${Math.abs(drop)}% this week compared to last week`);
    }
  }

  // ── 5. Revenue drop month-over-month ─────────────────────────────────────
  if (insights?.revenue?.monthlyChangePct !== null && insights?.revenue?.monthlyChangePct !== undefined) {
    const drop = insights.revenue.monthlyChangePct;
    if (drop <= -20) {
      problems.push(`Revenue dropped ${Math.abs(drop)}% this month compared to last month`);
    }
  }

  // ── 6. Many pending unpaid bookings ─────────────────────────────────────
  const pendingCount = allBookings.filter((b) => b.status === "reserved_unpaid").length;
  if (pendingCount >= 3) {
    problems.push(`${pendingCount} bookings are pending payment/approval`);
  }

  // ── 7. Vehicles in maintenance ────────────────────────────────────────────
  for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
    if (vehicle.status === "maintenance") {
      const name = vehicle.vehicle_name || vehicleId;
      problems.push(`${name} is in maintenance and unavailable for booking`);
    }
  }

  return problems;
}
