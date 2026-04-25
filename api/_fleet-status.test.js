// api/_fleet-status.test.js
// Tests for GET /api/fleet-status.
//
// Availability is now derived ONLY from the Supabase `bookings` table.
// vehicles.rental_status is used only for maintenance mode (not for
// booking-based availability).  fleet-status.json is no longer used.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_REPO = "kysboadi-afk/SLY-RIDES";
process.env.GITHUB_TOKEN = "test-github-token";

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

function makeReq() {
  return { method: "GET", headers: { origin: "https://www.slytrans.com" }, query: {}, body: {} };
}

const sbMock = {
  client: null,
  vehiclesRows: [
    { vehicle_id: "camry",      rental_status: "available" },
    { vehicle_id: "slingshot",  rental_status: "available" },
    { vehicle_id: "camry2013",  rental_status: "available" },
    { vehicle_id: "slingshot2", rental_status: "available" },
    { vehicle_id: "slingshot3", rental_status: "available" },
  ],
  vehiclesError: null,
  activeBookingRows: [],
  bookingsError: null,
};

function buildSbClient() {
  return {
    from(table) {
      let statusInFilter = null;
      const chain = {
        select() { return this; },
        eq()     { return this; },
        not()    { return this; },
        gte()    { return this; },
        lte()    { return this; },
        limit()  { return this; },
        order()  { return this; },
        in(col, val) {
          if (table === "bookings" && col === "status") statusInFilter = val;
          return this;
        },
        async then(resolve) {
          if (table === "vehicles") {
            return resolve({ data: sbMock.vehiclesRows, error: sbMock.vehiclesError });
          }
          if (table === "bookings") {
            if (!Array.isArray(statusInFilter) || statusInFilter.length === 0) {
              return resolve({ data: [], error: null });
            }
            return resolve({ data: sbMock.activeBookingRows, error: sbMock.bookingsError });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => sbMock.client,
  },
});

// fleet-status.json is no longer consulted for availability — any fetch to it
// should never be needed.  Return an empty object to surface regressions.
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { default: handler } = await import("./fleet-status.js");

function resetMock() {
  sbMock.vehiclesRows = [
    { vehicle_id: "camry",      rental_status: "available" },
    { vehicle_id: "slingshot",  rental_status: "available" },
    { vehicle_id: "camry2013",  rental_status: "available" },
    { vehicle_id: "slingshot2", rental_status: "available" },
    { vehicle_id: "slingshot3", rental_status: "available" },
  ];
  sbMock.vehiclesError  = null;
  sbMock.activeBookingRows = [];
  sbMock.bookingsError  = null;
  sbMock.client = buildSbClient();
}

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

test("no Supabase: returns hard-coded defaults with all vehicles available", async () => {
  sbMock.client = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  // All FALLBACK_VEHICLE_IDS should be available
  for (const vid of ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"]) {
    assert.equal(res._body[vid]?.available, true, `${vid} should default to available`);
  }
});

test("Supabase vehicles error: uses fallback IDs, still queries bookings, all available when no active bookings", async () => {
  resetMock();
  sbMock.vehiclesError = { message: "db timeout" };
  sbMock.vehiclesRows  = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  // No active bookings → all vehicles should be available
  for (const vid of ["camry", "slingshot"]) {
    assert.equal(res._body[vid]?.available, true, `${vid} should be available with no active bookings`);
    assert.equal(res._body[vid]?.available_at, null);
  }
});

test("no active bookings: all vehicles available and available_at is null", async () => {
  resetMock();
  sbMock.activeBookingRows = [];
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  for (const vid of ["camry", "slingshot", "camry2013", "slingshot2", "slingshot3"]) {
    assert.equal(res._body[vid]?.available, true, `${vid} should be available`);
    assert.equal(res._body[vid]?.available_at, null, `${vid} should have available_at=null`);
  }
});

test("active booking makes vehicle unavailable and derives available_at from return_date + return_time in LA", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: "14:00:00", status: "active_rental" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  // Booking drives unavailability — regardless of vehicles.rental_status
  assert.equal(res._body.camry?.available, false);
  const availAt = res._body.camry?.available_at;
  assert.equal(availAt, "2026-06-10T14:00:00-07:00");
  assert.equal(new Date(availAt).toISOString(), "2026-06-10T21:00:00.000Z");
});

test("vehicle with active booking is unavailable even when rental_status=available", async () => {
  resetMock();
  // vehicles table says slingshot is "available" — but there is an active booking
  sbMock.activeBookingRows = [
    { vehicle_id: "slingshot", return_date: "2026-06-11", return_time: "10:00:00", status: "booked_paid" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  // Booking overrides the vehicles.rental_status value — vehicle is unavailable
  assert.equal(res._body.slingshot?.available, false, "slingshot should be unavailable due to active booking");
  assert.ok(res._body.slingshot?.available_at, "slingshot should have available_at set");
});

test("latest active booking return datetime wins per vehicle", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: "09:00:00", status: "active_rental" },
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: "16:30:00", status: "booked_paid" },
    { vehicle_id: "camry", return_date: "2026-06-09", return_time: "20:00:00", status: "active_rental" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false);
  assert.equal(res._body.camry?.available_at, "2026-06-10T16:30:00-07:00");
});

test("reserved booking status is treated as active for availability computation", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-12", return_time: "11:00:00", status: "reserved" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false);
  assert.equal(res._body.camry?.available_at, "2026-06-12T11:00:00-07:00");
});

