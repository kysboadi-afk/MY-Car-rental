// api/complete-booking-mileage.js
// Admin endpoint: manually record start/end mileage for a booking.
// Inserts a trips record (migration 0030), updates vehicle.mileage, and
// triggers maintenance status recomputation.
//
// POST /api/complete-booking-mileage
// Body: {
//   "secret":       "<ADMIN_SECRET>",
//   "bookingId":    "BK-20240115-1234",  -- booking reference or numeric ID
//   "vehicleId":    "camry",
//   "startMileage": 12000,
//   "endMileage":   12350,
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { triggerMaintenanceUpdate } from "./update-maintenance-status.js";
import { normalizeVehicleId } from "./_vehicle-id.js";
import { FLEET_VEHICLE_IDS } from "./_pricing.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = FLEET_VEHICLE_IDS;

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

  const body = req.body || {};
  const { secret, bookingId, vehicleId, startMileage, endMileage } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Input validation ──────────────────────────────────────────────────────
  if (!bookingId) {
    return res.status(400).json({ error: "bookingId is required." });
  }
  if (!vehicleId || !ALLOWED_VEHICLES.includes(vehicleId)) {
    return res.status(400).json({ error: "A valid vehicleId is required." });
  }
  const start = Number(startMileage);
  const end   = Number(endMileage);
  if (!Number.isFinite(start) || start < 0) {
    return res.status(400).json({ error: "startMileage must be a non-negative number." });
  }
  if (!Number.isFinite(end) || end < 0) {
    return res.status(400).json({ error: "endMileage must be a non-negative number." });
  }
  if (end < start) {
    return res.status(400).json({ error: "endMileage must be greater than or equal to startMileage." });
  }

  const distance = end - start;

  try {
    const sb = getSupabaseAdmin();
    if (!sb) {
      return res.status(500).json({ error: "Database not configured." });
    }

    // ── Insert trip record ────────────────────────────────────────────────
    const { data: tripRow, error: tripErr } = await sb
      .from("trips")
      .insert({
        vehicle_id:    normalizeVehicleId(vehicleId),
        booking_id:    String(bookingId),
        start_mileage: start,
        end_mileage:   end,
        distance:      distance,
      })
      .select("id")
      .single();

    if (tripErr) {
      console.error("complete-booking-mileage: trips insert failed:", tripErr.message);
      return res.status(500).json({ error: adminErrorMessage(tripErr, "Failed to save trip record.") });
    }

    // ── Update vehicle current mileage (only advance, never roll back) ────
    const { error: mileageErr } = await sb
      .from("vehicles")
      .update({ mileage: end, updated_at: new Date().toISOString() })
      .eq("vehicle_id", normalizeVehicleId(vehicleId))
      .lt("mileage", end);   // only update when new value is higher

    if (mileageErr) {
      console.warn("complete-booking-mileage: vehicle mileage update failed (non-fatal):", mileageErr.message);
    }

    // ── Recompute maintenance status (non-fatal) ──────────────────────────
    try {
      await triggerMaintenanceUpdate(vehicleId);
    } catch (maintErr) {
      console.warn("complete-booking-mileage: maintenance update failed (non-fatal):", maintErr.message);
    }

    return res.status(200).json({
      success:   true,
      tripId:    tripRow?.id ?? null,
      vehicleId,
      bookingId: String(bookingId),
      startMileage: start,
      endMileage:   end,
      distance,
    });
  } catch (err) {
    console.error("complete-booking-mileage: unexpected error:", err.message);
    return res.status(500).json({ error: adminErrorMessage(err, "Unexpected server error.") });
  }
}
