// api/_waitlist-token.js
// HMAC-signed token utilities for waitlist approve/decline decisions.
//
// Tokens are non-expiring (no TTL) and bind a specific vehicleId + entryId pair
// so they cannot be replayed against other waitlist entries.
//
// Required environment variable:
//   OTP_SECRET — shared secret also used by _otp.js
import crypto from "crypto";

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn(
      "[_waitlist-token.js] WARNING: OTP_SECRET is not set. " +
        "Using insecure fallback — set it in your Vercel project settings."
    );
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

/**
 * Create a permanent HMAC-signed token for a waitlist decision.
 * The token encodes { vehicleId, entryId } and is signed with OTP_SECRET.
 *
 * @param {string} vehicleId
 * @param {string} entryId   — unique ID generated per waitlist entry
 * @returns {string}  URL-safe "payload.sig" string
 */
export function createDecisionToken(vehicleId, entryId) {
  const secret = getSecret();
  const payload = Buffer.from(JSON.stringify({ vehicleId, entryId })).toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`decision:${payload}`)
    .digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a decision token.
 * Returns the decoded { vehicleId, entryId } payload on success, or null on failure.
 *
 * @param {string} token
 * @returns {{ vehicleId: string, entryId: string } | null}
 */
export function verifyDecisionToken(token) {
  if (!token) return null;
  try {
    const secret = getSecret();
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx < 0) return null;
    const payload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`decision:${payload}`)
      .digest("base64url");

    const sigBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.vehicleId || !data.entryId) return null;
    return data;
  } catch {
    return null;
  }
}
