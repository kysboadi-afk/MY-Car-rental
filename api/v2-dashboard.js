// api/v2-dashboard.js
// SLYTRANS FLEET CONTROL v2 — Dashboard statistics endpoint.
// Returns aggregated KPIs, revenue trends, and alerts for the admin dashboard.
//
// POST /api/v2-dashboard
// Body: { "secret": "<ADMIN_SECRET>" }

import { loadVehicles } from "./_vehicles.js";
import { loadExpenses } from "./_expenses.js";
import { loadBookings } from "./_bookings.js";
import { computeAmount } from "./_pricing.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function bookingRevenue(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) {
    return booking.amountPaid;
  }
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    const computed = computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate);
    return computed || 0;
  }
  return 0;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret } = req.body || {};
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [{ data: vehicles }, { data: expenses }, { data: bookingsData }] = await Promise.all([
      loadVehicles(),
      loadExpenses(),
      loadBookings(),
    ]);

    // Flatten all bookings
    const allBookings = Object.values(bookingsData).flat();

    // KPIs
    const activeStatuses = new Set(["booked_paid", "active_rental", "reserved_unpaid"]);
    const paidStatuses   = new Set(["booked_paid", "active_rental", "completed_rental"]);

    let totalRevenue     = 0;
    let activeBookings   = 0;
    let pendingApprovals = 0;

    const monthlyRevenue = {};
    const bookingsPerVehicle = {};

    for (const booking of allBookings) {
      if (activeStatuses.has(booking.status)) activeBookings++;

      if (booking.status === "reserved_unpaid") pendingApprovals++;

      if (paidStatuses.has(booking.status)) {
        const amount = bookingRevenue(booking);
        totalRevenue += amount;

        const monthKey = (booking.createdAt || booking.pickupDate || "").slice(0, 7);
        if (monthKey) {
          monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + amount;
        }

        const vid = booking.vehicleId || "unknown";
        bookingsPerVehicle[vid] = (bookingsPerVehicle[vid] || 0) + 1;
      }
    }

    // Vehicles available
    const vehicleList = Object.values(vehicles);
    const availableVehicles = vehicleList.filter((v) => v.status === "active").length;

    // Per-vehicle stats for alerts
    const vehicleStats = {};
    for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
      const vBookings = (bookingsData[vehicleId] || []).filter((b) => paidStatuses.has(b.status));
      const vRevenue  = vBookings.reduce((s, b) => s + bookingRevenue(b), 0);
      const vExpenses = expenses.filter((e) => e.vehicle_id === vehicleId).reduce((s, e) => s + (e.amount || 0), 0);
      const purchasePrice = vehicle.purchase_price || 0;
      const netProfit = vRevenue - vExpenses;

      vehicleStats[vehicleId] = {
        name:          vehicle.vehicle_name,
        status:        vehicle.status,
        revenue:       Math.round(vRevenue   * 100) / 100,
        expenses:      Math.round(vExpenses  * 100) / 100,
        netProfit:     Math.round(netProfit  * 100) / 100,
        purchasePrice,
        roi: purchasePrice > 0 ? Math.round((netProfit / purchasePrice) * 10000) / 100 : null,
        bookingCount:  vBookings.length,
      };
    }

    // Alerts: negative-profit vehicles, upcoming bookings (next 7 days)
    const alerts = [];
    const now  = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    for (const [vehicleId, stats] of Object.entries(vehicleStats)) {
      if (stats.netProfit < 0) {
        alerts.push({
          type:    "warning",
          message: `${stats.name} has negative net profit ($${stats.netProfit.toFixed(2)})`,
          vehicleId,
        });
      }
    }

    for (const booking of allBookings) {
      if (activeStatuses.has(booking.status) && booking.pickupDate) {
        const pickup = new Date(booking.pickupDate);
        if (pickup >= now && pickup <= in7d) {
          alerts.push({
            type:      "info",
            message:   `Upcoming: ${booking.vehicleId} for ${booking.name} on ${booking.pickupDate}`,
            bookingId: booking.bookingId,
          });
        }
      }
    }

    if (pendingApprovals > 0) {
      alerts.unshift({
        type:    "action",
        message: `${pendingApprovals} booking${pendingApprovals > 1 ? "s" : ""} pending approval`,
      });
    }

    // Revenue chart: last 12 months sorted
    const revenueChart = Object.entries(monthlyRevenue)
      .sort(([a], [b]) => (a > b ? 1 : -1))
      .slice(-12)
      .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));

    // Recent bookings (last 10 across all vehicles)
    const recentBookings = [...allBookings]
      .filter((b) => b.createdAt)
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
      .slice(0, 10)
      .map((b) => ({
        bookingId:   b.bookingId,
        name:        b.name,
        vehicleId:   b.vehicleId,
        vehicleName: b.vehicleName,
        pickupDate:  b.pickupDate,
        returnDate:  b.returnDate,
        status:      b.status,
        amountPaid:  bookingRevenue(b),
        createdAt:   b.createdAt,
      }));

    return res.status(200).json({
      kpis: {
        totalRevenue:     Math.round(totalRevenue * 100) / 100,
        activeBookings,
        availableVehicles,
        pendingApprovals,
      },
      revenueChart,
      bookingsPerVehicle,
      vehicleStats,
      alerts,
      recentBookings,
    });
  } catch (err) {
    console.error("v2-dashboard error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
