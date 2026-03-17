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

// ─── blockBookedDates + markVehicleUnavailable shared mock helpers ─────────

const MOCK_BOOKED_DATES_CONTENT =
  Buffer.from(JSON.stringify({ slingshot: [], camry: [] }, null, 2) + "\n").toString("base64");

const MOCK_FLEET_STATUS_CONTENT =
  Buffer.from(
    JSON.stringify({ slingshot: { available: true }, camry: { available: true } }, null, 2) + "\n"
  ).toString("base64");

/**
 * Build a URL-routing fetch mock.
 * - booked-dates.json GETs → MOCK_BOOKED_DATES_CONTENT
 * - fleet-status.json GETs → MOCK_FLEET_STATUS_CONTENT
 * - All PUTs → ok:true
 * - Captures every call into the provided array.
 */
function makeGitHubFetchMock(calls) {
  return async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET", body: opts && opts.body });
    if (opts && opts.method === "PUT") return { ok: true, json: async () => ({}) };
    if (url.includes("fleet-status.json")) {
      return { ok: true, json: async () => ({ content: MOCK_FLEET_STATUS_CONTENT, sha: "xyz789" }) };
    }
    return { ok: true, json: async () => ({ content: MOCK_BOOKED_DATES_CONTENT, sha: "abc123" }) };
  };
}

// ─── blockBookedDates tests ────────────────────────────────────────────────

// blockBookedDates and markVehicleUnavailable are both awaited before res.json()
// so no extra delay is needed.

test("blockBookedDates: GitHub API is called with correct params when vehicleId and GITHUB_TOKEN are set", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200);
  // A confirmed booking triggers:
  // 1. GET booked-dates.json  (blockBookedDates)
  // 2. PUT booked-dates.json  (blockBookedDates)
  // 3. GET fleet-status.json  (markVehicleUnavailable)
  // 4. PUT fleet-status.json  (markVehicleUnavailable)
  assert.equal(fetchCalls.length, 4, "Should make 4 GitHub API calls (2 per file)");
  assert.ok(fetchCalls[0].url.includes("booked-dates.json"), "First call should GET booked-dates.json");
  assert.equal(fetchCalls[1].method, "PUT", "Second call should PUT booked-dates.json");
  assert.ok(fetchCalls[1].url.includes("booked-dates.json"), "Second call should target booked-dates.json");
  assert.ok(fetchCalls[2].url.includes("fleet-status.json"), "Third call should GET fleet-status.json");
  assert.equal(fetchCalls[3].method, "PUT", "Fourth call should PUT fleet-status.json");
  assert.ok(fetchCalls[3].url.includes("fleet-status.json"), "Fourth call should target fleet-status.json");
});

test("blockBookedDates: PUT body includes the new date range for the correct vehicle", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  // fetchCalls[1] is the PUT for booked-dates.json
  const bookedDatesPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("booked-dates.json"));
  assert.ok(bookedDatesPut, "PUT to booked-dates.json should have been made");
  const putBody = JSON.parse(bookedDatesPut.body);
  const updated = JSON.parse(Buffer.from(putBody.content, "base64").toString("utf-8"));
  assert.equal(updated.camry.length, 1, "camry should have one booked range");
  assert.equal(updated.camry[0].from, VALID_BODY.pickup);
  assert.equal(updated.camry[0].to, VALID_BODY.returnDate);
});

test("blockBookedDates: works correctly for slingshot vehicle", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";

  const slingshotBody = {
    ...VALID_BODY,
    vehicleId: "slingshot",
    car: "Slingshot R",
    pricePerDay: 300,
    deposit: 150,
    total: "450",
  };
  const req = makeReq("POST", slingshotBody);
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200);
  const bookedDatesPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("booked-dates.json"));
  assert.ok(bookedDatesPut, "PUT to booked-dates.json should have been made");
  const putBody = JSON.parse(bookedDatesPut.body);
  const updated = JSON.parse(Buffer.from(putBody.content, "base64").toString("utf-8"));
  assert.equal(updated.slingshot.length, 1, "slingshot should have one booked range");
  assert.equal(updated.slingshot[0].from, slingshotBody.pickup);
  assert.equal(updated.slingshot[0].to, slingshotBody.returnDate);
  assert.equal(updated.camry.length, 0, "camry should remain unaffected");
});

test("blockBookedDates: GitHub API failure does not change the 200 response", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "Server Error" });
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200, "Response should still be 200 when GitHub API fails");
  assert.deepEqual(res._body, { success: true });
});

test("blockBookedDates: GitHub API is not called when vehicleId is absent", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; };
  process.env.GITHUB_TOKEN = "test-token";

  // VALID_BODY has no vehicleId
  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(fetchCalls.length, 0, "GitHub API should not be called when vehicleId is absent");
});

