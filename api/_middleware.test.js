// api/_middleware.test.js
// Unit tests for api/_middleware.js
//
// Verifies:
//   1. setCorsHeaders — sets headers only for allowed origins
//   2. sendError      — produces structured JSON error responses
//   3. withAdminAuth  — legacy + Supabase operator auth lifecycle
//   4. ALLOWED_ORIGINS — canonical list is present and non-empty
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_ORIGINS,
  setCorsHeaders,
  sendError,
  withAdminAuth,
} from "./_middleware.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ADMIN_SECRET = process.env.ADMIN_SECRET;
const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function restoreEnv() {
  if (ORIGINAL_ADMIN_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL_ADMIN_SECRET;

  if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;

  if (ORIGINAL_SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_SUPABASE_SERVICE_ROLE_KEY;

  globalThis.fetch = ORIGINAL_FETCH;
}

function configureLegacyAdmin() {
  process.env.ADMIN_SECRET = "test-middleware-secret";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function configureSupabaseAdmin() {
  delete process.env.ADMIN_SECRET;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

function installSupabaseFetch({ user = null, memberships = [], authStatus = user ? 200 : 401 } = {}) {
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify(user || { message: "Invalid JWT" }),
        {
          status: authStatus,
          headers: { "content-type": "application/json" },
        }
      );
    }

    if (url.includes("/rest/v1/organization_users")) {
      return new Response(
        JSON.stringify(memberships),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    throw new Error(`Unexpected fetch request in middleware test: ${url}`);
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeReq(opts = {}) {
  return {
    method: opts.method ?? "POST",
    headers: { origin: opts.origin ?? "https://slycarrentals.com", ...opts.headers },
    body: opts.body ?? {},
    query: opts.query ?? {},
  };
}

test("ALLOWED_ORIGINS is a non-empty array", () => {
  assert.ok(Array.isArray(ALLOWED_ORIGINS));
  assert.ok(ALLOWED_ORIGINS.length > 0);
});

test("ALLOWED_ORIGINS includes the canonical admin domain", () => {
  assert.ok(new Set(ALLOWED_ORIGINS).has("https://admin.slycarrentals.com"));
});

test("ALLOWED_ORIGINS includes slycarrentals.com and www variant", () => {
  const allowedOrigins = new Set(ALLOWED_ORIGINS);
  assert.ok(allowedOrigins.has("https://slycarrentals.com"));
  assert.ok(allowedOrigins.has("https://www.slycarrentals.com"));
});

test("ALLOWED_ORIGINS includes slytrans.com and www variant", () => {
  const allowedOrigins = new Set(ALLOWED_ORIGINS);
  assert.ok(allowedOrigins.has("https://slytrans.com"));
  assert.ok(allowedOrigins.has("https://www.slytrans.com"));
});

test("setCorsHeaders sets Allow-Origin for allowed origin", () => {
  const req = makeReq({ origin: "https://slycarrentals.com" });
  const res = makeRes();
  setCorsHeaders(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://slycarrentals.com");
});

test("setCorsHeaders does not set Allow-Origin for disallowed origin", () => {
  const req = makeReq({ origin: "https://evil.example.com" });
  const res = makeRes();
  setCorsHeaders(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("setCorsHeaders always sets Allow-Methods and Allow-Headers", () => {
  const req = makeReq({ origin: "https://evil.example.com" });
  const res = makeRes();
  setCorsHeaders(req, res);
  assert.ok(res._headers["Access-Control-Allow-Methods"]);
  assert.ok(res._headers["Access-Control-Allow-Headers"]);
});

test("sendError sets status and returns error JSON", () => {
  const res = makeRes();
  const returned = sendError(res, 401, "Unauthorized");
  assert.equal(res._status, 401);
  assert.deepEqual(res._body, { error: "Unauthorized" });
  assert.equal(returned, res);
});

test("sendError includes details when provided", () => {
  const res = makeRes();
  sendError(res, 400, "Bad request", { field: "email" });
  assert.deepEqual(res._body, { error: "Bad request", details: { field: "email" } });
});

test("withAdminAuth: OPTIONS request returns 200 with CORS headers", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ method: "OPTIONS" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.ok(res._headers["Access-Control-Allow-Methods"]);
  restoreEnv();
});

test("withAdminAuth: GET request returns 405", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
  restoreEnv();
});

test("withAdminAuth: missing credentials returns 401 when auth is configured", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ body: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Unauthorized");
  restoreEnv();
});

test("withAdminAuth: returns 500 when no admin auth path is configured", async () => {
  delete process.env.ADMIN_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ body: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 500);
  restoreEnv();
});

test("withAdminAuth: wrong legacy secret returns 401", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ body: { secret: "wrong-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
  restoreEnv();
});

test("withAdminAuth: correct legacy secret passes through and leaves tenantContext null", async () => {
  configureLegacyAdmin();
  let capturedCtx = "unset";
  let capturedAdminAuth = null;
  const handler = withAdminAuth(async (req, res) => {
    capturedCtx = req.tenantContext;
    capturedAdminAuth = req.adminAuth;
    res.status(200).json({ ok: true });
  });
  const req = makeReq({ body: { secret: "test-middleware-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(capturedCtx, null);
  assert.deepEqual(capturedAdminAuth, { type: "legacy_admin_secret" });
  restoreEnv();
});

test("withAdminAuth: correct secret via Authorization header passes through", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq();
  req.headers.authorization = ["Bearer", "test-middleware-secret"].join(" ");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  restoreEnv();
});

test("withAdminAuth: Supabase operator token attaches tenant context", async () => {
  configureSupabaseAdmin();
  installSupabaseFetch({
    user: { id: "user-123", email: "ops@example.com" },
    memberships: [{
      organization_id: "org-123",
      role: "owner",
      status: "active",
      organizations: { id: "org-123", slug: "acme", status: "active" },
    }],
  });

  let captured = null;
  const handler = withAdminAuth(async (req, res) => {
    captured = {
      tenantContext: req.tenantContext,
      authUser: req.authUser,
      adminAuth: req.adminAuth,
    };
    res.status(200).json({ ok: true });
  });

  const req = makeReq();
  req.headers.authorization = ["Bearer", "supabase-jwt"].join(" ");
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(captured.tenantContext, {
    organizationId: "org-123",
    role: "owner",
    userId: "user-123",
  });
  assert.equal(captured.authUser?.id, "user-123");
  assert.deepEqual(captured.adminAuth, {
    type: "supabase_user",
    userId: "user-123",
    role: "owner",
    organizationId: "org-123",
  });
  restoreEnv();
});

test("withAdminAuth: Supabase operator without active org is rejected", async () => {
  configureSupabaseAdmin();
  installSupabaseFetch({
    user: { id: "user-456", email: "ops@example.com" },
    memberships: [],
  });

  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq();
  req.headers.authorization = ["Bearer", "supabase-jwt"].join(" ");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 403);
  restoreEnv();
});

test("withAdminAuth: sets CORS headers for allowed origin", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({
    origin: "https://admin.slycarrentals.com",
    body: { secret: "test-middleware-secret" },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://admin.slycarrentals.com");
  restoreEnv();
});

test("withAdminAuth: does not echo disallowed origin", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({
    origin: "https://attacker.example.com",
    body: { secret: "test-middleware-secret" },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
  restoreEnv();
});

test("withAdminAuth: unhandled throw in handler returns 500", async () => {
  configureLegacyAdmin();
  const handler = withAdminAuth(async () => {
    throw new Error("unexpected boom");
  });
  const req = makeReq({ body: { secret: "test-middleware-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);
  restoreEnv();
});
