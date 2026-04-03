// api/get-vehicle-stats.js
// Vercel serverless function — returns per-vehicle stats combining bookings + expenses.
// Admin-protected: requires ADMIN_SECRET in the request body.
//
// POST /api/get-vehicle-stats
// Body: { "secret": "<ADMIN_SECRET>" }
//
// Returns:
// {
//   "<vehicleId>": {
//     vehicle:         object,          // from vehicles.json
//     totalBookings:   number,
//     totalRevenue:    number,          // sum of amountPaid on paid bookings
//     monthlyRevenue:  { "YYYY-MM": number },
//     totalExpenses:   number,
//     netProfit:       number,
//     roi:             number | null,   // netProfit / purchase_price, null if price=0
//     breakEvenPct:    number | null,   // (totalRevenue / purchase_price)*100, null if price=0
//     expensesByCategory: { [category]: number },
//     monthlyExpenses: { "YYYY-MM": number },
//     recentBookings:  Booking[],       // last 10, newest first
//   }
// }

import { loadVehicles }  from "./_vehicles.js";
import { loadExpenses }  from "./_expenses.js";
import { loadBookings }  from "./_bookings.js";
import { computeAmount } from "./_pricing.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { computeVehiclePriority } from "../lib/ai/priority.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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
      console.warn("get-vehicle-stats: supabase expenses error, falling back to GitHub:", error.message);
    } catch (e) {
      console.warn("get-vehicle-stats: supabase expenses threw, falling back to GitHub:", e.message);
    }
  }
  const { data } = await loadExpenses();
  return data;
}

/**
 * Derive the revenue amount from a booking record.
 * Uses the stored amountPaid if present; otherwise falls back to server-side
 * pricing computation so legacy bookings without amountPaid still count.
 */
