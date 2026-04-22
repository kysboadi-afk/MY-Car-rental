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
//
// Financial source of truth: revenue_records (Supabase), identical to v2-dashboard.js
//   gross_revenue = SUM(gross_amount)  WHERE payment_status='paid' AND NOT cancelled/no-show
//   total_fees    = SUM(stripe_fee)    (null → 0 for unreconciled rows)
//   net_revenue   = SUM(stripe_net − refund_amount)    (null stripe_net → gross − fee)
//   profit        = net_revenue − total_expenses
//
// Falls back to bookings.json when Supabase is unavailable or revenue_records is empty.
// Non-financial metrics (utilization, active booking, day-of-week) always use bookings.json.

import { loadBookings } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { loadExpenses } from "./_expenses.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { uiVehicleId } from "./_vehicle-id.js";

// Minimum analysis window in days — ensures utilization % is meaningful for
// newly-added vehicles that have very few bookings.
const MIN_UTILIZATION_WINDOW_DAYS = 90;
// Average days per month (365.25 / 12) used for months_active calculation
const AVG_DAYS_PER_MONTH = 30.4375;
import { computeAmount } from "./_pricing.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/**
 * Load vehicles from Supabase when available (spreading the `data` JSONB column
 * so that purchase_price and purchase_date are included), falling back to
 * GitHub vehicles.json.  Returns the same { [vehicleId]: vehicleObject } shape
 * as loadVehicles().data.
 * @returns {Promise<object>}
 */
async function loadVehiclesWithPurchaseData() {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data: rows, error } = await sb
        .from("vehicles")
        .select("vehicle_id, data");
      if (!error && rows && rows.length > 0) {
        const vehicles = {};
        for (const row of rows) {
          vehicles[row.vehicle_id] = { ...(row.data || {}), vehicle_id: row.vehicle_id };
        }
        return vehicles;
      }
      if (error) {
        console.warn("v2-analytics: supabase vehicles error, falling back to GitHub:", error.message);
      }
    } catch (e) {
      console.warn("v2-analytics: supabase vehicles threw, falling back to GitHub:", e.message);
    }
  }
  const { data } = await loadVehicles();
  return data;
}

/**
 * Load expenses from Supabase when available; fall back to GitHub expenses.json.
 * @returns {Promise<Array>}
 */
async function loadExpensesAny() {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.from("expenses").select("*");
      if (!error) return data || [];
      console.warn("v2-analytics: supabase expenses error, falling back to GitHub:", error.message);
    } catch (e) {
      console.warn("v2-analytics: supabase expenses threw, falling back to GitHub:", e.message);
    }
  }
  const { data } = await loadExpenses();
  return data;
}

