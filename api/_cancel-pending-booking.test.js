import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state = {
  client: null,
  updatePayload: null,
  eqCalls: [],
  inCalls: [],
  neqCalls: [],
  selectClause: null,
};

function resetState() {
  state.updatePayload = null;
  state.eqCalls = [];
  state.inCalls = [];
  state.neqCalls = [];
  state.selectClause = null;
}

function makeSupabaseResult(result) {
  return {
    from(table) {
      assert.equal(table, "bookings");
      return {
        update(payload) {
          state.updatePayload = payload;
          return this;
        },
        eq(column, value) {
          state.eqCalls.push([column, value]);
          return this;
        },
        in(column, values) {
          state.inCalls.push([column, values]);
          return this;
        },
        neq(column, value) {
          state.neqCalls.push([column, value]);
          return this;
        },
        select(columns) {
          state.selectClause = columns;
          return Promise.resolve(result);
        },
      };
    },
  };
}

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => state.client,
  },
});

const { default: handler } = await import("./cancel-pending-booking.js");

function makeReq(body) {
  return {
    method: "POST",
    headers: { origin: "https://slycarrentals.com" },
    body,
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(key, value) { this._headers[key] = value; return this; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

test("cancel-pending-booking marks pending checkout rows as upload_failed", async () => {
  resetState();
  state.client = makeSupabaseResult({ data: [{ booking_ref: "bk-123456abcdef" }], error: null });

  const req = makeReq({
    bookingId: "bk-123456abcdef",
    targetStatus: "upload_failed",
    reason: "blocking_document_upload_failure",
    source: "unit_test",
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { ok: true });
  assert.equal(state.updatePayload.status, "upload_failed");
  assert.deepEqual(state.eqCalls, [["booking_ref", "bk-123456abcdef"]]);
  assert.deepEqual(state.inCalls[0], ["status", ["pending", "pending_checkout"]]);
  assert.deepEqual(state.neqCalls, [["payment_status", "paid"]]);
  assert.match(state.selectClause, /payment_intent_id/);
});

test("cancel-pending-booking defaults to abandoned_checkout", async () => {
  resetState();
  state.client = makeSupabaseResult({ data: [], error: null });

  const req = makeReq({ bookingId: "bk-abcdef123456" });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(state.updatePayload.status, "abandoned_checkout");
});
