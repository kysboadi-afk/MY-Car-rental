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
  // last value passed to .gte("actual_return_time", …) — used to assert TZ logic
  lastActualReturnGteValue: null,
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
        gte(col, val) {
          if (col === "actual_return_time") sbMock.lastActualReturnGteValue = val;
          return this;
        },
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
  sbMock.vehiclesError             = null;
  sbMock.activeBookingRows         = [];
  sbMock.activeBookingError        = null;
  sbMock.returnedBookingRows       = [];
  sbMock.returnedBookingError      = null;
  sbMock.lastActualReturnGteValue  = null;
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

// ─── 6. Returned today but MORE than 2h ago → still yields available_at ──────
// The old logic used gte(actual_return_time, NOW()-2h) which dropped same-day
// returns older than 2h. The fix uses gte(actual_return_time, startOfToday).

test("returned today but >2h ago: still gets available_at (start-of-day filter)", async () => {
  resetMock();
  // 3 hours ago — same calendar day, but outside the old 2h window.
  const returnedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  sbMock.returnedBookingRows = [
    { vehicle_id: "camry", actual_return_time: returnedAt },
  ];
  sbMock.activeBookingRows = [];
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);

  const availAt = res._body.camry?.available_at;
  assert.ok(availAt, "camry must have available_at when returned today (even if >2h ago)");

  const expectedMs = new Date(returnedAt).getTime() + 2 * 60 * 60 * 1000;
  const actualMs   = new Date(availAt).getTime();
  assert.ok(Math.abs(actualMs - expectedMs) < 5000,
    `available_at should be returnedAt + 2h. Got ${availAt}, expected ~${new Date(expectedMs).toISOString()}`);
});

// ─── 7. Returned YESTERDAY → excluded by start-of-today filter, no available_at

test("returned yesterday: no available_at (excluded by start-of-today filter)", async () => {
  resetMock();
  // Simulate Supabase correctly filtering out yesterday's return via
  // gte(actual_return_time, startOfBusinessDay) — mock returns empty rows.
  sbMock.returnedBookingRows = []; // yesterday's return excluded by gte filter
  sbMock.activeBookingRows   = [];
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available_at, undefined,
    "camry returned yesterday should have no available_at");
});

// ─── 7a. Cutoff passed to Supabase is midnight in America/Los_Angeles ─────────

test("gte cutoff is midnight America/Los_Angeles, not UTC midnight", async () => {
  resetMock();
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);

  const cutoff = sbMock.lastActualReturnGteValue;
  assert.ok(cutoff, "gte cutoff for actual_return_time must have been set");

  const cutoffDate = new Date(cutoff);

  // The cutoff must represent hour 0, minute 0 in the LA timezone
  const BUSINESS_TZ = "America/Los_Angeles";
  const laHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", hourCycle: "h23" }).format(cutoffDate),
    10
  );
  const laMin = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, minute: "numeric" }).format(cutoffDate),
    10
  );
  assert.equal(laHour, 0,  `cutoff should be hour 0 in LA, got ${laHour}`);
  assert.equal(laMin,  0,  `cutoff should be minute 0 in LA, got ${laMin}`);

  // The cutoff date in LA should equal today's date in LA
  const laCutoffDate = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(cutoffDate);
  const laTodayDate  = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(new Date());
  assert.equal(laCutoffDate, laTodayDate,
    `cutoff LA date (${laCutoffDate}) should equal today's LA date (${laTodayDate})`);
});

// ─── 8. Both active rental AND recent return → actual_return_time wins ────────

test("recent return overrides active rental scheduling", async () => {
  resetMock();
  const returnedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
  // Active rental entry for same vehicle (lower priority)
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-15" },
  ];
  // Return entry (higher priority)
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

// ─── 9. active rental on one vehicle, no impact on another ───────────────────

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
