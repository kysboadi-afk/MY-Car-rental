// Tests for api/send-contact-email.js
// Validates that contact form submissions are emailed to the owner
// and that OTP verification is enforced before sending.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SMTP + OTP env vars ─────────────────────────────────────────────────────
process.env.SMTP_HOST   = "smtp.test.invalid";
process.env.SMTP_PORT   = "587";
process.env.SMTP_USER   = "test@test.invalid";
process.env.SMTP_PASS   = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";
process.env.OTP_SECRET  = "test-otp-secret-for-contact-email-tests";

// ─── Nodemailer mock ─────────────────────────────────────────────────────────
const sentMails = [];
const mockSendMail = mock.fn(async (opts) => { sentMails.push(opts); });

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

const { default: handler } = await import("./send-contact-email.js");
const { createOtpToken }   = await import("./_otp.js");

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

// Build a valid body with a fresh OTP token each time (tokens expire in 10 min)
function makeValidBody(overrides = {}) {
  const email = overrides.email ?? "bob@example.com";
  const otp   = "482910";
  return {
    name:     "Bob Contact",
    email,
    phone:    "3105550199",
    message:  "Hello, I have a question about renting a Camry.",
    otpCode:  otp,
    otpToken: createOtpToken(email, otp),
    ...overrides,
  };
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
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody(), "https://www.slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("does not set CORS header for unknown origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody(), "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 400 when required fields are missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { name: "Bob" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 when message is missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { name: "Bob", email: "bob@example.com", phone: "123" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 when OTP token is missing", async () => {
  const res = makeRes();
  const body = makeValidBody();
  delete body.otpToken;
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 when OTP code is missing", async () => {
  const res = makeRes();
  const body = makeValidBody();
  delete body.otpCode;
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 for incorrect OTP code", async () => {
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody({ otpCode: "000000" })), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 400 for OTP token bound to different email", async () => {
  const res = makeRes();
  const body = makeValidBody();
  // Override email so it no longer matches the token
  body.email = "attacker@example.com";
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 200 and sends two emails for valid contact submission", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(sentMails.length, 2);
});

test("response includes a submissionId", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  assert.ok(typeof res._body.submissionId === "string" && res._body.submissionId.startsWith("SLY-"),
    `Expected submissionId starting with SLY-, got: ${res._body.submissionId}`);
});

test("sends email to OWNER_EMAIL", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  assert.equal(sentMails[0].to, "owner@test.invalid");
});

test("email subject contains sender name", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  assert.ok(sentMails[0].subject.includes("Bob Contact"),
    `Expected subject to include sender name, got: ${sentMails[0].subject}`);
});

test("email html contains all four contact fields", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  const html = sentMails[0].html;
  assert.ok(html.includes("Bob Contact"));
  assert.ok(html.includes("bob@example.com"));
  assert.ok(html.includes("3105550199"));
  assert.ok(html.includes("Hello, I have a question about renting a Camry."));
});

test("html-escapes special characters to prevent XSS", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const xssEmail = "x@example.com";
  const xssOtp   = "111111";
  await handler(makeReq("POST", {
    name:     '<script>alert(1)</script>',
    email:    xssEmail,
    phone:    "1234567",
    message:  '<img src=x onerror=alert(2)>',
    otpCode:  xssOtp,
    otpToken: createOtpToken(xssEmail, xssOtp),
  }), res);
  assert.equal(res._status, 200);
  const html = sentMails[0].html;
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("sets replyTo to the sender email", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  assert.equal(sentMails[0].replyTo, "bob@example.com");
});

test("owner email subject includes submission ID", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  assert.ok(sentMails[0].subject.includes(res._body.submissionId),
    `Expected subject to include submission ID`);
});

// ─── Honeypot ─────────────────────────────────────────────────────────────────

test("returns 400 when honeypot field is filled", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody({ honeypot: "http://spam.example.com" })), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
  assert.equal(sentMails.length, 0, "No emails should be sent for honeypot submissions");
});

test("returns 200 when honeypot field is empty string", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody({ honeypot: "" })), res);
  assert.equal(res._status, 200);
});

test("returns 200 when honeypot field is absent", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = makeValidBody();
  delete body.honeypot;
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 200);
});

// ─── Auto-reply ───────────────────────────────────────────────────────────────

test("auto-reply is sent to the submitter's email address", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  const autoReply = sentMails[1];
  assert.equal(autoReply.to, "bob@example.com");
});

test("auto-reply subject contains the submission ID", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  const autoReply = sentMails[1];
  assert.ok(autoReply.subject.includes(res._body.submissionId),
    `Expected auto-reply subject to include submission ID`);
});

test("auto-reply body contains the submission ID", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  const autoReply = sentMails[1];
  assert.ok(autoReply.text.includes(res._body.submissionId));
  assert.ok(autoReply.html.includes(res._body.submissionId));
});

test("auto-reply body contains the expected response time (5-15 minutes)", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  const autoReply = sentMails[1];
  assert.ok(autoReply.text.includes("5") && autoReply.text.includes("15"),
    "Auto-reply text should mention 5 and 15 minute response window");
  assert.ok(autoReply.html.includes("5") && autoReply.html.includes("15"),
    "Auto-reply HTML should mention 5 and 15 minute response window");
});

test("auto-reply body contains the business phone number", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", makeValidBody()), res);
  const autoReply = sentMails[1];
  assert.ok(autoReply.text.includes("(213) 916-6606"),
    "Auto-reply text should contain business phone number");
  assert.ok(autoReply.html.includes("(213) 916-6606"),
    "Auto-reply HTML should contain business phone number");
});

test("auto-reply failure does not prevent 200 response", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  // Owner email succeeds; auto-reply throws
  let callCount = 0;
  mockSendMail.mock.mockImplementation(async (opts) => {
    callCount++;
    if (callCount === 1) { sentMails.push(opts); return; } // owner succeeds
    throw new Error("SMTP auto-reply failure");             // auto-reply fails
  });

  const res = makeRes();
  try {
    await handler(makeReq("POST", makeValidBody()), res);
    assert.equal(res._status, 200, "Should still return 200 when auto-reply fails");
    assert.equal(res._body.success, true);
    assert.equal(sentMails.length, 1, "Only owner email recorded when auto-reply fails");
  } finally {
    mockSendMail.mock.mockImplementation(async (opts) => { sentMails.push(opts); });
  }
});

