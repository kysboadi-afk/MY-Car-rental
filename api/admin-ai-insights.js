// api/admin-ai-insights.js
// SLYTRANS Fleet Control — Business intelligence + problem detection endpoint.
// Returns structured insights and detected problems without requiring an OpenAI key.
// Uses Supabase as primary data source with JSON fallback.
//
// POST /api/admin-ai-insights
// Body: { secret: string }
//
// Response: { insights: object, problems: string[], fraud: { flagged: number, topRisks: object[] } }

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadBookings } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { computeAmount } from "./_pricing.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { scoreAllBookings } from "../lib/ai/fraud.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { uiVehicleId } from "./_vehicle-id.js";

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

  // ── Bookings ──────────────────────────────────────────────────────────────
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

  // ── Vehicles ──────────────────────────────────────────────────────────────
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
          // Skip slingshots — they are managed by the dedicated slingshot admin
          const type = row.data?.type || row.data?.vehicle_type || "";
          if (type === "slingshot") continue;
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
    for (const [id, v] of Object.entries(data)) {
      if ((v.type || "") === "slingshot") continue;
      vehicles[id] = v;
    }
  }

  // ── Mileage data (Bouncie-tracked vehicles only) ──────────────────────────
  // Tracking activity is determined by bouncie_device_id + last_synced_at,
  // NOT by rental_status.  A rented vehicle with an active Bouncie device is
  // still tracked and must be included in maintenance/mileage analysis.
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
          vehicle_id:               r.vehicle_id,
          vehicle_name:             r.data?.vehicle_name || r.vehicle_id,
          total_mileage:            Number(r.mileage) || 0,
          last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
          last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
          last_synced_at:           r.last_synced_at,
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

  // Filter bookings to car vehicles only (exclude slingshots).
  // Also normalize extended canonical IDs written by the Stripe webhook
  // (e.g. "camry2012" → "camry") back to their vehicle-table key using uiVehicleId().
  const carVehicleIds = new Set(Object.keys(vehicles));
  const filteredBookings = allBookings
    .map((b) => ({ ...b, vehicleId: uiVehicleId(b.vehicleId) }))
    .filter((b) => !b.vehicleId || carVehicleIds.has(b.vehicleId));

  return { allBookings: filteredBookings, vehicles, mileageData, recentTrips };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { allBookings, vehicles, mileageData, recentTrips } = await fetchAllData();
    const insights = computeInsights({ allBookings, vehicles, revenueFromBooking });
    const problems = detectProblems({ allBookings, vehicles, revenueFromBooking, insights, mileageData, recentTrips });

    // Fraud summary (top 10 risks)
    const fraudScored = scoreAllBookings(allBookings);
    const flagged     = fraudScored.filter((b) => b.flagged);
    flagged.sort((a, b) => b.risk_score - a.risk_score);

    // Persist fraud flags to Supabase in background (non-blocking)
    const sb = getSupabaseAdmin();
    if (sb && flagged.length > 0) {
      Promise.all(
        flagged.map((b) =>
          sb.from("bookings").update({ flagged: true, risk_score: b.risk_score }).eq("booking_id", b.bookingId)
        )
      ).catch((err) => console.warn("admin-ai-insights: fraud persist failed:", err.message));
    }

    return res.status(200).json({
      insights,
      problems,
      fraud: {
        total:    allBookings.length,
        flagged:  flagged.length,
        topRisks: flagged.slice(0, 10),
      },
    });
  } catch (err) {
    console.error("admin-ai-insights error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
