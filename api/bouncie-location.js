// api/bouncie-location.js
// Returns real-time GPS locations for all tracked fleet vehicles.
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
// All vehicles with is_tracked=true (or a bouncie_device_id set) are returned.
// Vehicles without a matching Bouncie IMEI have lat/lon/speed/heading set to
// null so the UI can show them as "no signal" rather than omitting them.

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
        hint: bouncieErr.message,
      });
    }

    // Build an entry for every tracked vehicle (null GPS until Bouncie enriches it).
    const vehicleMap = {};
    const imeiToId   = {};
    for (const v of trackedVehicles) {
      vehicleMap[v.vehicle_id] = {
        vehicleId:   v.vehicle_id,
        vehicleName: v.vehicle_name || v.vehicle_id,
        imei:        v.bouncie_device_id || null,
        lat:         null,
        lon:         null,
        speed:       null,
        heading:     null,
        isMoving:    false,
        odometer:    v.mileage || null,
        lastUpdated: null,
      };
      if (v.bouncie_device_id) imeiToId[v.bouncie_device_id] = v.vehicle_id;
    }

    // Enrich with live Bouncie data for vehicles whose IMEI is registered.
    for (const bv of bouncieVehicles) {
      const { imei, stats } = bv;
      if (!imei) continue;

      const vehicleId = imeiToId[imei];
      if (!vehicleId) continue; // IMEI not in our fleet

      const loc = stats?.location || {};
      vehicleMap[vehicleId] = {
        ...vehicleMap[vehicleId],
        imei,
        lat:         typeof loc.lat     === "number" ? loc.lat                : null,
        lon:         typeof loc.lon     === "number" ? loc.lon                : null,
        speed:       typeof loc.speed   === "number" ? Math.round(loc.speed)  : null,
        heading:     typeof loc.heading === "number" ? Math.round(loc.heading): null,
        isMoving:    loc.isMoving ?? false,
        odometer:    stats?.odometer ?? vehicleMap[vehicleId].odometer,
        lastUpdated: stats?.lastUpdated ?? null,
      };
    }

    const vehicles = Object.values(vehicleMap);
    return res.status(200).json({ connected: true, vehicles });
  } catch (err) {
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
