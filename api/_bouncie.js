// api/_bouncie.js
// Bouncie GPS API client helpers.
//
// Base URL : https://api.bouncie.dev/v1
// Auth     : Authorization: Bearer <token>
//
// Token source:
//   bouncie_tokens Supabase table (written by /api/bouncie-callback after OAuth
//   flow completes).  There is exactly one row (id = 1).
//
//   If the API returns 401, the stored refresh_token is exchanged for a new
//   access_token via POST https://auth.bouncie.com/oauth/token, the new tokens
//   are saved back, and the request is retried once automatically.
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
 * Resolve the Bouncie access token from the bouncie_tokens Supabase table.
 *
 * @param {object|null} [sb] - Supabase admin client (required; returns null when absent)
 * @returns {Promise<string|null>} access token or null if none found
 */
export async function loadBouncieToken(sb = null) {
  if (!sb) return null;

  try {
    const { data } = await sb
      .from("bouncie_tokens")
      .select("access_token")
      .eq("id", 1)
      .maybeSingle();

    return data?.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Use the stored refresh_token to obtain a new access_token from Bouncie,
 * persist both tokens back to the bouncie_tokens table, and return the new
 * access_token.
 *
 * Requires BOUNCIE_CLIENT_ID and BOUNCIE_CLIENT_SECRET in the environment.
 *
 * @param {object} sb - Supabase admin client
 * @returns {Promise<string>} new access token
 */
export async function refreshBouncieToken(sb) {
  const { data: row } = await sb
    .from("bouncie_tokens")
    .select("refresh_token")
    .eq("id", 1)
    .maybeSingle();

  if (!row?.refresh_token) {
    throw new Error("No Bouncie refresh token found — please re-authorize via the OAuth flow from the admin dashboard.");
  }

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: row.refresh_token,
    client_id:     process.env.BOUNCIE_CLIENT_ID,
    client_secret: process.env.BOUNCIE_CLIENT_SECRET,
  });

  const tokenRes = await fetch("https://auth.bouncie.com/oauth/token", {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(`Bouncie token refresh failed: ${tokenRes.status} ${text}`);
  }

  const tokenData = await tokenRes.json();
  const { access_token, refresh_token: newRefreshToken } = tokenData;

  if (!access_token) {
    throw new Error("Bouncie token refresh did not return an access_token.");
  }

  await sb.from("bouncie_tokens").upsert(
    {
      id:            1,
      access_token,
      refresh_token: newRefreshToken || row.refresh_token,
      obtained_at:   new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  return access_token;
}

// ── Bouncie REST helpers ──────────────────────────────────────────────────────

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 *
 * Token is read from the bouncie_tokens Supabase table.  If the API returns
 * 401 the refresh token is used to obtain a new access token (stored back to
 * Supabase) and the request is retried once automatically.
 *
 * @param {object|null} [sb] - Supabase admin client (required for token lookup)
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles(sb = null) {
  const token = await loadBouncieToken(sb);
  if (!token) throw new Error("No Bouncie access token found in the database. Please complete the OAuth flow from the admin dashboard to connect your Bouncie account.");

  const resp = await fetch(`${BOUNCIE_API}/vehicles`, { headers: makeHeaders(token) });

  // Token expired — attempt automatic refresh and retry once.
  if ((resp.status === 401 || resp.status === 403) && sb) {
    let newToken;
    try {
      newToken = await refreshBouncieToken(sb);
      console.log("Bouncie token refreshed successfully");
      console.log("New token (first 10):", newToken.slice(0, 10));
    } catch (refreshErr) {
      throw new Error(`Token refresh failed: ${refreshErr.message}`);
    }

    const retryResp = await fetch(`${BOUNCIE_API}/vehicles`, {
      headers: makeHeaders(newToken),
    });

    console.log("Bouncie retry request status:", retryResp.status);

    const retryText = await retryResp.text();

    if (!retryResp.ok) {
      throw new Error(`Retry failed: ${retryResp.status} ${retryText}`);
    }

    return JSON.parse(retryText);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Bouncie API: ${resp.status} Unauthorized — please re-authorize via the OAuth flow from the admin dashboard.`);
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
    "<h2>ℹ️ Bouncie OAuth</h2>" +
    "<p>To connect Bouncie, start the OAuth flow from the admin dashboard or navigate to " +
    "<code>/api/bouncie-oauth</code> to begin authorization.</p>" +
    "</body></html>"
  );
}
