// Tests for api/_waitlist-token.js
// Validates HMAC token creation and verification for waitlist approve/decline decisions.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OTP_SECRET = "test-waitlist-token-secret-abc123";

const { createDecisionToken, verifyDecisionToken } = await import("./_waitlist-token.js");

test("createDecisionToken returns a non-empty string", () => {
  const token = createDecisionToken("camry", "abc123");
  assert.ok(typeof token === "string" && token.length > 0);
});

test("verifyDecisionToken returns correct payload for a valid token", () => {
  const vehicleId = "camry";
  const entryId   = "deadbeef1234";
  const token = createDecisionToken(vehicleId, entryId);
  const result = verifyDecisionToken(token);
  assert.ok(result !== null);
  assert.equal(result.vehicleId, vehicleId);
  assert.equal(result.entryId,   entryId);
});

test("verifyDecisionToken returns null for a tampered token", () => {
  const token = createDecisionToken("camry", "entry001");
  // Flip the last character to simulate tampering
  const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
  assert.equal(verifyDecisionToken(tampered), null);
});

test("verifyDecisionToken returns null for an empty string", () => {
  assert.equal(verifyDecisionToken(""), null);
});

test("verifyDecisionToken returns null for null", () => {
  assert.equal(verifyDecisionToken(null), null);
});

test("verifyDecisionToken returns null for a token with no dot separator", () => {
  assert.equal(verifyDecisionToken("nodottoken"), null);
});

test("two different entries produce different tokens", () => {
  const t1 = createDecisionToken("camry", "entry001");
  const t2 = createDecisionToken("camry", "entry002");
  assert.notEqual(t1, t2);
});

test("two different vehicles produce different tokens", () => {
  const t1 = createDecisionToken("camry", "entry001");
  const t2 = createDecisionToken("camry",     "entry001");
  assert.notEqual(t1, t2);
});

test("token from one entry does not verify as another entry", () => {
  const token = createDecisionToken("camry", "entry001");
  // Manually build a payload for a different entry and splice in the original sig
  const fakeParts = token.split(".");
  const fakePayload = Buffer.from(JSON.stringify({ vehicleId: "camry", entryId: "entry002" })).toString("base64url");
  const spoofedToken = `${fakePayload}.${fakeParts[1]}`;
  assert.equal(verifyDecisionToken(spoofedToken), null);
});
