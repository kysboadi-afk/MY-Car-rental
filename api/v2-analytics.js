// api/v2-analytics.js
// SLYTRANS Fleet Control v2 — Fleet analytics endpoint.
// Derives utilization, booking counts, and revenue metrics from existing data.
// All analytics are computed additively — no writes to existing tables.
//
// POST /api/v2-analytics
// Actions:
//   fleet         — { secret, action:"fleet" } — overview all vehicles
//   vehicle       — { secret, action:"vehicle", vehicleId } — single vehicle deep-dive
//   revenue_trend — { secret, action:"revenue_trend", months? } — monthly revenue (last N months)
//   bookings_heatmap — { secret, action:"bookings_heatmap", vehicleId? } — day-of-week patterns

import { loadBookings } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { loadExpenses } from "./_expenses.js";

// Minimum analysis window in days — ensures utilization % is meaningful for
// newly-added vehicles that have very few bookings.
const MIN_UTILIZATION_WINDOW_DAYS = 90;
import { computeAmount } from "./_pricing.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function getSupabaseOptional() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function bookingRevenue(b) {
  if (typeof b.amountPaid === "number" && b.amountPaid > 0) return b.amountPaid;
  if (b.pickupDate && b.returnDate && b.vehicleId) {
    return computeAmount(b.vehicleId, b.pickupDate, b.returnDate) || 0;
  }
  return 0;
}

function rentalDays(b) {
  if (!b.pickupDate || !b.returnDate) return 0;
  const diff = new Date(b.returnDate) - new Date(b.pickupDate);
  return Math.max(1, Math.round(diff / 86400000));
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });

  const body = req.body || {};
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const [{ data: bookingsData }, { data: vehicles }, { data: expenses }] = await Promise.all([
      loadBookings(),
      loadVehicles(),
      loadExpenses(),
    ]);

    const allBookings   = Object.values(bookingsData).flat();
    const paidStatuses  = new Set(["booked_paid", "active_rental", "completed_rental"]);
    const activeStatuses = new Set(["booked_paid", "active_rental"]);

    // ── FLEET OVERVIEW ───────────────────────────────────────────────────────
    if (!action || action === "fleet") {
      const now = new Date();
      // Compute utilization: rented days / total days since first booking
      const vehicleStats = {};

      for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
        const vBookings = (bookingsData[vehicleId] || []);
        const paidBookings = vBookings.filter((b) => paidStatuses.has(b.status));
        const revenue = paidBookings.reduce((s, b) => s + bookingRevenue(b), 0);
        const vExpenses = expenses.filter((e) => e.vehicle_id === vehicleId).reduce((s, e) => s + (e.amount || 0), 0);

        // Total rented days
        const rentedDays = paidBookings.reduce((s, b) => s + rentalDays(b), 0);

        // Calendar days since first booking (or MIN_UTILIZATION_WINDOW_DAYS minimum for meaningful %)
        const allDates = vBookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const firstDate = allDates[0] ? new Date(allDates[0]) : new Date(now - MIN_UTILIZATION_WINDOW_DAYS * 86400000);
        const totalDays = Math.max(MIN_UTILIZATION_WINDOW_DAYS, Math.round((now - firstDate) / 86400000));
        const utilizationRate = Math.min(100, Math.round((rentedDays / totalDays) * 100 * 10) / 10);

        // Active booking right now
        const activeNow = vBookings.some((b) => {
          if (!activeStatuses.has(b.status)) return false;
          const pick = b.pickupDate ? new Date(b.pickupDate) : null;
          const ret  = b.returnDate ? new Date(b.returnDate) : null;
          return pick && ret && pick <= now && ret >= now;
        });

        vehicleStats[vehicleId] = {
          vehicleId,
          name:             vehicle.vehicle_name || vehicleId,
          status:           vehicle.status,
          totalBookings:    paidBookings.length,
          activeNow,
          revenue:          Math.round(revenue   * 100) / 100,
          expenses:         Math.round(vExpenses * 100) / 100,
          netProfit:        Math.round((revenue - vExpenses) * 100) / 100,
          rentedDays,
          utilizationRate,
          avgRevenuePerBooking: paidBookings.length > 0
            ? Math.round((revenue / paidBookings.length) * 100) / 100
            : 0,
        };
      }

      return res.status(200).json({ fleet: vehicleStats });
    }

    // ── SINGLE VEHICLE DEEP-DIVE ─────────────────────────────────────────────
    if (action === "vehicle") {
      const { vehicleId } = body;
      if (!vehicleId) return res.status(400).json({ error: "vehicleId is required" });

      const vBookings = (bookingsData[vehicleId] || []);
      const paid      = vBookings.filter((b) => paidStatuses.has(b.status));

      // Monthly revenue
      const monthly = {};
      for (const b of paid) {
        const m = (b.pickupDate || b.createdAt || "").slice(0, 7);
        if (m) monthly[m] = (monthly[m] || 0) + bookingRevenue(b);
      }
      const monthlyTrend = Object.entries(monthly)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));

      // Day-of-week pattern
      const dow = [0,0,0,0,0,0,0];
      for (const b of vBookings) {
        if (b.pickupDate) dow[new Date(b.pickupDate).getDay()]++;
      }

      // Revenue by hour tier (for slingshot)
      const tierBreakdown = {};
      for (const b of paid) {
        const tier = b.durationLabel || b.tier || (rentalDays(b) === 1 ? "1 day" : `${rentalDays(b)} days`);
        tierBreakdown[tier] = (tierBreakdown[tier] || 0) + bookingRevenue(b);
      }

      return res.status(200).json({
        vehicleId,
        bookings: paid.length,
        revenue: paid.reduce((s, b) => s + bookingRevenue(b), 0),
        monthlyTrend,
        dayOfWeekPattern: dow,
        tierBreakdown,
      });
    }

    // ── REVENUE TREND ────────────────────────────────────────────────────────
    if (action === "revenue_trend") {
      const months = Math.min(24, Number(body.months) || 12);
      const monthly = {};
      for (const b of allBookings) {
        if (!paidStatuses.has(b.status)) continue;
        const m = (b.pickupDate || b.createdAt || "").slice(0, 7);
        if (!m) continue;
        if (!monthly[m]) monthly[m] = { month: m, revenue: 0, bookings: 0 };
        monthly[m].revenue   += bookingRevenue(b);
        monthly[m].bookings  += 1;
      }
      const trend = Object.values(monthly)
        .sort((a, b) => a.month > b.month ? 1 : -1)
        .slice(-months)
        .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }));
      return res.status(200).json({ trend });
    }

    // ── BOOKINGS HEATMAP ─────────────────────────────────────────────────────
    if (action === "bookings_heatmap") {
      const source = body.vehicleId
        ? (bookingsData[body.vehicleId] || [])
        : allBookings;

      // Group by YYYY-MM-DD
      const daily = {};
      for (const b of source) {
        if (!b.pickupDate) continue;
        daily[b.pickupDate] = (daily[b.pickupDate] || 0) + 1;
      }
      return res.status(200).json({ heatmap: daily });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-analytics error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
