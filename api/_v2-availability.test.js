// api/_v2-availability.test.js
// Tests for GET|POST /api/v2-availability
//
// Key scenarios:
//  1. Returns 400 for missing/invalid from/to params
//  2. Returns 400 for unknown vehicleId
//  3. Single-vehicle check — Supabase OK → available/unavailable
//  4. Single-vehicle check — Supabase failure → falls back to booked-dates.json
//  5. All-vehicle check — Supabase OK
//  6. All-vehicle check — Supabase failure → fallback used for every vehicle
//  7. No Supabase configured → pure GitHub fallback
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.GITHUB_REPO  = "kysboadi-afk/SLY-RIDES";
process.env.GITHUB_TOKEN = "test-github-token";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  return {
    _status:  200,
    _body:    null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    send(body)   { this._body = body; return this; },
    end()        { return this; },
  };
}

function makeReq({ method = "GET", query = {}, body = {} } = {}) {
  return {
    method,
    headers: { origin: "https://www.slytrans.com" },
    query,
    body,
  };
}

// ─── Shared mock state ────────────────────────────────────────────────────────

// booked-dates.json served from GitHub mock
let githubBookedDates = {};
// Supabase mock state
const supabaseMock = {
  client: null,          // set to a client object to simulate Supabase configured
  queryError: null,      // set to simulate Supabase query failure
  queryRows: [],         // rows returned on success
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseMock.client,
  },
});

// Mock the global fetch used by fetchGitHubBookedDates
const originalFetch = globalThis.fetch;

// Install a fetch interceptor before each test that returns githubBookedDates
function setupFetchMock() {
  globalThis.fetch = async (url, opts) => {
    if (typeof url === "string" && url.includes("booked-dates.json")) {
      const encoded = Buffer.from(JSON.stringify(githubBookedDates)).toString("base64");
      return {
        ok: true,
        json: async () => ({ content: encoded }),
      };
    }
    // Unexpected fetch call
    return { ok: false, status: 500 };
  };
}

function teardownFetchMock() {
  globalThis.fetch = originalFetch;
}

// Build a minimal Supabase-style client stub
function makeSupabaseClient({ rows = [], error = null } = {}) {
  return {
    from() {
      return {
        select() { return this; },
        eq()     { return this; },
        in()     { return this; },
        lte()    { return this; },
        gte()    { return this; },
        limit()  { return this; },
        order()  { return this; },
        or()     { return this; },
        then: undefined,
        // Jest/node-test style: awaiting the chain resolves to { data, error }
        [Symbol.for("nodejs.rejection")]: undefined,
        async then(resolve) {
          return resolve({ data: rows, error });
        },
      };
    },
  };
}

/**
 * A mock Supabase client where the FIRST `.from()` call returns `rowsFirst`
 * and every subsequent call returns `rowsRest` (default []).
 *
 * Used for active_rental-override tests where:
 *   call 0  → active_rental lookup   (returns the stale booking row)
 *   call 1  → computeFinalReturnDate (revenue_records, returns [])
 *   call 2  → date-range overlap     (returns [])
 */
function makeSupabaseClientSeq({ rowsFirst = [], rowsRest = [], error = null } = {}) {
  let callIndex = 0;
  return {
    from() {
      const rows = callIndex++ === 0 ? rowsFirst : rowsRest;
      return {
        select() { return this; },
        eq()     { return this; },
        in()     { return this; },
        lte()    { return this; },
        gte()    { return this; },
        limit()  { return this; },
        order()  { return this; },
        or()     { return this; },
        then: undefined,
        [Symbol.for("nodejs.rejection")]: undefined,
        async maybeSingle() { return { data: rows[0] || null, error }; },
        async then(resolve) { return resolve({ data: rows, error }); },
      };
    },
  };
}

// Dynamically import the handler after mocks are in place
const { default: handler } = await import("./v2-availability.js");

// ─── Tests ───────────────────────────────────────────────────────────────────

test("OPTIONS returns 200", async () => {
  const res = makeRes();
  await handler({ method: "OPTIONS", headers: { origin: "https://www.slytrans.com" }, query: {}, body: {} }, res);
  assert.equal(res._status, 200);
});

test("non-GET/POST returns 405", async () => {
  const res = makeRes();
  await handler({ method: "DELETE", headers: {}, query: {}, body: {} }, res);
  assert.equal(res._status, 405);
});

test("400 when from is missing", async () => {
  setupFetchMock();
  try {
    const res = makeRes();
    await handler(makeReq({ query: { to: "2026-05-07" } }), res);
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes("from"));
  } finally { teardownFetchMock(); }
});

test("400 when to is missing", async () => {
  setupFetchMock();
  try {
    const res = makeRes();
    await handler(makeReq({ query: { from: "2026-05-01" } }), res);
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes("to"));
  } finally { teardownFetchMock(); }
});

test("400 when from is invalid format", async () => {
  setupFetchMock();
  try {
    const res = makeRes();
    await handler(makeReq({ query: { from: "May 1 2026", to: "2026-05-07" } }), res);
    assert.equal(res._status, 400);
  } finally { teardownFetchMock(); }
});

test("400 when to < from", async () => {
  setupFetchMock();
  try {
    const res = makeRes();
    await handler(makeReq({ query: { from: "2026-05-07", to: "2026-05-01" } }), res);
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes("before"));
  } finally { teardownFetchMock(); }
});

