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

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const PRICE_FIELDS = ["daily_price", "weekly_price", "biweekly_price", "monthly_price"];

// Pricing tiers that are not required — if omitted or left empty they are stored
// as null, meaning getVehiclePricing falls through to daily × days for those
// rental lengths.  daily_price is always required.
const OPTIONAL_PRICE_FIELDS = new Set(["biweekly_price", "monthly_price"]);

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

  const { action } = body;

  // ── action: get ────────────────────────────────────────────────────────────
  if (action === "get") {
    const { data, error } = await sb
      .from("vehicle_pricing")
      .select("vehicle_id, daily_price, weekly_price, biweekly_price, monthly_price, updated_at")
      .order("vehicle_id");

    if (error) {
      console.error("[admin-update-pricing] get error:", error);
      return res.status(500).json({ error: "Failed to load pricing." });
    }
    return res.status(200).json({ pricing: data || [] });
  }

  // ── action: update ─────────────────────────────────────────────────────────
  if (action === "update") {
    const { vehicle_id } = body;

    if (!vehicle_id || typeof vehicle_id !== "string" || !vehicle_id.trim()) {
      return res.status(400).json({ error: "vehicle_id is required." });
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
      if (isNaN(val) || val <= 0) {
        return res.status(400).json({ error: `${field} must be a positive number greater than $0.` });
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
