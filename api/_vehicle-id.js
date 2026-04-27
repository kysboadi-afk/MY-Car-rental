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

// All known DB-stored IDs (canonical + legacy) that belong to each canonical vehicle.
// Used to expand query filters so legacy-stored records are never missed.
const VEHICLE_ID_FAMILY = {
  camry: ["camry", "camry2012"],
};

/**
 * Normalize incoming vehicle IDs/names into canonical IDs used for persistence.
 * @param {string} vehicleId
 * @returns {string}
 */
export function normalizeVehicleId(vehicleId) {
  const raw = String(vehicleId || "").trim();
  if (!raw) return "";
  return VEHICLE_ID_ALIASES[raw] || LEGACY_ID_NORMALIZE[raw] || raw;
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
  return DB_TO_UI_MAP[raw] || LEGACY_ID_NORMALIZE[raw] || raw;
}

/**
 * Returns all DB-stored vehicle IDs (canonical + legacy aliases) that belong
 * to the same logical vehicle as the given ID.  Use this to expand Supabase
 * `.eq("vehicle_id", id)` filters into `.in("vehicle_id", vehicleIdFamily(id))`
 * so that records stored under legacy IDs (e.g. "camry2012") are never missed.
 *
 * @param {string} id - canonical or legacy vehicle ID
 * @returns {string[]} - e.g. vehicleIdFamily("camry") → ["camry", "camry2012"]
 */
export function vehicleIdFamily(id) {
  const canonical = normalizeVehicleId(id);
  return VEHICLE_ID_FAMILY[canonical] || [canonical];
}
