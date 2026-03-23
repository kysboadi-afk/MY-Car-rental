// Tests for api/send-sms.js
// Validates that an SMS is sent via TextMagic when a visitor submits the lead form.
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

test("SMS body contains the expected message", async () => {
  sentMessages.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", VALID_BODY), res);
  const body = sentMessages[0].text;
  assert.ok(body.includes("SLY Services"), `Expected body to mention SLY Services, got: ${body}`);
  assert.ok(body.includes("for vehicle rentals"), `Expected body to mention vehicle rentals, got: ${body}`);
  assert.ok(body.includes("Reply STOP"), `Expected body to include opt-out instruction, got: ${body}`);
});

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
