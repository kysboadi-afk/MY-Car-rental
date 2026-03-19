// Tests for api/send-phone-otp.js
// Validates that a 6-digit OTP is sent via SMS and a signed token is returned.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Twilio + OTP env vars ────────────────────────────────────────────────────
process.env.TWILIO_ACCOUNT_SID   = "ACtest00000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN    = "test-auth-token";
process.env.TWILIO_PHONE_NUMBER  = "+18773155034";
process.env.OTP_SECRET           = "test-otp-secret-for-send-phone-otp-tests";

// ─── Twilio mock ──────────────────────────────────────────────────────────────
const sentMessages = [];
const mockCreate = mock.fn(async (opts) => { sentMessages.push(opts); return {}; });

mock.module("twilio", {
  defaultExport: () => ({
    messages: { create: mockCreate },
  }),
});

const { default: handler } = await import("./send-phone-otp.js");

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

function makeReq(method, body = {}, origin = "https://www.slytrans.com") {
  return { method, headers: { origin }, body };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

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
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }, "https://www.slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("does not set CORS header for unknown origin", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }, "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 400 when phone is missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", {}), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 for phone with too few digits", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { phone: "12345" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 200 and a token for a valid 10-digit US phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }), res);
  assert.equal(res._status, 200);
  assert.ok(typeof res._body.token === "string" && res._body.token.length > 0,
    `Expected token string, got: ${JSON.stringify(res._body)}`);
});

test("returns 200 and a token for a valid E.164 phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "+12135550100" }), res);
  assert.equal(res._status, 200);
  assert.ok(typeof res._body.token === "string" && res._body.token.length > 0);
});

test("sends SMS to the normalised E.164 number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550199" }), res);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, "+12135550199");
});

test("SMS body contains a 6-digit code", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }), res);
  assert.match(sentMessages[0].body, /\b[0-9]{6}\b/);
});

test("returned token verifies the sent OTP", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }), res);

  // Extract the 6-digit code from the SMS body
  const match = sentMessages[0].body.match(/\b([0-9]{6})\b/);
  assert.ok(match, "No 6-digit OTP found in SMS body");
  const otp = match[1];

  const { verifyPhoneOtpToken } = await import("./_otp.js");
  // normalised form the handler uses
  assert.equal(verifyPhoneOtpToken(res._body.token, "+12135550100", otp), true);
});

test("token does not verify with wrong OTP", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }), res);
  const { verifyPhoneOtpToken } = await import("./_otp.js");
  assert.equal(verifyPhoneOtpToken(res._body.token, "+12135550100", "000000"), false);
});

test("token does not verify against a different phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "2135550100" }), res);
  const match = sentMessages[0].body.match(/\b([0-9]{6})\b/);
  const otp = match[1];
  const { verifyPhoneOtpToken } = await import("./_otp.js");
  assert.equal(verifyPhoneOtpToken(res._body.token, "+12135550199", otp), false);
});
