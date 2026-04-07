// api/bouncie-sync.js
// Bouncie GPS sync — Vercel Cron job (every 5 minutes).
//
// Pulls the latest odometer readings from the Bouncie REST API and writes them
// into the vehicles table (mileage + last_synced_at columns).
//
// Only vehicles with bouncie_device_id set are synced.
// Slingshots are never synced — the _bouncie helper filters them out.
// The stored mileage is always overwritten with Bouncie's latest value so that
// any stale or inflated DB reading is corrected on the next sync cycle.
//
// GET  — called by Vercel Cron (trusted by Vercel's internal network)
// POST — manual trigger: Authorization: Bearer <CRON_SECRET|ADMIN_SECRET>
//
// Required env vars:
//   BOUNCIE_CLIENT_ID, BOUNCIE_CLIENT_SECRET — for automatic token refresh
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

import { getBouncieVehicles, loadTrackedVehicles, updateVehicleMileage, loadBouncieToken } from "./_bouncie.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Maximum retries when Bouncie API returns a transient error
const MAX_RETRIES = 2;

async function fetchWithRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

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

  // Silently skip when Supabase is not configured — we need the DB to map IMEIs to vehicles.
  // A Bouncie token must also be available (env var or app_config) for the API call to succeed.
  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({ skipped: true, reason: "Supabase not configured — cannot sync without DB access" });
  }
  const bouncieToken = await loadBouncieToken(sb);
  if (!bouncieToken) {
    return res.status(200).json({ skipped: true, reason: "Bouncie token not configured — please complete the OAuth flow at /api/bouncie-oauth to connect your Bouncie account" });
  }

  const startedAt = Date.now();
  const synced    = [];
  const errors    = [];

  try {
    // ── 1. Load our tracked vehicles and Bouncie vehicles in parallel ────────
    const [trackedVehicles, bouncieVehicles] = await Promise.all([
      loadTrackedVehicles(sb),
      fetchWithRetry(() => getBouncieVehicles(sb)),
    ]);

    // Build a map: IMEI → tracked vehicle row
    const imeiMap = {};
    for (const v of trackedVehicles) {
      if (v.bouncie_device_id) imeiMap[v.bouncie_device_id] = v;
    }

    // ── 2. For each Bouncie vehicle, find and update the matching DB row ─────
    for (const bv of bouncieVehicles) {
      const { imei, stats } = bv;
      if (!imei || !stats?.odometer) continue;

      const tracked = imeiMap[imei];
      if (!tracked) continue; // no DB vehicle mapped to this IMEI

      try {
        const advanced = await updateVehicleMileage(
          sb,
          tracked.vehicle_id,
          stats.odometer,
          stats.lastUpdated || null
        );
        synced.push({
          vehicleId:    tracked.vehicle_id,
          imei,
          odometer:     stats.odometer,
          lastUpdated:  stats.lastUpdated,
          advanced,
        });
      } catch (err) {
        errors.push(`${tracked.vehicle_id}: ${err.message}`);
        console.error(`bouncie-sync: update failed for ${tracked.vehicle_id}:`, err.message);
      }
    }

    // ── 3. Post-sync: run AI mileage analysis and log any alerts ─────────────
    if (synced.length > 0) {
      try {
        const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
          sb.from("vehicles")
            .select("vehicle_id, mileage, last_synced_at, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
            .not("bouncie_device_id", "is", null),
          sb.from("trip_log")
            .select("vehicle_id, trip_distance, trip_at")
            .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
        ]);

        const mileageData = (vehicleRows || [])
          .filter((r) => {
            const type = r.data?.type || r.data?.vehicle_type || "";
            return type !== "slingshot";
          })
          .map((r) => ({
            vehicle_id:               r.vehicle_id,
            vehicle_name:             r.data?.vehicle_name || r.vehicle_id,
            total_mileage:            Number(r.mileage) || 0,
            last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
            last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
            last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
            last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
            last_synced_at:           r.last_synced_at,
          }));

        const { alerts } = analyzeMileage(mileageData, tripRows || []);

        if (alerts.length > 0) {
          await sb.from("ai_logs").insert({
            action:   "mileage_alert",
            input:    { synced_vehicles: synced.map((s) => s.vehicleId) },
            output:   { alerts },
            admin_id: "bouncie-cron",
          });
        }
      } catch (err) {
        console.warn("bouncie-sync: post-sync analysis failed:", err.message);
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

//
// Pulls the latest odometer readings from the Bouncie REST API and upserts
// them into the vehicle_mileage Supabase table.  After each sync it runs the
// mileage analysis engine and logs any maintenance/high-usage alerts to ai_logs.
//
// GET  — called by Vercel Cron (trusted by Vercel's internal network)
// POST — manual trigger; requires: Authorization: Bearer <CRON_SECRET|ADMIN_SECRET>
//
// Required env vars:
//   BOUNCIE_CLIENT_ID, BOUNCIE_CLIENT_SECRET — for automatic token refresh
//   BOUNCIE_DEVICE_MAP    — JSON {"<imei>":"<vehicle_id>", ...}  (optional if nicknames match)
