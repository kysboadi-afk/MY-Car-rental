// api/_bouncie.js
// Bouncie GPS API client helpers.
//
// Base URL : https://api.bouncie.dev/v1
// Auth     : Authorization: <access_token>
//            NOTE: Bouncie does NOT use a "Bearer" prefix — just the raw token.
//
// Token lifecycle:
//   Access tokens are obtained once via /api/bouncie-auth (one-time OAuth exchange).
//   They are stored in the Supabase app_config table and auto-refreshed here
//   before every API call.  The env var BOUNCIE_ACCESS_TOKEN is the fallback for
//   cases where Supabase is not available (e.g. cold start without DB access).
//
// Vehicle mapping is stored in the vehicles table (bouncie_device_id column).
// Slingshots (type = 'slingshot') are never tracked — all helpers skip them.

const BOUNCIE_API  = "https://api.bouncie.dev/v1";
const BOUNCIE_AUTH = "https://auth.bouncie.com/oauth/token";

// ── Token management ──────────────────────────────────────────────────────────

/**
 * Read Bouncie tokens from Supabase app_config.
 * Falls back to BOUNCIE_ACCESS_TOKEN env var if Supabase is unavailable.
 *
 * @param {object|null} sb - Supabase admin client (may be null)
 * @returns {Promise<{access_token:string, refresh_token:string|null}>}
 */
export async function getBouncieTokens(sb) {
  if (sb) {
    const { data } = await sb
      .from("app_config")
      .select("value")
      .eq("key", "bouncie_tokens")
      .maybeSingle();
    if (data?.value?.access_token) {
      return data.value;
    }
  }
  // Env var fallback
  const token = process.env.BOUNCIE_ACCESS_TOKEN;
  if (!token) throw new Error("Bouncie access token not configured — run /api/bouncie-auth first");
  return { access_token: token, refresh_token: process.env.BOUNCIE_REFRESH_TOKEN || null };
}

/**
 * Persist updated Bouncie tokens to Supabase app_config.
 * No-op if Supabase is unavailable.
 *
 * @param {object|null} sb
 * @param {string} accessToken
 * @param {string|null} refreshToken
 */
async function saveBouncieTokens(sb, accessToken, refreshToken) {
  if (!sb) return;
  await sb.from("app_config").upsert(
    {
      key:        "bouncie_tokens",
      value:      { access_token: accessToken, refresh_token: refreshToken, updated_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
}

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Stores the result in Supabase app_config.
 *
 * @param {object|null} sb
 * @param {string} authCode  - one-time code from the Bouncie OAuth redirect
 * @param {string} redirectUri
 * @returns {Promise<{access_token, refresh_token, expires_in}>}
 */
export async function exchangeAuthCode(sb, authCode, redirectUri) {
  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("BOUNCIE_CLIENT_ID and BOUNCIE_CLIENT_SECRET must be set in Vercel env vars");
  }

  const resp = await fetch(BOUNCIE_AUTH, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    "authorization_code",
      code:          authCode,
      redirect_uri:  redirectUri,
    }),
  });

  const body = await resp.json();
  if (!resp.ok || !body.access_token) {
    throw new Error(`Bouncie token exchange failed (${resp.status}): ${JSON.stringify(body)}`);
  }

  await saveBouncieTokens(sb, body.access_token, body.refresh_token || null);
  return body;
}

/**
 * Refresh an expired access token using the stored refresh_token.
 * Updates both Supabase and the in-process token cache.
 *
 * @param {object|null} sb
 * @param {string} refreshToken
 * @returns {Promise<string>} new access token
 */
export async function refreshBouncieToken(sb, refreshToken) {
  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("BOUNCIE_CLIENT_ID and BOUNCIE_CLIENT_SECRET must be set to refresh tokens");
  }

  const resp = await fetch(BOUNCIE_AUTH, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const body = await resp.json();
  if (!resp.ok || !body.access_token) {
    throw new Error(`Bouncie token refresh failed (${resp.status}): ${JSON.stringify(body)}`);
  }

  await saveBouncieTokens(sb, body.access_token, body.refresh_token || refreshToken);
  return body.access_token;
}

/**
 * Get a valid access token, auto-refreshing if a 401 is detected.
 * This is the main entry point used by all API call helpers below.
 *
 * @param {object|null} sb
 * @returns {Promise<string>}
 */
async function getValidToken(sb) {
  const tokens = await getBouncieTokens(sb);
  return tokens.access_token;
}

function makeHeaders(token) {
  return {
    Authorization:  token,   // raw token — Bouncie does NOT use "Bearer" prefix
    "Content-Type": "application/json",
  };
}

// ── Bouncie REST helpers ──────────────────────────────────────────────────────

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 * Automatically retries once with a refreshed token on 401.
 *
 * @param {object|null} sb - Supabase client (needed for token refresh)
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles(sb = null) {
  const token = await getValidToken(sb);
  let resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: makeHeaders(token) });

  // Auto-refresh on 401
  if (resp.status === 401 && sb) {
    const tokens = await getBouncieTokens(sb);
    if (tokens.refresh_token) {
      const newToken = await refreshBouncieToken(sb, tokens.refresh_token);
      resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: makeHeaders(newToken) });
    }
  }

  if (resp.status === 401) {
    throw new Error("Bouncie API: 401 Unauthorized — token expired and no refresh_token available. Re-run /api/bouncie-auth.");
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
 * Advance a vehicle's odometer reading and last_synced_at timestamp.
 * Only updates if the new reading is strictly greater (odometers are monotonic).
 * Mirrors the mileage into the data JSONB for the GitHub fallback path.
 *
 * @param {object} sb
 * @param {string} vehicleId
 * @param {number} odometer
 * @param {string|null} lastUpdatedAt
 * @param {number} [currentMileage]
 * @returns {Promise<boolean>}
 */
export async function updateVehicleMileage(sb, vehicleId, odometer, lastUpdatedAt, currentMileage = 0) {
  if (odometer <= currentMileage) return false;

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
