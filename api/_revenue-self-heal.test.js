import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "sk_test_fake";

const revenueRows = [];
const bookingsByRef = {};
const persistCalls = [];

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
        let isInitialQuery = false; // set by .or() → the initial revenue_records list query
        return {
          select() { return this; },
          or() {
            // .or() is only called on the initial "fetch all needing repair" query
            isInitialQuery = true;
            return this;
          },
          then(resolve, reject) {
            if (table === "revenue_records" && isInitialQuery) {
              // Simulate the filtered query: stripe_fee IS NULL OR payment_intent_id IS NULL
              const data = revenueRows.filter(
                (r) => r.stripe_fee == null || !r.payment_intent_id
              );
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
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

mock.module("./_booking-pipeline.js", {
  namedExports: {
    persistBooking: async (payload) => {
      persistCalls.push(payload);
      bookingsByRef[payload.bookingId] = {
        id: `rebuilt_${payload.bookingId}`,
        payment_intent_id: payload.paymentIntentId || null,
      };
      return { ok: true, bookingId: payload.bookingId, booking: payload, supabaseOk: true, errors: [] };
    },
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
  persistCalls.length = 0;
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
  assert.equal(persistCalls.length, 0);
  assert.equal(revenueRows[0].stripe_fee, 12);
  assert.equal(revenueRows[0].payment_intent_id, "pi_1");
});

test("revenue-self-heal reconstructs missing booking from revenue + Stripe data", async () => {
  revenueRows.length = 0;
  persistCalls.length = 0;
  revenueRows.push({
    id: "rr_missing_booking",
    booking_id: "bk-missing",
    payment_intent_id: "pi_missing",
    stripe_fee: null,
    refund_amount: 0,
    gross_amount: 350,
    vehicle_id: "camry",
    pickup_date: "2026-04-01",
    return_date: "2026-04-05",
    customer_name: "Rosa Ortuno",
    customer_phone: "+15551234567",
    customer_email: "rosa@example.com",
  });
  delete bookingsByRef["bk-missing"];

  const res = makeRes();
  await handler({ method: "GET", headers: {} }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.repaired, 1);
  assert.equal(persistCalls.length, 1);
  assert.equal(bookingsByRef["bk-missing"]?.id, "rebuilt_bk-missing");
});
