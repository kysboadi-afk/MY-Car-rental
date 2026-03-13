// Tests for api/send-sms.js
// Validates that an SMS is sent via Twilio when a visitor submits the lead form.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Twilio env vars ──────────────────────────────────────────────────────────
process.env.TWILIO_ACCOUNT_SID   = "ACtest00000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN    = "test_auth_token_00000000000000000000";
process.env.TWILIO_PHONE_NUMBER  = "+18773155034";

// ─── Twilio mock ──────────────────────────────────────────────────────────────
const sentMessages = [];
const mockCreate = mock.fn(async (opts) => { sentMessages.push(opts); return {}; });

mock.module("twilio", {
  defaultExport: () => ({
    messages: { create: mockCreate },
  }),
});

const { default: handler } = await import("./send-sms.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function makeReq(method, body = {}, origin = "https://www.slytrans.com") {
  return { method, headers: { origin }, body };
}

const VALID_BODY = { name: "Alice Tester", phone: "3105550123" };

// ─── Tests ────────────────────────────────────────────────────────────────────

test("OPTIONS preflight returns 200", async () => {
  const res = makeRes();
  await handler(makeReq("OPTIONS"), res);
  assert.equal(res._status, 200);
});

test("non-POST returns 405", async () => {
  const res = makeRes();
  await handler(makeReq("GET"), res);
  assert.equal(res._status, 405);
});

test("sets CORS header for allowed origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY, "https://www.slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("does not set CORS header for unknown origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY, "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 400 when required fields are missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { name: "Alice" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 200 and sends SMS for valid request", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(sentMessages.length, 1);
});

test("SMS is sent to the visitor phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMessages[0].to, "3105550123");
});

test("SMS is sent from the configured Twilio phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMessages[0].from, "+18773155034");
});

test("SMS body contains the expected message", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  const body = sentMessages[0].body;
  assert.ok(body.includes("SLY Services"), `Expected body to mention SLY Services, got: ${body}`);
  assert.ok(body.includes("for vehicle rentals"), `Expected body to mention vehicle rentals, got: ${body}`);
  assert.ok(body.includes("Reply STOP"), `Expected body to include opt-out instruction, got: ${body}`);
});

test("returns 500 when Twilio credentials are missing", async () => {
  const savedSid   = process.env.TWILIO_ACCOUNT_SID;
  const savedToken = process.env.TWILIO_AUTH_TOKEN;
  const savedPhone = process.env.TWILIO_PHONE_NUMBER;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;

  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);

  process.env.TWILIO_ACCOUNT_SID  = savedSid;
  process.env.TWILIO_AUTH_TOKEN   = savedToken;
  process.env.TWILIO_PHONE_NUMBER = savedPhone;
});