// Used only as a fallback when revenue_records is unavailable or empty.
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
    const [{ data: bookingsData }, vehicles, expenses] = await Promise.all([
      loadBookings(),
      loadVehiclesWithPurchaseData(),
      loadExpensesAny(),
    ]);

    const allBookings    = Object.values(bookingsData).flat();
    const paidStatuses   = new Set(["booked_paid", "active_rental", "completed_rental"]);
    const activeStatuses = new Set(["booked_paid", "active_rental"]);

    // ── Load revenue_records from Supabase (financial source of truth) ────────
    // Mirrors v2-dashboard.js exactly: payment_status='paid', sync_excluded=false,
    // skip is_cancelled and is_no_show, null stripe_fee treated as 0.
    //
    // rrByVehicle: { [vehicleId]: { gross, fees, net, count } }
    const rrByVehicle = {};
    let financialsFromRevRecords = false;

    const sb = getSupabaseAdmin();
    if (sb) {
      try {
        let rrResult = await sb
          .from("revenue_reporting_base")
          .select("vehicle_id, pickup_date, gross_amount, stripe_fee, stripe_net, refund_amount, is_cancelled, is_no_show");

        // If the canonical view is not deployed yet (migration pending), fall back to the
        // underlying revenue_records_effective view with the same filters applied server-side.
        // This matches exactly what the Revenue page does for its own display.
        if (rrResult.error && isSchemaError(rrResult.error)) {
          console.warn("v2-analytics: revenue_reporting_base not ready, trying revenue_records_effective:", rrResult.error.message);
          rrResult = await sb
            .from("revenue_records_effective")
            .select("vehicle_id, pickup_date, gross_amount, stripe_fee, stripe_net, refund_amount, is_cancelled, is_no_show")
            .eq("payment_status", "paid");
        }

        const { data: rrRows, error: rrErr } = rrResult;

        if (rrErr) {
          // At this point revenue_reporting_base was already tried (and failed with a schema
          // error), so any remaining error here means revenue_records_effective is also
          // unavailable — fall through to the bookings.json fallback below.
          console.error("v2-analytics: revenue records unavailable, falling back to bookings.json:", rrErr.message);
        } else if ((rrRows || []).length > 0) {
          financialsFromRevRecords = true;
          for (const r of rrRows) {
            if (r.is_cancelled || r.is_no_show) continue;
            const vid    = uiVehicleId(r.vehicle_id) || "unknown";
            const gross  = Number(r.gross_amount || 0);
            const fee    = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
            const refund = Number(r.refund_amount || 0);
            const net    = (r.stripe_net != null ? Number(r.stripe_net) : gross - fee) - refund;
            if (!rrByVehicle[vid]) rrByVehicle[vid] = { gross: 0, fees: 0, net: 0, count: 0, monthly: {} };
            rrByVehicle[vid].gross += gross;
            rrByVehicle[vid].fees  += fee;
            rrByVehicle[vid].net   += net;
            rrByVehicle[vid].count += 1;
            const monthKey = (r.pickup_date || "").slice(0, 7);
            if (monthKey) {
              rrByVehicle[vid].monthly[monthKey] = (rrByVehicle[vid].monthly[monthKey] || 0) + gross;
            }
          }
        }
      } catch (rrEx) {
        console.warn("v2-analytics: revenue_records unavailable, falling back to bookings.json:", rrEx.message);
      }
    }

    // ── FLEET OVERVIEW ───────────────────────────────────────────────────────
    if (!action || action === "fleet") {
      const now = new Date();
      const vehicleStats = {};

      for (const [vehicleId, vehicle] of Object.entries(vehicles)) {
        const vBookings    = (bookingsData[vehicleId] || []);
        const paidBookings = vBookings.filter((b) => paidStatuses.has(b.status));

        // Financial figures — from revenue_records when available, bookings.json otherwise
        let gross, fees, net, totalBookings;
        if (financialsFromRevRecords) {
          const vr    = rrByVehicle[vehicleId] || { gross: 0, fees: 0, net: 0, count: 0 };
          gross        = vr.gross;
          fees         = vr.fees;
          net          = vr.net;
          totalBookings = vr.count;
        } else {
          gross        = paidBookings.reduce((s, b) => s + bookingRevenue(b), 0);
          fees         = 0;
          net          = gross;
          totalBookings = paidBookings.length;
        }

        const vExpenses = expenses
          .filter((e) => e.vehicle_id === vehicleId)
          .reduce((s, e) => s + Number(e.amount || 0), 0);

        // Non-financial: utilization from bookings.json (rented days / calendar days)
        const rentedDays = paidBookings.reduce((s, b) => s + rentalDays(b), 0);
        const allDates   = vBookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const firstDate  = allDates[0] ? new Date(allDates[0]) : new Date(now - MIN_UTILIZATION_WINDOW_DAYS * 86400000);
        const totalDays  = Math.max(MIN_UTILIZATION_WINDOW_DAYS, Math.round((now - firstDate) / 86400000));
        const utilizationRate = Math.min(100, Math.round((rentedDays / totalDays) * 100 * 10) / 10);

        // Active booking right now (from bookings.json)
        const activeNow = vBookings.some((b) => {
          if (!activeStatuses.has(b.status)) return false;
          const pick = b.pickupDate ? new Date(b.pickupDate) : null;
          const ret  = b.returnDate ? new Date(b.returnDate) : null;
          return pick && ret && pick <= now && ret >= now;
        });

        const vProfit        = Math.round((net - vExpenses) * 100) / 100;
        const purchasePrice  = Number(vehicle.purchase_price || 0);
        // months_active: from purchase_date to now (min 1)
        const purchaseDateStr = vehicle.purchase_date || "";
        const purchaseDateMs  = purchaseDateStr ? new Date(purchaseDateStr).getTime() : 0;
        const monthsActive    = purchaseDateMs > 0
          ? Math.max(1, Math.round((now - purchaseDateMs) / (86400000 * AVG_DAYS_PER_MONTH)))
          : null;
        // Investment ROI = profit / purchase_price
        const vehicleRoi     = purchasePrice > 0 ? Math.round((vProfit / purchasePrice) * 10000) / 100 : null;
        // Monthly profit (for payback calculation)
        const monthlyProfit  = monthsActive != null && monthsActive > 0
          ? Math.round((vProfit / monthsActive) * 100) / 100
          : null;
        // Annual ROI = (monthly_profit * 12) / purchase_price
        const annualRoi      = purchasePrice > 0 && monthlyProfit != null
          ? Math.round(((monthlyProfit * 12) / purchasePrice) * 10000) / 100
          : null;
        // Payback period in months = purchase_price / monthly_profit
        const paybackMonths  = purchasePrice > 0 && monthlyProfit != null && monthlyProfit > 0
          ? Math.round((purchasePrice / monthlyProfit) * 10) / 10
          : null;

        vehicleStats[vehicleId] = {
          vehicleId,
          name:                vehicle.vehicle_name || vehicleId,
          status:              vehicle.status,
          totalBookings,
          activeNow,
          gross_revenue:       Math.round(gross    * 100) / 100,
          total_fees:          Math.round(fees     * 100) / 100,
          net_revenue:         Math.round(net      * 100) / 100,
          expenses:            Math.round(vExpenses * 100) / 100,
          profit:              vProfit,
          // Operational ROI = profit / expenses * 100 (null when no expenses recorded)
          roi:                 vExpenses > 0
            ? Math.round(((net - vExpenses) / vExpenses) * 10000) / 100
            : null,
          // Investment ROI fields
          purchase_price:      purchasePrice,
          months_active:       monthsActive,
          vehicle_roi:         vehicleRoi,
          monthly_profit:      monthlyProfit,
          annual_roi:          annualRoi,
          payback_months:      paybackMonths,
          // Legacy aliases so existing admin UI fields keep working
          revenue:             Math.round(gross    * 100) / 100,
          netProfit:           vProfit,
          rentedDays,
          utilizationRate,
          avgRevenuePerBooking: totalBookings > 0
            ? Math.round((gross / totalBookings) * 100) / 100
            : 0,
        };
      }

      return res.status(200).json({ fleet: vehicleStats, _source: financialsFromRevRecords ? "revenue_records" : "bookings_fallback" });
    }

    // ── SINGLE VEHICLE DEEP-DIVE ─────────────────────────────────────────────
    if (action === "vehicle") {
      const { vehicleId } = body;
      if (!vehicleId) return res.status(400).json({ error: "vehicleId is required" });

      const vBookings = (bookingsData[vehicleId] || []);
      const paid      = vBookings.filter((b) => paidStatuses.has(b.status));

      // Monthly revenue — from revenue_records when available
      let monthlyTrend;
      let totalRevenue;
      let totalFees;
      let totalNet;
      let bookingCount;

      if (financialsFromRevRecords && rrByVehicle[vehicleId]) {
        const vr = rrByVehicle[vehicleId];
        totalRevenue  = vr.gross;
        totalFees     = vr.fees;
        totalNet      = vr.net;
        bookingCount  = vr.count;
        monthlyTrend  = Object.entries(vr.monthly)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));
      } else {
        // Fallback: compute from bookings.json
        const monthly = {};
        for (const b of paid) {
          const m = (b.pickupDate || "").slice(0, 7);
        }
        totalRevenue = paid.reduce((s, b) => s + bookingRevenue(b), 0);
        totalFees    = 0;
        totalNet     = totalRevenue;
        bookingCount = paid.length;
        monthlyTrend = Object.entries(monthly)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));
      }

      // Day-of-week pattern (always from bookings.json)
      const dow = [0,0,0,0,0,0,0];
      for (const b of vBookings) {
        if (b.pickupDate) dow[new Date(b.pickupDate).getDay()]++;
      }

      // Revenue by duration tier (always from bookings.json — Stripe doesn't know tier)
      const tierBreakdown = {};
      for (const b of paid) {
        const tier = b.durationLabel || b.tier || (rentalDays(b) === 1 ? "1 day" : `${rentalDays(b)} days`);
        tierBreakdown[tier] = (tierBreakdown[tier] || 0) + bookingRevenue(b);
      }

      return res.status(200).json({
        vehicleId,
        bookings:         bookingCount,
        gross_revenue:    Math.round(totalRevenue * 100) / 100,
        total_fees:       Math.round(totalFees    * 100) / 100,
        net_revenue:      Math.round(totalNet     * 100) / 100,
        // Legacy alias
        revenue:          Math.round(totalRevenue * 100) / 100,
        monthlyTrend,
        dayOfWeekPattern: dow,
        tierBreakdown,
        _source: financialsFromRevRecords ? "revenue_records" : "bookings_fallback",
      });
    }

    // ── REVENUE TREND ────────────────────────────────────────────────────────
    if (action === "revenue_trend") {
      const months = Math.min(24, Number(body.months) || 12);
      const monthly = {};

      if (financialsFromRevRecords) {
        // Aggregate from revenue_records (already grouped by vehicle+month in rrByVehicle)
        for (const vr of Object.values(rrByVehicle)) {
          for (const [m, amount] of Object.entries(vr.monthly)) {
            if (!monthly[m]) monthly[m] = { month: m, revenue: 0, bookings: 0 };
            monthly[m].revenue  += amount;
            monthly[m].bookings += vr.count; // approximate; exact count not tracked per-month
          }
        }
        // Fix: recompute bookings per month using the full rrRows is not available here,
        // so use revenue_records' per-vehicle monthly maps (revenue only, bookings count approximate).
        // Reset bookings to 0 and recount from bookings.json to keep the count accurate.
        for (const m of Object.keys(monthly)) monthly[m].bookings = 0;
        for (const b of allBookings) {
          if (!paidStatuses.has(b.status)) continue;
          const m = (b.pickupDate || "").slice(0, 7);
          if (m && monthly[m]) monthly[m].bookings += 1;
        }
      } else {
        // Fallback: bookings.json
        for (const b of allBookings) {
          if (!paidStatuses.has(b.status)) continue;
          const m = (b.pickupDate || "").slice(0, 7);
          if (!m) continue;
          if (!monthly[m]) monthly[m] = { month: m, revenue: 0, bookings: 0 };
          monthly[m].revenue  += bookingRevenue(b);
          monthly[m].bookings += 1;
        }
      }

      const trend = Object.values(monthly)
        .sort((a, b) => a.month > b.month ? 1 : -1)
        .slice(-months)
        .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }));
      return res.status(200).json({ trend, _source: financialsFromRevRecords ? "revenue_records" : "bookings_fallback" });
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

