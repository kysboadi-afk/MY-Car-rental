// api/_stripe-replay.test.js
// Tests for POST /api/stripe-replay.
//
// Validates:
//   1. Valid full_payment with complete metadata is processed through all 4 steps
//      (saveWebhookBookingRecord, blockBookedDates, markVehicleUnavailable, sendWebhookNotificationEmails)
//   2. PI already in revenue_records returns already_processed without calling any step
//   3. balance_payment is rejected (422) — would create phantom duplicate booking
//   4. rental_extension is rejected (422)
//   5. slingshot_balance_payment is rejected (422)
//   6. PI with missing vehicle_id is rejected (422)
//   7. PI that is not succeeded is rejected (422)
//   8. dry_run=true returns would_process without calling any step
//   9. Invalid pi_id format returns 400
//  10. Wrong secret returns 401
//  11. Step errors are captured in response.steps and status is still "processed"
//  12. reservation_deposit is processed (creates reserved_unpaid booking)
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.ADMIN_SECRET      = "test-admin-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";

// ─── Mutable state ────────────────────────────────────────────────────────────
let stripePiFixture    = null;  // PI returned by stripe.paymentIntents.retrieve
let piAlreadyRecorded  = false; // simulate PI already in revenue_records
let saveBookingThrows  = false; // simulate saveWebhookBookingRecord throwing

const stepCalls = {
  saveWebhookBookingRecord:      [],
  blockBookedDates:              [],
  markVehicleUnavailable:        [],
  sendWebhookNotificationEmails: [],
};

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    get paymentIntents() {
      return {
        retrieve: async (piId) => {
          if (!stripePiFixture) throw new Error(`No such PaymentIntent: '${piId}'`);
          return stripePiFixture;
        },
      };
    }
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => {
        const builder = {
          select() { return builder; },
          eq()     { return builder; },
          maybeSingle() {
            if (table === "revenue_records") {
              return Promise.resolve({
                data:  piAlreadyRecorded ? { id: "rev-existing" } : null,
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
        return builder;
      },
    }),
  },
});

// Mock stripe-webhook.js — provide the 4 named exports the replay handler imports.
// This avoids pulling in the entire webhook's transitive dependency tree.
mock.module("./stripe-webhook.js", {
  namedExports: {
    saveWebhookBookingRecord: async (pi) => {
      stepCalls.saveWebhookBookingRecord.push(pi.id);
      if (saveBookingThrows) throw new Error("saveWebhookBookingRecord failed");
    },
    blockBookedDates: async (vehicleId, from, to) => {
      stepCalls.blockBookedDates.push({ vehicleId, from, to });
    },
    markVehicleUnavailable: async (vehicleId) => {
      stepCalls.markVehicleUnavailable.push(vehicleId);
    },
    sendWebhookNotificationEmails: async (pi) => {
      stepCalls.sendWebhookNotificationEmails.push(pi.id);
    },
    // Provide the module-level exports Vercel expects (ignored by replay handler).
    config: { api: { bodyParser: false } },
  },
});

const { default: handler } = await import("./stripe-replay.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makePi(id, paymentType, metaOverrides = {}) {
  return {
    id,
    status:          "succeeded",
    amount:          30000,
    amount_received: 30000,
    customer:        null,
    payment_method:  null,
    receipt_email:   null,
    metadata: {
      vehicle_id:   "camry",
      pickup_date:  "2026-08-01",
      return_date:  "2026-08-05",
      renter_name:  "Test User",
      renter_phone: "+13105550000",
      email:        "test@example.com",
      payment_type: paymentType,
      ...metaOverrides,
    },
  };
}

function makeReq(body) {
  return {
    method:  "POST",
    headers: { origin: "https://www.slytrans.com" },
    body,
  };
}

