// api/bouncie-location.js
// Returns real-time GPS locations for all Bouncie-tracked fleet vehicles.
//
// GET /api/bouncie-location?secret=<ADMIN_SECRET>
//
// Response (not connected):
//   { connected: false, message: "..." }
//
// Response (connected):
//   { connected: true, vehicles: [{ vehicleId, vehicleName, imei, lat, lon,
//     speed, heading, isMoving, odometer, lastUpdated }] }
//
// Vehicles whose Bouncie record has no location data are still included with
// lat/lon set to null so the UI can show them as "no signal".

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles, loadTrackedVehicles } from "./_bouncie.js";
import { adminErrorMessage } from "./_error-helpers.js";

export const config = {
  runtime: "nodejs",
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const secret = req.query?.secret;
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({ connected: false, message: "Database not configured." });
  }

  try {
    // Load tracked vehicles from DB first; a DB failure is a hard server error.
    const trackedVehicles = await loadTrackedVehicles(sb);

    // Call the Bouncie API separately so that any failure (missing/expired/invalid
    // token, upstream error) is surfaced as "not connected" rather than a 500.
    let bouncieVehicles;
    try {
      bouncieVehicles = await getBouncieVehicles();
    } catch (bouncieErr) {
      return res.status(200).json({
        connected: false,
        message: adminErrorMessage(bouncieErr),
      });
    }

    // Build IMEI → DB vehicle map
    const imeiMap = {};
    for (const v of trackedVehicles) {
      if (v.bouncie_device_id) imeiMap[v.bouncie_device_id] = v;
    }

    const vehicles = [];
    for (const bv of bouncieVehicles) {
      const { imei, stats } = bv;
      if (!imei) continue;

      const tracked = imeiMap[imei];
      if (!tracked) continue; // not in our fleet

      const loc = stats?.location || {};
      const lat = typeof loc.lat === "number" ? loc.lat : null;
      const lon = typeof loc.lon === "number" ? loc.lon : null;

      vehicles.push({
        vehicleId:   tracked.vehicle_id,
        vehicleName: tracked.vehicle_name || tracked.vehicle_id,
        imei,
        lat,
        lon,
        speed:       typeof loc.speed   === "number" ? Math.round(loc.speed) : null,
        heading:     typeof loc.heading === "number" ? Math.round(loc.heading) : null,
        isMoving:    loc.isMoving ?? false,
        odometer:    stats?.odometer ?? null,
        lastUpdated: stats?.lastUpdated ?? null,
      });
    }

    return res.status(200).json({ connected: true, vehicles });
  } catch (err) {
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
