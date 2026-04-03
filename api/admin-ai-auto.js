// api/admin-ai-auto.js
// SLYTRANS Fleet Control — AI automation loop (cron job entry point).
//
// Called by Vercel Cron every 10 minutes (see vercel.json).
// Also callable manually via POST with Authorization: Bearer <CRON_SECRET>.
//
// Flow:
//   1. Fetch bookings + vehicles from Supabase (fallback: JSON files)
//   2. Compute insights
//   3. Detect problems
//   4. If AUTO_MODE env var = "true" → execute low-risk actions
//   5. Log everything to ai_logs
//
// Required env vars:
//   ADMIN_SECRET or CRON_SECRET — authentication
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — database
// Optional:
//   AUTO_MODE=true — enables automatic action execution (default: false)
//   OPENAI_API_KEY — required for AI-generated action summaries

import { executeAction, logAiAction } from "./_admin-actions.js";
import { loadBookings } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { computeAmount } from "./_pricing.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { runAutoActions } from "../lib/ai/actions-auto.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const DB_TO_APP_STATUS = {
  pending:   "reserved_unpaid",
  approved:  "booked_paid",
  active:    "active_rental",
  completed: "completed_rental",
  cancelled: "cancelled_rental",
};

function revenueFromBooking(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) return booking.amountPaid;
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    return computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate) || 0;
  }
  return 0;
}

async function fetchAllData() {
  const sb = getSupabaseAdmin();

  let allBookings = [];
  if (sb) {
    try {
      const { data, error } = await sb
        .from("bookings")
        .select("booking_id, vehicle_id, customer_name, phone, email, pickup_date, return_date, status, amount_paid, total_price, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (!error && data) {
        allBookings = data.map((row) => ({
          bookingId:  row.booking_id || "",
          name:       row.customer_name || "",
          phone:      row.phone || "",
          email:      row.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.amount_paid || row.total_price || 0,
          createdAt:  row.created_at || "",
        }));
      }
    } catch {
      // fall through
    }
  }

  if (allBookings.length === 0) {
    const { data: bookingsData } = await loadBookings();
    allBookings = Object.values(bookingsData).flat();
  }

  // Include Bouncie fields so detectProblems can use tracking status as
  // source of truth, independent of booking/fleet status.
  let vehicles = {};
  if (sb) {
    try {
      const { data, error } = await sb
        .from("vehicles")
        .select("vehicle_id, data, rental_status, bouncie_device_id, last_synced_at");
      if (!error && data) {
        for (const row of data) {
          vehicles[row.vehicle_id] = {
            vehicle_id:        row.vehicle_id,
            ...(row.data || {}),
            rental_status:     row.rental_status     || null,
            bouncie_device_id: row.bouncie_device_id || null,
            last_synced_at:    row.last_synced_at    || null,
          };
        }
      }
    } catch {
      // fall through
    }
  }
  if (Object.keys(vehicles).length === 0) {
    const { data } = await loadVehicles();
    vehicles = data;
  }

  // Mileage data for Bouncie-tracked vehicles — rental_status is ignored when
  // deciding what to track; last_synced_at is the source of truth for activity.
  let mileageData = [];
  let recentTrips = [];
  if (sb) {
    try {
      const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicles")
          .select("vehicle_id, mileage, last_synced_at, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
          .not("bouncie_device_id", "is", null),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);
      mileageData = (vehicleRows || [])
        .filter((r) => {
          const type = r.data?.type || r.data?.vehicle_type || "";
          return type !== "slingshot";
        })
        .map((r) => ({
          vehicle_id:           r.vehicle_id,
          vehicle_name:         r.data?.vehicle_name || r.vehicle_id,
          total_mileage:        Number(r.mileage) || 0,
          last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
          last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
          last_synced_at:       r.last_synced_at,
        }));
      recentTrips = (tripRows || []).map((r) => ({
        vehicle_id:    r.vehicle_id,
        trip_distance: r.trip_distance,
        trip_at:       r.trip_at,
      }));
    } catch {
      // mileage data unavailable — detectProblems will skip mileage section
    }
  }

  return { allBookings, vehicles, mileageData, recentTrips };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Authentication ────────────────────────────────────────────────────────
  // Vercel Cron sends GET; manual triggers send POST with Bearer token.
  if (req.method === "POST") {
    const authHeader  = req.headers.authorization || "";
    const cronSecret  = process.env.CRON_SECRET;
    const adminSecret = process.env.ADMIN_SECRET;

    const validCron  = cronSecret  && authHeader === `Bearer ${cronSecret}`;
    const validAdmin = adminSecret && authHeader === `Bearer ${adminSecret}`;

    if (!validCron && !validAdmin) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  // GET requests from Vercel Cron are trusted implicitly (internal network).
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const autoMode = process.env.AUTO_MODE === "true";

  try {
    const runStart = Date.now();
    const { allBookings, vehicles, mileageData, recentTrips } = await fetchAllData();

    const insights = computeInsights({ allBookings, vehicles, revenueFromBooking });
    const problems = detectProblems({ allBookings, vehicles, revenueFromBooking, insights, mileageData, recentTrips });

    // Run auto-action engine
    const { suggestions, actions_taken } = await runAutoActions({
      insights,
      problems,
      autoMode,
      execute: executeAction,
      secret:  process.env.ADMIN_SECRET,
    });

    const runMs = Date.now() - runStart;

    const output = {
      ran_at:        new Date().toISOString(),
      auto_mode:     autoMode,
      duration_ms:   runMs,
      problems_found: problems.length,
      problems,
      suggestions,
      actions_taken,
      revenue_this_week:  insights.revenue?.thisWeek,
      bookings_last_7d:   insights.bookings?.last7Days,
    };

    // Log the auto-run to ai_logs
    await logAiAction("auto_run", { auto_mode: autoMode, booking_count: allBookings.length }, output, "cron");

    return res.status(200).json(output);
  } catch (err) {
    console.error("admin-ai-auto error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
