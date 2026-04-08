// api/_bouncie.js
// Bouncie GPS API client helpers.
//
// Base URL : https://api.bouncie.com/v1
// Auth     : OAuth 2.0 — access token stored in the bouncie_tokens Supabase table.
//            Tokens are obtained via /api/connectBouncie → /api/bouncieCallback.
//            A 401 response from the Bouncie API triggers an automatic token refresh.
//
// Vehicle mapping is stored in the vehicles table (bouncie_device_id column).
// Slingshots (type = 'slingshot') are never tracked — all helpers skip them.

import { getSupabaseAdmin } from "./_supabase.js";

const BOUNCIE_API = "https://api.bouncie.com/v1";

async function getToken() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new Error("Bouncie is not configured — Supabase environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) are missing.");
  }
  const { data, error } = await supabase
    .from("bouncie_tokens")
    .select("*")
    .eq("id", 1)
    .single();
  if (error && error.code !== "PGRST116") {
    throw new Error(`Supabase error loading bouncie_tokens: ${error.message} (code: ${error.code})`);
  }
  return data;
}

async function refreshAccessToken(currentRefreshToken) {
  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  const basic        = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://auth.bouncie.com/oauth/token", {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type:    "refresh_token",
      refresh_token: currentRefreshToken,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error("Bouncie token refresh failed");

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new Error("Bouncie token refresh succeeded but tokens could not be persisted — Supabase environment variables are missing.");
  }
  await supabase.from("bouncie_tokens").upsert({
    id:            1,
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    updated_at:    new Date().toISOString(),
  });

  return data.access_token;
}

// ── Bouncie REST helpers ──────────────────────────────────────────────────────

/**
 * Fetch all vehicles from the Bouncie API with their current stats.
 *
 * Reads the OAuth access token from the bouncie_tokens Supabase table and
 * automatically refreshes it on a 401 response.
 *
 * @returns {Promise<Array>}
 */
export async function getBouncieVehicles() {
  const tokenData = await getToken();
  if (!tokenData?.access_token) {
    throw new Error("Bouncie is not configured — no OAuth token found. Please connect your Bouncie account via System Settings.");
  }

  let accessToken = tokenData.access_token;

  let resp = await fetch(`${BOUNCIE_API}/vehicles`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (resp.status === 401) {
    accessToken = await refreshAccessToken(tokenData.refresh_token);
    resp = await fetch(`${BOUNCIE_API}/vehicles`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
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
    .not("bouncie_device_id", "is", null)
    .eq("is_tracked", true);
  if (error) {
    console.error("Supabase error in loadTrackedVehicles:", error);
    throw error;
  }

  return data || [];
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
// This stub is kept so that any cached or bookmarked URLs under /api/_bouncie
// continue to serve a meaningful response rather than a 404.

export default async function handler(req, res) {
  return res.status(200).send(
    "<!DOCTYPE html><html><head><title>Bouncie</title></head>" +
    "<body style='font-family:sans-serif;padding:2rem'>" +
    "<h2>ℹ️ Bouncie — OAuth Authentication</h2>" +
    "<p>To connect Bouncie GPS sync, visit <a href='/api/connectBouncie'>/api/connectBouncie</a>.</p>" +
    "</body></html>"
  );
}
