import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "sk_test_fake";

const revenueRows = [];
const bookingsByRef = {};

mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      retrieve: async (id) => ({
        id,
        amount_received: 35000,
        latest_charge: {
          id: `ch_${id}`,
          balance_transaction: {
            id: `txn_${id}`,
            fee: 1200,
            net: 33800,
          },
        },
      }),
    };
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => {
        let updatePayload = null;
        let filterCol = null;
        let filterVal = null;
        return {
          select() { return this; },
          or() {
            if (table !== "revenue_records") return Promise.resolve({ data: [], error: null });
            const data = revenueRows.filter((r) => r.stripe_fee == null || !r.payment_intent_id);
            return Promise.resolve({ data, error: null });
          },
          eq(col, val) {
            filterCol = col;
            filterVal = val;
            if (updatePayload && table === "revenue_records" && col === "id") {
              const idx = revenueRows.findIndex((r) => r.id === val);
              if (idx !== -1) revenueRows[idx] = { ...revenueRows[idx], ...updatePayload };
              return Promise.resolve({ error: null });
            }
            return this;
          },
          update(payload) {
            updatePayload = payload;
            return this;
          },
          maybeSingle() {
            if (table === "bookings" && filterCol === "booking_ref") {
              return Promise.resolve({ data: bookingsByRef[filterVal] || null, error: null });
            }
            if (table === "revenue_records" && filterCol === "id") {
              const row = revenueRows.find((r) => r.id === filterVal) || null;
              return Promise.resolve({ data: row, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    }),
  },
});

const { default: handler } = await import("./revenue-self-heal.js");

function makeRes() {
  return {
    _status: 200,
    _body: null,
    setHeader() {},
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
    send(payload) { this._body = payload; return this; },
    end() { return this; },
  };
}

test("revenue-self-heal repairs incomplete revenue row", async () => {
  revenueRows.length = 0;
  revenueRows.push({
    id: "rr_1",
    booking_id: "bk-1",
    payment_intent_id: "pi_1",
    stripe_fee: null,
    refund_amount: 0,
  });
  bookingsByRef["bk-1"] = { id: "b_1", payment_intent_id: "pi_1" };

  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.repaired, 1);
  assert.equal(revenueRows[0].stripe_fee, 12);
  assert.equal(revenueRows[0].payment_intent_id, "pi_1");
});

test("revenue-self-heal reports failure when booking is missing", async () => {
  revenueRows.length = 0;
  revenueRows.push({
    id: "rr_missing_booking",
    booking_id: "bk-missing",
    payment_intent_id: "pi_missing",
    stripe_fee: null,
    refund_amount: 0,
  });
  delete bookingsByRef["bk-missing"];

  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 1);
  assert.equal(res._body.repaired, 0);
});
