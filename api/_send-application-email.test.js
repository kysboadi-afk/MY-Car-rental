// Tests for api/send-application-email.js
// Validates that driver applications are emailed to the owner with the
// license as an attachment, pre-approval logic, SMS dispatch, and
// XSS/oversized payload guards.
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

// ─── TextMagic env vars ───────────────────────────────────────────────────────
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY  = "test-api-key-00000000000000000000000";

// ─── Nodemailer mock ──────────────────────────────────────────────────────────
const sentMails = [];
const mockSendMail = mock.fn(async (opts) => { sentMails.push(opts); });

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

// ─── TextMagic mock ───────────────────────────────────────────────────────────
const sentMessages = [];
const mockSendSms = mock.fn(async (to, text) => { sentMessages.push({ to, text }); return {}; });

mock.module("./_textmagic.js", {
  namedExports: { sendSms: mockSendSms },
});

const { default: handler } = await import("./send-application-email.js");

const TEST_PHONE = "3105550199";

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
  phone: TEST_PHONE,
  age: 25,
  experience: "3–5 years",
  apps: ["DoorDash", "Uber Eats"],
  agreeTerms: true,
  licenseFileName: "license.jpg",
  licenseMimeType: "image/jpeg",
  licenseBase64: Buffer.from("fake-image-data").toString("base64"),
};

const VALID_BODY_WITH_EMAIL = {
  ...VALID_BODY,
  email: "jane@example.com",
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

test("email html contains all application fields including age and apps", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  const html = sentMails[0].html;
  assert.ok(html.includes("Jane Driver"));
  assert.ok(html.includes("3105550199"));
  assert.ok(html.includes("25"));
  assert.ok(html.includes("3\u20135 years"));
  assert.ok(html.includes("DoorDash"));
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
  const body = { name: "Jane Driver", phone: TEST_PHONE, age: 25, experience: "3–5 years", agreeTerms: true };
  await handler(makeReq("POST", body), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails[0].attachments.length, 0);
});

test("html-escapes special characters to prevent XSS", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {
    name: "<script>alert(1)</script>",
    phone: TEST_PHONE,
    age: 25,
    experience: "<img src=x onerror=alert(1)>",
    agreeTerms: true,
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

// ─── Pre-approval decision tests ─────────────────────────────────────────────

test("decision is 'approved' for qualified applicant", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._body.decision, "approved");
});

test("decision is 'declined' when age is under 21", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, age: 19 }), res);
  assert.equal(res._body.decision, "declined");
});

test("decision is 'declined' when experience is less than 3 months", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, experience: "Less than 3 months" }), res);
  assert.equal(res._body.decision, "declined");
});

test("decision is 'review' when license is missing", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = { name: "Jane Driver", phone: TEST_PHONE, age: 25, experience: "3–5 years", agreeTerms: true };
  await handler(makeReq("POST", body), res);
  assert.equal(res._body.decision, "review");
});

test("decision is 'review' when terms are not agreed", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, agreeTerms: false }), res);
  assert.equal(res._body.decision, "review");
});

test("email subject contains decision label", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.ok(
    sentMails[0].subject.toLowerCase().includes("approved"),
    `Expected subject to contain decision, got: ${sentMails[0].subject}`
  );
});

// ─── SMS dispatch tests ───────────────────────────────────────────────────────

test("sends approved SMS for qualified applicant", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.includes("approved"),
    `Expected approved SMS body, got: ${sentMessages[0].text}`
  );
  assert.ok(sentMessages[0].text.includes("www.slytrans.com/cars"));
});

test("sends declined SMS when age is under 21", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, age: 18 }), res);
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.includes("does not meet our current rental requirements"),
    `Expected declined SMS body, got: ${sentMessages[0].text}`
  );
});

test("sends review SMS when license is missing", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  const body = { name: "Jane Driver", phone: TEST_PHONE, age: 25, experience: "3–5 years", agreeTerms: true };
  await handler(makeReq("POST", body), res);
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.includes("under review"),
    `Expected review SMS body, got: ${sentMessages[0].text}`
  );
});

test("SMS is sent to applicant phone number", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMessages[0].to, "+13105550199");
});

test("SMS contains first name in review/declined messages", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, age: 18 }), res);
  assert.ok(
    sentMessages[0].text.includes("Jane"),
    `Expected first name in SMS, got: ${sentMessages[0].text}`
  );
});

// ─── Applicant decision email tests ──────────────────────────────────────────

test("sends applicant email when email is provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(res._status, 200);
  assert.equal(sentMails.length, 2, "Expected 2 emails: owner + applicant");
});

test("does not send applicant email when email is omitted", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(sentMails.length, 1, "Expected only 1 email (owner) when no applicant email");
});

test("does not send applicant email for invalid email address", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, email: "not-an-email" }), res);
  assert.equal(sentMails.length, 1, "Expected only owner email for invalid applicant email");
});

test("applicant email is sent to applicant address", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(sentMails[1].to, "jane@example.com");
});

test("owner email is still sent when applicant email is provided", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(sentMails[0].to, "owner@test.invalid");
});

test("applicant approval email subject contains 'Approved'", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(res._body.decision, "approved");
  assert.ok(
    sentMails[1].subject.toLowerCase().includes("approved"),
    `Expected approval subject, got: ${sentMails[1].subject}`
  );
});

test("applicant review email subject contains 'Review'", async () => {
  sentMails.length = 0;
  const res = makeRes();
  const body = { ...VALID_BODY_WITH_EMAIL, licenseBase64: undefined, licenseFileName: undefined, licenseMimeType: undefined };
  await handler(makeReq("POST", body), res);
  assert.equal(res._body.decision, "review");
  assert.ok(
    sentMails[1].subject.toLowerCase().includes("review"),
    `Expected review subject, got: ${sentMails[1].subject}`
  );
});

test("applicant declined email is sent when age is under 21", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY_WITH_EMAIL, age: 19 }), res);
  assert.equal(res._body.decision, "declined");
  assert.equal(sentMails.length, 2, "Expected owner + applicant decline emails");
  assert.equal(sentMails[1].to, "jane@example.com");
  assert.ok(
    sentMails[1].html.includes("unable to approve"),
    `Expected decline message in html, got: ${sentMails[1].html}`
  );
});

test("applicant email html contains applicant first name", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.ok(
    sentMails[1].html.includes("Jane"),
    `Expected first name in applicant email html`
  );
});

test("applicant approval email html contains booking link", async () => {
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY_WITH_EMAIL), res);
  assert.equal(res._body.decision, "approved");
  assert.ok(
    sentMails[1].html.includes("www.slytrans.com/cars"),
    `Expected booking link in approval email`
  );
});

