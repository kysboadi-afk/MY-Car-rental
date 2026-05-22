import { CARS, FLEET_VEHICLE_IDS } from "./_pricing.js";

// Map legacy IDs and user-facing names to canonical IDs before persistence.
const VEHICLE_ID_ALIASES = {
  "Camry 2012": "camry",
  "Camry 2013 SE": "camry2013",
};

// Legacy raw IDs (stored in old DB records) that must map to their canonical ID.
// These are kept separate from VEHICLE_ID_ALIASES so they do not pollute the
// DB_TO_UI_MAP reverse lookup (built only from simple lowercase alias keys).
// uiVehicleId() also consults this map so that legacy bookings with
// vehicle_id="camry2012" are correctly grouped under the "camry" vehicle.
const LEGACY_ID_NORMALIZE = {
  "camry2012": "camry",
};

function normalizeAliasKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildAliasMap() {
  const map = {};
  for (const id of FLEET_VEHICLE_IDS) {
    const key = normalizeAliasKey(id);
    if (key) map[key] = id;
  }
  for (const [alias, canonical] of Object.entries(VEHICLE_ID_ALIASES)) {
    const key = normalizeAliasKey(alias);
    if (key) map[key] = canonical;
  }
  for (const [legacy, canonical] of Object.entries(LEGACY_ID_NORMALIZE)) {
    const key = normalizeAliasKey(legacy);
    if (key) map[key] = canonical;
  }
  for (const [id, data] of Object.entries(CARS || {})) {
    const idKey = normalizeAliasKey(id);
    const nameKey = normalizeAliasKey(data?.name || "");
    if (idKey) map[idKey] = id;
    if (nameKey) map[nameKey] = id;
  }
  return map;
}

const NORMALIZED_ALIAS_MAP = buildAliasMap();

// All DB-side vehicle IDs: canonical fleet IDs only.
// "camry2012" was a legacy alias stored in old DB records before normalisation
// was enforced; migration 0110 normalised all such rows to "camry".
// FLEET_DB_VEHICLE_IDS no longer needs to include "camry2012".
// Adding a new car to CARS in _pricing.js automatically includes it here.
export const FLEET_DB_VEHICLE_IDS = [...FLEET_VEHICLE_IDS];

// All known DB-stored IDs (canonical only) that belong to each canonical vehicle.
// "camry2012" was a legacy alias normalised to "camry" by migration 0110;
// it is no longer present in the database so there is no need to expand queries.
const VEHICLE_ID_FAMILY = {
  camry: ["camry"],
};

/**
 * Normalize incoming vehicle IDs/names into canonical IDs used for persistence.
 * @param {string} vehicleId
 * @returns {string}
 */
export function normalizeVehicleId(vehicleId) {
  const raw = String(vehicleId || "").trim();
  if (!raw) return "";
  const normalized = normalizeAliasKey(raw);
  return NORMALIZED_ALIAS_MAP[normalized] || raw;
}

// Reverse map: DB-canonical ID → UI/vehicles.json key (e.g. "camry" → "camry").
// Built from the simple-key entries in VEHICLE_ID_ALIASES (excludes display-name keys
// like "Camry 2012" which start with an uppercase letter).
const DB_TO_UI_MAP = Object.fromEntries(
  Object.entries(VEHICLE_ID_ALIASES)
    .filter(([k]) => /^[a-z][a-z0-9]*$/.test(k))
    .map(([ui, db]) => [db, ui])
);

/**
 * Reverse of normalizeVehicleId: maps a DB vehicle ID back to its canonical
 * UI/vehicles.json key.  Handles both current IDs (via DB_TO_UI_MAP) and
 * legacy raw IDs that were stored before normalisation was enforced (e.g.
 * "camry2012" → "camry").  Unknown IDs are returned unchanged.
 *
 * @param {string} dbId - e.g. "camry" or legacy "camry2012"
 * @returns {string}     - canonical key, e.g. "camry"
 */
export function uiVehicleId(dbId) {
  const raw = String(dbId || "").trim();
  if (!raw) return "";
  const canonical = normalizeVehicleId(raw);
  return DB_TO_UI_MAP[canonical] || canonical;
}

/**
 * Returns all DB-stored vehicle IDs that belong to the same logical vehicle
 * as the given ID.  Use this to expand Supabase `.eq("vehicle_id", id)` filters
 * into `.in("vehicle_id", vehicleIdFamily(id))` when backward compatibility is
 * needed during a data migration window.
 *
 * @param {string} id - canonical vehicle ID
 * @returns {string[]} - e.g. vehicleIdFamily("camry") → ["camry"]
 */
export function vehicleIdFamily(id) {
  const canonical = normalizeVehicleId(id);
  return VEHICLE_ID_FAMILY[canonical] || [canonical];
}