test("400 for unknown vehicleId", async () => {
  setupFetchMock();
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "hovercraft", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes("vehicleId"));
  } finally { teardownFetchMock(); }
});

// ─── Single-vehicle — Supabase OK, no conflicts ───────────────────────────────

test("single vehicle: available when Supabase returns no conflicts", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ rows: [] });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, true);
    assert.equal(res._body.source, "supabase");
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

// ─── Single-vehicle — Supabase OK, conflict exists ───────────────────────────

test("single vehicle: unavailable when Supabase returns a conflicting booking", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({
    rows: [{ booking_ref: "abc123", vehicle_id: "camry", pickup_date: "2026-05-03", return_date: "2026-05-09", status: "booked_paid" }],
  });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, false);
    assert.equal(res._body.conflicts.length, 1);
    assert.equal(res._body.source, "supabase");
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

test("single vehicle: reserved status blocks availability", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({
    rows: [{ booking_ref: "res123", vehicle_id: "camry", pickup_date: "2026-05-03", return_date: "2026-05-09", status: "reserved" }],
  });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, false);
    assert.equal(res._body.source, "supabase");
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

// ─── Single-vehicle — Supabase fails → must return error (no JSON fallback) ──

test("single vehicle: returns 500 when Supabase query errors", async () => {
  setupFetchMock();
  // Supabase is configured but returns an error
  supabaseMock.client = makeSupabaseClient({ error: { message: "connection timeout" } });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 500);
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

test("single vehicle: returns 500 when Supabase errors (even if no overlap in old fallback data)", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ error: { message: "503" } });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 500);
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

// ─── No Supabase → returns 503 ────────────────────────────────────────────────

test("single vehicle: no Supabase → returns 503", async () => {
  setupFetchMock();
  supabaseMock.client = null;
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 503);
  } finally {
    teardownFetchMock();
  }
});

// ─── All-vehicles — Supabase OK ───────────────────────────────────────────────

test("all vehicles: returns map of vehicleId → availability when Supabase OK", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ rows: [] });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.ok(res._body.vehicles, "response should have vehicles map");
    // Both configured vehicles should be present
    for (const vid of ["camry", "camry2013"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(res._body.vehicles, vid), `missing vehicle ${vid}`);
      assert.equal(res._body.vehicles[vid].available, true);
    }
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

// ─── All-vehicles — Supabase fails → errors per vehicle ──────────────────────

test("all vehicles: returns error per-vehicle when Supabase errors", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ error: { message: "timeout" } });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    // All vehicles should have source "error" since Supabase failed
    for (const vid of ["camry", "camry2013"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(res._body.vehicles, vid), `missing vehicle ${vid}`);
      assert.equal(res._body.vehicles[vid].source, "error", `${vid} should have source=error`);
    }
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

// ─── POST method ─────────────────────────────────────────────────────────────

// ─── Active rental override ───────────────────────────────────────────────────
// The active_rental override now uses finalReturnDate (incorporating paid
// extensions from revenue_records).  Requested windows that start AFTER
// finalReturnDate + 2-hour prep buffer are allowed; windows that start BEFORE
// are still blocked.

test("active rental override: available when requested dates start after final return + buffer", async () => {
  setupFetchMock();
  // Active rental whose return date is in the past (Apr 18, no extensions).
  // Query sequence:
  //   call 0 — active_rental lookup → returns the stale booking row
  //   call 1 — computeFinalReturnDate (revenue_records) → returns [] (no extensions)
  //   call 2 — date-range overlap check → returns [] (Apr 22 is after Apr 18)
  // Requesting Apr 22–25 (start >> Apr 18 + 2 h prep buffer) → AVAILABLE.
  supabaseMock.client = makeSupabaseClientSeq({
    rowsFirst: [{ booking_ref: "ar-001", return_date: "2026-04-18", return_time: "10:00:00" }],
    rowsRest:  [],
  });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-04-22", to: "2026-04-25" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, true, "vehicle must be available when requested start is after final return + buffer");
    assert.equal(res._body.source, "supabase");
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

test("active rental override: unavailable when requested dates overlap the active rental window", async () => {
  setupFetchMock();
  // Active rental ending May 5 (future). Requesting Apr 28–May 3 overlaps → UNAVAILABLE.
  supabaseMock.client = makeSupabaseClient({
    rows: [{ booking_ref: "ar-002", return_date: "2026-05-05", return_time: "10:00:00" }],
  });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-04-28", to: "2026-05-03" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, false, "vehicle must be unavailable when request overlaps active rental");
    assert.equal(res._body.source, "supabase");
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

test("active rental override: unavailable when requested dates are within prep buffer after final return", async () => {
  setupFetchMock();
  // Active rental ending May 5 at 10 AM.  Requesting May 5–7 is within 2-hour buffer → UNAVAILABLE.
  supabaseMock.client = makeSupabaseClient({
    rows: [{ booking_ref: "ar-003", return_date: "2026-05-05", return_time: "10:00:00" }],
  });
  try {
    const res = makeRes();
    // from = same day as return_date (within buffer regardless of time)
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-05", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, false, "vehicle must be unavailable within prep buffer of final return");
    assert.equal(res._body.source, "supabase");
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});
