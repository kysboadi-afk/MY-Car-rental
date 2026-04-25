// api/_late-fee-token.js
// HMAC-signed token utilities for one-click late-fee charge approval links.
//
// Tokens bind a booking_id + amount + action ("approve" | "decline") and carry
// a hard expiry so a link sent in an alert email cannot be replayed later.
//
// Format: <base64url-payload>.<base64url-signature>
//   payload = base64url({ bookingId, amount, action, exp })
//   sig     = HMAC-SHA256("late-fee-approval:" + payload, OTP_SECRET)
//
// The "late-fee-approval:" prefix prevents cross-use with other tokens (quick-service,
// waitlist-decision, appt-approval) that are also signed with OTP_SECRET.
//
// Required environment variable:
//   OTP_SECRET — shared secret (also used by _otp.js and _quick-service-token.js)

import crypto from "crypto";

// 24 hours — long enough that the owner can act on the email or SMS during the day.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX   = "late-fee-approval:";

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn(
      "[_late-fee-token.js] WARNING: OTP_SECRET is not set. " +
        "Using insecure fallback — set it in your Vercel project settings."
    );
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

/**
 * Create a time-limited HMAC-signed approval token for a late fee charge.
 *
 * @param {string} bookingId   — booking_ref / bookingId
 * @param {number} amount      — fee amount in USD (e.g. 50)
 * @param {"approve"|"decline"} action
 * @param {number} [ttlMs]     — token lifetime in ms (default: 24 h)
 * @returns {string}  URL-safe "payload.sig" string
 */
export function createLateFeeToken(bookingId, amount, action, ttlMs = DEFAULT_TTL_MS) {
  if (!bookingId) throw new Error("bookingId is required");
  if (typeof amount !== "number" || amount <= 0) throw new Error("amount must be a positive number");
  if (action !== "approve" && action !== "decline" && action !== "adjust") {
    throw new Error('action must be "approve", "decline", or "adjust"');
  }

  const secret  = getSecret();
  const payload = Buffer.from(JSON.stringify({
    bookingId,
    amount,
    action,
    exp: Date.now() + ttlMs,
  })).toString("base64url");

  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_PREFIX}${payload}`)
    .digest("base64url");

  return `${payload}.${sig}`;
}

/**
 * Verify a late-fee approval token.
 * Returns the decoded payload { bookingId, amount, action } on success, or null on failure.
 *
 * @param {string} token
 * @returns {{ bookingId: string, amount: number, action: string } | null}
 */
export function verifyLateFeeToken(token) {
  if (!token) return null;
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

    if (!data.bookingId || typeof data.amount !== "number" || !data.action) return null;
    if (!["approve", "decline", "adjust"].includes(data.action)) return null;
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;

    return { bookingId: data.bookingId, amount: data.amount, action: data.action };
  } catch {
    return null;
  }
}

/**
 * Build approve, decline, and adjust URLs for an owner notification email/SMS.
 *
 * @param {string} bookingId
 * @param {number} amount      — USD
 * @param {string} [baseUrl]   — defaults to VERCEL_URL or "https://sly-rides.vercel.app"
 * @param {number} [ttlMs]
 * @returns {{ approveUrl: string, declineUrl: string, adjustUrl: string }}
 */
export function buildLateFeeUrls(bookingId, amount, baseUrl, ttlMs) {
  const base = baseUrl || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://sly-rides.vercel.app");

  const approveToken = createLateFeeToken(bookingId, amount, "approve", ttlMs);
  const declineToken = createLateFeeToken(bookingId, amount, "decline", ttlMs);
  const adjustToken  = createLateFeeToken(bookingId, amount, "adjust",  ttlMs);

  const params = (token) =>
    `?bookingId=${encodeURIComponent(bookingId)}&amount=${encodeURIComponent(amount)}&token=${encodeURIComponent(token)}`;

  return {
    approveUrl: `${base}/api/approve-late-fee${params(approveToken)}&action=approve`,
    declineUrl: `${base}/api/approve-late-fee${params(declineToken)}&action=decline`,
    adjustUrl:  `${base}/api/approve-late-fee${params(adjustToken)}&action=adjust`,
  };
}
