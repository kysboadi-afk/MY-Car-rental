// api/v2-vehicles.js
// SLYTRANS FLEET CONTROL v2 — Vehicles CRUD endpoint.
// Supports listing, creating, and updating vehicle data stored in Supabase.
//
// GET  /api/v2-vehicles
//   Returns an array of vehicle objects: [{ vehicle_id, ...data }, ...]
//   cover_image paths are normalized to root-relative form (/images/...)
//
// POST /api/v2-vehicles
// Actions:
//   list   — { secret, action:"list" }
//   create — { secret, action:"create", vehicleId, vehicleName, type?, vehicleYear?, purchasePrice?, purchaseDate?, status? }
//   update — { secret, action:"update", vehicleId, updates:{...} }

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS       = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_STATUSES      = ["active", "maintenance", "inactive"];
const ALLOWED_TYPES         = ["slingshot", "economy", "luxury", "suv", "truck", "van", "other"];
const MAX_VEHICLE_NAME_LEN  = 200;
// ISO 8601 date strings are at most 10 chars (YYYY-MM-DD); allow 20 to be safe.
const MAX_PURCHASE_DATE_LEN = 20;

// vehicleId must be 2–50 lowercase letters, digits, hyphens, or underscores.
const VEHICLE_ID_RE = /^[a-z0-9_-]{2,50}$/;

// Normalize cover_image paths to root-relative form so browsers can resolve
// them correctly regardless of the page's location in the site hierarchy.
// e.g. "../images/car2.jpg" → "/images/car2.jpg"
//      "images/car2.jpg"    → "/images/car2.jpg"
//      "/images/car2.jpg"   → "/images/car2.jpg"  (unchanged)
//      "https://..."        → "https://..."        (unchanged)
function normalizeCoverImage(val) {
  if (!val || typeof val !== "string") return val;
  if (val.startsWith("http://") || val.startsWith("https://") || val.startsWith("/")) return val;
  // Strip any leading "../" segments then prepend "/"
  return "/" + val.replace(/^(\.\.\/)+/, "");
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── GET — public listing (no secret required) ──────────────────────────────
  if (req.method === "GET") {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return res.status(500).json({ error: "Server configuration error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set." });
    }
    try {
      const { data: rows, error } = await supabase
        .from("vehicles")
        .select("vehicle_id, data");
      if (error) throw new Error(`Supabase select failed: ${error.message}`);

      const vehicles = (rows || []).map((row) => {
        const obj = { vehicle_id: row.vehicle_id, ...(row.data || {}) };
        if (obj.cover_image) obj.cover_image = normalizeCoverImage(obj.cover_image);
        return obj;
      });
      return res.status(200).json(vehicles);
    } catch (err) {
      console.error("v2-vehicles GET error:", err);
      return res.status(500).json({ error: err.message || "An unexpected error occurred." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).send("Method Not Allowed");
  }

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

      if (!vehicleId || !VEHICLE_ID_RE.test(vehicleId)) {
        return res.status(400).json({ error: "Invalid or missing vehicleId" });
      }
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "updates object is required" });
      }

      // Validate and build safe updates
      const safeUpdates = {};
      const allowedUpdateFields = [
        "purchase_price", "purchase_date", "status",
        "vehicle_name", "vehicle_year", "type", "cover_image",
      ];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          const val = updates[f];
          if (f === "status" && !ALLOWED_STATUSES.includes(val)) {
            return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` });
          }
          if (f === "type" && val && !ALLOWED_TYPES.includes(val)) {
            return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(", ")}` });
          }
          if (f === "purchase_price" || f === "vehicle_year") {
            const n = Number(val);
            if (isNaN(n) || n < 0) {
              return res.status(400).json({ error: `${f} must be a non-negative number` });
            }
            safeUpdates[f] = Math.round(n * 100) / 100;
          } else if (f === "cover_image") {
            // Allow URLs, root-relative paths, or empty string
            safeUpdates[f] = typeof val === "string" ? val.trim().slice(0, 500) : "";
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

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === "create") {
      const { vehicleId, vehicleName, type, vehicleYear, purchasePrice, purchaseDate, status, coverImage } = body;

      if (!vehicleId || !VEHICLE_ID_RE.test(vehicleId)) {
        return res.status(400).json({ error: "vehicleId must be 2–50 lowercase letters, digits, hyphens, or underscores" });
      }
      if (!vehicleName || typeof vehicleName !== "string" || !vehicleName.trim()) {
        return res.status(400).json({ error: "vehicleName is required" });
      }

      const vehicleType = type || "economy";
      if (!ALLOWED_TYPES.includes(vehicleType)) {
        return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(", ")}` });
      }

      const vehicleStatus = status || "active";
      if (!ALLOWED_STATUSES.includes(vehicleStatus)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` });
      }

      // Validate vehicleYear if provided
      if (vehicleYear !== undefined && vehicleYear !== null && vehicleYear !== "") {
        const yearNum = Number(vehicleYear);
        if (isNaN(yearNum) || yearNum < 0) {
          return res.status(400).json({ error: "vehicle_year must be a non-negative number" });
        }
      }

      // Validate purchasePrice if provided
      if (purchasePrice !== undefined && purchasePrice !== null && purchasePrice !== "") {
        const priceNum = Number(purchasePrice);
        if (isNaN(priceNum) || priceNum < 0) {
          return res.status(400).json({ error: "purchase_price must be a non-negative number" });
        }
      }

      // Check the vehicle doesn't already exist
      const { data: existing, error: fetchErr } = await supabase
        .from("vehicles")
        .select("vehicle_id")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();

      if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
      if (existing) {
        return res.status(409).json({ error: `Vehicle "${vehicleId}" already exists` });
      }

      // Build the new vehicle data object
      const newData = {
        vehicle_id:     vehicleId,
        vehicle_name:   vehicleName.trim().slice(0, MAX_VEHICLE_NAME_LEN),
        type:           vehicleType,
        vehicle_year:   vehicleYear ? Math.round(Number(vehicleYear)) : null,
        purchase_price: purchasePrice ? Math.round(parseFloat(purchasePrice) * 100) / 100 : 0,
        purchase_date:  (purchaseDate && typeof purchaseDate === "string") ? purchaseDate.slice(0, MAX_PURCHASE_DATE_LEN) : "",
        status:         vehicleStatus,
        cover_image:    typeof coverImage === "string" ? coverImage.trim().slice(0, 500) : "",
      };

      const { data: inserted, error: insertErr } = await supabase
        .from("vehicles")
        .insert({ vehicle_id: vehicleId, data: newData, updated_at: new Date().toISOString() })
        .select("data")
        .single();

      if (insertErr) throw new Error(`Supabase insert failed: ${insertErr.message}`);

      return res.status(201).json({ success: true, vehicle: inserted.data });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-vehicles error:", err);
    return res.status(500).json({ error: err.message || "An unexpected error occurred." });
  }
}
