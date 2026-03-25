// Tests for api/send-sms.js
// Validates template-based SMS dispatch via TextMagic.
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── TextMagic env vars ───────────────────────────────────────────────────────
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY  = "test-api-key-00000000000000000000000";

// ─── TextMagic mock ───────────────────────────────────────────────────────────
const sentMessages = [];
const mockSendSms = mock.fn(async (to, text) => { sentMessages.push({ to, text }); return {}; });

mock.module("./_textmagic.js", {
  namedExports: { sendSms: mockSendSms },
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

const VALID_BODY = {
  phone:       "3105550123",
  templateKey: "booking_confirmed",
  variables: {
    customer_name: "Alice",
    vehicle:       "Slingshot R",
    pickup_date:   "March 28",
    pickup_time:   "3:00 PM",
    location:      "1200 S Figueroa St, Los Angeles, CA 90015",
  },
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
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY, "https://www.slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("does not set CORS header for unknown origin", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY, "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

// ─── phone validation ─────────────────────────────────────────────────────────

test("returns 400 when phone is missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { templateKey: "booking_confirmed" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("phone"));
});

test("returns 400 when phone is invalid", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { phone: "notaphone", templateKey: "booking_confirmed" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("phone"));
});

test("normalises 10-digit US number to E.164", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, phone: "3105550123" }), res);
  assert.equal(res._status, 200);
  assert.equal(sentMessages[0].to, "+13105550123");
});

test("accepts E.164 number as-is", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, phone: "+13105550123" }), res);
  assert.equal(res._status, 200);
  assert.equal(sentMessages[0].to, "+13105550123");
});

test("normalises 11-digit US number to E.164", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { ...VALID_BODY, phone: "13105550123" }), res);
  assert.equal(res._status, 200);
  assert.equal(sentMessages[0].to, "+13105550123");
});

// ─── templateKey validation ───────────────────────────────────────────────────

test("returns 400 when templateKey is missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { phone: "3105550123" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("templatekey"));
});

test("returns 400 when templateKey is unknown", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { phone: "3105550123", templateKey: "nonexistent_template" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("unknown"));
});

// ─── variables validation ─────────────────────────────────────────────────────

test("returns 400 when variables is an array", async () => {
  const res = makeRes();
  await handler(makeReq("POST", { phone: "3105550123", templateKey: "booking_confirmed", variables: ["x"] }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("variables"));
});

test("variables is optional — omitting it is accepted", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "3105550123", templateKey: "post_rental_thank_you" }), res);
  assert.equal(res._status, 200);
});

test("non-string/number values in variables are silently dropped", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {
    phone:       "3105550123",
    templateKey: "booking_confirmed",
    variables: {
      customer_name: "Bob",
      vehicle:       "Camry 2012",
      pickup_date:   "April 1",
      pickup_time:   "10:00 AM",
      location:      "Downtown LA",
      __proto__:     { polluted: true },
      evil:          { nested: "object" },
    },
  }), res);
  assert.equal(res._status, 200);
  // object value should not appear in the rendered message
  assert.ok(!sentMessages[0].text.includes("[object Object]"));
});

// ─── message rendering ────────────────────────────────────────────────────────

test("renders template variables into the SMS body", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 200);
  const text = sentMessages[0].text;
  assert.ok(text.includes("Alice"),       `expected Alice in: ${text}`);
  assert.ok(text.includes("Slingshot R"), `expected Slingshot R in: ${text}`);
  assert.ok(text.includes("March 28"),    `expected March 28 in: ${text}`);
  assert.ok(text.includes("3:00 PM"),     `expected 3:00 PM in: ${text}`);
});

test("leaves unresolved placeholders intact when variables is empty", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", { phone: "3105550123", templateKey: "booking_confirmed", variables: {} }), res);
  assert.equal(res._status, 200);
  // customer_name placeholder not supplied → stays as literal text
  assert.ok(sentMessages[0].text.includes("{customer_name}"));
});

test("returns 200 and { success: true } on valid dispatch", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(sentMessages.length, 1);
});

// ─── credentials guard ────────────────────────────────────────────────────────

test("returns 500 when TextMagic credentials are missing", async () => {
  const savedUser = process.env.TEXTMAGIC_USERNAME;
  const savedKey  = process.env.TEXTMAGIC_API_KEY;
  delete process.env.TEXTMAGIC_USERNAME;
  delete process.env.TEXTMAGIC_API_KEY;

  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);

  process.env.TEXTMAGIC_USERNAME = savedUser;
  process.env.TEXTMAGIC_API_KEY  = savedKey;
});
