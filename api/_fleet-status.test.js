// api/_fleet-status.test.js
// Tests for GET /api/fleet-status — available_at from latest active booking
// return_date + return_time in America/Los_Angeles.

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
    { vehicle_id: "camry", rental_status: "rented" },
    { vehicle_id: "slingshot", rental_status: "available" },
    { vehicle_id: "camry2013", rental_status: "available" },
    { vehicle_id: "slingshot2", rental_status: "available" },
    { vehicle_id: "slingshot3", rental_status: "available" },
  ],
  vehiclesError: null,
  activeBookingRows: [],
};

function buildSbClient() {
  return {
    from(table) {
      let statusInFilter = null;
      const chain = {
        select() { return this; },
        eq() { return this; },
        not() { return this; },
        gte() { return this; },
        lte() { return this; },
        limit() { return this; },
        order() { return this; },
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
            return resolve({ data: sbMock.activeBookingRows, error: null });
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

globalThis.fetch = async (url) => {
  if (typeof url === "string" && url.includes("fleet-status.json")) {
    const content = Buffer.from(JSON.stringify({})).toString("base64");
    return { ok: true, json: async () => ({ content }) };
  }
  return { ok: false, status: 404 };
};

const { default: handler } = await import("./fleet-status.js");

function resetMock() {
  sbMock.vehiclesRows = [
    { vehicle_id: "camry", rental_status: "rented" },
    { vehicle_id: "slingshot", rental_status: "available" },
    { vehicle_id: "camry2013", rental_status: "available" },
    { vehicle_id: "slingshot2", rental_status: "available" },
    { vehicle_id: "slingshot3", rental_status: "available" },
  ];
  sbMock.vehiclesError = null;
  sbMock.activeBookingRows = [];
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

test("no Supabase: falls back to GitHub fleet-status", async () => {
  sbMock.client = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available_at, undefined);
});

test("Supabase vehicles error: falls back to GitHub", async () => {
  resetMock();
  sbMock.vehiclesError = { message: "db timeout" };
  sbMock.vehiclesRows = null;
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.camry?.available_at, undefined);
});

test("no active bookings: available_at is null", async () => {
  resetMock();
  sbMock.activeBookingRows = [];
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  for (const vid of ["camry", "slingshot", "camry2013", "slingshot2", "slingshot3"]) {
    assert.equal(res._body[vid]?.available_at, null, `${vid} should have available_at=null`);
  }
});

test("booked vehicle uses return_date + return_time in LA for available_at", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: "14:00:00", status: "active_rental" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  const availAt = res._body.camry?.available_at;
  assert.equal(availAt, "2026-06-10T14:00:00-07:00");
  assert.equal(new Date(availAt).toISOString(), "2026-06-10T21:00:00.000Z");
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
  assert.equal(res._body.camry?.available_at, "2026-06-10T16:30:00-07:00");
});

test("available vehicle does not get available_at from booking rows", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "slingshot", return_date: "2026-06-11", return_time: "10:00:00", status: "booked_paid" },
  ];

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.slingshot?.available_at, null);
});

test("missing return_time logs error and leaves available_at null", async () => {
  resetMock();
  sbMock.activeBookingRows = [
    { vehicle_id: "camry", return_date: "2026-06-10", return_time: null, status: "active_rental" },
  ];

  const captured = [];
  const originalError = console.error;
  console.error = (...args) => { captured.push(args); };

  try {
    const res = makeRes();
    await handler(makeReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.camry?.available_at, null);
    assert.ok(captured.some((args) => args[0] === "[AVAILABLE_AT_RETURN_TIME_MISSING]"));
  } finally {
    console.error = originalError;
  }
});

test("logs [AVAILABLE_AT_COMPUTED] with return_datetime", async () => {
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
  } finally {
    console.log = originalLog;
  }
});
