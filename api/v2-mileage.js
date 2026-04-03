// api/v2-mileage.js
// SLYTRANS Fleet Control v2 — Mileage & Bouncie tracking endpoint.
//
// POST /api/v2-mileage
// Body: { secret, action, ...params }
//
// Actions:
//   get            — fetch mileage + trip stats for all vehicles
//   sync           — trigger an on-demand Bouncie pull (same logic as bouncie-sync cron)
//   update_service — record that a vehicle was serviced at its current mileage
//                    Body: { vehicleId, mileage? }  (defaults to current total_mileage)

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles, parseDeviceMap, resolveVehicleId, upsertMileage } from "./_bouncie.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  const { action = "get" } = body;

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (action === "get") {
      const [{ data: mileageRows, error: mErr }, { data: vehicleRows }, { data: tripRows }] =
        await Promise.all([
          sb.from("vehicle_mileage").select(
            "vehicle_id, bouncie_imei, total_mileage, last_service_mileage, last_trip_at, last_synced_at"
          ).order("vehicle_id"),
          sb.from("vehicles").select("vehicle_id, data"),
          sb.from("trip_log")
            .select("vehicle_id, trip_distance, trip_at")
            .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
        ]);

      if (mErr) throw new Error(`Supabase query failed: ${mErr.message}`);

      const vehicleNames = {};
      for (const row of vehicleRows || []) {
        vehicleNames[row.vehicle_id] = row.data?.vehicle_name || row.vehicle_id;
      }

      const mileageData = (mileageRows || []).map((row) => ({
        ...row,
        vehicle_name: vehicleNames[row.vehicle_id] || row.vehicle_id,
      }));

      const { alerts, stats } = analyzeMileage(mileageData, tripRows || []);

      return res.status(200).json({
        stats,
        alerts,
        bouncie_configured: !!process.env.BOUNCIE_ACCESS_TOKEN,
      });
    }

    // ── SYNC ─────────────────────────────────────────────────────────────────
    if (action === "sync") {
      if (!process.env.BOUNCIE_ACCESS_TOKEN) {
        return res.status(200).json({ skipped: true, reason: "BOUNCIE_ACCESS_TOKEN not configured" });
      }

      const deviceMap = parseDeviceMap();
      const synced    = [];
      const errors    = [];
      const startedAt = Date.now();

      const bouncieVehicles = await getBouncieVehicles();

      for (const bv of bouncieVehicles) {
        const { imei, nickName, stats } = bv;
        if (!imei || !stats) continue;
        const odometer    = stats.odometer   ?? null;
        const lastUpdated = stats.lastUpdated ?? null;
        if (odometer === null) continue;

        const vehicleId = resolveVehicleId(imei, nickName, deviceMap);
        if (!vehicleId) {
          errors.push(`IMEI ${imei}: no vehicle mapping — add to BOUNCIE_DEVICE_MAP`);
          continue;
        }

        try {
          await upsertMileage(sb, vehicleId, imei, odometer, lastUpdated);
          synced.push({ vehicleId, imei, odometer, lastUpdated });
        } catch (err) {
          errors.push(`${vehicleId}: ${err.message}`);
        }
      }

      return res.status(200).json({
        synced_count: synced.length,
        duration_ms:  Date.now() - startedAt,
        synced,
        errors,
      });
    }

    // ── UPDATE SERVICE ────────────────────────────────────────────────────────
    if (action === "update_service") {
      const { vehicleId, mileage } = body;
      if (!vehicleId) return res.status(400).json({ error: "vehicleId is required" });

      // Default to current total_mileage if not specified
      let serviceMileage = mileage !== undefined ? Number(mileage) : null;
      if (serviceMileage === null) {
        const { data: row } = await sb
          .from("vehicle_mileage")
          .select("total_mileage")
          .eq("vehicle_id", vehicleId)
          .maybeSingle();
        serviceMileage = row?.total_mileage ?? 0;
      }

      if (isNaN(serviceMileage) || serviceMileage < 0) {
        return res.status(400).json({ error: "mileage must be a non-negative number" });
      }

      const { error } = await sb
        .from("vehicle_mileage")
        .update({ last_service_mileage: serviceMileage })
        .eq("vehicle_id", vehicleId);

      if (error) throw new Error(`Supabase update failed: ${error.message}`);

      return res.status(200).json({ success: true, vehicleId, last_service_mileage: serviceMileage });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-mileage error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
