// Tests for api/send-reservation-email.js
// Validates the recent update: renter name field + awaited email fetch fix.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SMTP env vars (must be set before handler is imported) ─────────────────
// The handler guards against missing SMTP credentials before entering the
// try block. Set fake values here so the guard passes; nodemailer itself is
// mocked below and never actually connects to an SMTP server.
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";

// ─── Nodemailer mock ────────────────────────────────────────────────────────
// Must be registered before the handler module is imported so the
// module-level `nodemailer.createTransport()` call picks up the mock.

const sentMails = [];
const mockSendMail = mock.fn(async (opts) => { sentMails.push(opts); });

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

// Dynamic import so the mock above is already in place when the module loads.
const { default: handler } = await import("./send-reservation-email.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  return {
    method,
    headers: { origin },
    body,
  };
}

const VALID_BODY = {
  car: "Camry 2012",
  name: "Jane Doe",
  pickup: "2026-03-01",
  pickupTime: "10:00 AM",
  returnDate: "2026-03-05",
  returnTime: "10:00 AM",
  email: "jane@example.com",
  phone: "555-1234",
  total: "200",
  pricePerDay: 50,
  deposit: 0,
  days: 4,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

test("OPTIONS request returns 200", async () => {
  const req = makeReq("OPTIONS");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("non-POST request returns 405", async () => {
  const req = makeReq("GET");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("CORS header is set for allowed origin www.slytrans.com", async () => {
  const req = makeReq("OPTIONS", {}, "https://www.slytrans.com");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("CORS header is set for allowed origin slytrans.com", async () => {
  const req = makeReq("OPTIONS", {}, "https://slytrans.com");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://slytrans.com");
});

test("CORS header is NOT set for unknown origin", async () => {
  const req = makeReq("OPTIONS", {}, "https://evil.example.com");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("valid POST sends owner email containing renter name", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true });

  // Owner email is the first call; it must contain the renter's name
  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should have been sent");
  assert.ok(
    ownerMail.html.includes("Renter Name"),
    "Owner email HTML should contain 'Renter Name' label"
  );
  assert.ok(
    ownerMail.html.includes("Jane Doe"),
    "Owner email HTML should contain the renter's actual name"
  );
});

test("renter name with HTML special characters is escaped in owner email", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", {
    ...VALID_BODY,
    name: '<script>alert("xss")</script>',
  });
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should have been sent");
  assert.ok(
    !ownerMail.html.includes("<script>"),
    "Raw <script> tag must not appear in email HTML"
  );
  assert.ok(
    ownerMail.html.includes("&lt;script&gt;"),
    "Script tag must be HTML-escaped in email"
  );
});

test("valid POST sends customer confirmation email when email is provided", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  // sendMail should be called twice: once for owner, once for customer
  assert.equal(mockSendMail.mock.callCount(), 2, "sendMail should be called twice");
  const customerMail = sentMails[1];
  assert.equal(customerMail.to, VALID_BODY.email);
});

test("no customer email is sent when email is omitted", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const bodyWithoutEmail = { ...VALID_BODY, email: undefined };
  const req = makeReq("POST", bodyWithoutEmail);
  const res = makeRes();
  await handler(req, res);

  // Only the owner email should be sent
  assert.equal(mockSendMail.mock.callCount(), 1, "sendMail should be called once (owner only)");
});

test("owner email subject includes vehicle name", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(
    ownerMail.subject.includes("Camry 2012"),
    "Owner email subject should include vehicle name"
  );
});

test("owner email contains renter phone, email, and booking dates", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  const { html } = sentMails[0];
  assert.ok(html.includes("555-1234"), "Should include phone");
  assert.ok(html.includes("jane@example.com"), "Should include email");
  assert.ok(html.includes("2026-03-01"), "Should include pickup date");
  assert.ok(html.includes("2026-03-05"), "Should include return date");
});

test("owner email notes when no ID was uploaded", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", { ...VALID_BODY, idBase64: null, idFileName: null });
  const res = makeRes();
  await handler(req, res);

  const { html } = sentMails[0];
  assert.ok(html.includes("No ID was uploaded"), "Should warn when no ID uploaded");
});

test("owner email notes when ID is attached", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", {
    ...VALID_BODY,
    idBase64: "ZmFrZWRhdGE=",
    idFileName: "license.jpg",
    idMimeType: "image/jpeg",
  });
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(
    ownerMail.html.includes("Renter&#39;s ID is attached") ||
    ownerMail.html.includes("Renter's ID is attached"),
    "Should mention attached ID"
  );
  assert.equal(ownerMail.attachments.length, 1, "Should have one attachment");
  assert.equal(ownerMail.attachments[0].filename, "license.jpg");
});

test("returns 500 when SMTP credentials are not configured", async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedUser = process.env.SMTP_USER;
  const savedPass = process.env.SMTP_PASS;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  process.env.SMTP_HOST = savedHost;
  process.env.SMTP_USER = savedUser;
  process.env.SMTP_PASS = savedPass;

  assert.equal(res._status, 500);
  assert.ok(
    res._body.error.includes("SMTP"),
    "Error should mention SMTP so the operator knows what to configure"
  );
});
