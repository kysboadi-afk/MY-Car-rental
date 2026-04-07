// api/_quick-service-token.js
// HMAC-signed token utilities for one-click maintenance completion links.
//
// Tokens bind a specific vehicleId + serviceType pair and carry a hard expiry
// so a link sent in an alert email cannot be replayed arbitrarily later.
//
// Format: <base64url-payload>.<base64url-signature>
//   payload = base64url({ vehicleId, serviceType, exp })
//   sig     = HMAC-SHA256("quick-service:" + payload, OTP_SECRET)
//
// The "quick-service:" prefix prevents cross-use with waitlist-decision tokens
// that are signed with the same OTP_SECRET secret.
//
// Required environment variable:
//   OTP_SECRET — shared secret (also used by _otp.js and _waitlist-token.js)

import crypto from "crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const VALID_SERVICE_TYPES = new Set(["oil", "brakes", "tires"]);

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn(
      "[_quick-service-token.js] WARNING: OTP_SECRET is not set. " +
        "Using insecure fallback — set it in your Vercel project settings."
    );
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

/**
 * Create a time-limited HMAC-signed token for a one-click service link.
 *
 * @param {string} vehicleId
 * @param {string} serviceType  — "oil" | "brakes" | "tires"
 * @param {number} [ttlMs]      — token lifetime in ms (default: 30 min)
 * @returns {string}  URL-safe "payload.sig" string
 */
export function createServiceToken(vehicleId, serviceType, ttlMs = DEFAULT_TTL_MS) {
  if (!vehicleId)                       throw new Error("vehicleId is required");
  if (!VALID_SERVICE_TYPES.has(serviceType)) throw new Error(`Invalid serviceType "${serviceType}"`);

  const secret  = getSecret();
  const payload = Buffer.from(JSON.stringify({
    vehicleId,
    serviceType,
    exp: Date.now() + ttlMs,
  })).toString("base64url");

  const sig = crypto
    .createHmac("sha256", secret)
    .update(`quick-service:${payload}`)
    .digest("base64url");

  return `${payload}.${sig}`;
}

/**
 * Verify a quick-service token.
 * Returns the decoded { vehicleId, serviceType } on success, or null on failure.
 * Rejects tokens that have expired or whose signature does not match.
 *
 * @param {string} token
 * @returns {{ vehicleId: string, serviceType: string } | null}
 */
export function verifyServiceToken(token) {
  if (!token) return null;
  try {
    const secret = getSecret();
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx < 0) return null;

    const payload = token.slice(0, dotIdx);
    const sig     = token.slice(dotIdx + 1);

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`quick-service:${payload}`)
      .digest("base64url");

    // Constant-time comparison to prevent timing attacks
    const sigBuf      = Buffer.from(sig,         "base64url");
    const expectedBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));

    if (!data.vehicleId || !data.serviceType || typeof data.exp !== "number") return null;
    if (!VALID_SERVICE_TYPES.has(data.serviceType)) return null;
    if (Date.now() > data.exp) return null; // expired

    return { vehicleId: data.vehicleId, serviceType: data.serviceType };
  } catch {
    return null;
  }
}

/**
 * Build a ready-to-use quick-service URL.
 *
 * @param {string} vehicleId
 * @param {string} serviceType
 * @param {string} [baseUrl]  — e.g. "https://sly-rides.vercel.app" (defaults to VERCEL_URL or slytrans.com)
 * @param {number} [ttlMs]    — token lifetime in ms (default: 30 min; use a longer value for email links)
 * @returns {string}
 */
export function buildServiceUrl(vehicleId, serviceType, baseUrl, ttlMs) {
  const base  = baseUrl || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://sly-rides.vercel.app");
  const token = createServiceToken(vehicleId, serviceType, ttlMs);
  return `${base}/api/quick-service?vehicleId=${encodeURIComponent(vehicleId)}&serviceType=${encodeURIComponent(serviceType)}&token=${encodeURIComponent(token)}`;
}
