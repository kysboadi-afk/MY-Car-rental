// api/admin-update-pricing.js
// Admin endpoint — read and update per-vehicle pricing in the vehicle_pricing table.
//
// POST /api/admin-update-pricing
// Body variants:
//   { secret, action: "get" }
//     → returns all vehicle_pricing rows
//
//   { secret, action: "update", vehicle_id, daily_price, weekly_price, biweekly_price, monthly_price }
//     → updates the named row; all four price fields are required positive numbers

import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadVehicles } from "./_vehicles.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const PRICE_FIELDS = ["daily_price", "weekly_price", "biweekly_price", "monthly_price"];
const VALID_SCOPES = new Set(["car", "cars", "slingshot"]);

// Pricing tiers that are not required — if omitted or left empty they are stored
// as null, meaning getVehiclePricing falls through to daily × days for those
// rental lengths.  daily_price is always required.
const OPTIONAL_PRICE_FIELDS = new Set(["biweekly_price", "monthly_price"]);

function normalizeScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  return VALID_SCOPES.has(value) ? value : null;
}

function deriveCategory(vehicle = {}, fallbackVehicleId = "") {
  const explicit = String(vehicle.category || "").trim().toLowerCase();
  if (explicit === "car" || explicit === "slingshot") return explicit;
  const type = String(vehicle.type || vehicle.vehicle_type || "").toLowerCase();
  const id = String(vehicle.vehicle_id || fallbackVehicleId || "").toLowerCase();
  const name = String(vehicle.vehicle_name || vehicle.name || "").toLowerCase();
  if (type === "slingshot" || id.includes("slingshot") || name.includes("slingshot")) return "slingshot";
  return "car";
}

async function loadScopedVehicleIds(sb, scope) {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope) return null;
  const wantSlingshots = normalizedScope === "slingshot";
  const scopedIds = new Set();

  try {
    const { data, error } = await sb.from("vehicles").select("vehicle_id, data");
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const vehicle = { vehicle_id: row.vehicle_id, ...(row.data || {}) };
        const category = deriveCategory(vehicle, row.vehicle_id);
        if ((wantSlingshots && category === "slingshot") || (!wantSlingshots && category === "car")) {
          scopedIds.add(row.vehicle_id);
        }
      }
    }
  } catch {
    // fall through to JSON fallback
  }

  if (scopedIds.size > 0) return scopedIds;

  try {
    const { data: vehicles } = await loadVehicles();
    for (const [vehicleId, vehicle] of Object.entries(vehicles || {})) {
      const category = deriveCategory(vehicle, vehicleId);
      if ((wantSlingshots && category === "slingshot") || (!wantSlingshots && category === "car")) {
        scopedIds.add(vehicleId);
      }
    }
  } catch {
    // ignore fallback failure
  }

  return scopedIds;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable." });
  }

  const { action, scope = null } = body;

  // ── action: get ────────────────────────────────────────────────────────────
  if (action === "get") {
    const scopedVehicleIds = await loadScopedVehicleIds(sb, scope);
    const { data, error } = await sb
      .from("vehicle_pricing")
      .select("vehicle_id, daily_price, weekly_price, biweekly_price, monthly_price, updated_at")
      .order("vehicle_id");

    if (error) {
      console.error("[admin-update-pricing] get error:", error);
      return res.status(500).json({ error: "Failed to load pricing." });
    }
    const pricing = scopedVehicleIds
      ? (data || []).filter((row) => scopedVehicleIds.has(row.vehicle_id))
      : (data || []);
    return res.status(200).json({ pricing });
  }

  // ── action: update ─────────────────────────────────────────────────────────
  if (action === "update") {
    const { vehicle_id } = body;
    const scopedVehicleIds = await loadScopedVehicleIds(sb, scope);

    if (!vehicle_id || typeof vehicle_id !== "string" || !vehicle_id.trim()) {
      return res.status(400).json({ error: "vehicle_id is required." });
    }
    if (scopedVehicleIds && !scopedVehicleIds.has(vehicle_id.trim())) {
      return res.status(400).json({ error: `Vehicle "${vehicle_id.trim()}" is not available in this pricing workspace.` });
    }

    const patch = {};
    for (const field of PRICE_FIELDS) {
      const raw = body[field];
      // biweekly_price and monthly_price are optional — null/empty/0 means "not offered"
      // (falls through to daily × days in computeAmountFromPricing).
      if (OPTIONAL_PRICE_FIELDS.has(field) && (raw === undefined || raw === null || raw === "" || Number(raw) === 0)) {
        patch[field] = null;
        continue;
      }
      if (raw === undefined || raw === null || raw === "") {
        return res.status(400).json({ error: `${field} is required.` });
      }
      const val = Number(raw);
      // Required fields must be positive (> 0); $0 would cause a $0 payment intent.
      // Optional fields reaching this point have a non-empty, non-zero value — validate
      // it is a positive number (leave empty to clear an optional rate instead of using $0).
      const errorMsg = OPTIONAL_PRICE_FIELDS.has(field)
        ? `${field} must be a positive number greater than $0, or left empty to remove this rate.`
        : `${field} must be a positive number greater than $0.`;
      if (isNaN(val) || val <= 0) {
        return res.status(400).json({ error: errorMsg });
      }
      patch[field] = val;
    }
    patch.updated_at = new Date().toISOString();

    const { error } = await sb
      .from("vehicle_pricing")
      .upsert({ vehicle_id: vehicle_id.trim(), ...patch }, { onConflict: "vehicle_id" });

    if (error) {
      console.error("[admin-update-pricing] update error:", error);
      return res.status(500).json({ error: "Failed to save pricing." });
    }

    console.log("[admin-update-pricing] updated", vehicle_id, patch);
    return res.status(200).json({ ok: true, vehicle_id: vehicle_id.trim(), updated: patch });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
