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
process.env.STRIPE_SECRET_KEY = "sk_live_mock";

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

mock.module("stripe", {
  defaultExport: class StripeMock {
    paymentIntents = {
      retrieve: async () => ({
        status: "succeeded",
        payment_method: { card: { last4: "4242" } },
      }),
    };
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
  paymentStatus: "confirmed",
  paymentIntentId: "pi_test_123",
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

test("returns 400 when pickupTime is missing", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", { ...VALID_BODY, pickupTime: "   ", paymentIntentId: "" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.match(res._body?.error || "", /pickup time is required/i);
  assert.equal(mockSendMail.mock.callCount(), 0, "sendMail should not be called when pickupTime is missing");
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
  assert.ok(html.includes("No ID front was uploaded"), "Should warn when no ID uploaded");
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
    ownerMail.html.includes("Renter&#39;s ID (front) is attached") ||
    ownerMail.html.includes("Renter's ID (front) is attached"),
    "Should mention attached ID"
  );
  assert.equal(ownerMail.attachments.length, 1, "Should have one attachment");
  assert.equal(ownerMail.attachments[0].filename, "license.jpg");
});

// ─── blockBookedDates + markVehicleUnavailable shared mock helpers ─────────

const MOCK_BOOKED_DATES_CONTENT =
  Buffer.from(JSON.stringify({ camry: [] }, null, 2) + "\n").toString("base64");

const MOCK_FLEET_STATUS_CONTENT =
  Buffer.from(
    JSON.stringify({ camry: { available: true }, camry2013: { available: true } }, null, 2) + "\n"
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

test("blockBookedDates: GitHub API is NOT called for booked-dates.json (Phase 4: writes disabled)", async () => {
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
  // Phase 4: bookings.json and booked-dates.json writes are disabled.
  // Only fleet-status.json still gets a GET+PUT (markVehicleUnavailable still active).
  const bookedDatesCalls = fetchCalls.filter(c => c.url.includes("booked-dates.json"));
  assert.equal(bookedDatesCalls.length, 0, "Phase 4: no GitHub calls for booked-dates.json");
  const bookingsCalls = fetchCalls.filter(c => c.url.includes("bookings.json"));
  assert.equal(bookingsCalls.length, 0, "Phase 4: no GitHub calls for bookings.json");
  // fleet-status.json still written (markVehicleUnavailable not disabled)
  assert.equal(fetchCalls.filter(c => c.url.includes("fleet-status.json")).length, 2,
    "fleet-status.json should still receive GET + PUT");
});

test("blockBookedDates: no PUT to booked-dates.json (Phase 4: writes disabled)", async () => {
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

  // Phase 4: no PUT to booked-dates.json should be made
  const bookedDatesPut = fetchCalls.find(c => c.method === "PUT" && c.url.includes("booked-dates.json"));
  assert.equal(bookedDatesPut, undefined, "Phase 4: PUT to booked-dates.json must not be made");
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

test("owner email retries without attachments when attachment delivery fails", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  let callCount = 0;
  mockSendMail.mock.mockImplementation(async (opts) => {
    callCount++;
    if (callCount === 1) throw new Error("Message too large");
    sentMails.push(opts);
  });

  const req = makeReq("POST", {
    ...VALID_BODY,
    email: "",
    idBase64: "ZmFrZWRhdGE=",
    idFileName: "license.jpg",
    idMimeType: "image/jpeg",
  });
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res._status, 200, "Should recover by retrying owner email without attachments");
    assert.equal(sentMails.length, 1, "Only retried owner email should be recorded");
    assert.equal(sentMails[0].attachments.length, 0, "Retried owner email should drop attachments");
    assert.ok(
      sentMails[0].text.includes("could not be attached"),
      "Retried owner email should explain attachment delivery issue"
    );
  } finally {
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

test("paymentStatus:failed — no owner email is sent", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", { ...VALID_BODY, paymentStatus: "failed" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(mockSendMail.mock.callCount(), 0, "No email should be sent for failed payment attempts");
  assert.equal(res._body?.emailSkipped, true);
  assert.equal(res._body?.reason, "payment_not_confirmed");
});

test("paymentStatus:failed — customer confirmation email is NOT sent", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", { ...VALID_BODY, paymentStatus: "failed" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(mockSendMail.mock.callCount(), 0, "No email should be sent for a failed payment");
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

test("test mode — booking persistence and availability updates are skipped", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  const savedStripeKey = process.env.STRIPE_SECRET_KEY;
  globalThis.fetch = makeGitHubFetchMock(fetchCalls);
  process.env.GITHUB_TOKEN = "test-token";
  process.env.STRIPE_SECRET_KEY = "sk_test_mock";

  try {
    const req = makeReq("POST", { ...VALID_BODY, vehicleId: "camry" });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.equal(fetchCalls.length, 0, "Test mode must not update bookings.json, booked-dates.json, or fleet-status.json");
  } finally {
    delete process.env.GITHUB_TOKEN;
    process.env.STRIPE_SECRET_KEY = savedStripeKey;
    globalThis.fetch = originalFetch;
  }
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

test("customer email retries without agreement attachment when attachment delivery fails", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  let callCount = 0;
  mockSendMail.mock.mockImplementation(async (opts) => {
    callCount++;
    if (callCount === 2) throw new Error("Message too large");
    sentMails.push(opts);
  });

  const req = makeReq("POST", { ...VALID_BODY, signature: "Jane Doe" });
  const res = makeRes();
  try {
    await handler(req, res);
    assert.equal(res._status, 200, "Should still succeed when customer attachment send fails");
    assert.equal(sentMails.length, 2, "Owner email and customer retry should both be sent");
    const customerRetryMail = sentMails[1];
    assert.equal(customerRetryMail.to, VALID_BODY.email, "Retry should target renter email");
    assert.equal(customerRetryMail.attachments.length, 0, "Retry should drop customer attachment");
    assert.ok(
      customerRetryMail.text.includes("could not be attached"),
      "Retry email should explain attachment delivery issue"
    );
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
  assert.ok(html.includes("verify insurance at pickup before releasing the vehicle"), "Should warn when no insurance uploaded");
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

test("owner email omits oversized attachments but still sends successfully", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const largeBase64A = Buffer.alloc(8 * 1024 * 1024, 1).toString("base64");
  const largeBase64B = Buffer.alloc(8 * 1024 * 1024, 2).toString("base64");

  const req = makeReq("POST", {
    ...VALID_BODY,
    idBase64: largeBase64A,
    idFileName: "id-front-large.jpg",
    idMimeType: "image/jpeg",
    idBackBase64: largeBase64B,
    idBackFileName: "id-back-large.jpg",
    idBackMimeType: "image/jpeg",
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200, "Owner email should still succeed when attachments are oversized");
  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should be sent");
  assert.equal(ownerMail.attachments.length, 1, "One oversized attachment should be omitted to stay within budget");
  assert.ok(
    ownerMail.text.includes("Attachments omitted due to email size limit"),
    "Owner plain-text should explain attachment omission"
  );
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
    JSON.stringify({ camry: { available: false }, camry2013: { available: true } }, null, 2) + "\n"
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

// ─── Balance payment (paymentType: 'balance_payment') tests ──────────────────

// A booking payload that simulates the final balance payment after a $50 deposit.
const BALANCE_PAYMENT_BODY = {
  vehicleId:          "camry",
  bookingId:          "booking-balance-test-1",
  car:                "Camry 2012",
  name:               "Jane Doe",
  email:              "jane@example.com",
  phone:              "555-1234",
  pickup:             "2026-04-01",
  pickupTime:         "10:00",
  returnDate:         "2026-04-05",
  returnTime:         "10:00",
  total:              "169.03",   // balance amount (full – deposit)
  days:               4,
  protectionPlan:     false,
  paymentType:        "balance_payment",
  paymentStatus:      "confirmed",
  paymentIntentId:    "pi_balance_test_123",
  depositAlreadyPaid: "50.00",
  fullRentalTotal:    "219.03",
};

test("balance payment: owner email subject contains 'Balance Paid'", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", BALANCE_PAYMENT_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  const ownerMail = sentMails[0];
  assert.ok(ownerMail, "Owner email should be sent");
  assert.ok(
    ownerMail.subject.includes("Balance Paid"),
    `Owner subject should include 'Balance Paid', got: ${ownerMail.subject}`
  );
});

test("balance payment: customer email subject contains 'Balance Paid'", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", BALANCE_PAYMENT_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  const customerMail = sentMails[1];
  assert.ok(customerMail, "Customer email should be sent");
  assert.ok(
    customerMail.subject.includes("Balance Paid"),
    `Customer subject should include 'Balance Paid', got: ${customerMail.subject}`
  );
});

test("balance payment: blockBookedDates and markVehicleUnavailable are NOT called", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true }; };
  process.env.GITHUB_TOKEN = "test-token";

  const req = makeReq("POST", BALANCE_PAYMENT_BODY);
  const res = makeRes();
  await handler(req, res);

  delete process.env.GITHUB_TOKEN;
  globalThis.fetch = originalFetch;

  assert.equal(res._status, 200);
  assert.equal(
    fetchCalls.length, 0,
    "GitHub API must not be called for a balance payment (dates already blocked at deposit time)"
  );
});

test("balance payment: response is 200 and two emails are sent", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", BALANCE_PAYMENT_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true });
  assert.equal(mockSendMail.mock.callCount(), 2, "Both owner and customer emails should be sent");
});

// ─── Deposit email should not expose direct balance links ─────────────────────

const DEPOSIT_BOOKING_BODY = {
  vehicleId:      "camry",
  car:            "Camry 2012",
  name:           "Jane Doe",
  email:          "jane@example.com",
  phone:          "555-1234",
  pickup:         "2026-05-01",
  pickupTime:     "09:00",
  returnDate:     "2026-05-05",
  returnTime:     "09:00",
  total:          "50",           // deposit amount charged
  paymentStatus:  "confirmed",
  days:           4,
  protectionPlan: false,
  paymentIntentId: "pi_deposit_test_123",
  fullRentalCost: "200",          // signals this is a deposit payment
  balanceAtPickup: "150",
};

test("deposit confirmation email does not include direct pay-balance link", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", DEPOSIT_BOOKING_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  const customerMail = sentMails[1];
  assert.ok(customerMail, "Customer email should be sent");
  assert.ok(
    !customerMail.html.includes("balance.html"),
    "Customer deposit email HTML should not include a direct balance.html link"
  );
  assert.ok(
    !customerMail.html.includes("Pay Balance Online"),
    "Customer deposit email HTML should not include a 'Pay Balance Online' button"
  );
});

test("deposit confirmation plain-text email does not include pay balance URL", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  const req = makeReq("POST", DEPOSIT_BOOKING_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  const customerMail = sentMails[1];
  assert.ok(customerMail, "Customer email should be sent");
  assert.ok(
    !customerMail.text.includes("balance.html"),
    "Customer deposit plain-text email should not include a link to balance.html"
  );
});

test("non-deposit full-payment email does NOT include 'Pay Balance Online' link", async () => {
  mockSendMail.mock.resetCalls();
  sentMails.length = 0;

  // fullRentalCost absent → full payment, no balance link expected
  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  const customerMail = sentMails[1];
  assert.ok(customerMail, "Customer email should be sent");
  assert.ok(
    !customerMail.html.includes("Pay Balance Online"),
    "Full-payment email should NOT include a 'Pay Balance Online' link"
  );
});
