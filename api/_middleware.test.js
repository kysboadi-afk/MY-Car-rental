// api/_middleware.test.js
// Unit tests for api/_middleware.js
//
// Verifies:
//   1. setCorsHeaders — sets headers only for allowed origins
//   2. sendError      — produces structured JSON error responses
//   3. withAdminAuth  — full lifecycle: CORS, OPTIONS, method guard, auth, error catch
//   4. ALLOWED_ORIGINS — canonical list is present and non-empty
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-middleware-secret";

import {
  ALLOWED_ORIGINS,
  setCorsHeaders,
  sendError,
  withAdminAuth,
} from "./_middleware.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
  return res;
}

function makeReq(opts = {}) {
  return {
    method:  opts.method  ?? "POST",
    headers: { origin: opts.origin ?? "https://slycarrentals.com", ...opts.headers },
    body:    opts.body    ?? {},
  };
}

// ─── ALLOWED_ORIGINS ──────────────────────────────────────────────────────────

test("ALLOWED_ORIGINS is a non-empty array", () => {
  assert.ok(Array.isArray(ALLOWED_ORIGINS));
  assert.ok(ALLOWED_ORIGINS.length > 0);
});

test("ALLOWED_ORIGINS includes the canonical admin domain", () => {
  assert.ok(ALLOWED_ORIGINS.includes("https://admin.slycarrentals.com"));
});

test("ALLOWED_ORIGINS includes slycarrentals.com and www variant", () => {
  assert.ok(ALLOWED_ORIGINS.includes("https://slycarrentals.com"));
  assert.ok(ALLOWED_ORIGINS.includes("https://www.slycarrentals.com"));
});

test("ALLOWED_ORIGINS includes slytrans.com and www variant", () => {
  assert.ok(ALLOWED_ORIGINS.includes("https://slytrans.com"));
  assert.ok(ALLOWED_ORIGINS.includes("https://www.slytrans.com"));
});

// ─── setCorsHeaders ───────────────────────────────────────────────────────────

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

test("setCorsHeaders always sets Allow-Methods", () => {
  const req = makeReq({ origin: "https://evil.example.com" });
  const res = makeRes();
  setCorsHeaders(req, res);
  assert.ok(res._headers["Access-Control-Allow-Methods"]);
});

test("setCorsHeaders always sets Allow-Headers", () => {
  const req = makeReq({ origin: "https://evil.example.com" });
  const res = makeRes();
  setCorsHeaders(req, res);
  assert.ok(res._headers["Access-Control-Allow-Headers"]);
});

test("setCorsHeaders handles missing origin header without throwing", () => {
  const req = { method: "POST", headers: {}, body: {} };
  const res = makeRes();
  assert.doesNotThrow(() => setCorsHeaders(req, res));
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

// ─── sendError ────────────────────────────────────────────────────────────────

test("sendError sets status and returns error JSON", () => {
  const res = makeRes();
  sendError(res, 401, "Unauthorized");
  assert.equal(res._status, 401);
  assert.deepEqual(res._body, { error: "Unauthorized" });
});

test("sendError includes details when provided", () => {
  const res = makeRes();
  sendError(res, 400, "Bad request", { field: "email" });
  assert.deepEqual(res._body, { error: "Bad request", details: { field: "email" } });
});

test("sendError omits details when undefined", () => {
  const res = makeRes();
  sendError(res, 500, "Server error");
  assert.equal("details" in res._body, false);
});

test("sendError returns the response for chaining / return", () => {
  const res = makeRes();
  const returned = sendError(res, 404, "Not found");
  assert.equal(returned, res);
});

// ─── withAdminAuth ────────────────────────────────────────────────────────────

test("withAdminAuth: OPTIONS request returns 200 with CORS headers", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ method: "OPTIONS" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.ok(res._headers["Access-Control-Allow-Methods"]);
});

test("withAdminAuth: GET request returns 405", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("withAdminAuth: missing secret returns 401", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ body: {} });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Unauthorized");
});

test("withAdminAuth: wrong secret returns 401", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ body: { secret: "wrong-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("withAdminAuth: correct secret passes through to handler", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({ body: { secret: "test-middleware-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { ok: true });
});

test("withAdminAuth: correct secret via Authorization header passes through", async () => {
  const secret = process.env.ADMIN_SECRET;
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({
    body: {},
    headers: { authorization: `Bearer ${secret}` },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("withAdminAuth: sets req.tenantContext = null in Phase 0", async () => {
  let capturedCtx;
  const handler = withAdminAuth(async (req, res) => {
    capturedCtx = req.tenantContext;
    res.status(200).json({ ok: true });
  });
  const req = makeReq({ body: { secret: "test-middleware-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(capturedCtx, null);
});

test("withAdminAuth: sets CORS headers for allowed origin", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({
    origin: "https://admin.slycarrentals.com",
    body: { secret: "test-middleware-secret" },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://admin.slycarrentals.com");
});

test("withAdminAuth: does not echo disallowed origin", async () => {
  const handler = withAdminAuth(async (_req, res) => res.status(200).json({ ok: true }));
  const req = makeReq({
    origin: "https://attacker.example.com",
    body: { secret: "test-middleware-secret" },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("withAdminAuth: unhandled throw in handler returns 500", async () => {
  const handler = withAdminAuth(async (_req, _res) => {
    throw new Error("unexpected boom");
  });
  const req = makeReq({ body: { secret: "test-middleware-secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error);
});
