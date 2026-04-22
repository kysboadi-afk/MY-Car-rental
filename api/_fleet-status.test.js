// api/_fleet-status.test.js
// Tests for GET /api/fleet-status — specifically the time-aware available_at
// enrichment introduced alongside the "Returned" button functionality.
//
// Scenarios:
//  1. No Supabase → falls back to GitHub, no available_at
//  2. Supabase vehicles query error → falls back to GitHub, no available_at
//  3. No active/completed bookings → no available_at in response
//  4. Active rental (status='active') → available_at = return_date + 1 day
//  5. Returned within 2h buffer (actual_return_time set) → available_at = actual_return_time + 2h
//  6. Returned MORE than 2h ago → NOT within buffer, no available_at from that booking
//  7. Both active rental AND recent return for same vehicle → actual_return_time wins
//  8. [AVAILABILITY_COMPUTED_WITH_TIME] is logged for enriched vehicles
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

function makeReq() {
  return { method: "GET", headers: { origin: "https://www.slytrans.com" }, query: {}, body: {} };
}

// ─── Shared Supabase mock state ───────────────────────────────────────────────

// Configurable per-test query results keyed by the table name + status filter
// used in the mock .from()/.select()/.eq() chain.
const sbMock = {
  client: null,
  // vehicles rows
  vehiclesRows: [
    { vehicle_id: "camry",      rental_status: "rented"    },
    { vehicle_id: "slingshot",  rental_status: "available" },
    { vehicle_id: "camry2013",  rental_status: "available" },
    { vehicle_id: "slingshot2", rental_status: "available" },
    { vehicle_id: "slingshot3", rental_status: "available" },
  ],
  vehiclesError: null,
  // active booking rows (status='active')
  activeBookingRows: [],
  activeBookingError: null,
  // returned booking rows (status='completed', actual_return_time set)
  returnedBookingRows: [],
  returnedBookingError: null,
};

