// api/_cleanup-blocked-dates.test.js
// Tests for the cleanup-blocked-dates cron endpoint.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ──────────────────────────────────────────────────────
process.env.CRON_SECRET = "test-cron-secret";

// ─── Supabase mock ──────────────────────────────────────────────────────────
let deletedRows = [];
let supabaseDeleteError = null;
let supabaseMissingConfig = false;

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => {
      if (supabaseMissingConfig) return null;
      const builder = {
        _table: null,
        _ltFilter: null,
        from(table) { this._table = table; return this; },
        delete() { return this; },
        lt(col, val) { this._ltFilter = { col, val }; return this; },
        select() {
          if (supabaseDeleteError) {
            return Promise.resolve({ data: null, error: { message: supabaseDeleteError } });
          }
          return Promise.resolve({ data: deletedRows, error: null });
        },
      };
      return builder;
    },
  },
});

const { default: handler } = await import("./cleanup-blocked-dates.js");

// ─── Helpers ────────────────────────────────────────────────────────────────
function makeRes() {
  return {
    _headers: {},
    _status: 200,
    _body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    end() { return this; },
    send(text) { this._body = text; return this; },
    json(obj) { this._body = obj; return this; },
  };
}

function makeReq(method = "GET", headers = {}) {
  return {
    method,
    headers: { authorization: `Bearer test-cron-secret`, ...headers },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("OPTIONS request returns 200", async () => {
  const req = { method: "OPTIONS", headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("non-GET/OPTIONS request returns 405", async () => {
  const req = { method: "POST", headers: { authorization: "Bearer test-cron-secret" } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("returns 401 when Authorization header is missing", async () => {
  const req = { method: "GET", headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 401 when Authorization header has wrong secret", async () => {
  const req = { method: "GET", headers: { authorization: "Bearer wrong-secret" } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 401 when CRON_SECRET is not configured", async () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  process.env.CRON_SECRET = saved;
  assert.equal(res._status, 401);
});

test("returns skipped:true when Supabase is not configured", async () => {
  supabaseMissingConfig = true;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  supabaseMissingConfig = false;
  assert.equal(res._status, 200);
  assert.equal(res._body.skipped, true);
});

test("returns removed:0 when no expired rows exist", async () => {
  deletedRows = [];
  supabaseDeleteError = null;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.removed, 0);
});

test("returns removed count matching deleted rows", async () => {
  deletedRows = [
    { id: 1, vehicle_id: "camry", start_date: "2025-01-01", end_date: "2025-01-05", reason: "booking" },
    { id: 2, vehicle_id: "slingshot", start_date: "2025-02-01", end_date: "2025-02-03", reason: "maintenance" },
  ];
  supabaseDeleteError = null;
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.removed, 2);
  assert.equal(res._body.rows.length, 2);
});

test("returns 500 when Supabase delete fails", async () => {
  deletedRows = [];
  supabaseDeleteError = "database connection error";
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  supabaseDeleteError = null;
  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("database connection error"));
});

test("CORS header is set for allowed origin www.slytrans.com", async () => {
  deletedRows = [];
  const req = { method: "OPTIONS", headers: { origin: "https://www.slytrans.com" } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("CORS header is not set for unknown origin", async () => {
  deletedRows = [];
  const req = { method: "OPTIONS", headers: { origin: "https://evil.example.com" } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});
