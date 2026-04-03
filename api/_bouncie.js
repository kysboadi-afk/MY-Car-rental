// api/_bouncie.js
// Bouncie GPS API client helpers.
//
// Base URL : https://api.bouncie.dev/v1
// Auth     : Authorization: <access_token>
//            NOTE: Bouncie does NOT use a "Bearer" prefix — just the raw token.
//
// Vehicle mapping is stored in the vehicles table (bouncie_device_id column).
// Slingshots (type = 'slingshot') are never tracked — all helpers skip them.

const BOUNCIE_API = "https://api.bouncie.dev/v1";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function bouncieHeaders() {
  const token = process.env.BOUNCIE_ACCESS_TOKEN;
  if (!token) throw new Error("BOUNCIE_ACCESS_TOKEN env var is not set");
  return {
    Authorization:  token,    // raw token, no "Bearer" prefix per Bouncie docs
    "Content-Type": "application/json",
  };
}

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 * Returns an array of Bouncie vehicle objects; each has:
 *   imei, nickName, vin, model, stats.odometer, stats.lastUpdated,
 *   stats.mil, stats.battery, stats.location, stats.isRunning
 *
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles() {
  const resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: bouncieHeaders() });
  if (resp.status === 401) {
    throw new Error("Bouncie API: 401 Unauthorized — check BOUNCIE_ACCESS_TOKEN");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Bouncie API GET /vehicles failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Load all vehicles that have a Bouncie IMEI assigned (i.e. are actively tracked).
 * Slingshots are excluded regardless of whether they have an IMEI.
 *
 * @param {object} sb - Supabase admin client
 * @returns {Promise<Array<{vehicle_id, bouncie_device_id, mileage, vehicle_name, vehicle_type, data}>>}
 */
export async function loadTrackedVehicles(sb) {
  const { data, error } = await sb
    .from("vehicles")
    .select("vehicle_id, bouncie_device_id, mileage, vehicle_name, vehicle_type, data")
    .not("bouncie_device_id", "is", null);
  if (error) throw new Error(`loadTrackedVehicles failed: ${error.message}`);

  // Exclude slingshots — they are never Bouncie-tracked
  return (data || []).filter((row) => {
    const type = row.vehicle_type || row.data?.type || "";
    return type !== "slingshot";
  });
}

/**
 * Advance a vehicle's odometer reading and last_synced_at timestamp.
 * Only updates if the new reading is strictly greater (odometers are monotonic).
 * Also mirrors the mileage into the data JSONB for the GitHub fallback path.
 *
 * @param {object} sb
 * @param {string} vehicleId
 * @param {number} odometer       - new odometer reading in miles
 * @param {string|null} lastUpdatedAt - ISO timestamp from Bouncie stats.lastUpdated
 * @param {number} [currentMileage]   - stored value; avoids extra round-trip when already known
 * @returns {Promise<boolean>} true if updated, false if reading was not newer
 */
export async function updateVehicleMileage(sb, vehicleId, odometer, lastUpdatedAt, currentMileage = 0) {
  if (odometer <= currentMileage) return false; // never decrease odometer

  // Fetch current data JSONB so we can mirror the mileage into it
  const { data: row } = await sb
    .from("vehicles")
    .select("data")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  const updatedData = { ...(row?.data || {}), mileage: odometer };

  const { error } = await sb
    .from("vehicles")
    .update({
      mileage:        odometer,
      last_synced_at: lastUpdatedAt || new Date().toISOString(),
      data:           updatedData,
      updated_at:     new Date().toISOString(),
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`updateVehicleMileage failed for ${vehicleId}: ${error.message}`);
  return true;
}

/**
 * Insert a trip record into trip_log, silently ignoring duplicate transaction_ids.
 *
 * @param {object} sb
 * @param {object} trip
 * @param {string} trip.vehicleId
 * @param {string} trip.imei
 * @param {string} trip.transactionId
 * @param {number} [trip.tripDistance]    - miles
 * @param {number} [trip.endOdometer]     - miles
 * @param {number} [trip.tripTimeSecs]
 * @param {number} [trip.maxSpeedMph]
 * @param {number} [trip.hardBraking]
 * @param {number} [trip.hardAccel]
 * @param {string} trip.tripAt            - ISO timestamp
 */
export async function insertTripLog(sb, trip) {
  const { error } = await sb.from("trip_log").insert({
    vehicle_id:     trip.vehicleId,
    bouncie_imei:   trip.imei,
    transaction_id: trip.transactionId,
    trip_distance:  trip.tripDistance  ?? null,
    end_odometer:   trip.endOdometer   ?? null,
    trip_time_secs: trip.tripTimeSecs  ?? null,
    max_speed_mph:  trip.maxSpeedMph   ?? null,
    hard_braking:   trip.hardBraking   ?? 0,
    hard_accel:     trip.hardAccel     ?? 0,
    trip_at:        trip.tripAt,
  });

  // 23505 = unique_violation on transaction_id — safe to ignore (duplicate event)
  if (error && !error.code?.includes("23505") && !error.message?.includes("unique")) {
    throw new Error(`insertTripLog failed: ${error.message}`);
  }
}


// ── HTTP helpers ──────────────────────────────────────────────────────────────

function bouncieHeaders() {
  const token = process.env.BOUNCIE_ACCESS_TOKEN;
  if (!token) throw new Error("BOUNCIE_ACCESS_TOKEN env var is not set");
  return {
    Authorization:  token,    // raw token, no "Bearer" prefix per Bouncie docs
    "Content-Type": "application/json",
  };
}

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 * Returns an array of Bouncie vehicle objects; each has:
 *   imei, nickName, vin, model, stats.odometer, stats.lastUpdated,
 *   stats.mil, stats.battery, stats.location, stats.isRunning
 *
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles() {
  const resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: bouncieHeaders() });
  if (resp.status === 401) {
    throw new Error("Bouncie API: 401 Unauthorized — check BOUNCIE_ACCESS_TOKEN");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Bouncie API GET /vehicles failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Load all vehicles that have a Bouncie IMEI assigned (i.e. are actively tracked).
 * Slingshots are excluded regardless of whether they have an IMEI.
 *
 * @param {object} sb - Supabase admin client
 * @returns {Promise<Array<{vehicle_id, bouncie_device_id, mileage, vehicle_name, vehicle_type}>>}
 */
export async function loadTrackedVehicles(sb) {
  const { data, error } = await sb
    .from("vehicles")
    .select("vehicle_id, bouncie_device_id, mileage, vehicle_name, vehicle_type, data")
    .not("bouncie_device_id", "is", null);
  if (error) throw new Error(`loadTrackedVehicles failed: ${error.message}`);

  // Exclude slingshots — they are never Bouncie-tracked
  return (data || []).filter((row) => {
    const type = row.vehicle_type || row.data?.type || "";
    return type !== "slingshot";
  });
}

/**
 * Advance a vehicle's odometer reading and last_synced_at timestamp.
 * Only updates if the new reading is strictly greater (odometers are monotonic).
 *
 * @param {object} sb
 * @param {string} vehicleId
 * @param {number} odometer      - miles
 * @param {string} lastUpdatedAt - ISO timestamp from Bouncie
 * @param {number} [currentMileage] - current stored value (avoids extra round-trip)
 * @returns {Promise<boolean>} true if updated, false if reading was not newer
 */
export async function advanceMileage(sb, vehicleId, odometer, lastUpdatedAt, currentMileage = 0) {
  if (odometer <= currentMileage) return false; // never decrease odometer

  const { error } = await sb
    .from("vehicles")
    .update({
      mileage:        odometer,
      last_synced_at: lastUpdatedAt || new Date().toISOString(),
      // Mirror into data JSONB for the GitHub JSON fallback path
      data: sb.rpc ? undefined : undefined, // can't easily use rpc here; handled below
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`advanceMileage failed for ${vehicleId}: ${error.message}`);

  // Also mirror into data JSONB so vehicles.json fallback stays in sync
  await sb.rpc("jsonb_set_vehicle_mileage", {
    p_vehicle_id: vehicleId,
    p_mileage:    odometer,
  }).catch(() => {
    // RPC may not exist yet — fall back to a direct update of the data column
    return sb
      .from("vehicles")
      .update({
        data: sb
          .from("vehicles")
          .select("data")
          .eq("vehicle_id", vehicleId)
          .then(({ data: rows }) => {
            const existing = rows?.[0]?.data || {};
            return { ...existing, mileage: odometer };
          }),
      })
      .eq("vehicle_id", vehicleId);
  });

  return true;
}

/**
 * Simpler mileage update that avoids the complex RPC fallback.
 * Updates the dedicated `mileage` column and mirrors into data JSONB in one statement.
 *
 * @param {object} sb
 * @param {string} vehicleId
 * @param {number} odometer
 * @param {string} lastUpdatedAt
 * @param {number} currentMileage
 * @returns {Promise<boolean>}
 */
export async function updateVehicleMileage(sb, vehicleId, odometer, lastUpdatedAt, currentMileage = 0) {
  if (odometer <= currentMileage) return false;

  // Fetch current data blob first, then update both the column and the JSONB
  const { data: rows } = await sb
    .from("vehicles")
    .select("data")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  const existingData = rows?.data || {};
  const updatedData  = { ...existingData, mileage: odometer };

  const { error } = await sb
    .from("vehicles")
    .update({
      mileage:        odometer,
      last_synced_at: lastUpdatedAt || new Date().toISOString(),
      data:           updatedData,
      updated_at:     new Date().toISOString(),
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`updateVehicleMileage failed for ${vehicleId}: ${error.message}`);
  return true;
}

/**
 * Insert a trip record into trip_log, silently ignoring duplicate transaction_ids.
 *
 * @param {object} sb
 * @param {object} trip
 * @param {string} trip.vehicleId
 * @param {string} trip.imei
 * @param {string} trip.transactionId
 * @param {number} [trip.tripDistance]
 * @param {number} [trip.endOdometer]
 * @param {number} [trip.tripTimeSecs]
 * @param {number} [trip.maxSpeedMph]
 * @param {number} [trip.hardBraking]
 * @param {number} [trip.hardAccel]
 * @param {string} trip.tripAt
 */
export async function insertTripLog(sb, trip) {
  const { error } = await sb.from("trip_log").insert({
    vehicle_id:     trip.vehicleId,
    bouncie_imei:   trip.imei,
    transaction_id: trip.transactionId,
    trip_distance:  trip.tripDistance  ?? null,
    end_odometer:   trip.endOdometer   ?? null,
    trip_time_secs: trip.tripTimeSecs  ?? null,
    max_speed_mph:  trip.maxSpeedMph   ?? null,
    hard_braking:   trip.hardBraking   ?? 0,
    hard_accel:     trip.hardAccel     ?? 0,
    trip_at:        trip.tripAt,
  });

  // 23505 = unique_violation on transaction_id — safe to ignore (duplicate event)
  if (error && !error.code?.includes("23505") && !error.message?.includes("unique")) {
    throw new Error(`insertTripLog failed: ${error.message}`);
  }
}


function bouncieHeaders() {
  const token = process.env.BOUNCIE_ACCESS_TOKEN;
  if (!token) throw new Error("BOUNCIE_ACCESS_TOKEN env var is not set");
  return {
    Authorization:  token,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 * Each vehicle includes: imei, nickName, vin, model, stats.odometer, stats.lastUpdated,
 * stats.mil, stats.battery, stats.location.
 *
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles() {
  const resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: bouncieHeaders() });
  if (resp.status === 401) {
    throw new Error("Bouncie API: 401 Unauthorized — check BOUNCIE_ACCESS_TOKEN");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Bouncie API GET /vehicles failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Parse the BOUNCIE_DEVICE_MAP env var into an IMEI→vehicle_id map.
 * Returns {} when the env var is absent or unparseable.
 *
 * @returns {{ [imei: string]: string }}
 */
export function parseDeviceMap() {
  const raw = process.env.BOUNCIE_DEVICE_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) return {};
    return parsed;
  } catch {
    console.warn("_bouncie: BOUNCIE_DEVICE_MAP is not valid JSON — ignoring");
    return {};
  }
}

/**
 * Resolve a Bouncie device IMEI to our internal vehicle_id.
 * Order of preference:
 *   1. Explicit BOUNCIE_DEVICE_MAP entry
 *   2. Slugified device nickname  (e.g. "Slingshot R" → "slingshot-r")
 *
 * @param {string} imei
 * @param {string} [nickName]
 * @param {{ [imei: string]: string }} [deviceMap]   - pre-parsed device map
 * @returns {string | null}
 */
export function resolveVehicleId(imei, nickName, deviceMap = parseDeviceMap()) {
  if (deviceMap[imei]) return deviceMap[imei];
  if (nickName) {
    return nickName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || null;
  }
  return null;
}

/**
 * Upsert the current mileage for a vehicle.
 * Only advances total_mileage forward — never decreases it.
 *
 * @param {object} sb            - Supabase admin client
 * @param {string} vehicleId
 * @param {string} imei
 * @param {number} odometer      - miles
 * @param {string|null} lastTripAt - ISO timestamp
 */
export async function upsertMileage(sb, vehicleId, imei, odometer, lastTripAt) {
  // Fetch current value first so we never decrease the odometer
  const { data: existing } = await sb
    .from("vehicle_mileage")
    .select("total_mileage")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  const currentMileage = existing?.total_mileage ?? 0;
  if (odometer < currentMileage) return; // odometers only go forward

  const { error } = await sb.from("vehicle_mileage").upsert(
    {
      vehicle_id:     vehicleId,
      bouncie_imei:   imei,
      total_mileage:  odometer,
      last_trip_at:   lastTripAt || null,
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "vehicle_id" }
  );
  if (error) throw new Error(`upsertMileage failed for ${vehicleId}: ${error.message}`);
}

/**
 * Insert a trip record into trip_log, silently ignoring duplicate transaction_ids.
 *
 * @param {object} sb
 * @param {object} trip
 * @param {string} trip.vehicleId
 * @param {string} trip.imei
 * @param {string} trip.transactionId
 * @param {number} [trip.tripDistance]    - miles
 * @param {number} [trip.startOdometer]   - miles
 * @param {number} [trip.endOdometer]     - miles
 * @param {number} [trip.tripTimeSecs]
 * @param {number} [trip.maxSpeedMph]
 * @param {number} [trip.hardBraking]
 * @param {number} [trip.hardAccel]
 * @param {string} trip.tripAt            - ISO timestamp
 * @param {string} [trip.source]          - 'webhook' | 'sync'
 */
export async function insertTripLog(sb, trip) {
  const { error } = await sb.from("trip_log").insert({
    vehicle_id:     trip.vehicleId,
    bouncie_imei:   trip.imei,
    transaction_id: trip.transactionId,
    trip_distance:  trip.tripDistance   ?? null,
    start_odometer: trip.startOdometer  ?? null,
    end_odometer:   trip.endOdometer    ?? null,
    trip_time_secs: trip.tripTimeSecs   ?? null,
    max_speed_mph:  trip.maxSpeedMph    ?? null,
    hard_braking:   trip.hardBraking    ?? 0,
    hard_accel:     trip.hardAccel      ?? 0,
    trip_at:        trip.tripAt,
    source:         trip.source         ?? "webhook",
  });

  // 23505 = unique_violation — duplicate transactionId, safe to ignore
  if (error && !error.code?.includes("23505") && !error.message?.includes("unique")) {
    throw new Error(`insertTripLog failed: ${error.message}`);
  }
}
