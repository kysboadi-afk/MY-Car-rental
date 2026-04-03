// api/v2-mileage.js
// SLYTRANS Fleet Control v2 — Bouncie mileage management endpoint.
//
// POST /api/v2-mileage
// Body: { secret, action, ...params }
//
// Actions:
//   get            — fetch mileage + AI stats for all Bouncie-tracked vehicles
//   sync           — trigger an on-demand Bouncie pull (same as bouncie-sync cron)
//   update_service — record that a vehicle was serviced; resets miles-since-service counter
//                    Body: { vehicleId, mileage? }  (defaults to current odometer)

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles, loadTrackedVehicles, updateVehicleMileage } from "./_bouncie.js";
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
      const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicles")
          .select("vehicle_id, vehicle_name, vehicle_type, mileage, last_synced_at, bouncie_device_id, data")
          .not("bouncie_device_id", "is", null)
          .order("vehicle_id"),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);

      const mileageData = (vehicleRows || [])
        .filter((r) => {
          const type = r.vehicle_type || r.data?.type || "";
          return type !== "slingshot";
        })
        .map((r) => ({
          vehicle_id:           r.vehicle_id,
          vehicle_name:         r.vehicle_name || r.data?.vehicle_name || r.vehicle_id,
          total_mileage:        Number(r.mileage) || 0,
          last_service_mileage: Number(r.data?.last_service_mileage) || 0,
          bouncie_device_id:    r.bouncie_device_id,
          last_synced_at:       r.last_synced_at,
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

      const startedAt = Date.now();
      const [trackedVehicles, bouncieVehicles] = await Promise.all([
        loadTrackedVehicles(sb),
        getBouncieVehicles(sb),
      ]);

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
        if (!tracked) continue;

        try {
          await updateVehicleMileage(
            sb, tracked.vehicle_id, stats.odometer,
            stats.lastUpdated ?? null, Number(tracked.mileage) || 0
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

    // ── UPDATE SERVICE ────────────────────────────────────────────────────────
    if (action === "update_service") {
      const { vehicleId, mileage: serviceMileageParam } = body;
      if (!vehicleId) return res.status(400).json({ error: "vehicleId is required" });

      // Default to current odometer if no override provided
      let serviceMileage;
      if (serviceMileageParam !== undefined && serviceMileageParam !== null) {
        serviceMileage = Number(serviceMileageParam);
        if (isNaN(serviceMileage) || serviceMileage < 0) {
          return res.status(400).json({ error: "mileage must be a non-negative number" });
        }
      } else {
        const { data: row } = await sb
          .from("vehicles")
          .select("mileage")
          .eq("vehicle_id", vehicleId)
          .maybeSingle();
        serviceMileage = Number(row?.mileage) || 0;
      }

      // Store last_service_mileage inside the data JSONB (no separate column needed)
      const { data: existing } = await sb
        .from("vehicles")
        .select("data")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();

      if (!existing) return res.status(404).json({ error: `Vehicle "${vehicleId}" not found` });

      const updatedData = { ...(existing.data || {}), last_service_mileage: serviceMileage };
      const { error } = await sb
        .from("vehicles")
        .update({ data: updatedData, updated_at: new Date().toISOString() })
        .eq("vehicle_id", vehicleId);

      if (error) throw new Error(`Supabase update failed: ${error.message}`);

      return res.status(200).json({
        success:              true,
        vehicleId,
        last_service_mileage: serviceMileage,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-mileage error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

//
// POST /api/v2-mileage
// Body: { secret, action, ...params }
//
// Actions:
//   get            — fetch mileage + trip stats for all vehicles
//   sync           — trigger an on-demand Bouncie pull (same logic as bouncie-sync cron)
//   update_service — record that a vehicle was serviced at its current mileage