test("maintenance vehicle is unavailable even with no active bookings", async () => {
  resetMock();
  sbMock.vehiclesRows = [
    { vehicle_id: "camry",      rental_status: "maintenance" },
    { vehicle_id: "slingshot",  rental_status: "available"   },
    { vehicle_id: "camry2013",  rental_status: "available"   },
    { vehicle_id: "slingshot2", rental_status: "available"   },
    { vehicle_id: "slingshot3", rental_status: "available"   },
  ];
  sbMock.activeBookingRows = []; // no bookings

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available, false, "maintenance vehicle should be unavailable");
  assert.equal(res._body.camry?.rental_status, "maintenance");
  assert.equal(res._body.camry?.available_at, null, "no booking = no available_at");
  assert.equal(res._body.slingshot?.available, true, "non-maintenance vehicle should still be available");
});

test("missing return_time logs warning, leaves available_at null, and sets next_available_display to date-only", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: null, status: "active_rental" },
  ];

  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { captured.push(args); };

  try {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.camry?.available, false);
    // available_at must remain null — no synthetic timestamp should be exposed
    assert.equal(res._body.camry?.available_at, null);
    // next_available_display should be set to just the date (no time)
    assert.ok(res._body.camry?.next_available_display, "next_available_display should be set");
    assert.ok(!res._body.camry.next_available_display.includes(" at "), "next_available_display should not include time when return_time is absent");
    assert.ok(captured.some((args) => args[0] === "[AVAILABLE_AT_RETURN_TIME_MISSING]"));
  } finally {
    console.warn = originalWarn;
  }
});

test("logs [AVAILABLE_AT_COMPUTED] with return_datetime and next_available_display", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: "14:00:00", status: "active_rental" },
  ];

  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => { captured.push(args); };

  try {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res._status, 200);
    const computedLog = captured.find((args) => args[0] === "[AVAILABLE_AT_COMPUTED]");
    assert.ok(computedLog, "Expected [AVAILABLE_AT_COMPUTED] log entry");
    assert.equal(computedLog[1]?.vehicle_id, "camry");
    assert.equal(computedLog[1]?.return_datetime, "2026-06-10T14:00:00-07:00");
    // next_available_display should be set and include time
    assert.ok(res._body.camry?.next_available_display, "next_available_display should be set");
    assert.ok(res._body.camry.next_available_display.includes(" at "), "next_available_display should include time");
  } finally {
    console.log = originalLog;
  }
});
