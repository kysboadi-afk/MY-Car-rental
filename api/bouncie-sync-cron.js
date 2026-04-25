// api/bouncie-sync-cron.js
// Vercel cron — runs twice a day (see vercel.json).
// Syncs current Bouncie odometer readings into the vehicle_state table so the
// oil-check-cron can compute miles-since-last-check without calling Bouncie on
// every trigger evaluation.
//
// Auth:
//   GET  — called by Vercel cron scheduler (no auth required from Vercel)
//   POST — manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Required env vars:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   BOUNCIE_CLIENT_ID + BOUNCIE_CLIENT_SECRET  (for OAuth token refresh)

import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles } from "./_bouncie.js";

export default async function handler(req, res) {
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

  // Load all tracked vehicles (non-slingshot with Bouncie device assigned)
  const { data: trackedData, error: trackedError } = await sb
    .from("vehicles")
    .select("vehicle_id, bouncie_device_id, data")
    .or("is_tracked.eq.true,bouncie_device_id.not.is.null");

  if (trackedError) {
    console.error("bouncie-sync-cron: vehicles query failed:", trackedError.message);
    return res.status(200).json({
      skipped:     true,
      reason:      trackedError.message,
      duration_ms: Date.now() - startedAt,
    });
  }

  const trackedVehicles = (trackedData || []).map((v) => ({
    ...v,
    bouncie_device_id: v.bouncie_device_id || v.data?.bouncie_device_id || null,
  }));

  // Fetch live odometer readings from Bouncie
  let bouncieVehicles;
  try {
    bouncieVehicles = await getBouncieVehicles();
  } catch (err) {
    console.error("bouncie-sync-cron: Bouncie API fetch failed:", err.message);
    return res.status(200).json({
      bouncie_error: true,
      skipped:       true,
      reason:        err.message,
      duration_ms:   Date.now() - startedAt,
    });
  }

  // Build IMEI → tracked vehicle map
  const imeiMap = {};
  for (const v of trackedVehicles) {
    if (v.bouncie_device_id) imeiMap[v.bouncie_device_id] = v;
  }

  const synced = [];
  const errors = [];
  const nowIso = new Date().toISOString();

  for (const bv of bouncieVehicles) {
    const { imei, stats } = bv;
    if (!imei || !stats?.odometer) continue;

    const tracked = imeiMap[imei];
    if (!tracked) continue;

    const odometer = stats.odometer;
    if (!odometer || odometer <= 0) continue;

    try {
      // Upsert vehicle_state.current_mileage
      const { error } = await sb
        .from("vehicle_state")
        .upsert(
          {
            vehicle_id:      tracked.vehicle_id,
            current_mileage: odometer,
            updated_at:      nowIso,
          },
          { onConflict: "vehicle_id" }
        );

      if (error) throw new Error(error.message);

      synced.push({ vehicleId: tracked.vehicle_id, imei, odometer });
    } catch (err) {
      errors.push(`${tracked.vehicle_id}: ${err.message}`);
      console.error("bouncie-sync-cron: upsert failed for", tracked.vehicle_id, err.message);
    }
  }

  return res.status(200).json({
    synced_count: synced.length,
    error_count:  errors.length,
    duration_ms:  Date.now() - startedAt,
    synced,
    errors,
  });
}
