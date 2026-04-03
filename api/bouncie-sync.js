// api/bouncie-sync.js
// Bouncie GPS sync — Vercel Cron job (every 5 minutes).
//
// Pulls the latest odometer readings from the Bouncie REST API and upserts
// them into the vehicle_mileage Supabase table.  After each sync it runs the
// mileage analysis engine and logs any maintenance/high-usage alerts to ai_logs.
//
// GET  — called by Vercel Cron (trusted by Vercel's internal network)
// POST — manual trigger; requires: Authorization: Bearer <CRON_SECRET|ADMIN_SECRET>
//
// Required env vars:
//   BOUNCIE_ACCESS_TOKEN  — Bouncie OAuth access token
//   BOUNCIE_DEVICE_MAP    — JSON {"<imei>":"<vehicle_id>", ...}  (optional if nicknames match)
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

import { getBouncieVehicles, parseDeviceMap, resolveVehicleId, upsertMileage } from "./_bouncie.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Manual POST requires Bearer auth
  if (req.method === "POST") {
    const auth        = req.headers.authorization || "";
    const cronSecret  = process.env.CRON_SECRET;
    const adminSecret = process.env.ADMIN_SECRET;
    const ok = (cronSecret  && auth === `Bearer ${cronSecret}`) ||
               (adminSecret && auth === `Bearer ${adminSecret}`);
    if (!ok) return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Silently skip when not configured — avoids noisy cron errors
  if (!process.env.BOUNCIE_ACCESS_TOKEN) {
    return res.status(200).json({ skipped: true, reason: "BOUNCIE_ACCESS_TOKEN not configured" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({ skipped: true, reason: "Supabase not configured" });
  }

  const startedAt = Date.now();
  const deviceMap  = parseDeviceMap();
  const synced     = [];
  const errors     = [];

  try {
    const bouncieVehicles = await getBouncieVehicles();

    for (const bv of bouncieVehicles) {
      const { imei, nickName, stats } = bv;
      if (!imei || !stats) continue;

      const odometer    = stats.odometer   ?? null;
      const lastUpdated = stats.lastUpdated ?? null;
      if (odometer === null) continue;

      const vehicleId = resolveVehicleId(imei, nickName, deviceMap);
      if (!vehicleId) {
        errors.push(`IMEI ${imei} (${nickName || "unnamed"}): no vehicle mapping — add to BOUNCIE_DEVICE_MAP`);
        continue;
      }

      try {
        await upsertMileage(sb, vehicleId, imei, odometer, lastUpdated);
        synced.push({ vehicleId, imei, odometer, lastUpdated });
      } catch (err) {
        errors.push(`${vehicleId}: ${err.message}`);
      }
    }

    // ── Post-sync: mileage analysis → log any alerts ─────────────────────
    if (synced.length > 0) {
      const [{ data: mileageRows }, { data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicle_mileage").select("vehicle_id, total_mileage, last_service_mileage, last_trip_at, last_synced_at"),
        sb.from("vehicles").select("vehicle_id, data"),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);

      const vehicleNames = {};
      for (const row of vehicleRows || []) {
        vehicleNames[row.vehicle_id] = row.data?.vehicle_name || row.vehicle_id;
      }

      const mileageData = (mileageRows || []).map((row) => ({
        ...row,
        vehicle_name: vehicleNames[row.vehicle_id] || row.vehicle_id,
      }));

      const { alerts } = analyzeMileage(mileageData, tripRows || []);

      if (alerts.length > 0) {
        await sb.from("ai_logs").insert({
          action:   "mileage_alert",
          input:    { synced_vehicles: synced.map((s) => s.vehicleId) },
          output:   { alerts },
          admin_id: "bouncie-cron",
        }).catch((err) => console.warn("bouncie-sync: ai_logs insert failed:", err.message));
      }
    }

    return res.status(200).json({
      ran_at:       new Date().toISOString(),
      duration_ms:  Date.now() - startedAt,
      synced_count: synced.length,
      synced,
      errors,
    });
  } catch (err) {
    console.error("bouncie-sync error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
