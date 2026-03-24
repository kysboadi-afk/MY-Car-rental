// api/v2-vehicles.js
// SLYTRANS FLEET CONTROL v2 — Vehicles CRUD endpoint.
// Supports listing and updating vehicle data.
//
// POST /api/v2-vehicles
// Actions:
//   list   — { secret, action:"list" }
//   update — { secret, action:"update", vehicleId, updates:{...} }

import { loadVehicles, saveVehicles } from "./_vehicles.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = ["slingshot", "slingshot2", "camry", "camry2013"];
const ALLOWED_STATUSES = ["active", "maintenance", "inactive"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body   = req.body || {};
  const { secret, action } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (action === "list" || !action) {
      const { data } = await loadVehicles();
      return res.status(200).json({ vehicles: data });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      const { vehicleId, updates } = body;

      if (!vehicleId || !ALLOWED_VEHICLES.includes(vehicleId)) {
        return res.status(400).json({ error: "Invalid or missing vehicleId" });
      }
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "updates object is required" });
      }
      if (!process.env.GITHUB_TOKEN) {
        return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
      }

      const { data, sha } = await loadVehicles();
      if (!data[vehicleId]) {
        return res.status(404).json({ error: "Vehicle not found" });
      }

      // Only allow safe fields to be updated
      const safeUpdates = {};
      const allowedUpdateFields = [
        "purchase_price", "purchase_date", "status",
        "vehicle_name", "vehicle_year", "type",
      ];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          const val = updates[f];
          if (f === "status" && !ALLOWED_STATUSES.includes(val)) {
            return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` });
          }
          if (f === "purchase_price" || f === "vehicle_year") {
            const n = Number(val);
            if (isNaN(n) || n < 0) {
              return res.status(400).json({ error: `${f} must be a non-negative number` });
            }
            safeUpdates[f] = Math.round(n * 100) / 100;
          } else {
            safeUpdates[f] = typeof val === "string" ? val.trim().slice(0, 200) : val;
          }
        }
      }

      data[vehicleId] = { ...data[vehicleId], ...safeUpdates };
      await saveVehicles(data, sha, `v2: Update vehicle ${vehicleId}: ${JSON.stringify(Object.keys(safeUpdates))}`);

      return res.status(200).json({ success: true, vehicle: data[vehicleId] });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-vehicles error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
