// api/_identity-resume-token.test.js
// Unit tests for the identity verification recovery token helper.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OTP_SECRET = "test-secret-for-identity-resume-tokens";

const { createResumeToken, verifyResumeToken, buildResumeUrl } = await import("./_identity-resume-token.js");

const TEST_APP_ID = "8d3b1914-5f12-4f61-a0cb-b57f042080ab";

// ─── createResumeToken ────────────────────────────────────────────────────────

test("createResumeToken returns a non-empty string", () => {
  const token = createResumeToken(TEST_APP_ID);
  assert.ok(typeof token === "string" && token.length > 0);
});

test("createResumeToken token contains a dot separator", () => {
  const token = createResumeToken(TEST_APP_ID);
  assert.ok(token.includes("."));
});

test("createResumeToken throws when applicationId is empty string", () => {
  assert.throws(() => createResumeToken(""), /applicationId is required/);
});

test("createResumeToken throws when applicationId is null", () => {
  assert.throws(() => createResumeToken(null), /applicationId is required/);
});

test("createResumeToken throws when applicationId is undefined", () => {
  assert.throws(() => createResumeToken(undefined), /applicationId is required/);
});

test("createResumeToken accepts a custom TTL", () => {
  const token = createResumeToken(TEST_APP_ID, 60_000);
  assert.ok(typeof token === "string" && token.length > 0);
});

// ─── verifyResumeToken ────────────────────────────────────────────────────────

test("verifyResumeToken returns applicationId for a valid fresh token", () => {
  const token = createResumeToken(TEST_APP_ID);
  const result = verifyResumeToken(token);
  assert.equal(result, TEST_APP_ID);
});

test("verifyResumeToken returns null for an empty string", () => {
  assert.equal(verifyResumeToken(""), null);
});

test("verifyResumeToken returns null for null", () => {
  assert.equal(verifyResumeToken(null), null);
});

test("verifyResumeToken returns null for a token with no dot separator", () => {
  assert.equal(verifyResumeToken("nodothere"), null);
});

test("verifyResumeToken returns null for a tampered payload", () => {
  const token = createResumeToken(TEST_APP_ID);
  const lastDot = token.lastIndexOf(".");
  const payload = token.slice(0, lastDot);
  const sig     = token.slice(lastDot + 1);
  // Flip the last character of the payload
  const tampered = payload.slice(0, -1) + (payload.at(-1) === "A" ? "B" : "A");
  assert.equal(verifyResumeToken(`${tampered}.${sig}`), null);
});

test("verifyResumeToken returns null for a tampered signature", () => {
  const token  = createResumeToken(TEST_APP_ID);
  const lastDot = token.lastIndexOf(".");
  const payload = token.slice(0, lastDot);
  const sig     = token.slice(lastDot + 1);
  const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
  assert.equal(verifyResumeToken(`${payload}.${tamperedSig}`), null);
});

test("verifyResumeToken returns null for an expired token", () => {
  // TTL of -1 ms creates a token that expired immediately
  const token = createResumeToken(TEST_APP_ID, -1);
  assert.equal(verifyResumeToken(token), null);
});

test("verifyResumeToken trims leading/trailing whitespace from stored applicationId", () => {
  const token  = createResumeToken("  " + TEST_APP_ID + "  ");
  const result = verifyResumeToken(token);
  assert.equal(result, TEST_APP_ID);
});

test("verifyResumeToken returns null for completely invalid input", () => {
  assert.equal(verifyResumeToken("not.a.valid.token.at.all"), null);
});

test("verifyResumeToken two tokens for same applicationId are independently valid", () => {
  const t1 = createResumeToken(TEST_APP_ID);
  const t2 = createResumeToken(TEST_APP_ID);
  assert.equal(verifyResumeToken(t1), TEST_APP_ID);
  assert.equal(verifyResumeToken(t2), TEST_APP_ID);
});

test("verifyResumeToken tokens cannot be cross-verified across different applicationIds", () => {
  const token = createResumeToken(TEST_APP_ID);
  const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  // The token decodes to TEST_APP_ID, not 'other'
  const result = verifyResumeToken(token);
  assert.notEqual(result, other);
});

// ─── buildResumeUrl ───────────────────────────────────────────────────────────

test("buildResumeUrl returns a URL pointing to thank-you.html", () => {
  const url = buildResumeUrl(TEST_APP_ID);
  assert.ok(url.includes("thank-you.html"));
});

test("buildResumeUrl includes from=apply query param", () => {
  const url = buildResumeUrl(TEST_APP_ID);
  assert.ok(url.includes("from=apply"));
});

test("buildResumeUrl includes the applicationId as a query param", () => {
  const url = buildResumeUrl(TEST_APP_ID);
  assert.ok(url.includes(`applicationId=${encodeURIComponent(TEST_APP_ID)}`));
});

test("buildResumeUrl defaults to www.slytrans.com origin", () => {
  const url = buildResumeUrl(TEST_APP_ID);
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, "www.slytrans.com");
});

test("buildResumeUrl respects a custom baseUrl", () => {
  const url = buildResumeUrl(TEST_APP_ID, "https://staging.slytrans.com");
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "staging.slytrans.com");
  assert.ok(url.includes(`applicationId=${encodeURIComponent(TEST_APP_ID)}`));
});

test("buildResumeUrl strips a trailing slash from baseUrl", () => {
  const url = buildResumeUrl(TEST_APP_ID, "https://www.slytrans.com/");
  assert.ok(!url.includes("//thank-you"), `Double slash found in: ${url}`);
});

test("buildResumeUrl throws when applicationId is empty", () => {
  assert.throws(() => buildResumeUrl(""), /applicationId is required/);
});

test("buildResumeUrl throws when applicationId is null", () => {
  assert.throws(() => buildResumeUrl(null), /applicationId is required/);
});

test("buildResumeUrl trims surrounding whitespace in applicationId", () => {
  const url = buildResumeUrl("  " + TEST_APP_ID + "  ");
  assert.ok(url.includes(`applicationId=${encodeURIComponent(TEST_APP_ID)}`));
});
