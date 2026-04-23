// Map legacy IDs and user-facing names to canonical IDs before persistence.
const VEHICLE_ID_ALIASES = {
  camry: "camry",
  "Camry 2012": "camry",
  "Camry 2013 SE": "camry2013",
};

/**
 * Normalize incoming vehicle IDs/names into canonical IDs used for persistence.
 * @param {string} vehicleId
 * @returns {string}
 */
export function normalizeVehicleId(vehicleId) {
  const raw = String(vehicleId || "").trim();
  if (!raw) return "";
  return VEHICLE_ID_ALIASES[raw] || raw;
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
 * Reverse of normalizeVehicleId: maps a DB-canonical vehicle ID back to its
 * UI/vehicles.json key.  Unknown IDs are returned unchanged.
 *
 * @param {string} dbId - e.g. "camry"
 * @returns {string}     - e.g. "camry"
 */
export function uiVehicleId(dbId) {
  const raw = String(dbId || "").trim();
  return DB_TO_UI_MAP[raw] || raw;
}
