// Tests for api/send-signnow-invite.js
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── SignNow env vars (must be set before handler is imported) ───────────────
process.env.SIGNNOW_API_TOKEN = "test-token";
process.env.SIGNNOW_TEMPLATE_ID = "test-template-id";

// ─── fetch mock ─────────────────────────────────────────────────────────────
// The handler uses the global fetch. Patch it before importing the handler.
// Default mock: first call (template copy) returns { id: "new-doc-id" },
// second call (invite) returns ok.
const mockFetch = mock.fn(async (_url) => {
  if (_url && _url.includes("/copy")) {
    return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "new-doc-id" }) };
  }
  return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
});

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

test("returns 500 when both SIGNNOW_TEMPLATE_ID and SIGNNOW_DOCUMENT_ID are missing", async () => {
  const savedTemplateId = process.env.SIGNNOW_TEMPLATE_ID;
  const savedDocId = process.env.SIGNNOW_DOCUMENT_ID;
  delete process.env.SIGNNOW_TEMPLATE_ID;
  delete process.env.SIGNNOW_DOCUMENT_ID;
  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);
  process.env.SIGNNOW_TEMPLATE_ID = savedTemplateId;
  if (savedDocId) process.env.SIGNNOW_DOCUMENT_ID = savedDocId;
  assert.equal(res._status, 500);
});

test("SIGNNOW_DOCUMENT_ID is accepted as fallback when SIGNNOW_TEMPLATE_ID is not set", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/copy")) return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "new-doc-id" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });
  const savedTemplateId = process.env.SIGNNOW_TEMPLATE_ID;
  delete process.env.SIGNNOW_TEMPLATE_ID;
  process.env.SIGNNOW_DOCUMENT_ID = "legacy-doc-id";
  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);
  process.env.SIGNNOW_TEMPLATE_ID = savedTemplateId;
  delete process.env.SIGNNOW_DOCUMENT_ID;
  assert.equal(res._status, 200);
});

test("valid POST calls SignNow API and returns success", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/copy")) return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "new-doc-id" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true });
  assert.equal(mockFetch.mock.callCount(), 2, "Should make 2 calls: template copy + invite");
});

test("first fetch call copies the template to create a fresh document", async () => {
  mockFetch.mock.resetCalls();
  let capturedCopyUrl;
  let capturedCopyBody;
  mockFetch.mock.mockImplementation(async (_url, opts) => {
    if (_url.includes("/copy")) {
      capturedCopyUrl = _url;
      capturedCopyBody = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "fresh-doc-id" }) };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.ok(capturedCopyUrl.includes("test-template-id"), "Copy URL should include the template ID");
  assert.ok(capturedCopyUrl.includes("/copy"), "First call should be to the /copy endpoint");
  assert.ok(capturedCopyBody.document_name, "Copy body should include a document_name");
  assert.ok(capturedCopyBody.document_name.includes(VALID_BODY.name), "document_name should include renter name");
});

test("second fetch call sends invite for the newly created document (not the template)", async () => {
  mockFetch.mock.resetCalls();
  let capturedInviteUrl;
  mockFetch.mock.mockImplementation(async (_url, opts) => {
    if (_url.includes("/copy")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "fresh-doc-id" }) };
    }
    capturedInviteUrl = _url;
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.ok(capturedInviteUrl, "Invite fetch should have been called");
  assert.ok(capturedInviteUrl.includes("fresh-doc-id"), "Invite URL should use the new copy's ID, not the template ID");
  assert.ok(!capturedInviteUrl.includes("test-template-id"), "Invite URL must NOT use the template ID");
});

test("SignNow API call includes renter email in invite body", async () => {
  mockFetch.mock.resetCalls();
  let capturedInviteBody;
  mockFetch.mock.mockImplementation(async (_url, opts) => {
    if (_url.includes("/copy")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "new-doc-id" }) };
    }
    capturedInviteBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.ok(capturedInviteBody, "Invite fetch should have been called");
  assert.equal(capturedInviteBody.to[0].email, VALID_BODY.email);
});

test("SignNow API calls use Bearer token in Authorization header", async () => {
  mockFetch.mock.resetCalls();
  const capturedAuthHeaders = [];
  mockFetch.mock.mockImplementation(async (_url, opts) => {
    capturedAuthHeaders.push(opts.headers.Authorization);
    if (_url.includes("/copy")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "new-doc-id" }) };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(capturedAuthHeaders.length, 2, "Both calls should set Authorization");
  capturedAuthHeaders.forEach(h => {
    assert.ok(h.startsWith("Bearer "), "Should use Bearer auth");
    assert.ok(h.includes("test-token"), "Should include the API token");
  });
});

test("returns 502 when template copy fails", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/copy")) {
      return { ok: false, status: 404, text: async () => "Not found", json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  });

  const req = makeReq("POST", VALID_BODY);
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 502);
  assert.ok(res._body.error, "Should return an error message");
});

test("returns 502 when invite call fails", async () => {
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/copy")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "new-doc-id" }) };
    }
    return { ok: false, status: 401, text: async () => "Unauthorized", json: async () => ({}) };
  });

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
