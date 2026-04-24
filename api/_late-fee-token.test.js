// api/_late-fee-token.test.js
// Unit tests for _late-fee-token.js — approve / decline / adjust actions

import { test } from "node:test";
import assert   from "node:assert/strict";

process.env.OTP_SECRET = "test-secret-for-late-fee-token-tests";

const {
  createLateFeeToken,
  verifyLateFeeToken,
  buildLateFeeUrls,
} = await import("./_late-fee-token.js");

// ── createLateFeeToken ────────────────────────────────────────────────────────

test("createLateFeeToken: returns a non-empty string for approve", () => {
  const tok = createLateFeeToken("bk-001", 50, "approve");
  assert.ok(typeof tok === "string" && tok.length > 0);
});

test("createLateFeeToken: returns a non-empty string for decline", () => {
  const tok = createLateFeeToken("bk-001", 50, "decline");
  assert.ok(typeof tok === "string" && tok.length > 0);
});

test("createLateFeeToken: returns a non-empty string for adjust", () => {
  const tok = createLateFeeToken("bk-001", 75, "adjust");
  assert.ok(typeof tok === "string" && tok.length > 0);
});

test("createLateFeeToken: throws for unknown action", () => {
  assert.throws(() => createLateFeeToken("bk-001", 50, "charge"), /action must be/);
});

test("createLateFeeToken: throws for non-positive amount", () => {
  assert.throws(() => createLateFeeToken("bk-001", 0, "approve"),    /positive number/);
  assert.throws(() => createLateFeeToken("bk-001", -10, "approve"),  /positive number/);
});

test("createLateFeeToken: throws for missing bookingId", () => {
  assert.throws(() => createLateFeeToken("", 50, "approve"), /bookingId is required/);
});

// ── verifyLateFeeToken ────────────────────────────────────────────────────────

test("verifyLateFeeToken: round-trips approve token correctly", () => {
  const tok = createLateFeeToken("bk-123", 75, "approve");
  const dec = verifyLateFeeToken(tok);
  assert.deepEqual(dec, { bookingId: "bk-123", amount: 75, action: "approve" });
});

test("verifyLateFeeToken: round-trips decline token correctly", () => {
  const tok = createLateFeeToken("bk-456", 100, "decline");
  const dec = verifyLateFeeToken(tok);
  assert.deepEqual(dec, { bookingId: "bk-456", amount: 100, action: "decline" });
});

test("verifyLateFeeToken: round-trips adjust token correctly", () => {
  const tok = createLateFeeToken("bk-789", 200, "adjust");
  const dec = verifyLateFeeToken(tok);
  assert.deepEqual(dec, { bookingId: "bk-789", amount: 200, action: "adjust" });
});

test("verifyLateFeeToken: returns null for tampered signature", () => {
  const tok = createLateFeeToken("bk-001", 50, "approve");
  const tampered = tok.slice(0, -4) + "xxxx";
  assert.equal(verifyLateFeeToken(tampered), null);
});

test("verifyLateFeeToken: returns null for null input", () => {
  assert.equal(verifyLateFeeToken(null), null);
});

test("verifyLateFeeToken: returns null for expired token (negative ttl)", () => {
  // ttl = -1000ms → exp is 1 second in the past → should be rejected
  const tok = createLateFeeToken("bk-001", 50, "approve", -1000);
  assert.equal(verifyLateFeeToken(tok), null);
});

test("verifyLateFeeToken: returns null for completely bogus string", () => {
  assert.equal(verifyLateFeeToken("notavalidtoken"), null);
});

test("verifyLateFeeToken: approve token does not verify as decline", () => {
  const tok = createLateFeeToken("bk-001", 50, "approve");
  const dec = verifyLateFeeToken(tok);
  assert.notEqual(dec?.action, "decline");
});

test("verifyLateFeeToken: adjust token does not verify as approve", () => {
  const tok = createLateFeeToken("bk-001", 50, "adjust");
  const dec = verifyLateFeeToken(tok);
  assert.notEqual(dec?.action, "approve");
});

test("verifyLateFeeToken: different bookingIds produce different tokens", () => {
  const t1 = createLateFeeToken("bk-001", 50, "approve");
  const t2 = createLateFeeToken("bk-002", 50, "approve");
  assert.notEqual(t1, t2);
});

test("verifyLateFeeToken: different amounts produce different tokens", () => {
  const t1 = createLateFeeToken("bk-001", 50,  "approve");
  const t2 = createLateFeeToken("bk-001", 100, "approve");
  assert.notEqual(t1, t2);
});

// ── buildLateFeeUrls ──────────────────────────────────────────────────────────

test("buildLateFeeUrls: returns approveUrl, declineUrl, and adjustUrl", () => {
  const { approveUrl, declineUrl, adjustUrl } = buildLateFeeUrls("bk-001", 50, "https://example.com");
  assert.ok(approveUrl.startsWith("https://example.com/api/approve-late-fee"));
  assert.ok(declineUrl.startsWith("https://example.com/api/approve-late-fee"));
  assert.ok(adjustUrl.startsWith("https://example.com/api/approve-late-fee"));
  assert.ok(approveUrl.includes("action=approve"));
  assert.ok(declineUrl.includes("action=decline"));
  assert.ok(adjustUrl.includes("action=adjust"));
});

test("buildLateFeeUrls: each URL contains the correct bookingId", () => {
  const { approveUrl, declineUrl, adjustUrl } = buildLateFeeUrls("bk-XYZ", 75, "https://example.com");
  assert.ok(approveUrl.includes("bk-XYZ"));
  assert.ok(declineUrl.includes("bk-XYZ"));
  assert.ok(adjustUrl.includes("bk-XYZ"));
});

test("buildLateFeeUrls: approve/decline/adjust URLs are all distinct", () => {
  const { approveUrl, declineUrl, adjustUrl } = buildLateFeeUrls("bk-001", 50, "https://example.com");
  assert.notEqual(approveUrl, declineUrl);
  assert.notEqual(approveUrl, adjustUrl);
  assert.notEqual(declineUrl, adjustUrl);
});

test("buildLateFeeUrls: tokens embedded in URLs are valid", () => {
  const { approveUrl, declineUrl, adjustUrl } = buildLateFeeUrls("bk-001", 50, "https://example.com");

  function extractToken(url) {
    const m = url.match(/[?&]token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  const approvePayload = verifyLateFeeToken(extractToken(approveUrl));
  const declinePayload = verifyLateFeeToken(extractToken(declineUrl));
  const adjustPayload  = verifyLateFeeToken(extractToken(adjustUrl));

  assert.equal(approvePayload?.action, "approve");
  assert.equal(declinePayload?.action, "decline");
  assert.equal(adjustPayload?.action,  "adjust");
});
