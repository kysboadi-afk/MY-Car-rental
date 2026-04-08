// api/_bouncie.js
// Bouncie GPS API client helpers.
//
// Base URL : https://api.bouncie.dev/v1
// Auth     : Authorization: <BOUNCIE_API_KEY>
//
// API key source:
//   BOUNCIE_API_KEY environment variable (set in Vercel dashboard).
//
// Vehicle mapping is stored in the vehicles table (bouncie_device_id column).
// Slingshots (type = 'slingshot') are never tracked — all helpers skip them.

const BOUNCIE_API = "https://api.bouncie.dev/v1";

function makeHeaders(apiKey) {
  return {
    Authorization: apiKey,
    "Content-Type": "application/json",
  };
}

// ── API key helper ────────────────────────────────────────────────────────────

/**
 * Return the Bouncie API key from the BOUNCIE_API_KEY environment variable.
 *
 * The `sb` parameter is accepted for backward-compatibility with existing
 * callers but is no longer used — the API key is read from the environment.
 *
 * @param {object|null} [sb] - Supabase admin client (ignored; kept for compat)
 * @returns {Promise<string|null>} API key or null if not configured
 */
export async function loadBouncieToken(sb = null) {
  return process.env.BOUNCIE_API_KEY || null;
}

// ── Bouncie REST helpers ──────────────────────────────────────────────────────

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 *
 * The API key is read from the BOUNCIE_API_KEY environment variable.
 *
 * @param {object|null} [sb] - Supabase admin client (accepted for compat; not used)
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles(sb = null) {
  const apiKey = await loadBouncieToken(sb);
  if (!apiKey) throw new Error("No Bouncie API key found. Please set the BOUNCIE_API_KEY environment variable in your Vercel dashboard.");

  const resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: makeHeaders(apiKey) });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Bouncie API: ${resp.status} Unauthorized — please verify your BOUNCIE_API_KEY is correct.`);
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
 * Load all vehicles that have a Bouncie IMEI assigned (actively tracked).
 * Slingshots are excluded regardless of whether they have an IMEI.
 *
 * @param {object} sb - Supabase admin client
 * @returns {Promise<Array>}
 */
export async function loadTrackedVehicles(sb) {
  const { data, error } = await sb
    .from("vehicles")
    .select("vehicle_id, bouncie_device_id, mileage, vehicle_name, vehicle_type, data")
    .not("bouncie_device_id", "is", null);
  if (error) {
    console.error("Supabase error in loadTrackedVehicles:", error);
    throw error;
  }

  return (data || []).filter((row) => {
    const type = row.vehicle_type || row.data?.type || "";
    return type !== "slingshot";
  });
}

/**
 * Overwrite a vehicle's odometer reading and last_synced_at timestamp with the
 * latest value from Bouncie.  The stored mileage is always replaced — there is
 * no monotonic guard — so that a corrected Bouncie reading can fix a stale or
 * inflated DB value.  The only check is that the incoming odometer is a
 * positive number, guarding against a Bouncie API glitch zeroing the record.
 *
 * Mirrors the mileage into the data JSONB for the GitHub fallback path.
 *
 * @param {object} sb
 * @param {string} vehicleId
 * @param {number} odometer
 * @param {string|null} lastUpdatedAt
 * @returns {Promise<boolean>} true if the row was written, false if skipped (odometer ≤ 0)
 */
export async function updateVehicleMileage(sb, vehicleId, odometer, lastUpdatedAt) {
  if (!odometer || odometer <= 0) return false;

  const { data: row, error: selectError } = await sb
    .from("vehicles")
    .select("data")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  if (selectError) {
    console.error("Supabase error in updateVehicleMileage (select):", selectError);
    throw selectError;
  }

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

  if (error) {
    console.error("Supabase error in updateVehicleMileage (update):", error);
    throw error;
  }
  return true;
}

/**
 * Insert a trip record into trip_log, silently ignoring duplicate transaction_ids.
 *
 * @param {object} sb
 * @param {object} trip
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

// ── Vercel serverless handler ─────────────────────────────────────────────────
//
// This stub is kept so that any cached or bookmarked URLs under /api/bouncie-oauth
// or /api/_bouncie continue to serve a meaningful response rather than a 404.

export default async function handler(req, res) {
  return res.status(200).send(
    "<!DOCTYPE html><html><head><title>Bouncie</title></head>" +
    "<body style='font-family:sans-serif;padding:2rem'>" +
    "<h2>ℹ️ Bouncie — API Key Authentication</h2>" +
    "<p>Bouncie GPS sync uses API key authentication. " +
    "Set the <code>BOUNCIE_API_KEY</code> environment variable in your Vercel dashboard to enable mileage sync.</p>" +
    "</body></html>"
  );
}
