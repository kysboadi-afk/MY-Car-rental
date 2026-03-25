// Tests for api/send-email-otp.js
// Validates that a 6-digit OTP is emailed and a signed token is returned.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SMTP + OTP env vars ─────────────────────────────────────────────────────
process.env.SMTP_HOST    = "smtp.test.invalid";
process.env.SMTP_PORT    = "587";
process.env.SMTP_USER    = "test@test.invalid";
process.env.SMTP_PASS    = "test-password";
process.env.OTP_SECRET   = "test-otp-secret-for-send-email-otp-tests";

// ─── Nodemailer mock ─────────────────────────────────────────────────────────
const sentMails = [];
const mockSendMail = mock.fn(async (opts) => { sentMails.push(opts); });

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

const { default: handler } = await import("./send-email-otp.js");

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
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }, "https://www.slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("does not set CORS header for unknown origin", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }, "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 400 when email is missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", {}), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 for invalid email format", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { email: "not-an-email" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 200 and a token for valid email", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }), res);
  assert.equal(res._status, 200);
  assert.ok(typeof res._body.token === "string" && res._body.token.length > 0,
    `Expected token string, got: ${JSON.stringify(res._body)}`);
});

test("sends OTP email to the supplied address", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "recipient@example.com" }), res);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, "recipient@example.com");
});

test("email subject mentions verification", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }), res);
  assert.ok(
    sentMails[0].subject.toLowerCase().includes("verif"),
    `Expected verification subject, got: ${sentMails[0].subject}`
  );
});

test("email body contains a 6-digit code", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }), res);
  assert.match(sentMails[0].text, /\b[0-9]{6}\b/);
});

test("returned token verifies the sent OTP", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }), res);
  // Extract OTP from the plain-text email
  const match = sentMails[0].text.match(/\b([0-9]{6})\b/);
  assert.ok(match, "No 6-digit OTP found in email text");
  const otp = match[1];

  // Import verifyOtpToken to confirm the token is correct
  const { verifyOtpToken } = await import("./_otp.js");
  assert.equal(verifyOtpToken(res._body.token, "user@example.com", otp), true);
});

test("token does not verify with wrong OTP", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { email: "user@example.com" }), res);
  const { verifyOtpToken } = await import("./_otp.js");
  assert.equal(verifyOtpToken(res._body.token, "user@example.com", "000000"), false);
});
