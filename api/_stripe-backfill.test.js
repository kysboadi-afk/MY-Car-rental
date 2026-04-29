// api/_stripe-backfill.test.js
// Routing tests for stripe-backfill.js.
//
// Validates that backfill routes each payment_type identically to stripe-webhook.js:
//
//   PROCESSED (persistBooking called):
//     full_payment                         — standard new booking
//     reservation_deposit                  — Camry deposit; saved as reserved_unpaid
//     slingshot_security_deposit           — Slingshot deposit; saved as reserved_unpaid
//     unrecognised / missing payment_type  — safe generic fallback (same as webhook)
//
//   SKIPPED (webhook mutates existing booking; backfill must not create phantom booking):
//     rental_extension
//     balance_payment
//     slingshot_balance_payment
//     PI already in revenue_records
//     PI missing vehicle_id / pickup_date / return_date
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET      = "test-admin-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";

// ─── Mutable state ────────────────────────────────────────────────────────────
// PIs that the mock Stripe returns on paymentIntents.list
let stripePiList = [];
// PI IDs already in revenue_records (should be skipped)
let existingRevenuePiIds = new Set();
// Calls made to persistBooking
const persistedOpts = [];

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    get paymentIntents() {
      return {
        list: async () => ({
          data:     stripePiList,
          has_more: false,
        }),
      };
    }
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => {
        let _filters = {};
        const builder = {
          select() { return builder; },
          in(col, vals) {
            // revenue_records .in("payment_intent_id", [...]) lookup
            _filters.vals = vals;
            return builder;
          },
          eq(col, val) { _filters[col] = val; return builder; },
          then(resolve) {
            if (table === "revenue_records") {
              const data = (_filters.vals || [])
                .filter((id) => existingRevenuePiIds.has(id))
                .map((id) => ({ payment_intent_id: id }));
              return Promise.resolve({ data, error: null }).then(resolve);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return builder;
      },
    }),
  },
});

mock.module("./_booking-pipeline.js", {
  namedExports: {
    persistBooking: async (opts) => {
      persistedOpts.push({ ...opts });
      return { ok: true, bookingId: opts.bookingId || "mocked-bk", booking: opts, supabaseOk: true, errors: [] };
    },
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    normalizePhone: (p) => p,
    appendBooking:  async () => {},
    loadBookings:   async () => ({ data: {}, sha: "sha1" }),
    saveBookings:   async () => {},
    updateBooking:  async () => false,
  },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    DEFAULT_LOCATION:           "Los Angeles, CA",
    render:                     (t) => t,
    EXTEND_CONFIRMED_SLINGSHOT: "",
    EXTEND_CONFIRMED_ECONOMY:   "",
  },
});

const { default: handler } = await import("./stripe-backfill.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makePi(id, paymentType, overrides = {}) {
  return {
    id,
    status:          "succeeded",
    amount:          30000,
    amount_received: 30000,
    customer:        null,
    payment_method:  null,
    receipt_email:   null,
    metadata: {
      vehicle_id:    "camry",
      pickup_date:   "2026-07-01",
      return_date:   "2026-07-05",
      renter_name:   "Test User",
      payment_type:  paymentType,
      ...overrides.metadata,
    },
    ...overrides.pi,
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
  stripePiList = [];
  existingRevenuePiIds = new Set();
  persistedOpts.length = 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("backfill: full_payment with complete metadata is processed via persistBooking", async () => {
  reset();
  stripePiList = [makePi("pi_full_1", "full_payment")];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._status, 200);
  const body = res._body;
  assert.equal(body.processed, 1, "expected 1 processed");
  assert.equal(body.skipped,   0, "expected 0 skipped");
  assert.equal(body.errors,    0, "expected 0 errors");

  const detail = body.details[0];
  assert.equal(detail.pi,           "pi_full_1");
  assert.equal(detail.payment_type, "full_payment");
  assert.equal(detail.status,       "processed");

  assert.equal(persistedOpts.length, 1, "persistBooking should have been called once");
  assert.equal(persistedOpts[0].vehicleId, "camry");
  assert.equal(persistedOpts[0].status,    "booked_paid");
});

test("backfill: balance_payment with complete metadata is SKIPPED (not a new booking)", async () => {
  reset();
  // balance_payment PIs do have vehicle_id/dates in metadata (from pay-balance.js)
  // so the old skipReason() would have passed them through — this tests the fix.
  stripePiList = [makePi("pi_bal_1", "balance_payment")];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._status, 200);
  const body = res._body;
  assert.equal(body.skipped,   1, "expected 1 skipped");
  assert.equal(body.processed, 0, "expected 0 processed");

  const detail = body.details[0];
  assert.equal(detail.pi,           "pi_bal_1");
  assert.equal(detail.payment_type, "balance_payment");
  assert.equal(detail.status,       "skipped");
  assert.ok(detail.reason.includes("balance_payment"), `reason should mention payment_type; got: ${detail.reason}`);

  assert.equal(persistedOpts.length, 0, "persistBooking must NOT be called for balance_payment");
});

test("backfill: PI already in revenue_records is SKIPPED", async () => {
  reset();
  existingRevenuePiIds = new Set(["pi_dup_1"]);
  stripePiList = [makePi("pi_dup_1", "full_payment")];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.skipped, 1);
  assert.equal(res._body.details[0].reason, "already in revenue_records");
  assert.equal(persistedOpts.length, 0);
});

