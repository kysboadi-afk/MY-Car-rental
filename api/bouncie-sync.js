// api/bouncie-sync.js
// Vercel cron — runs every 5 minutes (see vercel.json).
// Pulls the latest odometer readings from the Bouncie API and persists them to
// the vehicles table for all Bouncie-tracked fleet vehicles.
//
// Auth:
//   GET  — called by Vercel cron scheduler (no auth required from Vercel)
//   POST — manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Only vehicles with a bouncie_device_id set in the DB are synced.
// Slingshots are excluded by loadTrackedVehicles() regardless of IMEI.
//
// Required env vars:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   BOUNCIE_CLIENT_ID + BOUNCIE_CLIENT_SECRET  (for OAuth token refresh)

import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles, loadTrackedVehicles, updateVehicleMileage } from "./_bouncie.js";
import { adminErrorMessage } from "./_error-helpers.js";

export default async function handler(req, res) {
  // Allow GET (cron) and POST (manual trigger)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Manual POST requires ADMIN_SECRET or CRON_SECRET
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const startedAt = Date.now();

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({
      skipped:     true,
      reason:      "Supabase not configured",
      duration_ms: Date.now() - startedAt,
    });
  }

  let trackedVehicles, bouncieVehicles;
  try {
    [trackedVehicles, bouncieVehicles] = await Promise.all([
      loadTrackedVehicles(sb),
      getBouncieVehicles(),
    ]);
  } catch (err) {
    console.error("bouncie-sync: fetch failed:", err.message);
    // Return 200 so Vercel cron does not treat this as a hard failure
    return res.status(200).json({
      bouncie_error: true,
      skipped:       true,
      reason:        adminErrorMessage(err),
      duration_ms:   Date.now() - startedAt,
    });
  }

  // Build IMEI → DB vehicle map
  const imeiMap = {};
  for (const v of trackedVehicles) {
    if (v.bouncie_device_id) imeiMap[v.bouncie_device_id] = v;
  }

  const synced = [];
  const errors = [];

  for (const bv of bouncieVehicles) {
    const { imei, stats } = bv;
    if (!imei || !stats?.odometer) continue;

    const tracked = imeiMap[imei];
    if (!tracked) continue; // IMEI not in our fleet — skip

    try {
      await updateVehicleMileage(
        sb,
        tracked.vehicle_id,
        stats.odometer,
        stats.lastUpdated ?? null
      );
      synced.push({ vehicleId: tracked.vehicle_id, imei, odometer: stats.odometer });
    } catch (err) {
      errors.push(`${tracked.vehicle_id}: ${err.message}`);
    }
  }

  return res.status(200).json({
    synced_count: synced.length,
    duration_ms:  Date.now() - startedAt,
    synced,
    errors,
  });
}
