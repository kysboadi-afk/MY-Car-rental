// Tests for api/send-signnow-invite.js
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SignNow env vars (must be set before handler is imported) ───────────────
process.env.SIGNNOW_API_TOKEN = "test-token";
process.env.SIGNNOW_DOCUMENT_ID = "test-document-id";

// ─── fetch mock ─────────────────────────────────────────────────────────────
// The handler uses the global fetch. Patch it before importing the handler.
const mockFetch = mock.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => "",
}));

globalThis.fetch = mockFetch;

// Dynamic import so the mock is already in place when the module loads.
const { default: handler } = await import("./send-signnow-invite.js");

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
  return { method, headers: { origin }, body };
}

const VALID_BODY = {
  name: "Jane Doe",
  email: "jane@example.com",
  car: "Camry 2012",
  pickup: "2026-03-01",
  returnDate: "2026-03-05",
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

test("returns 400 when email is missing", async () => {
  mockFetch.mock.resetCalls();
  const req = makeReq("POST", { ...VALID_BODY, email: undefined });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error, "Should return an error message");
});

test("returns 400 when email is invalid", async () => {
  mockFetch.mock.resetCalls();
  const req = makeReq("POST", { ...VALID_BODY, email: "not-an-email" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});

test("returns 500 when SIGNNOW_API_TOKEN is missing", async () => {
  const savedToken = process.env.SIGNNOW_API_TOKEN;
  delete process.env.SIGNNOW_API_TOKEN;
  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);
  process.env.SIGNNOW_API_TOKEN = savedToken;
  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("SignNow"), "Error should mention SignNow");
});

test("returns 500 when SIGNNOW_DOCUMENT_ID is missing", async () => {
  const savedId = process.env.SIGNNOW_DOCUMENT_ID;
  delete process.env.SIGNNOW_DOCUMENT_ID;
  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);
  process.env.SIGNNOW_DOCUMENT_ID = savedId;
  assert.equal(res._status, 500);
});

test("valid POST calls SignNow API and returns success", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async () => ({ ok: true, status: 200, text: async () => "" }));

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true });
  assert.equal(mockFetch.mock.callCount(), 1, "Should call SignNow API once");
});

test("SignNow API call includes renter email in request body", async () => {
  mockFetch.mock.resetCalls();
  let capturedBody;
  mockFetch.mock.mockImplementation(async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => "" };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.ok(capturedBody, "Fetch should have been called");
  assert.equal(capturedBody.to[0].email, VALID_BODY.email);
});

test("SignNow API call uses Bearer token in Authorization header", async () => {
  mockFetch.mock.resetCalls();
  let capturedHeaders;
  mockFetch.mock.mockImplementation(async (_url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, text: async () => "" };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.ok(capturedHeaders.Authorization.startsWith("Bearer "), "Should use Bearer auth");
  assert.ok(capturedHeaders.Authorization.includes("test-token"), "Should include the API token");
});

test("returns 502 when SignNow API returns an error", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async () => ({
    ok: false,
    status: 401,
    text: async () => "Unauthorized",
  }));

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 502);
  assert.ok(res._body.error, "Should return an error message");
});

test("returns 500 when fetch throws a network error", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async () => { throw new Error("Network error"); });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 500);
});
