// Tests for api/check-email.js
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Nodemailer mock ─────────────────────────────────────────────────────────
// A shared flag controls whether verify() succeeds or throws, so tests can
// exercise both paths without reassigning the mock implementation.
let verifyShouldFail = false;
let verifyError = new Error("Connection refused");

const mockVerify = mock.fn(async () => {
  if (verifyShouldFail) throw verifyError;
  return true;
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ verify: mockVerify }),
  },
});

// ─── Baseline env vars ────────────────────────────────────────────────────────
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "work@example.com";

const { default: handler } = await import("./check-email.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeRes() {
  const res = {
    _headers: {},
    _status: 200,
    _body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    end() { return this; },
    send(text) { this._body = text; return this; },
    json(obj) { this._body = obj; return this; },
  };
  return res;
}

function makeReq(method = "GET") {
  return { method, headers: {} };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("OPTIONS request returns 200", async () => {
  const req = makeReq("OPTIONS");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("non-GET request returns 405", async () => {
  const req = makeReq("POST");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("CORS header allows all origins", async () => {
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
});

test("overall passes when SMTP and OWNER_EMAIL are all set and connection succeeds", async () => {
  verifyShouldFail = false;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.ok(res._body.overall.startsWith("✅"), `Expected overall to start with ✅, got: ${res._body.overall}`);
});

test("report shows SMTP_HOST as set when configured", async () => {
  verifyShouldFail = false;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.ok(res._body.smtp.SMTP_HOST.startsWith("✅"), "SMTP_HOST should be marked as set");
  assert.ok(res._body.smtp.SMTP_HOST.includes("smtp.test.invalid"), "SMTP_HOST value should appear in the report");
});

test("report shows SMTP_USER and SMTP_PASS as set (without exposing values)", async () => {
  verifyShouldFail = false;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.ok(res._body.smtp.SMTP_USER.startsWith("✅"), "SMTP_USER should be marked as set");
  assert.ok(!res._body.smtp.SMTP_USER.includes("test@test.invalid"), "SMTP_USER value must not appear in the report");
  assert.ok(res._body.smtp.SMTP_PASS.startsWith("✅"), "SMTP_PASS should be marked as set");
  assert.ok(!res._body.smtp.SMTP_PASS.includes("test-password"), "SMTP_PASS value must not appear in the report");
});

test("report shows ownerEmail value and marks it as from env var", async () => {
  verifyShouldFail = false;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._body.ownerEmail.value, "work@example.com");
  assert.ok(res._body.ownerEmail.source.includes("OWNER_EMAIL"), "Source should mention env var name");
});

test("connection status is success when nodemailer verify resolves", async () => {
  verifyShouldFail = false;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.ok(res._body.connection.status.startsWith("✅"), "Connection should succeed");
});

test("connection status shows failure when nodemailer verify rejects", async () => {
  verifyShouldFail = true;
  verifyError = new Error("Connection refused");

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  verifyShouldFail = false;

  assert.ok(res._body.connection.status.startsWith("❌"), "Connection should fail");
  assert.ok(res._body.connection.status.includes("Connection refused"), "Error message should be included");
  assert.ok(res._body.overall.startsWith("❌"), `Overall should be ❌ when connection fails, got: ${res._body.overall}`);
});

test("Gmail hint is shown when SMTP_HOST contains gmail and connection fails", async () => {
  verifyShouldFail = true;
  verifyError = new Error("Invalid credentials");

  const savedHost = process.env.SMTP_HOST;
  process.env.SMTP_HOST = "smtp.gmail.com";

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  process.env.SMTP_HOST = savedHost;
  verifyShouldFail = false;

  assert.ok(res._body.connection.hint, "A hint should be provided for Gmail failures");
  assert.ok(res._body.connection.hint.toLowerCase().includes("gmail"), "Hint should mention Gmail");
  assert.ok(res._body.connection.hint.includes("App Password"), "Hint should mention App Password");
});

test("when SMTP_HOST is missing, connection check is skipped and overall is failure", async () => {
  const savedHost = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  process.env.SMTP_HOST = savedHost;

  assert.ok(res._body.smtp.SMTP_HOST.startsWith("❌"), "SMTP_HOST should be marked as not set");
  assert.ok(res._body.connection.status.startsWith("⏭"), "Connection check should be skipped");
  assert.ok(res._body.overall.startsWith("❌"), "Overall should be failure");
});

test("when SMTP_USER is missing, connection check is skipped", async () => {
  const savedUser = process.env.SMTP_USER;
  delete process.env.SMTP_USER;

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  process.env.SMTP_USER = savedUser;

  assert.ok(res._body.smtp.SMTP_USER.startsWith("❌"), "SMTP_USER should be marked as not set");
  assert.ok(res._body.connection.status.startsWith("⏭"), "Connection check should be skipped");
  assert.ok(res._body.connection.status.includes("SMTP_USER"), "Skipped message should name the missing var");
});

test("when SMTP_PASS is missing, connection check is skipped", async () => {
  const savedPass = process.env.SMTP_PASS;
  delete process.env.SMTP_PASS;

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  process.env.SMTP_PASS = savedPass;

  assert.ok(res._body.smtp.SMTP_PASS.startsWith("❌"), "SMTP_PASS should be marked as not set");
  assert.ok(res._body.connection.status.startsWith("⏭"), "Connection check should be skipped");
});

test("when OWNER_EMAIL is not set, uses default and warns in overall", async () => {
  verifyShouldFail = false;
  const savedOwner = process.env.OWNER_EMAIL;
  delete process.env.OWNER_EMAIL;

  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  process.env.OWNER_EMAIL = savedOwner;

  assert.ok(
    res._body.ownerEmail.source.includes("default"),
    "Source should mention 'default' when OWNER_EMAIL is not set"
  );
  assert.ok(
    res._body.ownerEmail.hint.includes("⚠️"),
    "Hint should warn when using default"
  );
  assert.ok(
    res._body.overall.startsWith("⚠️"),
    `Overall should be ⚠️ when SMTP is fine but OWNER_EMAIL is default, got: ${res._body.overall}`
  );
});

test("report includes a timestamp", async () => {
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);

  assert.ok(typeof res._body.timestamp === "string", "timestamp should be present");
  assert.ok(!isNaN(Date.parse(res._body.timestamp)), "timestamp should be a valid ISO date string");
});

