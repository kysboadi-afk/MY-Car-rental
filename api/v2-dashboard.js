// api/v2-dashboard.js
// SLYTRANS FLEET CONTROL v2 — Dashboard statistics endpoint.
// Returns aggregated KPIs, revenue trends, and alerts for the admin dashboard.
//
// POST /api/v2-dashboard
// Body: { "secret": "<ADMIN_SECRET>" }
//
// Financial source of truth: revenue_records (Supabase)
//   Gross Revenue = SUM(gross_amount  WHERE payment_status='paid' AND !is_cancelled AND !is_no_show)
//   Total Fees    = SUM(stripe_fee)   (null treated as 0 for unreconciled rows)
//   Net Revenue   = SUM(stripe_net)   (null treated as gross_amount − stripe_fee)
//   Net Profit    = Net Revenue − Total Expenses
//
// Falls back to bookings.json when Supabase is unavailable or revenue_records
// is empty, matching the same fallback behaviour as api/v2-revenue.js.

import { loadVehicles } from "./_vehicles.js";
import { loadExpenses } from "./_expenses.js";
import { loadBookings } from "./_bookings.js";
import { computeAmount } from "./_pricing.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Used only as a fallback when revenue_records is unavailable or empty.
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

  const { secret, scope } = req.body || {};
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = getSupabaseAdmin();

    // Load expenses: prefer Supabase (matches the write path in add-expense.js),
    // fall back to GitHub expenses.json when Supabase is unavailable or errors.
    async function fetchExpenses() {
      if (sb) {
        const { data, error } = await sb.from("expenses").select("*");
        if (!error && data) {
          return { data };
        }
        console.warn("v2-dashboard: Supabase expenses query failed, falling back to GitHub:", error?.message);
      }
      return loadExpenses();
    }

    const [{ data: vehicles }, { data: expenses }, { data: bookingsData }] = await Promise.all([
      loadVehicles(),
      fetchExpenses(),
      loadBookings(),
    ]);

    // Filter vehicles by scope: "car" → exclude slingshots; "slingshot" → only slingshots
    const filteredVehicleEntries = Object.entries(vehicles).filter(([, v]) => {
      const type = v.type || "";
      if (scope === "car" || scope === "cars") return type !== "slingshot";
      if (scope === "slingshot") return type === "slingshot";
      return true;
    });
    const filteredVehicles   = Object.fromEntries(filteredVehicleEntries);
    const filteredVehicleIds = new Set(Object.keys(filteredVehicles));

    // All bookings limited to scoped vehicles (used for non-financial KPIs)
    const allBookings = Object.values(bookingsData).flat()
      .filter((b) => filteredVehicleIds.size === 0 || filteredVehicleIds.has(b.vehicleId));

    // Non-financial KPIs (always from bookings.json)
    const activeStatuses = new Set(["booked_paid", "active_rental", "reserved_unpaid"]);
    let activeBookings   = 0;
    let pendingApprovals = 0;
    for (const booking of allBookings) {
      if (activeStatuses.has(booking.status)) activeBookings++;
      if (booking.status === "reserved_unpaid") pendingApprovals++;
    }

    // Total expenses (scoped)
    const totalExpenses = expenses
      .filter((e) => filteredVehicleIds.size === 0 || filteredVehicleIds.has(e.vehicle_id))
      .reduce((s, e) => s + Number(e.amount || 0), 0);

    // ── Financial KPIs: revenue_records (primary) or bookings.json (fallback) ─
    // Mirrors the same source of truth used by api/v2-revenue.js so totals match.

    let totalRevenue    = 0;
    let totalStripeFees = 0;
    let netRevenue      = 0;
    let reconciledCount = 0;
    const monthlyRevenue     = {};
    const bookingsPerVehicle = {};
    // Per-vehicle revenue from revenue_records (keyed by vehicle_id)
    const rrByVehicle = {}; // { [vehicleId]: { gross, net, count } }
    let financialsFromRevRecords = false;

    if (sb) {
      try {
        const { data: rrRows, error: rrErr } = await sb
          .from("revenue_records_effective")
          .select("vehicle_id, gross_amount, stripe_fee, stripe_net, is_cancelled, is_no_show, payment_status, created_at, pickup_date")
          .eq("payment_status", "paid")
          .eq("sync_excluded", false);

        if (rrErr) {
          if (isSchemaError(rrErr)) {
            console.warn("v2-dashboard: revenue_records schema not ready, falling back to bookings.json:", rrErr.message);
          } else {
            console.error("v2-dashboard: revenue_records query error, falling back to bookings.json:", rrErr.message);
          }
        } else if ((rrRows || []).length > 0) {
          financialsFromRevRecords = true;
          for (const r of rrRows) {
            if (r.is_cancelled || r.is_no_show) continue;
            const vid = r.vehicle_id || "unknown";
            if (filteredVehicleIds.size > 0 && !filteredVehicleIds.has(vid)) continue;

            const gross = Number(r.gross_amount || 0);
            // stripe_fee and stripe_net are always populated together by stripe-reconcile.js.
            // When both are null (unreconciled row): fee=0, net=gross (conservative estimate).
            // When both are set (reconciled row): use exact Stripe values.
            const fee   = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
            const net   = r.stripe_net != null ? Number(r.stripe_net) : gross - fee;

            totalRevenue    += gross;
            totalStripeFees += fee;
            netRevenue      += net;
            if (r.stripe_fee != null) reconciledCount++;

            const monthKey = (r.created_at || r.pickup_date || "").slice(0, 7);
            if (monthKey) monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + gross;

            bookingsPerVehicle[vid] = (bookingsPerVehicle[vid] || 0) + 1;

            if (!rrByVehicle[vid]) rrByVehicle[vid] = { gross: 0, net: 0, count: 0 };
            rrByVehicle[vid].gross += gross;
            rrByVehicle[vid].net   += net;
            rrByVehicle[vid].count += 1;
          }
        }
        // If rrRows is empty (no paid records yet) we fall through to bookings.json.
      } catch (rrEx) {
        console.warn("v2-dashboard: revenue_records unavailable, falling back to bookings.json:", rrEx.message);
      }
    }

    // Fallback: compute from bookings.json when Supabase unavailable or rev_records empty.
    // Mirrors the same fallback used by api/v2-revenue.js.
    if (!financialsFromRevRecords) {
      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
      for (const booking of allBookings) {
        if (!paidStatuses.has(booking.status)) continue;
        const amount = bookingRevenue(booking);
        totalRevenue += amount;
        netRevenue   += amount; // No Stripe fee data available in fallback

        const monthKey = (booking.createdAt || booking.pickupDate || "").slice(0, 7);
        if (monthKey) monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + amount;

        const vid = booking.vehicleId || "unknown";
        bookingsPerVehicle[vid] = (bookingsPerVehicle[vid] || 0) + 1;
      }
    }

    // ── Per-vehicle stats ─────────────────────────────────────────────────────
    const paidStatusesFallback = new Set(["booked_paid", "active_rental", "completed_rental"]);
    const vehicleStats = {};
    for (const [vehicleId, vehicle] of Object.entries(filteredVehicles)) {
      const vExpenses = expenses
        .filter((e) => e.vehicle_id === vehicleId)
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const purchasePrice = vehicle.purchase_price || 0;

      let vGross, vNet, vBookingCount;
      if (financialsFromRevRecords) {
        const vr  = rrByVehicle[vehicleId] || { gross: 0, net: 0, count: 0 };
        vGross        = vr.gross;
        vNet          = vr.net;
        vBookingCount = vr.count;
      } else {
        // Fallback from bookings.json
        const vBookings = (bookingsData[vehicleId] || [])
          .filter((b) => paidStatusesFallback.has(b.status));
        vGross        = vBookings.reduce((s, b) => s + bookingRevenue(b), 0);
        vNet          = vGross; // Assume zero fees when no Stripe data available
        vBookingCount = vBookings.length;
      }

      const vNetProfit = vNet - vExpenses;
      vehicleStats[vehicleId] = {
        name:             vehicle.vehicle_name,
        status:           vehicle.status,
        revenue:          Math.round(vGross     * 100) / 100,
        expenses:         Math.round(vExpenses  * 100) / 100,
        netProfit:        Math.round(vNetProfit * 100) / 100,
        purchasePrice,
        roi:              purchasePrice > 0 ? Math.round((vNetProfit / purchasePrice) * 10000) / 100 : null,
        operationalROI:   vExpenses > 0 ? Math.round((vNetProfit / vExpenses) * 10000) / 100 : null,
        bookingCount:     vBookingCount,
      };
    }

    // ── Supplemental: succeeded extra charges (damages, late fees, etc.) ──────
    // These are NOT in revenue_records and must always be added on top.
    if (sb) {
      const bookingVehicleMap = {};
      for (const b of allBookings) {
        if (b.bookingId) bookingVehicleMap[b.bookingId] = b.vehicleId;
      }
      try {
        const { data: chargesData } = await sb
          .from("charges")
          .select("booking_id, amount, created_at")
          .eq("status", "succeeded");
        for (const charge of (chargesData || [])) {
          const vid = bookingVehicleMap[charge.booking_id];
          if (!vid) continue;
          if (filteredVehicleIds.size > 0 && !filteredVehicleIds.has(vid)) continue;
          const amount = Number(charge.amount || 0);
          totalRevenue += amount;
          netRevenue   += amount;
          const monthKey = (charge.created_at || "").slice(0, 7);
          if (monthKey) monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + amount;
          if (vehicleStats[vid]) {
            vehicleStats[vid].revenue   = Math.round((vehicleStats[vid].revenue   + amount) * 100) / 100;
            vehicleStats[vid].netProfit = Math.round((vehicleStats[vid].netProfit + amount) * 100) / 100;
            const pp  = vehicleStats[vid].purchasePrice || 0;
            const exp = vehicleStats[vid].expenses      || 0;
            vehicleStats[vid].roi = pp > 0
              ? Math.round((vehicleStats[vid].netProfit / pp) * 10000) / 100
              : null;
            vehicleStats[vid].operationalROI = exp > 0
              ? Math.round((vehicleStats[vid].netProfit / exp) * 10000) / 100
              : null;
          }
        }
      } catch (chargesErr) {
        console.error("v2-dashboard: charges load error (non-fatal):", chargesErr.message);
      }
    }

    // Vehicles available
    const vehicleList       = Object.values(filteredVehicles);
    const availableVehicles = vehicleList.filter((v) => v.status === "active").length;

    // ── Alerts ────────────────────────────────────────────────────────────────
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

    // Revenue chart: last 12 months sorted (gross revenue by month)
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

    // Net profit = net revenue − total expenses
    const netProfit = netRevenue - totalExpenses;
    // Operational ROI = profit / expenses * 100 (null when no expenses recorded)
    const operationalROI = totalExpenses > 0
      ? Math.round((netProfit / totalExpenses) * 10000) / 100
      : null;
    console.log("v2-dashboard: totalExpenses =", totalExpenses, "(count:", expenses.length, ")");

    return res.status(200).json({
      kpis: {
        totalRevenue:    Math.round(totalRevenue    * 100) / 100,
        totalExpenses:   Math.round(totalExpenses   * 100) / 100,
        netRevenue:      Math.round(netRevenue      * 100) / 100,
        netProfit:       Math.round(netProfit       * 100) / 100,
        totalStripeFees: Math.round(totalStripeFees * 100) / 100,
        operationalROI,
        reconciledCount,
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