function bookingRevenue(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) {
    return booking.amountPaid;
  }
  // Fallback: recompute from pricing (excludes tax — best-effort for legacy records)
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
    const sb = getSupabaseAdmin();

    // Fetch Supabase vehicle columns (bouncie_device_id, decision_status, action_status)
    // needed for UI badges and tracking warning.  Non-fatal — falls back to empty map.
    let sbVehicleCols = {};
    if (sb) {
      try {
        const { data: sbRows, error: sbErr } = await sb
          .from("vehicles")
          .select("vehicle_id, bouncie_device_id, decision_status, action_status, mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data");
        if (!sbErr && sbRows) {
          for (const row of sbRows) {
            sbVehicleCols[row.vehicle_id] = {
              bouncie_device_id:         row.bouncie_device_id || null,
              decision_status:           row.decision_status   || null,
              action_status:             row.action_status     || null,
              type:                      row.data?.type || row.data?.vehicle_type || null,
              mileage:                   row.mileage,
              last_oil_change_mileage:   row.last_oil_change_mileage,
              last_brake_check_mileage:  row.last_brake_check_mileage,
              last_tire_change_mileage:  row.last_tire_change_mileage,
            };
          }
        }
      } catch {
        // ignore — UI will render without badges if Supabase is unavailable
      }
    }

    // Compute mileage stats for priority calculation (cars with Bouncie only)
    let mileageStatMap = {};
    if (sb && Object.keys(sbVehicleCols).length > 0) {
      try {
        const mileageInput = Object.entries(sbVehicleCols)
          .filter(([, c]) => c.bouncie_device_id && (c.type || "") !== "slingshot")
          .map(([vehicleId, c]) => ({
            vehicle_id:               vehicleId,
            total_mileage:            Number(c.mileage) || 0,
            last_oil_change_mileage:  c.last_oil_change_mileage  != null ? Number(c.last_oil_change_mileage)  : null,
            last_brake_check_mileage: c.last_brake_check_mileage != null ? Number(c.last_brake_check_mileage) : null,
            last_tire_change_mileage: c.last_tire_change_mileage != null ? Number(c.last_tire_change_mileage) : null,
          }));
        if (mileageInput.length > 0) {
          // Fetch recent trips for avg-daily-miles computation (non-fatal)
          const tripRows = await sb.from("trip_log")
            .select("vehicle_id, trip_distance, trip_at")
            .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString())
            .then((r) => r.data || [])
            .catch(() => []);
          const { stats } = analyzeMileage(mileageInput, tripRows);
          for (const s of stats) mileageStatMap[s.vehicle_id] = s;
        }
      } catch {
        // priority degrades gracefully to decision_status-only
      }
    }

    const [{ data: vehicles }, expenses, { data: bookingsData }] = await Promise.all([
      loadVehicles(),
      loadExpensesAny(),
      loadBookings(),
    ]);

    const stats = {};

    for (const vehicleId of Object.keys(vehicles)) {
      const vehicle = vehicles[vehicleId];

      // Merge Supabase-only columns into the vehicle object for UI consumption
      const sbCols = sbVehicleCols[vehicleId] || {};
      if (sbCols.bouncie_device_id !== undefined) vehicle.bouncie_device_id = sbCols.bouncie_device_id;
      if (sbCols.decision_status   !== undefined) vehicle.decision_status   = sbCols.decision_status;
      if (sbCols.action_status     !== undefined) vehicle.action_status     = sbCols.action_status;
      if (sbCols.type && !vehicle.type)           vehicle.type              = sbCols.type;

      // Tracking warning for cars without a Bouncie device
      const isCar = (vehicle.type || "") !== "slingshot";
      if (isCar && !vehicle.bouncie_device_id) {
        vehicle.tracking_warning = "⚠️ This vehicle is not tracked — no mileage or maintenance alerts";
      } else {
        delete vehicle.tracking_warning;
      }

      // Derived priority (high / medium / low)
      const { priority, reason: priorityReason } = computeVehiclePriority(vehicle, mileageStatMap[vehicleId] || null);
      vehicle.priority        = priority;
      vehicle.priority_reason = priorityReason;

      // ── Bookings ───────────────────────────────────────────────────────────
      const vehicleBookings = (bookingsData[vehicleId] || []).filter(
        (b) => b.status === "booked_paid" || b.status === "active_rental" || b.status === "completed_rental"
      );

      let totalRevenue = 0;
      const monthlyRevenue = {};

      for (const booking of vehicleBookings) {
        const amount = bookingRevenue(booking);
        totalRevenue += amount;

        const monthKey = (booking.createdAt || booking.pickupDate || "").slice(0, 7); // "YYYY-MM"
        if (monthKey) {
          monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + amount;
        }
      }

      // ── Expenses ───────────────────────────────────────────────────────────
      const vehicleExpenses = expenses.filter((e) => e.vehicle_id === vehicleId);
      let totalExpenses = 0;
      const expensesByCategory = {};
      const monthlyExpenses = {};

      for (const expense of vehicleExpenses) {
        totalExpenses += expense.amount || 0;
        const cat = expense.category || "other";
        expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (expense.amount || 0);
        const monthKey = (expense.date || "").slice(0, 7);
        if (monthKey) {
          monthlyExpenses[monthKey] = (monthlyExpenses[monthKey] || 0) + (expense.amount || 0);
        }
      }

      // ── Profit / ROI ───────────────────────────────────────────────────────
      const netProfit   = totalRevenue - totalExpenses;
      const purchasePrice = vehicle.purchase_price || 0;
      const roi           = purchasePrice > 0 ? Math.round((netProfit / purchasePrice) * 10000) / 100 : null;
      const breakEvenPct  = purchasePrice > 0 ? Math.min(100, Math.round((totalRevenue / purchasePrice) * 10000) / 100) : null;

      // Recent bookings — last 10 sorted newest first
      const recentBookings = [...vehicleBookings]
        .sort((a, b) => (b.createdAt || "") > (a.createdAt || "") ? -1 : 1)
        .slice(0, 10);

      stats[vehicleId] = {
        vehicle,
        totalBookings:      vehicleBookings.length,
        totalRevenue:       Math.round(totalRevenue * 100) / 100,
        monthlyRevenue,
        totalExpenses:      Math.round(totalExpenses * 100) / 100,
        netProfit:          Math.round(netProfit * 100) / 100,
        roi,
        breakEvenPct,
        expensesByCategory,
        monthlyExpenses,
        recentBookings,
      };
    }

    return res.status(200).json(stats);
  } catch (err) {
    console.error("get-vehicle-stats error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
