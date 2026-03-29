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
        order()  { return this; },
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

// ─── Single-vehicle — Supabase fails → must use GitHub fallback ───────────────
// This is the bug fixed in this PR: previously fallback was {} so the vehicle
// would always appear available, allowing double-bookings.

test("single vehicle: falls back to booked-dates.json when Supabase query errors", async () => {
  githubBookedDates = {
    camry: [{ from: "2026-05-03", to: "2026-05-09" }],
  };
  setupFetchMock();
  // Supabase is configured but returns an error
  supabaseMock.client = makeSupabaseClient({ error: { message: "connection timeout" } });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    // Must be unavailable — using GitHub fallback which has the conflict
    assert.equal(res._body.available, false, "vehicle must appear unavailable from GitHub fallback");
    assert.equal(res._body.source, "booked-dates-json");
  } finally {
    supabaseMock.client = null;
    githubBookedDates = {};
    teardownFetchMock();
  }
});

test("single vehicle: available via GitHub fallback when Supabase errors and no overlap in fallback data", async () => {
  githubBookedDates = {
    camry: [{ from: "2026-04-01", to: "2026-04-10" }],
  };
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ error: { message: "503" } });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, true);
    assert.equal(res._body.source, "booked-dates-json");
  } finally {
    supabaseMock.client = null;
    githubBookedDates = {};
    teardownFetchMock();
  }
});

// ─── No Supabase → pure GitHub fallback ──────────────────────────────────────

test("single vehicle: no Supabase → uses GitHub fallback only", async () => {
  githubBookedDates = {
    camry: [{ from: "2026-05-03", to: "2026-05-09" }],
  };
  setupFetchMock();
  supabaseMock.client = null;
  try {
    const res = makeRes();
    await handler(makeReq({ query: { vehicleId: "camry", from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.available, false);
    assert.equal(res._body.source, "booked-dates-json");
  } finally {
    githubBookedDates = {};
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
    // All five vehicles should be present
    for (const vid of ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(res._body.vehicles, vid), `missing vehicle ${vid}`);
      assert.equal(res._body.vehicles[vid].available, true);
    }
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});

// ─── All-vehicles — Supabase fails → fallback must be used ───────────────────

test("all vehicles: falls back to GitHub when Supabase errors — unavailable vehicles must not appear available", async () => {
  githubBookedDates = {
    camry: [{ from: "2026-05-03", to: "2026-05-09" }],
  };
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ error: { message: "timeout" } });
  try {
    const res = makeRes();
    await handler(makeReq({ query: { from: "2026-05-01", to: "2026-05-07" } }), res);
    assert.equal(res._status, 200);
    // camry is blocked in booked-dates.json — must appear unavailable
    assert.equal(res._body.vehicles.camry.available, false, "camry must not appear available during Supabase outage");
    assert.equal(res._body.vehicles.camry.source, "booked-dates-json");
    // Other vehicles with no bookings in fallback must appear available
    assert.equal(res._body.vehicles.slingshot.available, true);
  } finally {
    supabaseMock.client = null;
    githubBookedDates = {};
    teardownFetchMock();
  }
});

// ─── POST method ─────────────────────────────────────────────────────────────

test("POST: accepts params from body", async () => {
  setupFetchMock();
  supabaseMock.client = makeSupabaseClient({ rows: [] });
  try {
    const res = makeRes();
    await handler(makeReq({ method: "POST", body: { vehicleId: "slingshot", from: "2026-06-01", to: "2026-06-02" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.vehicleId, "slingshot");
    assert.equal(res._body.available, true);
  } finally {
    supabaseMock.client = null;
    teardownFetchMock();
  }
});
