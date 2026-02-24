// Tests for api/check-signnow.js
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── fetch mock ─────────────────────────────────────────────────────────────
const mockFetch = mock.fn(async (_url) => {
  if (_url.includes("/oauth2/token")) {
    return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "token-abc" }) };
  }
  if (_url.includes("/document/")) {
    return {
      ok: true, status: 200, text: async () => "",
      json: async () => ({ roles: [{ name: "Signer 1" }], fields: [] }),
    };
  }
  return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
});

globalThis.fetch = mockFetch;

// ─── Setup env vars before importing handler ─────────────────────────────────
process.env.SIGNNOW_CLIENT_ID = "cid";
process.env.SIGNNOW_CLIENT_SECRET = "csecret";
process.env.SIGNNOW_EMAIL = "owner@example.com";
process.env.SIGNNOW_PASSWORD = "pass";
process.env.SIGNNOW_TEMPLATE_ID = "tmpl-123";

const { default: handler } = await import("./check-signnow.js");

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

function makeReq(method = "GET") {
  return { method, headers: {} };
}

function setOAuthEnv() {
  process.env.SIGNNOW_CLIENT_ID = "cid";
  process.env.SIGNNOW_CLIENT_SECRET = "csecret";
  process.env.SIGNNOW_EMAIL = "owner@example.com";
  process.env.SIGNNOW_PASSWORD = "pass";
}

function clearOAuthEnv() {
  delete process.env.SIGNNOW_CLIENT_ID;
  delete process.env.SIGNNOW_CLIENT_SECRET;
  delete process.env.SIGNNOW_EMAIL;
  delete process.env.SIGNNOW_PASSWORD;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("OPTIONS returns 200", async () => {
  const req = makeReq("OPTIONS");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("non-GET returns 405", async () => {
  const req = makeReq("POST");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("CORS header allows all origins", async () => {
  const req = makeReq("GET");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
});

test("overall is success when OAuth + template + role all pass", async () => {
  setOAuthEnv();
  process.env.SIGNNOW_TEMPLATE_ID = "tmpl-123";
  delete process.env.SIGNNOW_ROLE_NAME;
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [{ name: "Signer 1" }], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.ok(res._body.overall.startsWith("✅"), `Expected success, got: ${res._body.overall}`);
  assert.ok(res._body.auth.status.startsWith("✅"), "Auth should be OK");
});

test("auth method is 'oauth' when all four OAuth vars are set", async () => {
  setOAuthEnv();
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._body.auth.method, "oauth");
});

test("auth method is 'static_token' when only SIGNNOW_API_TOKEN is set", async () => {
  clearOAuthEnv();
  process.env.SIGNNOW_API_TOKEN = "static-tok";
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async () => {
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  delete process.env.SIGNNOW_API_TOKEN;
  setOAuthEnv();

  assert.equal(res._body.auth.method, "static_token");
  assert.ok(res._body.auth.status.includes("⚠️"), "Should warn about expiry");
});

test("auth method is 'none' and overall fails when no credentials are set", async () => {
  clearOAuthEnv();
  delete process.env.SIGNNOW_API_TOKEN;
  mockFetch.mock.resetCalls();

  const res = makeRes();
  await handler(makeReq(), res);

  setOAuthEnv();

  assert.equal(res._body.auth.method, "none");
  assert.ok(res._body.overall.startsWith("❌"), `Should fail, got: ${res._body.overall}`);
});

test("reports OAuth token failure correctly", async () => {
  setOAuthEnv();
  process.env.SIGNNOW_TEMPLATE_ID = "tmpl-123";
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: false, status: 401, text: async () => "Unauthorized", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  assert.ok(res._body.auth.status.startsWith("❌"), "Should report OAuth failure");
  assert.ok(res._body.overall.startsWith("❌"), `Should fail overall: ${res._body.overall}`);
});

test("templateId status shows not-set when SIGNNOW_TEMPLATE_ID is missing", async () => {
  setOAuthEnv();
  const savedTmpl = process.env.SIGNNOW_TEMPLATE_ID;
  delete process.env.SIGNNOW_TEMPLATE_ID;
  delete process.env.SIGNNOW_DOCUMENT_ID;
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  process.env.SIGNNOW_TEMPLATE_ID = savedTmpl;
  assert.ok(res._body.templateId.status.startsWith("❌"), "Should report missing template ID");
});

test("reports role mismatch when configured role is not in template", async () => {
  setOAuthEnv();
  process.env.SIGNNOW_TEMPLATE_ID = "tmpl-123";
  process.env.SIGNNOW_ROLE_NAME = "Tenant";
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [{ name: "Signer 1" }], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  delete process.env.SIGNNOW_ROLE_NAME;

  assert.ok(res._body.template.roleMatch.startsWith("❌"), "Should report role mismatch");
  assert.ok(res._body.overall.includes("⚠️") || res._body.overall.includes("❌"), "Overall should not be fully green");
});

test("reports template inaccessible when document endpoint returns 404", async () => {
  setOAuthEnv();
  process.env.SIGNNOW_TEMPLATE_ID = "bad-id";
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: false, status: 404, text: async () => "Not found", json: async () => ({}) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  assert.ok(res._body.template.status.startsWith("❌"), "Template should be inaccessible");
  assert.ok(res._body.template.hint.includes("not exist"), "Should hint about wrong ID");
});

test("returns roles found in the template", async () => {
  setOAuthEnv();
  process.env.SIGNNOW_TEMPLATE_ID = "tmpl-123";
  delete process.env.SIGNNOW_ROLE_NAME;
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [{ name: "Signer 1" }, { name: "Owner" }], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  assert.ok(res._body.template.roles.includes("Signer 1"), "Should include Signer 1");
  assert.ok(res._body.template.roles.includes("Owner"), "Should include Owner");
});

test("SIGNNOW_DOCUMENT_ID is accepted as template ID fallback", async () => {
  setOAuthEnv();
  const savedTmpl = process.env.SIGNNOW_TEMPLATE_ID;
  delete process.env.SIGNNOW_TEMPLATE_ID;
  process.env.SIGNNOW_DOCUMENT_ID = "legacy-doc-id";
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [{ name: "Signer 1" }], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  process.env.SIGNNOW_TEMPLATE_ID = savedTmpl;
  delete process.env.SIGNNOW_DOCUMENT_ID;

  assert.ok(res._body.templateId.status.startsWith("✅"), "Should accept legacy SIGNNOW_DOCUMENT_ID");
  assert.ok(res._body.templateId.source.includes("legacy"), "Should indicate it's using legacy env var");
});

test("report includes timestamp", async () => {
  setOAuthEnv();
  process.env.SIGNNOW_TEMPLATE_ID = "tmpl-123";
  mockFetch.mock.resetCalls();
  mockFetch.mock.mockImplementation(async (_url) => {
    if (_url.includes("/oauth2/token")) return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "tok" }) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ roles: [], fields: [] }) };
  });

  const res = makeRes();
  await handler(makeReq(), res);

  assert.ok(res._body.timestamp, "Should include a timestamp");
  assert.ok(!isNaN(Date.parse(res._body.timestamp)), "Timestamp should be a valid date string");
});