test("blockBookedDates: GitHub API is not called when GITHUB_TOKEN is not set", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; };
  delete process.env.GITHUB_TOKEN;

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  globalThis.fetch = originalFetch;

  assert.equal(fetchCalls.length, 0, "GitHub API should not be called without GITHUB_TOKEN");
});

test("owner email has replyTo set to customer email", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should have been sent");
  assert.equal(ownerMail.replyTo, VALID_BODY.email, "Owner email replyTo should be the customer email");
});

test("owner email has plain-text body", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should have been sent");
  assert.ok(typeof ownerMail.text === "string" && ownerMail.text.length > 0, "Owner email should include a plain-text body");
  assert.ok(ownerMail.text.includes("Jane Doe"), "Plain-text body should contain renter name");
  assert.ok(ownerMail.text.includes("2026-03-01"), "Plain-text body should contain pickup date");
});

test("customer email has plain-text body", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  const customerMail = sentMails[1];
  assert.ok(customerMail, "Customer email should have been sent");
  assert.ok(typeof customerMail.text === "string" && customerMail.text.length > 0, "Customer email should include a plain-text body");
  assert.ok(customerMail.text.includes("2026-03-01"), "Plain-text body should contain pickup date");
  assert.ok(customerMail.text.includes("CONFIRMED"), "Plain-text body should confirm payment status");
});

test("response is 200 and both emails are sent on success", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(sentMails.length, 2, "Both emails should be sent when no failures occur");
});

test("returns 500 when owner email fails to send", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  // Make sendMail throw on the first call (owner email) and succeed on the second
  let callCount = 0;
  mockSendMail.mock.mockImplementation(async (opts) => {
    callCount++;
    if (callCount === 1) throw new Error("SMTP connection refused");
    sentMails.push(opts);
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  try {
    await handler(req, res);

    assert.equal(res._status, 500, "Should return 500 when owner email fails");
    assert.ok(
      typeof res._body.error === "string" && res._body.error.length > 0,
      "Error body should be a non-empty string"
    );
  } finally {
    // Restore default mock behaviour regardless of test outcome
    mockSendMail.mock.mockImplementation(async (opts) => { sentMails.push(opts); });
  }
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

// ─── paymentStatus tests ───────────────────────────────────────────────────

test("paymentStatus:failed — owner email is sent with FAILED label in subject and body", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", { ...VALID_BODY, paymentStatus: "failed" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should have been sent");
  assert.ok(ownerMail.subject.includes("Payment Failed"), "Subject should indicate payment failed");
  assert.ok(ownerMail.html.includes("FAILED"), "HTML body should show FAILED status");
  assert.ok(ownerMail.text.includes("FAILED"), "Plain-text body should show FAILED status");
});

test("paymentStatus:failed — customer confirmation email is NOT sent", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", { ...VALID_BODY, paymentStatus: "failed" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(mockSendMail.mock.callCount(), 1, "Only the owner email should be sent for a failed payment");
});

test("paymentStatus:failed — blockBookedDates is NOT called", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; };
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry", paymentStatus: "failed" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(fetchCalls.length, 0, "GitHub API should not be called for a failed payment (neither blockBookedDates nor markVehicleUnavailable)");
});

test("customer email failure returns 200 — owner already received the booking alert", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  // Owner email succeeds; customer email throws
  let callCount = 0;
  mockSendMail.mock.mockImplementation(async (opts) => {
    callCount++;
    if (callCount === 1) { sentMails.push(opts); return; } // owner succeeds
    throw new Error("SMTP customer send error");             // customer fails
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res._status, 200, "Should still return 200 — owner was notified");
    assert.deepEqual(res._body, { success: true });
    assert.equal(sentMails.length, 1, "Only owner email should have been recorded");
  } finally {
    mockSendMail.mock.mockImplementation(async (opts) => { sentMails.push(opts); });
  }
});

test("owner email notes when insurance is attached", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", {
    ...VALID_BODY,
    idBase64: "ZmFrZWRhdGE=",
    idFileName: "license.jpg",
    idMimeType: "image/jpeg",
    insuranceBase64: "aW5zdXJhbmNlZGF0YQ==",
    insuranceFileName: "insurance.pdf",
    insuranceMimeType: "application/pdf",
  });
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should have been sent");
  assert.ok(
    ownerMail.html.includes("insurance document is attached") ||
    ownerMail.html.includes("Renter&#39;s insurance document is attached"),
    "Should mention attached insurance"
  );
  assert.equal(ownerMail.attachments.length, 2, "Should have two attachments (ID + insurance)");
  assert.equal(ownerMail.attachments[1].filename, "insurance.pdf");
});

