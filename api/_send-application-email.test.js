// Tests for api/send-application-email.js
// Validates that driver applications are emailed to the owner with the
// license as an attachment, and that XSS/oversized payload guards work.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SMTP env vars ────────────────────────────────────────────────────────────
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";

// ─── Nodemailer mock ──────────────────────────────────────────────────────────
const sentMails = [];
const mockSendMail = mock.fn(async (opts) => { sentMails.push(opts); });

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

const { default: handler } = await import("./send-application-email.js");

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

const VALID_BODY = {
  name: "Jane Driver",
  phone: "3105550199",
  experience: "3–5 years",
  licenseFileName: "license.jpg",
  licenseMimeType: "image/jpeg",
  licenseBase64: Buffer.from("fake-image-data").toString("base64"),
};

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
  await handler(makeReq("POST", { name: "Jane" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});

test("returns 200 and sends email for valid application", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(sentMails.length, 1);
});

test("sends email to OWNER_EMAIL", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMails[0].to, "owner@test.invalid");
});

test("email subject contains applicant name", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.ok(
    sentMails[0].subject.includes("Jane Driver"),
    `Expected subject to include applicant name, got: ${sentMails[0].subject}`
  );
});

test("email html contains all application fields", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  const html = sentMails[0].html;
  assert.ok(html.includes("Jane Driver"));
  assert.ok(html.includes("3105550199"));
  assert.ok(html.includes("3\u20135 years"));
  assert.ok(html.includes("license.jpg"));
});

test("attaches license file when base64 data is provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMails[0].attachments.length, 1);
  assert.equal(sentMails[0].attachments[0].filename, "license.jpg");
  assert.equal(sentMails[0].attachments[0].contentType, "image/jpeg");
});

test("sends without attachment when license fields are omitted", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = { name: "Jane Driver", phone: "3105550199", experience: "Less than 1 year" };
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails[0].attachments.length, 0);
});

test("html-escapes special characters to prevent XSS", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {
    name: "<script>alert(1)</script>",
    phone: "1234567",
    experience: "<img src=x onerror=alert(1)>",
  }), res);
  assert.equal(res._status, 200);
  const html = sentMails[0].html;
  // Tags must be escaped — no raw < or > in user-supplied values
  assert.ok(!html.includes("<script>"), "raw <script> tag must not appear");
  assert.ok(html.includes("&lt;script&gt;"), "escaped &lt;script&gt; must appear");
  assert.ok(!html.includes("<img"), "raw <img> tag must not appear");
  assert.ok(html.includes("&lt;img"), "escaped &lt;img must appear");
});

test("rejects oversized license base64 payload", async () => {
  const res = makeRes();
  const bigB64 = "A".repeat(15_000_000);
  await handler(makeReq("POST", { ...VALID_BODY, licenseBase64: bigB64 }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error);
});
