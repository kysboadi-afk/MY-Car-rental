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
  pending:              "reserved_unpaid",
  reserved:             "reserved_unpaid",
  pending_verification: "reserved_unpaid",
  approved:             "booked_paid",
  booked_paid:          "booked_paid",
  active:               "active_rental",
  active_rental:        "active_rental",
  overdue:              "overdue",
  completed:            "completed_rental",
  completed_rental:     "completed_rental",
  cancelled:            "cancelled_rental",
  cancelled_rental:     "cancelled_rental",
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
        .select("booking_ref, vehicle_id, customer_name, customer_phone, customer_email, pickup_date, return_date, status, deposit_paid, total_price, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (!error && data) {
        allBookings = data.map((row) => ({
          bookingId:  row.booking_ref || "",
          name:       row.customer_name || "",
          phone:      row.customer_phone || "",
          email:      row.customer_email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: Number(row.deposit_paid || row.total_price || 0),
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

  // ── Revenue records (source of truth for financial totals) ─────────────
  // Fetch all paid, non-cancelled, non-no-show records from revenue_records_effective
  // so computeInsights can produce accurate weekly/monthly revenue snapshots that
  // match the Revenue page and Fleet Analytics instead of relying on the bookings table.
  let revenueRecords = [];
  if (sb) {
    try {
      const { data: rrData, error: rrErr } = await sb
        .from("revenue_records_effective")
        .select("vehicle_id, pickup_date, gross_amount, is_cancelled, is_no_show")
        .eq("payment_status", "paid");
      if (!rrErr && rrData && rrData.length > 0) {
        revenueRecords = rrData.filter((r) => !r.is_cancelled && !r.is_no_show);
      }
    } catch (rrEx) {
      // Non-fatal — computeInsights will fall back to the bookings array
      console.warn("admin-ai-insights: revenue_records fetch failed, using bookings fallback:", rrEx.message);
    }
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

  // Filter revenue records to car vehicles only (same scope as filteredBookings).
  const filteredRevenueRecords = revenueRecords.filter((r) => {
    const vid = uiVehicleId(r.vehicle_id);
    return !vid || carVehicleIds.has(vid);
  });

  return { allBookings: filteredBookings, vehicles, mileageData, recentTrips, revenueRecords: filteredRevenueRecords };
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

  // Default 10 s budget: ~3 s Supabase cold-start + 3 s for parallel queries
  // (bookings, vehicles, revenue_records_effective) + 4 s buffer for computation.
  // 5 s was too tight after revenue_records_effective was added to fetchAllData
  // and caused spurious "System is busy" responses on first load.
  const TIMEOUT_MS = Number(process.env.AI_INSIGHTS_TIMEOUT_MS) || 10000;

  async function mainLogic() {
    const { allBookings, vehicles, mileageData, recentTrips, revenueRecords } = await fetchAllData();
    const insights = computeInsights({ allBookings, vehicles, revenueFromBooking, revenueRecords });
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

    return {
      insights,
      problems,
      fraud: {
        total:    allBookings.length,
        flagged:  flagged.length,
        topRisks: flagged.slice(0, 10),
      },
    };
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("AI timeout")), TIMEOUT_MS);
  });

  console.time("AI request");
  try {
    const result = await Promise.race([mainLogic(), timeoutPromise]);
    clearTimeout(timeoutId);
    console.timeEnd("AI request");
    return res.status(200).json(result);
  } catch (err) {
    clearTimeout(timeoutId);
    console.timeEnd("AI request");
    if (err.message === "AI timeout") {
      return res.status(200).json({ message: "System is busy. Try a simpler question." });
    }
    console.error("admin-ai-insights error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