function makeRes() {
  return {
    _status: 200, _body: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(b)   { this._body  = b; return this; },
    send(b)   { this._body  = b; return this; },
    end()     { return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
  };
}

function reset() {
  stripePiFixture   = null;
  piAlreadyRecorded = false;
  saveBookingThrows = false;
  stepCalls.saveWebhookBookingRecord.length      = 0;
  stepCalls.blockBookedDates.length              = 0;
  stepCalls.markVehicleUnavailable.length        = 0;
  stepCalls.sendWebhookNotificationEmails.length = 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("replay: full_payment with complete metadata calls all 4 webhook steps", async () => {
  reset();
  stripePiFixture = makePi("pi_test_full_1", "full_payment");

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_test_full_1" }), res);

  assert.equal(res._status, 200);
  const body = res._body;
  assert.equal(body.status,       "processed");
  assert.equal(body.payment_type, "full_payment");
  assert.equal(body.vehicle_id,   "camry");

  // All 4 steps must have been called exactly once
  assert.equal(stepCalls.saveWebhookBookingRecord.length,      1, "saveWebhookBookingRecord must be called once");
  assert.equal(stepCalls.blockBookedDates.length,              1, "blockBookedDates must be called once");
  assert.equal(stepCalls.markVehicleUnavailable.length,        1, "markVehicleUnavailable must be called once");
  assert.equal(stepCalls.sendWebhookNotificationEmails.length, 1, "sendWebhookNotificationEmails must be called once");

  // Steps object in response must show all ok
  assert.equal(body.steps.saveWebhookBookingRecord,      "ok");
  assert.equal(body.steps.blockBookedDates,              "ok");
  assert.equal(body.steps.markVehicleUnavailable,        "ok");
  assert.equal(body.steps.sendWebhookNotificationEmails, "ok");

  // Verify blockBookedDates received correct vehicle/dates
  assert.equal(stepCalls.blockBookedDates[0].vehicleId, "camry");
  assert.equal(stepCalls.blockBookedDates[0].from,      "2026-08-01");
  assert.equal(stepCalls.blockBookedDates[0].to,        "2026-08-05");
});

test("replay: PI already in revenue_records returns already_processed — no steps called", async () => {
  reset();
  stripePiFixture   = makePi("pi_dup_1", "full_payment");
  piAlreadyRecorded = true;

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_dup_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status, "already_processed");

  // Must not call any pipeline step
  assert.equal(stepCalls.saveWebhookBookingRecord.length,      0, "saveWebhookBookingRecord must NOT be called");
  assert.equal(stepCalls.blockBookedDates.length,              0, "blockBookedDates must NOT be called");
  assert.equal(stepCalls.markVehicleUnavailable.length,        0, "markVehicleUnavailable must NOT be called");
  assert.equal(stepCalls.sendWebhookNotificationEmails.length, 0, "sendWebhookNotificationEmails must NOT be called");
});

test("replay: balance_payment is rejected (422) — not a new booking", async () => {
  reset();
  stripePiFixture = makePi("pi_bal_1", "balance_payment");

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_bal_1" }), res);

  assert.equal(res._status, 422);
  assert.equal(res._body.status,       "error");
  assert.equal(res._body.payment_type, "balance_payment");
  assert.ok(res._body.reason.includes("balance_payment"), `reason should mention payment type; got: ${res._body.reason}`);
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0, "no pipeline steps must run");
});

test("replay: rental_extension is rejected (422)", async () => {
  reset();
  stripePiFixture = makePi("pi_ext_1", "rental_extension");

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_ext_1" }), res);

  assert.equal(res._status, 422);
  assert.equal(res._body.status, "error");
  assert.ok(res._body.reason.includes("rental_extension"));
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0);
});

test("replay: slingshot_balance_payment is rejected (422)", async () => {
  reset();
  stripePiFixture = makePi("pi_slb_1", "slingshot_balance_payment");

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_slb_1" }), res);

  assert.equal(res._status, 422);
  assert.equal(res._body.status, "error");
  assert.ok(res._body.reason.includes("slingshot_balance_payment"));
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0);
});

