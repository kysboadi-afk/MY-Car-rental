// api/_stripe-reconcile-cron.test.js
// Unit tests for api/stripe-reconcile-cron.js.
//
// Covers:
//   1. GET (Vercel cron trigger) — happy path, returns 200 with ok:true
//   2. GET — STRIPE_SECRET_KEY missing → skipped:true
//   3. GET — Supabase not configured → skipped:true
//   4. GET — runSyncRecent throws → 200 with ok:false and error message
//   5. POST — valid Bearer token → executes reconcile
//   6. POST — invalid token → 401
//   7. POST — missing Authorization header → 401
//   8. Unsupported method → 405
//   9. lookback_hours is always LOOKBACK_HOURS (48) — not caller-configurable
//  10. duration_ms is present in all successful responses
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Environment stubs ─────────────────────────────────────────────────────
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.ADMIN_SECRET      = "test-admin-secret";
process.env.CRON_SECRET       = "test-cron-secret";

// ── Shared state ──────────────────────────────────────────────────────────
let runSyncRecentResult = null;   // resolved value for the next call
let runSyncRecentThrows = false;  // if true, next call throws
let runSyncRecentCalls  = [];     // recorded call args

// ── Module mocks ──────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => (supabaseEnabled ? {} : null),
  },
});

mock.module("./stripe-reconcile.js", {
  namedExports: {
    runSyncRecent: async (sb, lookbackHours) => {
      runSyncRecentCalls.push({ lookbackHours });
      if (runSyncRecentThrows) {
        throw new Error("stripe API timeout");
      }
      return runSyncRecentResult;
    },
  },
});

// ── Supabase toggle ───────────────────────────────────────────────────────
let supabaseEnabled = true;

// ── Import handler after mocks ────────────────────────────────────────────
const { default: handler } = await import("./stripe-reconcile-cron.js");

// ── Test helpers ──────────────────────────────────────────────────────────
function makeRes() {
  return {
    _status: 200,
    _body:   null,
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
    send(payload) { this._body = payload; return this; },
    end()          { return this; },
  };
}

function makeGet() {
  return { method: "GET", headers: {} };
}

function makePost(token) {
  return {
    method:  "POST",
    headers: { authorization: token ? `Bearer ${token}` : "" },
  };
}

function reset() {
  runSyncRecentCalls.length = 0;
  runSyncRecentResult       = null;
  runSyncRecentThrows       = false;
  supabaseEnabled           = true;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("GET: happy path → 200 with reconciliation result and duration_ms", async () => {
  reset();
  runSyncRecentResult = {
    ok:             true,
    lookback_hours: 48,
    total:          3,
    processed:      3,
    recovered:      0,
    errors:         0,
    details:        { processed: [], recovered: [], errors: [] },
  };

  const res = makeRes();
  await handler(makeGet(), res);

  assert.equal(res._status,        200);
  assert.equal(res._body.ok,       true);
  assert.equal(res._body.total,    3);
  assert.equal(res._body.processed, 3);
  assert.ok(typeof res._body.duration_ms === "number", "duration_ms should be a number");
});

test("GET: always uses lookback_hours=48", async () => {
  reset();
  runSyncRecentResult = { ok: true, lookback_hours: 48, total: 0, processed: 0, recovered: 0, errors: 0, details: {} };

  const res = makeRes();
  await handler(makeGet(), res);

  assert.equal(runSyncRecentCalls.length, 1);
  assert.equal(runSyncRecentCalls[0].lookbackHours, 48);
});

test("GET: STRIPE_SECRET_KEY missing → skipped:true (200)", async () => {
  reset();
  const orig = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  const res = makeRes();
  await handler(makeGet(), res);

  process.env.STRIPE_SECRET_KEY = orig;
  assert.equal(res._status,          200);
  assert.equal(res._body.skipped,    true);
  assert.ok(res._body.reason.includes("STRIPE_SECRET_KEY"));
  assert.equal(runSyncRecentCalls.length, 0, "runSyncRecent not called when key missing");
});

test("GET: Supabase not configured → skipped:true (200)", async () => {
  reset();
  supabaseEnabled = false;

  const res = makeRes();
  await handler(makeGet(), res);

  supabaseEnabled = true;
  assert.equal(res._status,          200);
  assert.equal(res._body.skipped,    true);
  assert.ok(res._body.reason.toLowerCase().includes("supabase"));
  assert.equal(runSyncRecentCalls.length, 0);
});

test("GET: runSyncRecent throws → 200 with ok:false and error message", async () => {
  reset();
  runSyncRecentThrows = true;

  const res = makeRes();
  await handler(makeGet(), res);

  assert.equal(res._status,      200);
  assert.equal(res._body.ok,     false);
  assert.ok(res._body.error.includes("stripe API timeout"));
  assert.ok(typeof res._body.duration_ms === "number");
});

test("POST: valid ADMIN_SECRET → executes reconcile", async () => {
  reset();
  runSyncRecentResult = { ok: true, lookback_hours: 48, total: 1, processed: 1, recovered: 0, errors: 0, details: {} };

  const res = makeRes();
  await handler(makePost("test-admin-secret"), res);

  assert.equal(res._status,     200);
  assert.equal(res._body.ok,    true);
  assert.equal(runSyncRecentCalls.length, 1);
});

test("POST: valid CRON_SECRET → executes reconcile", async () => {
  reset();
  runSyncRecentResult = { ok: true, lookback_hours: 48, total: 0, processed: 0, recovered: 0, errors: 0, details: {} };

  const res = makeRes();
  await handler(makePost("test-cron-secret"), res);

  assert.equal(res._status, 200);
  assert.equal(runSyncRecentCalls.length, 1);
});

test("POST: invalid token → 401", async () => {
  reset();
  const res = makeRes();
  await handler(makePost("wrong-token"), res);

  assert.equal(res._status, 401);
  assert.equal(runSyncRecentCalls.length, 0);
});

test("POST: missing Authorization header → 401", async () => {
  reset();
  const res = makeRes();
  await handler({ method: "POST", headers: {} }, res);

  assert.equal(res._status, 401);
  assert.equal(runSyncRecentCalls.length, 0);
});

test("PUT: unsupported method → 405", async () => {
  reset();
  const res = makeRes();
  await handler({ method: "PUT", headers: {} }, res);

  assert.equal(res._status, 405);
});

test("duration_ms present on skipped response", async () => {
  reset();
  supabaseEnabled = false;

  const res = makeRes();
  await handler(makeGet(), res);

  supabaseEnabled = true;
  assert.ok(typeof res._body.duration_ms === "number");
});
