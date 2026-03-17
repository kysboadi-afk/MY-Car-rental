// Tests for api/_otp.js
// Validates OTP generation, token creation, and verification logic.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.OTP_SECRET = "test-otp-secret-for-unit-tests";

const { generateOtp, createOtpToken, verifyOtpToken } = await import("./_otp.js");

// ─── generateOtp ──────────────────────────────────────────────────────────────

test("generateOtp returns a 6-digit string", () => {
  const otp = generateOtp();
  assert.equal(typeof otp, "string");
  assert.match(otp, /^[0-9]{6}$/);
});

test("generateOtp is in range 100000–999999", () => {
  for (let i = 0; i < 20; i++) {
    const n = Number(generateOtp());
    assert.ok(n >= 100000 && n <= 999999, `Out of range: ${n}`);
  }
});

// ─── createOtpToken ───────────────────────────────────────────────────────────

test("createOtpToken returns a non-empty string with one dot separator", () => {
  const token = createOtpToken("user@example.com", "123456");
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
  assert.ok(token.includes("."));
});

test("different emails produce different tokens", () => {
  const t1 = createOtpToken("a@example.com", "111111");
  const t2 = createOtpToken("b@example.com", "111111");
  assert.notEqual(t1, t2);
});

test("different OTPs produce different tokens", () => {
  const t1 = createOtpToken("user@example.com", "111111");
  const t2 = createOtpToken("user@example.com", "222222");
  assert.notEqual(t1, t2);
});

// ─── verifyOtpToken ───────────────────────────────────────────────────────────

test("verifyOtpToken returns true for valid token, email, and OTP", () => {
  const otp = "482910";
  const token = createOtpToken("user@example.com", otp);
  assert.equal(verifyOtpToken(token, "user@example.com", otp), true);
});

test("verifyOtpToken returns false for wrong OTP", () => {
  const token = createOtpToken("user@example.com", "123456");
  assert.equal(verifyOtpToken(token, "user@example.com", "999999"), false);
});

test("verifyOtpToken returns false for wrong email", () => {
  const otp = "123456";
  const token = createOtpToken("user@example.com", otp);
  assert.equal(verifyOtpToken(token, "other@example.com", otp), false);
});

test("verifyOtpToken returns false for tampered token payload", () => {
  const otp = "123456";
  const token = createOtpToken("user@example.com", otp);
  // Flip one character in the payload portion
  const tampered = "X" + token.slice(1);
  assert.equal(verifyOtpToken(tampered, "user@example.com", otp), false);
});

test("verifyOtpToken returns false for tampered signature", () => {
  const otp = "123456";
  const token = createOtpToken("user@example.com", otp);
  const dotIdx = token.lastIndexOf(".");
  const tampered = token.slice(0, dotIdx + 1) + "XXXXXXXX";
  assert.equal(verifyOtpToken(tampered, "user@example.com", otp), false);
});

test("verifyOtpToken returns false for missing token", () => {
  assert.equal(verifyOtpToken(null, "user@example.com", "123456"), false);
  assert.equal(verifyOtpToken("", "user@example.com", "123456"), false);
});

test("verifyOtpToken returns false for missing email", () => {
  const token = createOtpToken("user@example.com", "123456");
  assert.equal(verifyOtpToken(token, null, "123456"), false);
  assert.equal(verifyOtpToken(token, "", "123456"), false);
});

test("verifyOtpToken returns false for missing otp", () => {
  const token = createOtpToken("user@example.com", "123456");
  assert.equal(verifyOtpToken(token, "user@example.com", null), false);
  assert.equal(verifyOtpToken(token, "user@example.com", ""), false);
});

test("verifyOtpToken returns false for expired token", () => {
  // Manually craft a token with an already-expired timestamp
  const secret = process.env.OTP_SECRET;
  const otp = "123456";
  const hashedOtp = crypto.createHmac("sha256", secret).update(otp).digest("hex");
  const payload = Buffer.from(
    JSON.stringify({ email: "user@example.com", hashedOtp, expiresAt: Date.now() - 1000 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const expiredToken = `${payload}.${sig}`;
  assert.equal(verifyOtpToken(expiredToken, "user@example.com", otp), false);
});
