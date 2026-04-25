// api/update-maintenance-status.js
// Fleet maintenance status cron endpoint.
//
// GET  /api/update-maintenance-status  — Vercel cron trigger (no auth required from Vercel)
// POST /api/update-maintenance-status  — Manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// What it does:
//   1. Loads all vehicles (is_tracked = true or bouncie_device_id set)
//   2. For each vehicle, computes OK / DUE_SOON / OVERDUE status using
//      lib/ai/maintenance.js (general interval-based check)
//   3. Upserts a row in the maintenance table (migration 0029) for each vehicle
//   4. On OVERDUE: sets vehicle.action_status = "pending" so the admin AI
//      priority-alerts system surfaces it
//   5. Returns structured alerts for admin / AI consumption
//
// Configured as a Vercel cron job at vercel.json: { "crons": [{ "path": "/api/update-maintenance-status", "schedule": "*/10 * * * *" }] }

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { computeMaintenanceStatus, computeFleetAlerts } from "../lib/ai/maintenance.js";

const CRON_SECRET  = process.env.CRON_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

/**
 * Verify that a POST request carries a valid Bearer token.
 */
function isAuthorized(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (ADMIN_SECRET && token === ADMIN_SECRET) return true;
  if (CRON_SECRET  && token === CRON_SECRET)  return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Allow Vercel cron (GET) without auth; require auth for POST manual trigger
  if (req.method === "POST" && !isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Database not configured — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set." });
  }

  // ── 1. Load all tracked vehicles ──────────────────────────────────────────
  let vehicleRows;
  try {
    const { data, error } = await sb
      .from("vehicles")
      .select("vehicle_id, data, mileage, maintenance_interval, is_tracked, bouncie_device_id, action_status, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage");

    if (error) throw new Error(`vehicles query failed: ${error.message}`);
    vehicleRows = data || [];
  } catch (err) {
    console.error("update-maintenance-status: vehicles query error:", err.message);
    return res.status(500).json({ error: adminErrorMessage(err), details: err.message });
  }

  // Filter to vehicles that should be monitored
  const trackedVehicles = vehicleRows.filter((v) => v.is_tracked || v.bouncie_device_id != null);

  if (trackedVehicles.length === 0) {
    return res.status(200).json({
      processed: 0,
      alerts:    [],
      overdue:   0,
      due_soon:  0,
      ok:        0,
      note:      "No tracked vehicles found. Set is_tracked = true on vehicles to enable monitoring.",
    });
  }

  // Enrich vehicle rows with last_service_mileage from JSONB data blob
  const enriched = trackedVehicles.map((v) => ({
    ...v,
    vehicle_name:        v.data?.vehicle_name || v.data?.name || v.vehicle_id,
    last_service_mileage: v.data?.last_service_mileage ?? null,
  }));

  // ── 2. Compute fleet status ────────────────────────────────────────────────
  const { results, alerts, overdue, due_soon, ok } = computeFleetAlerts(enriched);

  // ── 3. Upsert maintenance rows + update vehicle action_status ──────────────
  const now    = new Date().toISOString();
  const errors = [];

  for (const result of results) {
    const { vehicle_id, status, miles_since_service, interval, miles_until_service } = result;

    // Map to the maintenance table status values (migration 0029)
    const dbStatus = status === "OVERDUE"   ? "overdue"
                   : status === "DUE_SOON"  ? "pending"
                   :                          "completed"; // OK means last service is still within interval

    // Upsert into maintenance table: one row per vehicle_id + service_type="general"
    try {
      const { error: upsertErr } = await sb
        .from("maintenance")
        .upsert(
          {
            vehicle_id,
            service_type: "general",
            status:       dbStatus,
            notes:        `Auto-computed: ${miles_since_service} mi since last service. Interval: ${interval} mi. Miles until next service: ${miles_until_service}.`,
            updated_at:   now,
          },
          { onConflict: "vehicle_id,service_type" }
        );
      if (upsertErr) {
        console.error(`update-maintenance-status: upsert failed for ${vehicle_id}:`, upsertErr.message);
        errors.push({ vehicle_id, error: upsertErr.message });
      }
    } catch (err) {
      console.error(`update-maintenance-status: upsert threw for ${vehicle_id}:`, err.message);
      errors.push({ vehicle_id, error: err.message });
    }

    // ── 4. Set action_status = "pending" when OVERDUE (so AI priority alerts fire) ──
    if (status === "OVERDUE") {
      const vehicle = enriched.find((v) => v.vehicle_id === vehicle_id);
      const currentActionStatus = vehicle?.action_status;
      // Only escalate if not already pending/in_progress (avoid overwriting active work)
      if (!currentActionStatus || currentActionStatus === "resolved") {
        try {
          const { error: updateErr } = await sb
            .from("vehicles")
            .update({ action_status: "pending", updated_at: now })
            .eq("vehicle_id", vehicle_id);
          if (updateErr) {
            console.error(`update-maintenance-status: action_status update failed for ${vehicle_id}:`, updateErr.message);
          }
        } catch (err) {
          console.error(`update-maintenance-status: action_status update threw for ${vehicle_id}:`, err.message);
        }
      }
    }
  }

  return res.status(200).json({
    processed: results.length,
    alerts,
    overdue,
    due_soon,
    ok,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

/**
 * Exported helper — can be called by other API functions (e.g. after booking completion).
 * Non-fatal: logs errors but never throws.
 *
 * @param {string} vehicleId - optional: update only this vehicle. If omitted, updates all.
 * @returns {Promise<void>}
 */
export async function triggerMaintenanceUpdate(vehicleId) {
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    let query = sb
      .from("vehicles")
      .select("vehicle_id, data, mileage, maintenance_interval, is_tracked, bouncie_device_id, action_status");

    if (vehicleId) {
      query = query.eq("vehicle_id", vehicleId);
    } else {
      query = query.or("is_tracked.eq.true,bouncie_device_id.not.is.null");
    }

    const { data, error } = await query;
    if (error) {
      console.error("triggerMaintenanceUpdate: vehicles query error:", error.message);
      return;
    }

    const rows = (data || []).map((v) => ({
      ...v,
      last_service_mileage: v.data?.last_service_mileage ?? null,
    }));

    const now = new Date().toISOString();

    for (const v of rows) {
      const computed = computeMaintenanceStatus(v);
      const dbStatus = computed.status === "OVERDUE"  ? "overdue"
                     : computed.status === "DUE_SOON" ? "pending"
                     :                                  "completed";

      // Non-fatal upserts
      sb.from("maintenance")
        .upsert(
          {
            vehicle_id:   v.vehicle_id,
            service_type: "general",
            status:       dbStatus,
            notes:        `Auto-computed: ${computed.miles_since_service} mi since last service. Interval: ${v.maintenance_interval || 5000} mi.`,
            updated_at:   now,
          },
          { onConflict: "vehicle_id,service_type" }
        )
        .then(() => {})
        .catch((err) => console.warn("triggerMaintenanceUpdate: upsert failed:", err.message));

      if (computed.status === "OVERDUE" && (!v.action_status || v.action_status === "resolved")) {
        sb.from("vehicles")
          .update({ action_status: "pending", updated_at: now })
          .eq("vehicle_id", v.vehicle_id)
          .then(() => {})
          .catch((err) => console.warn("triggerMaintenanceUpdate: action_status update failed:", err.message));
      }
    }
  } catch (err) {
    console.error("triggerMaintenanceUpdate: unexpected error:", err.message);
  }
}
