// api/_otp.js
// Shared OTP utilities — stateless HMAC-signed token for email verification.
//
// The signed token encodes { email, hashedOtp, expiresAt } so no server-side
// state is needed (compatible with Vercel's stateless serverless functions).
//
// Required environment variable (set in Vercel dashboard):
//   OTP_SECRET — a long random string used to sign and verify tokens.
//                Defaults to a hard-coded fallback for local dev only.
import crypto from "crypto";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn(
      "[_otp.js] WARNING: OTP_SECRET environment variable is not set. " +
      "Using a hard-coded fallback — this is only safe for local development. " +
      "Set OTP_SECRET in your Vercel project settings before deploying to production."
    );
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

/**
 * Generate a cryptographically random 6-digit OTP string.
 * @returns {string} e.g. "483920"
 */
export function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Create a signed, expiring token that binds an email address to a hashed OTP.
 * The OTP itself is never stored in plain text — only its HMAC-SHA256 hash.
 *
 * @param {string} email - The email address to bind the OTP to.
 * @param {string} otp   - The plain-text OTP to embed (hashed).
 * @returns {string} A URL-safe token string "payload.signature".
 */
export function createOtpToken(email, otp) {
  const secret = getSecret();
  const hashedOtp = crypto.createHmac("sha256", secret).update(otp).digest("hex");
  const payload = Buffer.from(
    JSON.stringify({ email, hashedOtp, expiresAt: Date.now() + OTP_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a signed OTP token.
 * Returns true only when the token signature is valid, the embedded email
 * matches the supplied email, the OTP matches, and the token has not expired.
 *
 * @param {string} token - Token previously returned by createOtpToken().
 * @param {string} email - The email address to verify against.
 * @param {string} otp   - The OTP the user entered.
 * @returns {boolean}
 */
export function verifyOtpToken(token, email, otp) {
  if (!token || !email || !otp) return false;
  try {
    const secret = getSecret();
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx < 0) return false;
    const payload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    const sigBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.email !== email) return false;
    if (Date.now() > data.expiresAt) return false;

    const expectedHash = crypto
      .createHmac("sha256", secret)
      .update(otp)
      .digest("hex");
    const storedBuf = Buffer.from(data.hashedOtp, "hex");
    const expectedHashBuf = Buffer.from(expectedHash, "hex");
    if (storedBuf.length !== expectedHashBuf.length) return false;
    if (!crypto.timingSafeEqual(storedBuf, expectedHashBuf)) return false;

    return true;
  } catch {
    return false;
  }
}