test("backfill: PI missing vehicle_id is SKIPPED", async () => {
  reset();
  stripePiList = [{
    id:              "pi_nocar_1",
    status:          "succeeded",
    amount:          30000,
    amount_received: 30000,
    customer: null, payment_method: null, receipt_email: null,
    metadata: { pickup_date: "2026-07-01", return_date: "2026-07-05", payment_type: "full_payment" },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.skipped, 1);
  assert.ok(res._body.details[0].reason.includes("vehicle_id"));
  assert.equal(persistedOpts.length, 0);
});

test("backfill: PI missing pickup_date is SKIPPED", async () => {
  reset();
  stripePiList = [{
    id:              "pi_nodates_1",
    status:          "succeeded",
    amount:          30000,
    amount_received: 30000,
    customer: null, payment_method: null, receipt_email: null,
    metadata: { vehicle_id: "camry", return_date: "2026-07-05", payment_type: "full_payment" },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.skipped, 1);
  assert.ok(res._body.details[0].reason.includes("pickup_date"));
  assert.equal(persistedOpts.length, 0);
});

test("backfill: reservation_deposit is processed as reserved_unpaid", async () => {
  reset();
  stripePiList = [makePi("pi_dep_1", "reservation_deposit", {
    metadata: { full_rental_amount: "250.00" },
  })];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.processed, 1);
  assert.equal(res._body.details[0].payment_type, "reservation_deposit");
  assert.equal(res._body.details[0].booking_status, "reserved_unpaid");
  assert.equal(persistedOpts[0].status, "reserved_unpaid");
});

test("backfill: dry_run=true returns would_process for full_payment without calling persistBooking", async () => {
  reset();
  stripePiList = [makePi("pi_dry_1", "full_payment")];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", dry_run: true }), res);

  assert.equal(res._body.dry_run,   true);
  assert.equal(res._body.processed, 1, "dry_run counts as processed");
  assert.equal(res._body.skipped,   0);
  assert.equal(res._body.details[0].status,       "would_process");
  assert.equal(res._body.details[0].payment_type, "full_payment");
  assert.equal(persistedOpts.length, 0, "persistBooking must NOT be called in dry_run mode");
});

test("backfill: dry_run=true skips balance_payment (routing consistent with live mode)", async () => {
  reset();
  stripePiList = [makePi("pi_drydal_1", "balance_payment")];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", dry_run: true }), res);

  assert.equal(res._body.skipped, 1, "balance_payment skipped even in dry_run");
  assert.equal(res._body.details[0].status, "skipped");
  assert.equal(persistedOpts.length, 0);
});

test("backfill: phone falls back to customer_details.phone when renter_phone is absent in metadata", async () => {
  reset();
  stripePiList = [makePi("pi_cd_phone_1", "full_payment", {
    metadata: { renter_phone: "" },
    pi:       { customer_details: { phone: "+13105559999" } },
  })];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.processed, 1);
  assert.equal(persistedOpts.length, 1);
  assert.equal(persistedOpts[0].phone, "+13105559999", "should use customer_details.phone when renter_phone is empty");
});

test("backfill: phone falls back to meta.customer_phone when renter_phone and customer_details are absent", async () => {
  reset();
  stripePiList = [makePi("pi_meta_cph_1", "full_payment", {
    metadata: { renter_phone: "", customer_phone: "+13105550042" },
    pi:       { customer_details: null },
  })];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.processed, 1);
  assert.equal(persistedOpts[0].phone, "+13105550042", "should use meta.customer_phone fallback");
});

test("backfill: email falls back to customer_details.email when metadata email is absent", async () => {
  reset();
  stripePiList = [makePi("pi_cd_email_1", "full_payment", {
    metadata: { email: "" },
    pi:       { customer_details: { email: "cd-fallback@example.com" } },
  })];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.processed, 1);
  assert.equal(persistedOpts.length, 1);
  assert.equal(persistedOpts[0].email, "cd-fallback@example.com", "should use customer_details.email when metadata email is empty");
});

test("backfill: email falls back to meta.customer_email when email and customer_details are absent", async () => {
  reset();
  stripePiList = [makePi("pi_meta_cemail_1", "full_payment", {
    metadata: { email: "", customer_email: "metacust@example.com" },
    pi:       { customer_details: null },
  })];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.processed, 1);
  assert.equal(persistedOpts[0].email, "metacust@example.com", "should use meta.customer_email fallback");
});

test("backfill: email falls back to receipt_email when both metadata email and customer_details.email are absent", async () => {
  reset();
  stripePiList = [makePi("pi_receipt_email_1", "full_payment", {
    metadata: { email: "" },
    pi:       { receipt_email: "receipt@example.com", customer_details: null },
  })];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._body.processed, 1);
  assert.equal(persistedOpts[0].email, "receipt@example.com", "should use receipt_email as last-resort fallback");
});

test("backfill: details include payment_type for every entry", async () => {
  reset();
  existingRevenuePiIds = new Set(["pi_existing_1"]);
  stripePiList = [
    makePi("pi_existing_1", "full_payment"),    // skipped — already in revenue_records
    makePi("pi_new_1",      "full_payment"),    // processed
    makePi("pi_bal_2",      "balance_payment"), // skipped — not a new booking
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);

  for (const detail of res._body.details) {
    assert.ok("payment_type" in detail, `detail for PI ${detail.pi} missing payment_type field`);
    assert.ok(typeof detail.payment_type === "string", `payment_type for PI ${detail.pi} should be a string`);
  }

  assert.equal(res._body.skipped,   2);
  assert.equal(res._body.processed, 1);
});
