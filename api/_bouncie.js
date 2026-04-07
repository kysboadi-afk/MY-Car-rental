// api/_bouncie.js
// Bouncie GPS API client helpers.
//
// Base URL : https://api.bouncie.dev/v1
// Auth     : Authorization: Bearer <token>
//
// Token source (in priority order):
//   1. BOUNCIE_ACCESS_TOKEN env var (Vercel environment variable)
//   2. app_config Supabase table, row key = "bouncie_tokens"
//      (written by /api/bouncie-callback after OAuth flow completes)
//
// Vehicle mapping is stored in the vehicles table (bouncie_device_id column).
// Slingshots (type = 'slingshot') are never tracked — all helpers skip them.

const BOUNCIE_API = "https://api.bouncie.dev/v1";

function makeHeaders(token) {
  // Strip any accidental "Bearer " prefix before re-adding it so the header is never doubled.
  const cleanToken = token.replace(/^Bearer\s+/i, "");
  return {
    Authorization: `Bearer ${cleanToken}`,
    "Content-Type": "application/json",
  };
}

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the Bouncie access token.
 *
 * Priority:
 *   1. BOUNCIE_ACCESS_TOKEN env var (fastest, no DB round-trip)
 *   2. app_config Supabase row "bouncie_tokens".access_token
 *      (set by /api/bouncie-callback after an OAuth authorisation)
 *
 * @param {object|null} [sb] - Supabase admin client (optional)
 * @returns {Promise<string|null>} access token or null if none found
 */
export async function loadBouncieToken(sb = null) {
  if (process.env.BOUNCIE_ACCESS_TOKEN) return process.env.BOUNCIE_ACCESS_TOKEN;

  if (!sb) return null;

  try {
    const { data } = await sb
      .from("app_config")
      .select("value")
      .eq("key", "bouncie_tokens")
      .maybeSingle();

    return data?.value?.access_token || null;
  } catch {
    return null;
  }
}

// ── Bouncie REST helpers ──────────────────────────────────────────────────────

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 *
 * Token is resolved via loadBouncieToken(): BOUNCIE_ACCESS_TOKEN env var
 * first, then app_config Supabase table (written by /api/bouncie-callback).
 *
 * @param {object|null} [sb] - Supabase admin client (used for DB token lookup)
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles(sb = null) {
  const token = await loadBouncieToken(sb);
  if (!token) throw new Error("BOUNCIE_ACCESS_TOKEN is not configured. Set it in Vercel env vars or complete the OAuth flow at /api/bouncie-callback.");

  const resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: makeHeaders(token) });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Bouncie API: ${resp.status} Unauthorized — check that BOUNCIE_ACCESS_TOKEN is valid.`);
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
  if (error) throw new Error(`loadTrackedVehicles failed: ${error.message}`);

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
// The public OAuth callback is handled by /api/bouncie-callback.js.
// This stub is kept so that the /api/bouncie-oauth route (and the vercel.json
// rewrite from /api/_bouncie) continues to serve a meaningful response rather
// than a 404 for any cached or bookmarked URLs.

export default async function handler(req, res) {
  return res.status(200).send(
    "<!DOCTYPE html><html><head><title>Bouncie</title></head>" +
    "<body style='font-family:sans-serif;padding:2rem'>" +
    "<h2>ℹ️ OAuth callback not required</h2>" +
    "<p>Bouncie is configured via the <code>BOUNCIE_ACCESS_TOKEN</code> environment variable. " +
    "No OAuth flow is needed.</p>" +
    "</body></html>"
  );
}
