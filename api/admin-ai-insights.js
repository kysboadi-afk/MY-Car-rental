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
  let vehicles = {};
  if (sb) {
    try {
      const { data, error } = await sb.from("vehicles").select("vehicle_id, data, rental_status");
      if (!error && data) {
        for (const row of data) {
          vehicles[row.vehicle_id] = { vehicle_id: row.vehicle_id, ...(row.data || {}), rental_status: row.rental_status };
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

  return { allBookings, vehicles };
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
    const { allBookings, vehicles } = await fetchAllData();
    const insights = computeInsights({ allBookings, vehicles, revenueFromBooking });
    const problems = detectProblems({ allBookings, vehicles, revenueFromBooking, insights });

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
