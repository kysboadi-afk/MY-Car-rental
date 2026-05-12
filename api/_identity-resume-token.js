// api/_identity-resume-token.js
// HMAC-signed token utilities for identity verification recovery links.
//
// Recovery links allow applicants to resume identity verification from email
// or SMS, including on different devices, without restarting the application.
//
// Tokens carry a 7-day TTL.  Token validity covers TTL only; application
// lifecycle invalidation (verified/approved/rejected/expired/withdrawn) is
// enforced server-side by create-identity-verification-session when the
// applicant actually attempts to start or resume verification.
//
// Format: <base64url-payload>.<base64url-signature>
//   payload = base64url({ applicationId, exp })
//   sig     = HMAC-SHA256("identity-resume:" + payload, OTP_SECRET)
//
// The "identity-resume:" prefix prevents cross-use with other HMAC tokens
// (waitlist-decision, manage-booking, quick-service) that share OTP_SECRET.
//
// Required environment variable:
//   OTP_SECRET — shared secret (also used by _otp.js, _waitlist-token.js, etc.)

import crypto from "crypto";

const TOKEN_PREFIX   = "identity-resume:";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FRONTEND_BASE  = "https://www.slytrans.com";

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn(
      "[_identity-resume-token.js] WARNING: OTP_SECRET is not set. " +
        "Using insecure fallback — set it in your Vercel project settings."
    );
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

/**
 * Create a time-limited HMAC-signed recovery token for identity verification.
 *
 * @param {string} applicationId
 * @param {number} [ttlMs]  — token lifetime in ms (default: 7 days)
 * @returns {string}  URL-safe "payload.sig" string
 */
export function createResumeToken(applicationId, ttlMs = DEFAULT_TTL_MS) {
  if (!applicationId || typeof applicationId !== "string") {
    throw new Error("applicationId is required");
  }

  const secret  = getSecret();
  const payload = Buffer.from(JSON.stringify({
    applicationId: applicationId.trim(),
    exp: Date.now() + ttlMs,
  })).toString("base64url");

  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest("base64url");

  return `${payload}.${sig}`;
}

/**
 * Verify an identity resume token.
 * Returns the decoded applicationId on success, or null on any failure.
 * Tokens are rejected if expired or if the signature does not match.
 *
 * NOTE: Token validity here covers TTL only.  Application lifecycle state
 * (verified/approved/rejected/expired/withdrawn) is enforced server-side
 * when the applicant actually attempts to start or resume verification.
 *
 * @param {string} token
 * @returns {string | null}  applicationId, or null
 */
export function verifyResumeToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const secret  = getSecret();
    const dotIdx  = token.lastIndexOf(".");
    if (dotIdx < 0) return null;

    const payload = token.slice(0, dotIdx);
    const sig     = token.slice(dotIdx + 1);

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${TOKEN_PREFIX}${payload}`)
      .digest("base64url");

    const sigBuf      = Buffer.from(sig,         "base64url");
    const expectedBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (!data.applicationId || typeof data.applicationId !== "string") return null;
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;

    return data.applicationId;
  } catch {
    return null;
  }
}

/**
 * Build the full identity verification recovery URL for a given application.
 * The URL points to the thank-you page with the applicationId pre-populated,
 * allowing applicants to resume verification from any device.
 *
 * @param {string} applicationId
 * @param {string} [baseUrl]  — override for testing (default: www.slytrans.com)
 * @returns {string}  Full HTTPS URL
 */
export function buildResumeUrl(applicationId, baseUrl) {
  if (!applicationId || typeof applicationId !== "string") {
    throw new Error("applicationId is required");
  }
  const base = (baseUrl || FRONTEND_BASE).replace(/\/$/, "");
  const u    = new URL(`${base}/thank-you.html`);
  u.searchParams.set("from",          "apply");
  u.searchParams.set("applicationId", applicationId.trim());
  return u.toString();
}