test("owner email notes when no insurance was uploaded", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", {
    ...VALID_BODY,
    insuranceBase64: null,
    insuranceFileName: null,
  });
  const res = makeRes();
  await handler(req, res);

  const { html } = sentMails[0];
  assert.ok(html.includes("No insurance document was uploaded"), "Should warn when no insurance uploaded");
});

test("owner email plain-text notes insurance attachment", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", {
    ...VALID_BODY,
    insuranceBase64: "aW5zdXJhbmNlZGF0YQ==",
    insuranceFileName: "insurance.jpg",
    insuranceMimeType: "image/jpeg",
  });
  const res = makeRes();
  await handler(req, res);

  const ownerMail = sentMails[0];
  assert.ok(ownerMail.text.includes("Insurance attached: insurance.jpg"), "Plain-text should note insurance filename");
});

// ─── markVehicleUnavailable tests ─────────────────────────────────────────

test("markVehicleUnavailable: fleet-status.json is updated to available:false after confirmed booking", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200);
  const fleetStatusPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("fleet-status.json"));
  assert.ok(fleetStatusPut, "PUT to fleet-status.json should have been made");
  const putBody = JSON.parse(fleetStatusPut.body);
  const updated = JSON.parse(Buffer.from(putBody.content, "base64").toString("utf-8"));
  assert.equal(updated.camry.available, false, "camry should be marked unavailable in fleet-status.json");
  assert.ok(putBody.message.includes("camry"), "Commit message should reference the vehicle");
  assert.ok(putBody.message.toLowerCase().includes("unavailable"), "Commit message should mention unavailable");
});

test("markVehicleUnavailable: fleet-status.json is updated for slingshot vehicle too", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", {
    ...VALID_BODY,
    vehicleId: "slingshot",
    car: "Slingshot R",
    pricePerDay: 300,
    deposit: 150,
    total: "450",
  });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200);
  const fleetStatusPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("fleet-status.json"));
  assert.ok(fleetStatusPut, "PUT to fleet-status.json should have been made");
  const putBody = JSON.parse(fleetStatusPut.body);
  const updated = JSON.parse(Buffer.from(putBody.content, "base64").toString("utf-8"));
  assert.equal(updated.slingshot.available, false, "slingshot should be marked unavailable");
  assert.equal(updated.camry.available, true, "camry should remain unaffected");
});

test("markVehicleUnavailable: fleet-status.json is NOT updated for a failed payment", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry", paymentStatus: "failed" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  const fleetStatusCall = fetchCalls.find(c => c.url && c.url.includes("fleet-status.json"));
  assert.equal(fleetStatusCall, undefined, "fleet-status.json should not be touched for a failed payment");
});

test("markVehicleUnavailable: GitHub API is not called when GITHUB_TOKEN is not set", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; };
  delete process.env.GITHUB_TOKEN;

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  globalThis.fetch = originalFetch;

  const fleetCall = fetchCalls.find(c => c.url && c.url.includes("fleet-status.json"));
  assert.equal(fleetCall, undefined, "fleet-status.json should not be called without GITHUB_TOKEN");
});

test("markVehicleUnavailable: fleet-status.json GitHub failure does not change the 200 response", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // booked-dates.json succeeds normally
    if (url.includes("booked-dates.json")) {
      if (opts && opts.method === "PUT") return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ content: MOCK_BOOKED_DATES_CONTENT, sha: "abc123" }) };
    }
    // fleet-status.json fails
    return { ok: false, status: 503, text: async () => "Service Unavailable" };
  };
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200, "Response should still be 200 when fleet-status GitHub API fails");
  assert.deepEqual(res._body, { success: true });
});

test("markVehicleUnavailable: skips the GitHub write when vehicle is already unavailable", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  // Provide a fleet-status where camry is ALREADY unavailable
  const alreadyUnavailableContent = Buffer.from(
    JSON.stringify({ slingshot: { available: true }, camry: { available: false } }, null, 2) + "\n"
  ).toString("base64");

  const putCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "PUT") {
      putCalls.push(url);
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes("fleet-status.json")) {
      return { ok: true, json: async () => ({ content: alreadyUnavailableContent, sha: "xyz789" }) };
    }
    return { ok: true, json: async () => ({ content: MOCK_BOOKED_DATES_CONTENT, sha: "abc123" }) };
  };
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200);
  // Only the booked-dates.json PUT should happen — not the fleet-status.json PUT
  const fleetStatusPuts = putCalls.filter(u => u.includes("fleet-status.json"));
  assert.equal(fleetStatusPuts.length, 0, "Should not PUT fleet-status.json when vehicle is already unavailable");
});
