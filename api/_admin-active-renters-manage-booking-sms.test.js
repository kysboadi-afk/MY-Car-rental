import { test, mock } from "node:test";
import assert from "node:assert/strict";

let supabaseClient = null;
let dispatchImpl = async () => ({ sent: true });
const dispatchCalls = [];

mock.module("./_admin-auth.js", {
  namedExports: {
    isAdminConfigured: () => Boolean(process.env.ADMIN_SECRET),
    isAdminAuthorized: (supplied) => Boolean(process.env.ADMIN_SECRET && supplied === process.env.ADMIN_SECRET),
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseClient,
  },
});

mock.module("./_sms-dispatcher.js", {
  namedExports: {
    dispatchSms: async (payload) => {
      dispatchCalls.push(payload);
      return dispatchImpl(payload);
    },
  },
});

const { default: handler } = await import("./admin-active-renters-manage-booking-sms.js");

function makeReq({ body = {}, method = "POST", origin = "https://slycarrentals.com" } = {}) {
  return { method, body, headers: { origin } };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function setSupabaseBookings({ data = [], error = null } = {}) {
  supabaseClient = {
    from(table) {
      assert.equal(table, "bookings");
      return {
        select(columns) {
          assert.ok(columns.includes("booking_ref"));
          return {
            in(column, statuses) {
              assert.equal(column, "status");
              assert.deepEqual(statuses, ["active_rental", "active", "overdue"]);
              return Promise.resolve({ data, error });
            },
          };
        },
      };
    },
  };
}

test("returns 401 when secret is invalid", async () => {
  process.env.ADMIN_SECRET = "secret";
  setSupabaseBookings();
  const req = makeReq({ body: { secret: "wrong" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 500 when supabase is not configured", async () => {
  process.env.ADMIN_SECRET = "secret";
  supabaseClient = null;
  const req = makeReq({ body: { secret: "secret" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 500);
  assert.match(res._body.error, /Supabase not configured/i);
});

test("dryRun returns unique active renter targets", async () => {
  process.env.ADMIN_SECRET = "secret";
  dispatchCalls.length = 0;
  setSupabaseBookings({
    data: [
      { booking_ref: "bk-2", status: "active_rental", renter_phone: "+1 (212) 555-0100" },
      { booking_ref: "bk-1", status: "active", renter_phone: "+12125550100" },
      { booking_ref: "bk-3", status: "overdue", customer_phone: "+13105550100" },
      { booking_ref: "bk-4", status: "active_rental", renter_phone: "" },
    ],
  });
  const req = makeReq({ body: { secret: "secret", dryRun: true } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.dryRun, true);
  assert.equal(res._body.uniqueRenters, 2);
  assert.equal(res._body.skippedNoPhone, 1);
  assert.deepEqual(res._body.sampleBookingRefs, ["bk-1", "bk-3"]);
  assert.equal(dispatchCalls.length, 0);
});

test("sends one-time education SMS and reports sent/deduped/failed counts", async () => {
  process.env.ADMIN_SECRET = "secret";
  dispatchCalls.length = 0;
  setSupabaseBookings({
    data: [
      { booking_ref: "bk-1", vehicle_id: "camry", status: "active_rental", renter_phone: "+12125550100" },
      { booking_ref: "bk-2", vehicle_id: "camry2013", status: "active", customer_phone: "+13105550100" },
      { booking_ref: "bk-3", vehicle_id: "camry", status: "overdue", renter_phone: "+14155550100" },
    ],
  });
  dispatchImpl = async (payload) => {
    if (payload.bookingId === "bk-1") return { sent: true };
    if (payload.bookingId === "bk-2") return { sent: false, skipped: true, dedupSkipped: true };
    return { sent: false, skipped: false, error: "provider_error" };
  };

  const req = makeReq({ body: { secret: "secret" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.targetedRenters, 3);
  assert.equal(res._body.sent, 1);
  assert.equal(res._body.deduped, 1);
  assert.equal(res._body.failed, 1);
  assert.equal(dispatchCalls.length, 3);
  assert.equal(dispatchCalls[0].templateKey, "active_renter_manage_booking_education_2026_05");
});
