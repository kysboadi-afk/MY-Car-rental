// api/v2-vehicles.js
// SLYTRANS FLEET CONTROL v2 — Vehicles CRUD endpoint.
// Supports listing and updating vehicle data stored in Supabase.
//
// POST /api/v2-vehicles
// Actions:
//   list   — { secret, action:"list" }
//   update — { secret, action:"update", vehicleId, updates:{...} }

import { getSupabaseAdmin } from "./_supabase.js";

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

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).json({ error: "Server configuration error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set." });
  }

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (action === "list" || !action) {
      const { data: rows, error } = await supabase
        .from("vehicles")
        .select("vehicle_id, data");

      if (error) throw new Error(`Supabase select failed: ${error.message}`);

      const vehicles = {};
      for (const row of rows || []) {
        vehicles[row.vehicle_id] = row.data;
      }
      return res.status(200).json({ vehicles });
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

      // Validate and build safe updates
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

      // Fetch existing row
      const { data: existing, error: fetchErr } = await supabase
        .from("vehicles")
        .select("data")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();

      if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
      if (!existing) {
        return res.status(404).json({ error: "Vehicle not found" });
      }

      // Merge safe updates into existing data and upsert atomically
      const updatedData = { ...existing.data, ...safeUpdates };
      const { data: upserted, error: upsertErr } = await supabase
        .from("vehicles")
        .upsert(
          { vehicle_id: vehicleId, data: updatedData, updated_at: new Date().toISOString() },
          { onConflict: "vehicle_id" }
        )
        .select("data")
        .single();

      if (upsertErr) throw new Error(`Supabase upsert failed: ${upsertErr.message}`);

      return res.status(200).json({ success: true, vehicle: upserted.data });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-vehicles error:", err);
    return res.status(500).json({ error: err.message || "An unexpected error occurred." });
  }
}
