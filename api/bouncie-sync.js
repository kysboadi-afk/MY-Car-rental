// api/bouncie-sync.js
// Vercel cron — runs every 5 minutes (see vercel.json).
// Pulls the latest odometer readings from the Bouncie API and persists them to
// the vehicles table for all Bouncie-tracked fleet vehicles.
//
// Auth:
//   GET  — called by Vercel cron scheduler (no auth required from Vercel)
//   POST — manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Only vehicles with bouncie_device_id set AND is_tracked=true are synced.
//
// Required env vars:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   BOUNCIE_CLIENT_ID + BOUNCIE_CLIENT_SECRET  (for OAuth token refresh)

import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles, updateVehicleMileage } from "./_bouncie.js";

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

  // Fetch all vehicles with a Bouncie IMEI assigned — prefer the dedicated
  // bouncie_device_id column but also include is_tracked=true rows whose IMEI
  // may only be stored in the data JSONB (legacy write path).
  const { data: trackedData, error: trackedError } = await sb
    .from("vehicles")
    .select("*")
    .or("is_tracked.eq.true,bouncie_device_id.not.is.null");

  if (trackedError) {
    console.error("bouncie-sync: vehicles query failed:", trackedError.message);
    return res.status(200).json({
      bouncie_error: true,
      skipped:       true,
      reason:        trackedError.message,
      duration_ms:   Date.now() - startedAt,
    });
  }

  console.log("Tracked vehicles:", trackedData);
  // Normalize: fall back to data JSONB when the dedicated column is null.
  const trackedVehicles = (trackedData || []).map((v) => ({
    ...v,
    bouncie_device_id: v.bouncie_device_id || v.data?.bouncie_device_id || null,
  }));

  let bouncieVehicles;
  try {
    bouncieVehicles = await getBouncieVehicles();
  } catch (err) {
    console.error("bouncie-sync: Bouncie API fetch failed:", err.message, err);
    // Return 200 so Vercel cron does not treat this as a hard failure
    return res.status(200).json({
      bouncie_error: true,
      skipped:       true,
      reason:        err.message,
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
