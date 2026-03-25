// Tests for api/send-otp.js
// Validates that a TOTP code is generated and sent via TextMagic SMS to the
// business phone (+18332521093).
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Required env vars ────────────────────────────────────────────────────────
process.env.OTP_SECRET          = "JBSWY3DPEHPK3PXP"; // valid base32 test secret
process.env.TEXTMAGIC_USERNAME  = "testuser";
process.env.TEXTMAGIC_API_KEY   = "test-api-key-00000000000000000000000";

// ─── axios mock ──────────────────────────────────────────────────────────────
const sentRequests = [];
const mockAxiosPost = mock.fn(async (url, data, config) => {
  sentRequests.push({ url, data, config });
  return { data: { id: 1 } };
});

mock.module("axios", {
  defaultExport: { post: mockAxiosPost },
});

// ─── speakeasy mock ───────────────────────────────────────────────────────────
// Return a deterministic 6-digit OTP so tests are predictable.
mock.module("speakeasy", {
  defaultExport: {
    totp: mock.fn(() => "123456"),
  },
});

const { default: handler } = await import("./send-otp.js");

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

test("sets CORS header for allowed origin www.slytrans.com", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {}, "https://www.slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("sets CORS header for allowed origin slytrans.com", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {}, "https://slytrans.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://slytrans.com");
});

test("does not set CORS header for unknown origin", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", {}, "https://evil.example.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 500 when OTP_SECRET is missing", async () => {
  const saved = process.env.OTP_SECRET;
  delete process.env.OTP_SECRET;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);
  process.env.OTP_SECRET = saved;
});

test("returns 500 when TEXTMAGIC_USERNAME is missing", async () => {
  const saved = process.env.TEXTMAGIC_USERNAME;
  delete process.env.TEXTMAGIC_USERNAME;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);
  process.env.TEXTMAGIC_USERNAME = saved;
});

test("returns 500 when TEXTMAGIC_API_KEY is missing", async () => {
  const saved = process.env.TEXTMAGIC_API_KEY;
  delete process.env.TEXTMAGIC_API_KEY;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);
  process.env.TEXTMAGIC_API_KEY = saved;
});

test("returns 200 with success:true on successful send", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true, message: "OTP sent" });
});

test("does not include OTP value in the response", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.ok(!("otp" in res._body), "Response must not expose the OTP");
});

test("calls axios.post with TextMagic URL", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(sentRequests.length, 1);
  assert.equal(sentRequests[0].url, "https://rest.textmagic.com/api/v2/messages");
});

test("sends to +18332521093 (E.164 business phone)", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(sentRequests[0].data.phones, "+18332521093");
});

test("SMS text contains 'OTP code is:'", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.ok(
    sentRequests[0].data.text.includes("OTP code is:"),
    `Expected OTP message text, got: ${sentRequests[0].data.text}`
  );
});

test("uses basic auth with TEXTMAGIC_USERNAME and TEXTMAGIC_API_KEY", async () => {
  sentRequests.length = 0;
  const res = makeRes();
  await handler(makeReq("POST"), res);
  const auth = sentRequests[0].config.auth;
  assert.equal(auth.username, "testuser");
  assert.equal(auth.password, "test-api-key-00000000000000000000000");
});

test("returns 500 with error details when axios throws", async () => {
  sentRequests.length = 0;
  mockAxiosPost.mock.mockImplementationOnce(async () => {
    const err = new Error("Network error");
    err.response = { data: { message: "Unauthorized" } };
    throw err;
  });
  const res = makeRes();
  await handler(makeReq("POST"), res);
  assert.equal(res._status, 500);
  assert.equal(res._body.error, "Failed to send OTP");
});