test("replay: PI missing vehicle_id in metadata is rejected (422)", async () => {
  reset();
  stripePiFixture = makePi("pi_nocar_1", "full_payment", { vehicle_id: undefined });

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_nocar_1" }), res);

  assert.equal(res._status, 422);
  assert.ok(res._body.reason.includes("vehicle_id"), `reason should mention vehicle_id; got: ${res._body.reason}`);
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0);
});

test("replay: PI missing pickup_date in metadata is rejected (422)", async () => {
  reset();
  stripePiFixture = makePi("pi_nodates_1", "full_payment", { pickup_date: undefined });

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_nodates_1" }), res);

  assert.equal(res._status, 422);
  assert.ok(res._body.reason.includes("pickup_date"));
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0);
});

test("replay: PI not in succeeded state is rejected (422)", async () => {
  reset();
  stripePiFixture = {
    ...makePi("pi_pend_1", "full_payment"),
    status:          "requires_payment_method",
    amount_received: 0,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_pend_1" }), res);

  assert.equal(res._status, 422);
  assert.ok(res._body.reason.includes("not in succeeded state"), `reason: ${res._body.reason}`);
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0);
});

test("replay: PI not found in Stripe returns 404", async () => {
  reset();
  stripePiFixture = null; // triggers throw in mock

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_notfound_1" }), res);

  assert.equal(res._status, 404);
  assert.equal(res._body.status, "error");
  assert.ok(res._body.reason.includes("Stripe retrieve failed"));
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 0);
});

test("replay: dry_run=true returns would_process without calling any step", async () => {
  reset();
  stripePiFixture = makePi("pi_dry_1", "full_payment");

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_dry_1", dry_run: true }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status, "would_process");
  assert.equal(res._body.steps.saveWebhookBookingRecord,      "would_run");
  assert.equal(res._body.steps.blockBookedDates,              "would_run");
  assert.equal(res._body.steps.markVehicleUnavailable,        "would_run");
  assert.equal(res._body.steps.sendWebhookNotificationEmails, "would_run");

  // No real writes must occur
  assert.equal(stepCalls.saveWebhookBookingRecord.length,      0, "steps must not run in dry_run");
  assert.equal(stepCalls.blockBookedDates.length,              0);
  assert.equal(stepCalls.markVehicleUnavailable.length,        0);
  assert.equal(stepCalls.sendWebhookNotificationEmails.length, 0);
});

test("replay: invalid pi_id format returns 400", async () => {
  reset();

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "not_a_pi_id" }), res);

  assert.equal(res._status, 400);
});

test("replay: wrong secret returns 401", async () => {
  reset();

  const res = makeRes();
  await handler(makeReq({ secret: "wrong-secret", pi_id: "pi_anything" }), res);

  assert.equal(res._status, 401);
});

test("replay: step error in saveWebhookBookingRecord is captured — remaining steps still run", async () => {
  reset();
  stripePiFixture = makePi("pi_err_1", "full_payment");
  saveBookingThrows = true; // make step 1 throw

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_err_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status, "processed"); // endpoint still succeeds
  assert.ok(
    res._body.steps.saveWebhookBookingRecord.startsWith("error:"),
    `saveWebhookBookingRecord step should record error; got: ${res._body.steps.saveWebhookBookingRecord}`
  );
  // Remaining steps must still have been attempted
  assert.equal(stepCalls.blockBookedDates.length,              1, "blockBookedDates must still run after step 1 error");
  assert.equal(stepCalls.markVehicleUnavailable.length,        1, "markVehicleUnavailable must still run");
  assert.equal(stepCalls.sendWebhookNotificationEmails.length, 1, "emails must still run");
});

test("replay: reservation_deposit is processed (reserved_unpaid booking — not rejected)", async () => {
  reset();
  stripePiFixture = makePi("pi_dep_1", "reservation_deposit");

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", pi_id: "pi_dep_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status,       "processed");
  assert.equal(res._body.payment_type, "reservation_deposit");
  assert.equal(stepCalls.saveWebhookBookingRecord.length, 1, "saveWebhookBookingRecord must be called");
});
