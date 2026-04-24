// lib/ai/insights.js
// Business intelligence engine — pure computation, no I/O.
// Takes pre-fetched data and returns structured insights for the AI to interpret.

/**
 * Compute revenue totals for a given ISO month string "YYYY-MM".
 * @param {Array} bookings - flat array of all booking objects
 * @param {Function} revenueFromBooking - (booking) => number
 * @param {string} month - "YYYY-MM"
 */
function revenueForMonth(bookings, revenueFromBooking, month) {
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
  return bookings
    .filter((b) => paidStatuses.has(b.status) && (b.pickupDate || b.createdAt || "").startsWith(month))
    .reduce((sum, b) => sum + revenueFromBooking(b), 0);
}

/**
 * ISO week string "YYYY-WNN" for a Date object.
 */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Compute business insights from raw data.
 *
 * @param {object} params
 * @param {Array}  params.allBookings       - flat array of booking objects
 * @param {object} params.vehicles          - { [vehicleId]: vehicleObj }
 * @param {Function} params.revenueFromBooking - (booking) => number
 * @returns {object} Structured insights
 */
export function computeInsights({ allBookings, vehicles, revenueFromBooking }) {
  const now      = new Date();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  // ── Revenue ──────────────────────────────────────────────────────────────
  // Use LA timezone for month boundaries — booking dates are stored as LA dates.
  const laFmt     = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
  const thisMonth = laFmt.format(now).slice(0, 7);
  // Derive last month by stepping back to the 1st of the previous LA month.
  const nowLAParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const laYear  = Number((nowLAParts.find((p) => p.type === "year")  || {}).value);
  const laMonth = Number((nowLAParts.find((p) => p.type === "month") || {}).value);
  const prevMonth = laMonth === 1 ? 12 : laMonth - 1;
  const prevYear  = laMonth === 1 ? laYear - 1 : laYear;
  const lastMonth = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

  const thisMonthRevenue = revenueForMonth(allBookings, revenueFromBooking, thisMonth);
  const lastMonthRevenue = revenueForMonth(allBookings, revenueFromBooking, lastMonth);

  // Week-over-week revenue
  const thisWeekKey  = isoWeek(now);
  const lastWeekDate = new Date(now.getTime() - 7 * 86400000);
  const lastWeekKey  = isoWeek(lastWeekDate);

  function revenueForWeek(weekKey) {
    return allBookings
      .filter((b) => {
        if (!paidStatuses.has(b.status)) return false;
        const d = new Date(b.pickupDate || b.createdAt || "");
        return isoWeek(d) === weekKey;
      })
      .reduce((sum, b) => sum + revenueFromBooking(b), 0);
  }

  const thisWeekRevenue  = revenueForWeek(thisWeekKey);
  const lastWeekRevenue  = revenueForWeek(lastWeekKey);
  const weeklyChangePct  = lastWeekRevenue > 0
    ? Math.round(((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue) * 100)
    : null;
  const monthlyChangePct = lastMonthRevenue > 0
    ? Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100)
    : null;

  // ── Bookings ─────────────────────────────────────────────────────────────
  const last7Days  = new Date(now.getTime() - 7 * 86400000);
  const last30Days = new Date(now.getTime() - 30 * 86400000);

  const bookingsLast7  = allBookings.filter((b) => new Date(b.createdAt || b.pickupDate || 0) >= last7Days).length;
  const bookingsLast30 = allBookings.filter((b) => new Date(b.createdAt || b.pickupDate || 0) >= last30Days).length;

  const activeBookings = allBookings.filter((b) =>
    new Set(["booked_paid", "active_rental"]).has(b.status)
  ).length;

  const pendingBookings = allBookings.filter((b) => b.status === "reserved_unpaid").length;

  // ── Per-vehicle stats ────────────────────────────────────────────────────
  const vehicleStats = {};
  for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
    const vBookings  = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));
    const vRevenue   = vBookings.reduce((sum, b) => sum + revenueFromBooking(b), 0);
    const recentVB   = vBookings.filter((b) => new Date(b.pickupDate || b.createdAt || 0) >= last30Days);

    vehicleStats[vehicleId] = {
      name:                vehicle.vehicle_name || vehicleId,
      status:              vehicle.status || "unknown",
      totalBookings:       vBookings.length,
      recentBookings30d:   recentVB.length,
      totalRevenue:        Math.round(vRevenue * 100) / 100,
    };
  }

  // Rank vehicles
  const sortedByBookings = Object.entries(vehicleStats)
    .sort(([, a], [, b]) => b.totalBookings - a.totalBookings);
  const mostBooked  = sortedByBookings[0]  ? { vehicleId: sortedByBookings[0][0],  ...sortedByBookings[0][1]  } : null;
  const leastBooked = sortedByBookings[sortedByBookings.length - 1]
    ? { vehicleId: sortedByBookings[sortedByBookings.length - 1][0], ...sortedByBookings[sortedByBookings.length - 1][1] }
    : null;

  return {
    generatedAt: now.toISOString(),
    revenue: {
      thisMonth:   Math.round(thisMonthRevenue  * 100) / 100,
      lastMonth:   Math.round(lastMonthRevenue  * 100) / 100,
      thisWeek:    Math.round(thisWeekRevenue   * 100) / 100,
      lastWeek:    Math.round(lastWeekRevenue   * 100) / 100,
      weeklyChangePct,
      monthlyChangePct,
    },
    bookings: {
      last7Days:  bookingsLast7,
      last30Days: bookingsLast30,
      active:     activeBookings,
      pending:    pendingBookings,
    },
    vehicles: {
      stats:      vehicleStats,
      mostBooked,
      leastBooked,
    },
  };
}
