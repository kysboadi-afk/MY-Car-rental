// api/admin-ai-insights.js
// SLYTRANS Fleet Control — Business intelligence + problem detection endpoint.
// Returns structured insights and detected problems without requiring an OpenAI key.
//
// POST /api/admin-ai-insights
// Body: { secret: string }
//
// Response: { insights: object, problems: string[], fraud: { flagged: number, topRisks: object[] } }

import { isAdminAuthorized } from "./_admin-auth.js";
import { loadBookings } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { computeAmount } from "./_pricing.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { scoreAllBookings } from "../lib/ai/fraud.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function revenueFromBooking(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) return booking.amountPaid;
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    return computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate) || 0;
  }
  return 0;
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
    const [{ data: bookingsData }, { data: vehicles }] = await Promise.all([
      loadBookings(),
      loadVehicles(),
    ]);

    const allBookings = Object.values(bookingsData).flat();
    const insights    = computeInsights({ allBookings, vehicles, revenueFromBooking });
    const problems    = detectProblems({ allBookings, vehicles, revenueFromBooking, insights });

    // Fraud summary (top 10 risks)
    const fraudScored = scoreAllBookings(allBookings);
    const flagged     = fraudScored.filter((b) => b.flagged);
    flagged.sort((a, b) => b.risk_score - a.risk_score);

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