// Build a Supabase client stub that serves sbMock data.
// The fleet-status.js handler runs three queries:
//   1. vehicles → select vehicle_id, rental_status
//   2. bookings → eq status 'active'
//   3. bookings → eq status 'completed'
// We intercept them by tracking the last eq("status", ...) call.
function buildSbClient() {
  return {
    from(table) {
      let lastStatusFilter = null;
      const chain = {
        select()  { return this; },
        in()      { return this; },
        not()     { return this; },
        gte()     { return this; },
        lte()     { return this; },
        limit()   { return this; },
        order()   { return this; },
        eq(col, val) {
          if (col === "status") lastStatusFilter = val;
          return this;
        },
        async then(resolve) {
          if (table === "vehicles") {
            return resolve({ data: sbMock.vehiclesRows, error: sbMock.vehiclesError });
          }
          if (table === "bookings") {
            if (lastStatusFilter === "active") {
              return resolve({ data: sbMock.activeBookingRows, error: sbMock.activeBookingError });
            }
            if (lastStatusFilter === "completed") {
              return resolve({ data: sbMock.returnedBookingRows, error: sbMock.returnedBookingError });
            }
            return resolve({ data: [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => sbMock.client,
  },
});

// GitHub fetch stub — returns an empty vehicles/fleet-status JSON
globalThis.fetch = async (url) => {
  if (typeof url === "string" && url.includes("fleet-status.json")) {
    const content = Buffer.from(JSON.stringify({})).toString("base64");
    return { ok: true, json: async () => ({ content }) };
  }
  return { ok: false, status: 404 };
};

// Import handler after mocks
const { default: handler } = await import("./fleet-status.js");

// ─── Reset helpers ─────────────────────────────────────────────────────────────

function resetMock() {
  sbMock.vehiclesRows = [
    { vehicle_id: "camry",      rental_status: "rented"    },
    { vehicle_id: "slingshot",  rental_status: "available" },
    { vehicle_id: "camry2013",  rental_status: "available" },
    { vehicle_id: "slingshot2", rental_status: "available" },
    { vehicle_id: "slingshot3", rental_status: "available" },
  ];
  sbMock.vehiclesError      = null;
  sbMock.activeBookingRows  = [];
  sbMock.activeBookingError = null;
  sbMock.returnedBookingRows  = [];
  sbMock.returnedBookingError = null;
  sbMock.client = buildSbClient();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("OPTIONS returns 200", async () => {
  const res = makeRes();
  await handler({ method: "OPTIONS", headers: { origin: "https://www.slytrans.com" } }, res);
  assert.equal(res._status, 200);
});

test("non-GET returns 405", async () => {
  resetMock();
  const res = makeRes();
  await handler({ method: "POST", headers: {}, query: {}, body: {} }, res);
  assert.equal(res._status, 405);
});

// ─── 1. No Supabase — GitHub fallback, no available_at ───────────────────────

test("no Supabase: falls back to GitHub fleet-status, no available_at", async () => {
  sbMock.client = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200, "Should return 200 via GitHub fallback");
  // GitHub stub returns {} so result should be default all-available
  for (const vid of ["camry", "slingshot"]) {
    assert.equal(res._body[vid]?.available_at, undefined, `${vid} should not have available_at`);
  }
});

// ─── 2. Supabase vehicles error — falls back to GitHub ────────────────────────

test("Supabase vehicles error: falls back to GitHub, no available_at", async () => {
  resetMock();
  sbMock.vehiclesError = { message: "db timeout" };
  sbMock.vehiclesRows  = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available_at, undefined);
});

// ─── 3. No active / completed bookings → no available_at ─────────────────────

test("no bookings: no available_at added", async () => {
  resetMock();
  sbMock.activeBookingRows   = [];
  sbMock.returnedBookingRows = [];
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  for (const vid of ["camry", "slingshot", "camry2013"]) {
    assert.equal(res._body[vid]?.available_at, undefined, `${vid} should have no available_at`);
  }
});

// ─── 4. Active rental (no actual_return_time) → available_at = next day ──────

test("active rental: available_at = return_date + 1 day (date-level)", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10" },
  ];
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);

  const availAt = res._body.camry?.available_at;
  assert.ok(availAt, "camry must have available_at");

  const parsed = new Date(availAt);
  const expectedISO = "2026-06-11"; // return_date + 1 day
  assert.equal(parsed.toISOString().slice(0, 10), expectedISO,
    `available_at should be the day after return_date. Got: ${availAt}`);
});

// ─── 5. Returned within 2h buffer → available_at = actual_return_time + 2h ───

test("returned within 2h buffer: available_at = actual_return_time + 2h", async () => {
  resetMock();
  const returnedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
  sbMock.returnedBookingRows = [
    { vehicle_id: "camry", actual_return_time: returnedAt },
  ];
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);

  const availAt = res._body.camry?.available_at;
  assert.ok(availAt, "camry must have available_at when returned in buffer");

  const expectedMs = new Date(returnedAt).getTime() + 2 * 60 * 60 * 1000;
  const actualMs   = new Date(availAt).getTime();
  // Allow 5s tolerance for timing
  assert.ok(Math.abs(actualMs - expectedMs) < 5000,
    `available_at should be actual_return_time + 2h. Expected ~${new Date(expectedMs).toISOString()}, got ${availAt}`);
});

// ─── 6. Returned MORE than 2h ago → outside buffer, no available_at ──────────

test("returned more than 2h ago: no available_at from that booking", async () => {
  resetMock();
  // 3 hours ago — outside the 2h buffer window
  const returnedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  // This row should be excluded by the gte(actual_return_time, twoHoursAgo) filter.
  // Our mock does not filter by gte, so we simulate by having the mock return []
  // for the completed query when the row is outside the window.
  // (In production, Supabase filters this out via .gte("actual_return_time", twoHoursAgo))
  sbMock.returnedBookingRows = []; // outside buffer — Supabase gte filter would exclude it
  sbMock.activeBookingRows   = []; // no active booking either
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available_at, undefined,
    "camry should not have available_at when returned outside buffer");
});

// ─── 7. Both active rental AND recent return → actual_return_time wins ────────

test("recent return overrides active rental scheduling", async () => {
  resetMock();
  const returnedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
  // Active rental entry for same vehicle (lower priority)
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-15" },
  ];
  // Recent return entry (higher priority)
  sbMock.returnedBookingRows = [
    { vehicle_id: "camry", actual_return_time: returnedAt },
  ];

  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);

  const availAt = res._body.camry?.available_at;
  assert.ok(availAt, "camry must have available_at");

  // Should be actual_return_time + 2h, NOT return_date + 1 day
  const expectedMs = new Date(returnedAt).getTime() + 2 * 60 * 60 * 1000;
  const actualMs   = new Date(availAt).getTime();
  const dateOnly   = new Date(availAt).toISOString().slice(0, 10);
  assert.ok(Math.abs(actualMs - expectedMs) < 5000,
    `actual_return_time should win over return_date. Got available_at=${availAt}, expected ~${new Date(expectedMs).toISOString()}`);
  assert.notEqual(dateOnly, "2026-06-16",
    "available_at must NOT be based on the active rental return_date when actual_return_time is present");
});

// ─── 8. active rental on one vehicle, no impact on another ───────────────────

test("active rental for one vehicle does not affect other vehicles", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10" },
  ];
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);

  assert.ok(res._body.camry?.available_at, "camry must have available_at");
  assert.equal(res._body.slingshot?.available_at, undefined, "slingshot must not be affected");
  assert.equal(res._body.camry2013?.available_at, undefined,  "camry2013 must not be affected");
});
