// api/_manage-booking-token.js
// HMAC-signed token utilities for customer "Manage Your Booking" portal links.
//
// Tokens bind a booking_ref to a 72-hour expiry window so a link sent in a
// deposit-confirmation email cannot be replayed indefinitely.
//
// Format: <base64url-payload>.<base64url-signature>
//   payload = base64url({ bookingRef, exp })
//   sig     = HMAC-SHA256("manage-booking:" + payload, OTP_SECRET)
//
// The "manage-booking:" prefix prevents cross-use with other tokens (late-fee,
// quick-service, waitlist-decision) that are also signed with OTP_SECRET.
//
// Required environment variable:
//   OTP_SECRET — shared secret (also used by _otp.js, _late-fee-token.js, etc.)

import crypto from "crypto";

// 72 hours — customer has three days to act on the link without needing to
// request a fresh one from admin.
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_PREFIX   = "manage-booking:";

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn(
      "[_manage-booking-token.js] WARNING: OTP_SECRET is not set. " +
        "Using insecure fallback — set it in your Vercel project settings."
    );
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

/**
 * Create a time-limited HMAC-signed manage-booking token.
 *
 * @param {string} bookingRef  — booking_ref / bookingId
 * @param {number} [ttlMs]     — token lifetime in ms (default: 72 h)
 * @returns {string}  URL-safe "payload.sig" string
 */
export function createManageToken(bookingRef, ttlMs = DEFAULT_TTL_MS) {
  if (!bookingRef) throw new Error("bookingRef is required");

  const secret  = getSecret();
  const payload = Buffer.from(JSON.stringify({
    bookingRef,
    exp: Date.now() + ttlMs,
  })).toString("base64url");

  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest("base64url");

  return `${payload}.${sig}`;
}

/**
 * Verify a manage-booking token.
 * Returns the decoded bookingRef on success, or null on any failure.
 *
 * @param {string} token
 * @returns {string | null}  bookingRef, or null
 */
export function verifyManageToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const secret = getSecret();
    const dotIdx = token.lastIndexOf(".");
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

    if (!data.bookingRef || typeof data.bookingRef !== "string") return null;
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;

    return data.bookingRef;
  } catch {
    return null;
  }
}
