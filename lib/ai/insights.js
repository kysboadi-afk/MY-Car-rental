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
 * @param {Array}  params.allBookings         - flat array of booking objects
 * @param {object} params.vehicles            - { [vehicleId]: vehicleObj }
 * @param {Function} params.revenueFromBooking  - (booking) => number
 * @param {Array|null} [params.revenueRecords]  - optional array of revenue_records rows
 *   (payment_status='paid', not cancelled/no-show already filtered by caller).
 *   When provided these are used as the authoritative source for weekly/monthly
 *   revenue totals, matching the Revenue page and Fleet Analytics.
 * @returns {object} Structured insights
 */
export function computeInsights({ allBookings, vehicles, revenueFromBooking, revenueRecords }) {
  const now      = new Date();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  // ── Revenue ──────────────────────────────────────────────────────────────
  // Use LA timezone for month boundaries — booking dates are stored as LA dates.
  // Subtracting 32 days always lands in the previous calendar month.
  const laFmt     = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
  const thisMonth = laFmt.format(now).slice(0, 7);
  const lastMonth = laFmt.format(new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000)).slice(0, 7);

  // Week-over-week revenue
  const thisWeekKey  = isoWeek(now);
  const lastWeekDate = new Date(now.getTime() - 7 * 86400000);
  const lastWeekKey  = isoWeek(lastWeekDate);

  let thisMonthRevenue, lastMonthRevenue, thisWeekRevenue, lastWeekRevenue;

  if (revenueRecords && revenueRecords.length > 0) {
    // Use revenue_records as the authoritative financial source — matches the
    // Revenue page and Fleet Analytics so the AI snapshot stays consistent.
    // gross_amount = total collected before Stripe fees, matching amountPaid.
    thisMonthRevenue = 0; lastMonthRevenue = 0;
    thisWeekRevenue  = 0; lastWeekRevenue  = 0;

    for (const r of revenueRecords) {
      const amount  = Number(r.gross_amount || 0);
      const dateStr = r.pickup_date || "";
      if (dateStr.startsWith(thisMonth)) thisMonthRevenue += amount;
      if (dateStr.startsWith(lastMonth)) lastMonthRevenue += amount;
      // Compute ISO week from the YYYY-MM-DD pickup_date string.
      // Append T12:00:00 so the Date constructor doesn't risk a UTC-midnight
      // boundary shift on servers running in non-UTC timezones.
      if (dateStr.length >= 10) {
        const wk = isoWeek(new Date(dateStr.slice(0, 10) + "T12:00:00"));
        if (wk === thisWeekKey)  thisWeekRevenue  += amount;
        if (wk === lastWeekKey)  lastWeekRevenue  += amount;
      }
    }
  } else {
    // Fallback: derive from the allBookings array (limited dataset).
    thisMonthRevenue = revenueForMonth(allBookings, revenueFromBooking, thisMonth);
    lastMonthRevenue = revenueForMonth(allBookings, revenueFromBooking, lastMonth);

    function revenueForWeek(weekKey) {
      return allBookings
        .filter((b) => {
          if (!paidStatuses.has(b.status)) return false;
          const d = new Date(b.pickupDate || b.createdAt || "");
          return isoWeek(d) === weekKey;
        })
        .reduce((sum, b) => sum + revenueFromBooking(b), 0);
    }

    thisWeekRevenue = revenueForWeek(thisWeekKey);
    lastWeekRevenue = revenueForWeek(lastWeekKey);
  }

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
    new Set(["booked_paid", "active_rental", "overdue"]).has(b.status)
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
