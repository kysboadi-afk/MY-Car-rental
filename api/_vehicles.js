// api/_vehicles.js
// Helper module for reading and writing vehicles.json on GitHub.
//
// vehicles.json stores metadata about each vehicle in the fleet:
// purchase date, purchase price, operational status, etc.
//
// Schema:
// {
//   "<vehicleId>": {
//     vehicle_id:     string,
//     vehicle_name:   string,
//     type:           "economy",
//     vehicle_year:   number | null  (model year, e.g. 2021),
//     purchase_date:  string  (YYYY-MM-DD or ""),
//     purchase_price: number  (dollars),
//     status:         "active" | "maintenance" | "inactive",
//   }
// }

import { CARS } from "./_pricing.js";
import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const VEHICLES_PATH      = "vehicles.json";

const EMPTY_VEHICLES = {
  camry:      { vehicle_id: "camry",      vehicle_name: "Camry 2012",    type: "economy",   vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
  camry2013:  { vehicle_id: "camry2013",  vehicle_name: "Camry 2013 SE", type: "economy",   vehicle_year: null, purchase_date: "", purchase_price: 0, status: "active" },
};

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Load vehicles.json from the GitHub repo.
 * @returns {Promise<{ data: object, sha: string|null }>}
 */
export async function loadVehicles() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${VEHICLES_PATH}`;
  const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });

  if (!resp.ok) {
    if (resp.status === 404) {
      return { data: { ...EMPTY_VEHICLES }, sha: null };
    }
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET vehicles.json failed: ${resp.status} ${text}`);
  }

  const file = await resp.json();
  let data;
  try {
    data = JSON.parse(
      Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8")
    );
  } catch {
    data = { ...EMPTY_VEHICLES };
  }

  // Backfill any missing vehicle keys
  for (const [key, defaults] of Object.entries(EMPTY_VEHICLES)) {
    if (!data[key]) data[key] = { ...defaults };
  }

  return { data, sha: file.sha };
}

/**
 * Save vehicles.json back to the GitHub repo.
 * @param {object} data
 * @param {string|null} sha
 * @param {string} message
 */
export async function saveVehicles(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("_vehicles: GITHUB_TOKEN not set — vehicles.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${VEHICLES_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content, branch: GITHUB_DATA_BRANCH };
  if (sha) body.sha = sha;

  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT vehicles.json failed: ${resp.status} ${text}`);
  }
}

/**
 * Normalize raw vehicle storage data into a consistent shape used by all
 * booking endpoints.  This is the single place where field aliases (daily_rate
 * vs pricePerDay, vehicle_name vs name, type vs vehicle_type) are resolved.
 *
 * @param {string} vehicleId
 * @param {object} vdata - raw vehicle data from CARS, Supabase, or vehicles.json
 * @returns {{ vehicleId, name, type, hourlyTiers, pricePerDay, weekly, biweekly, monthly, deposit }}
 */
function normalizeVehicleData(vehicleId, vdata) {
  const type = (vdata.type || vdata.vehicle_type || "car").toLowerCase();
  const hourlyTiers = vdata.hourlyTiers || null;
  const toNum = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
  return {
    vehicleId,
    name:        vdata.vehicle_name || vdata.name || vehicleId,
    type,
    hourlyTiers,
    pricePerDay: toNum(vdata.daily_price  ?? vdata.daily_rate  ?? vdata.pricePerDay),
    weekly:      toNum(vdata.weekly_price ?? vdata.weekly      ?? vdata.weekly_rate),
    biweekly:    toNum(vdata.biweekly_price ?? vdata.biweekly  ?? vdata.biweekly_rate),
    monthly:     toNum(vdata.monthly_price  ?? vdata.monthly   ?? vdata.monthly_rate),
    deposit:     toNum(vdata.deposit),
  };
}

/**
 * Look up a single vehicle by ID, returning a normalized vehicle data object.
 *
 * Resolution order (first match wins):
 *   1. Static CARS list in _pricing.js (fastest — no I/O for known vehicles)
 *   2. Supabase vehicles table (live database for admin-created vehicles)
 *   3. vehicles.json on GitHub (fallback when Supabase is not configured)
 *
 * Returns null when the vehicle is not found in any source, or when it is
 * found but its status is not "active" (inactive/maintenance vehicles cannot
 * be booked by the public).
 *
 * @param {string} vehicleId
 * @returns {Promise<object|null>}
 */
export async function getVehicleById(vehicleId) {
  if (!vehicleId) return null;

  // ── 1. Known static vehicles (CARS) ─────────────────────────────────────
  if (CARS[vehicleId]) {
    const car = CARS[vehicleId];
    return {
      vehicleId,
      name:        car.name,
      type:        "car",
      hourlyTiers: car.hourlyTiers || null,
      pricePerDay: car.pricePerDay || null,
      weekly:      car.weekly      || null,
      biweekly:    car.biweekly    || null,
      monthly:     car.monthly     || null,
      deposit:     car.deposit     || null,
    };
  }

  // ── 2. Supabase vehicles table ───────────────────────────────────────────
  // NOTE: Do NOT select `rental_status` here — that column stores booking-state
  // values ('available', 'rented', 'reserved', 'maintenance') which are never
  // "active", so mixing it into the status check would make every admin-created
  // vehicle that has no explicit `data.status` field appear inactive.
  // isVehicleAvailable() handles the rental_status check separately with
  // fail-open semantics.  We also use .maybeSingle() instead of .single() so
  // that 0 matching rows returns { data: null, error: null } instead of a
  // PGRST116 error that would be silently swallowed and send us to the
  // vehicles.json fallback even when the vehicle IS in Supabase.
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb
        .from("vehicles")
        .select("vehicle_id, data")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();
      if (error) {
        console.error("[getVehicleById] Supabase query error for vehicle:", vehicleId, error.code, error.message);
        // fall through to vehicles.json
      } else if (data) {
        const vdata = data.data || {};
        // Only block vehicles explicitly marked inactive or maintenance
        // in the admin-managed status field.  An absent status means active.
        if (vdata.status && vdata.status !== "active") {
          console.warn("[getVehicleById] Vehicle is inactive/maintenance:", vehicleId, vdata.status);
          return null;
        }
        return normalizeVehicleData(vehicleId, vdata);
      } else {
        // 0 rows returned — vehicle not found in Supabase
        console.warn("[getVehicleById] Vehicle not found in Supabase vehicles table:", vehicleId);
        // fall through to vehicles.json
      }
    } catch (sbErr) {
      console.error("[getVehicleById] Supabase threw for vehicle:", vehicleId, sbErr?.message || sbErr);
      // fall through to vehicles.json
    }
  }

  // ── 3. vehicles.json fallback (GitHub) ───────────────────────────────────
  try {
    const { data: vehicles } = await loadVehicles();
    if (vehicles[vehicleId]) {
      const v = vehicles[vehicleId];
      if (v.status && v.status !== "active") return null;
      return normalizeVehicleData(vehicleId, v);
    }
  } catch {
    // vehicle not found
  }

  return null;
}