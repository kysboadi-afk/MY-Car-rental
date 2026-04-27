// api/_stripe-reconcile-sync.test.js
// Unit tests for the "sync_recent" action added to stripe-reconcile.js.
//
// Covers:
//   1. classifyPaymentType — all three branches (rental, rental_extension, deposit)
//   2. sync_recent / processed — PI already in DB with correct data
//   3. sync_recent / recovered — PI missing from DB (inserted)
//   4. sync_recent / recovered — PI in DB with wrong amount (updated)
//   5. sync_recent / recovered — PI in DB with missing stripe_fee (updated)
//   6. sync_recent / error     — Supabase lookup throws
//   7. lookback_hours clamped to 1–168
//   8. alert email sent when recovered/error items are present
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Environment stubs ──────────────────────────────────────────────────────
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.ADMIN_SECRET      = "test-secret";
// Set SMTP vars so sendReconcileAlertEmail fires in tests (not short-circuited).
process.env.SMTP_HOST         = "smtp.test.invalid";
process.env.SMTP_PORT         = "587";
process.env.SMTP_USER         = "noreply@test.invalid";
process.env.SMTP_PASS         = "testpass";
process.env.OWNER_EMAIL       = "owner@test.invalid";

// ── Shared state ───────────────────────────────────────────────────────────

// revenue_records store: keyed by payment_intent_id
const rrByPI = {};
// Track calls to autoCreateRevenueRecord
const createCalls = [];
// Track nodemailer sendMail calls
const mailsSent = [];

// Stripe PI list (populated per-test)
let stripeListPage = [];

// ── Module mocks ───────────────────────────────────────────────────────────

mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      list: async (params) => {
        // Respect the created.gte filter so time-window logic is exercised.
        const sinceGte = params?.created?.gte || 0;
        const filtered = stripeListPage.filter(
          (pi) => pi.created >= sinceGte && pi.status === "succeeded"
        );
        return { data: filtered, has_more: false };
      },
    };
  },
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (opts) => {
        mailsSent.push(opts);
        return {};
      },
    }),
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => buildFakeSupabase(),
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({ data: {} }),
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (err) => err?.message || String(err),
    isSchemaError:     ()    => false,
  },
});

mock.module("./_booking-automation.js", {
  namedExports: {
    autoCreateRevenueRecord: async (booking, _opts) => {
      createCalls.push(booking);
      // Simulate successful insert: register the PI in rrByPI
      if (booking.paymentIntentId) {
        rrByPI[booking.paymentIntentId] = {
          id:              "rr_new_" + booking.paymentIntentId,
          gross_amount:    booking.amountPaid,
          stripe_fee:      booking.stripeFee,
          stripe_net:      booking.stripeNet,
          stripe_charge_id: null,
          payment_status:  "paid",
          payment_intent_id: booking.paymentIntentId,
        };
      }
    },
    extendBlockedDateForBooking: async () => {},
  },
});

// ── Fake Supabase factory ──────────────────────────────────────────────────

// Controls whether the next lookup should simulate an error.
let nextLookupError = null;
// Controls whether the next update should simulate an error.
let nextUpdateError = null;

function buildFakeSupabase() {
  return {
    from: (table) => buildTable(table),
  };
}

// Track update payloads for verification
const updatePayloads = {};
// Track bookings.return_date updates from applyExtensionReturnDateToBooking
const bookingReturnDateUpdates = [];
// Simulated bookings store (keyed by booking_ref) for applyExtensionReturnDateToBooking reads
const bookingsStore = {};

function buildTable(table) {
  let filterPiId      = null;
  let filterBookingRef = null;
  let updateBuf    = null;
  let filterId     = null;
  let excludeFlag  = null;

  const chain = {
    select()      { return this; },
    eq(col, val) {
      if (col === "payment_intent_id") filterPiId       = val;
      if (col === "booking_ref")       filterBookingRef = val;
      if (col === "id")               filterId         = val;
      if (col === "sync_excluded")    excludeFlag      = val;
      return this;
    },
    update(payload) {
      updateBuf = payload;
      return this;
    },
    maybeSingle() {
      // bookings table: return a found booking for any "bk-…" ref so
      // resolveBookingId succeeds in deposit-recovery tests.
      if (table === "bookings") {
        if (filterBookingRef && filterBookingRef.startsWith("bk-")) {
          const stored = bookingsStore[filterBookingRef] || {};
          return Promise.resolve({ data: { booking_ref: filterBookingRef, ...stored }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (table !== "revenue_records") return Promise.resolve({ data: null, error: null });
      // Simulate a lookup error if requested.
      if (nextLookupError) {
        const err = nextLookupError;
        nextLookupError = null;
        return Promise.resolve({ data: null, error: err });
      }
      const raw = filterPiId ? (rrByPI[filterPiId] || null) : null;
      // Return a shallow clone so the test's rrByPI entry is not mutated by the
      // fake update path — preserves original values for the reason string assertion.
      const row = raw ? { ...raw } : null;
      return Promise.resolve({ data: row, error: null });
    },
    then(resolve, reject) {
      // Called when update chain is awaited directly (update → eq → then)
      if (updateBuf && table === "revenue_records") {
        if (nextUpdateError) {
          const err = nextUpdateError;
          nextUpdateError = null;
          return Promise.resolve({ error: err }).then(resolve, reject);
        }
        if (filterId) {
          // Find the record with this id and apply the update.
          for (const [piKey, rec] of Object.entries(rrByPI)) {
            if (rec.id === filterId) {
              Object.assign(rrByPI[piKey], updateBuf);
              updatePayloads[filterId] = { ...updateBuf };
            }
          }
        }
        return Promise.resolve({ error: null }).then(resolve, reject);
      }
      // bookings update (applyExtensionReturnDateToBooking)
      if (updateBuf && table === "bookings") {
        if (filterBookingRef && updateBuf.return_date) {
          bookingReturnDateUpdates.push({ booking_ref: filterBookingRef, return_date: updateBuf.return_date });
          if (bookingsStore[filterBookingRef]) {
            bookingsStore[filterBookingRef].return_date = updateBuf.return_date;
          }
        }
        return Promise.resolve({ error: null }).then(resolve, reject);
      }
      // bookings lookup (resolveBookingId) — legacy .then() path
      if (table === "bookings") {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    },
  };
  return chain;
}

// ── Import handler after all mocks are set ────────────────────────────────
const { default: handler } = await import("./stripe-reconcile.js");

function makeReq(body) {
  return {
    method:  "POST",
    headers: { origin: "https://www.slytrans.com" },
    body,
  };
}

function makeRes() {
  return {
    _status: 200,
    _body:   null,
    setHeader() {},
    status(code) { this._status = code; return this; },
    json(payload) { this._body = payload; return this; },
    send(payload) { this._body = payload; return this; },
    end()  { return this; },
  };
}

function reset() {
  for (const k of Object.keys(rrByPI))       delete rrByPI[k];
  for (const k of Object.keys(updatePayloads)) delete updatePayloads[k];
  for (const k of Object.keys(bookingsStore))  delete bookingsStore[k];
  createCalls.length              = 0;
  mailsSent.length                = 0;
  bookingReturnDateUpdates.length = 0;
  stripeListPage      = [];
  nextLookupError     = null;
  nextUpdateError     = null;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("sync_recent: PI already in DB with correct data → processed", async () => {
  reset();
  const piId = "pi_correct_1";
  rrByPI[piId] = {
    id:               "rr_c1",
    gross_amount:     100,
    stripe_fee:       3.2,
    stripe_net:       96.8,
    stripe_charge_id: "ch_c1",
    payment_status:   "paid",
    payment_intent_id: piId,
  };
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 10000,       // $100
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   "test@example.com",
    metadata:        { payment_type: "full_payment" },
    latest_charge:   {
      id: "ch_c1",
      billing_details: { email: "test@example.com" },
      balance_transaction: { fee: 320, net: 9680 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent", lookback_hours: 2 }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.ok,        true);
  assert.equal(res._body.processed, 1);
  assert.equal(res._body.recovered, 0);
  assert.equal(res._body.errors,    0);
  assert.equal(createCalls.length,  0);
  assert.equal(mailsSent.length,    0, "no alert when everything is already correct");
});

test("sync_recent: PI missing from DB → recovered (inserted)", async () => {
  reset();
  const piId = "pi_missing_1";
  // rrByPI is empty for this PI
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 5000,        // $50
    created:         Math.floor(Date.now() / 1000) - 120,
    receipt_email:   "renter@example.com",
    metadata: {
      payment_type:  "full_payment",
      booking_id:    "bk-missing-1",
      vehicle_id:    "camry",
      renter_name:   "Jane Doe",
      pickup_date:   "2026-05-01",
      return_date:   "2026-05-03",
    },
    latest_charge: {
      id: "ch_m1",
      billing_details: { email: "renter@example.com" },
      balance_transaction: { fee: 175, net: 4825 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.ok,        true);  // no errors
  assert.equal(res._body.recovered, 1);
  assert.equal(res._body.processed, 0);
  assert.equal(createCalls.length,  1);
  assert.equal(createCalls[0].paymentIntentId, piId);
  assert.equal(createCalls[0].type,            "rental");
  assert.equal(createCalls[0].amountPaid,       50);
  // Alert must be sent because there is a recovered item
  assert.equal(mailsSent.length, 1, "alert email sent when record was recovered");
  assert.match(mailsSent[0].subject, /Stripe Reconcile Alert/);
});

test("sync_recent: rental_extension PI missing from DB → recovered with extension type and booking.return_date updated", async () => {
  reset();
  const piId = "pi_ext_1";
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 15000,       // $150
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   "renter@example.com",
    metadata: {
      payment_type:         "rental_extension",
      booking_id:           "bk-original-1",
      vehicle_id:           "camry",
      previous_return_date: "2026-05-10",
      new_return_date:      "2026-05-11",
    },
    latest_charge: {
      id: "ch_ext1",
      billing_details: {},
      balance_transaction: { fee: 480, net: 14520 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.recovered, 1);
  assert.equal(createCalls.length,  1);
  const extCall = createCalls[0];
  assert.equal(extCall.type, "extension");
  // Extension revenue record must use the extension window dates.
  assert.equal(extCall.pickupDate, "2026-05-10", "extension pickupDate must equal previous_return_date");
  assert.equal(extCall.returnDate, "2026-05-11", "extension returnDate must equal new_return_date");
  // bookings.return_date must be advanced to new_return_date.
  assert.equal(bookingReturnDateUpdates.length, 1, "bookings.return_date must be updated after extension recovery");
  assert.equal(bookingReturnDateUpdates[0].booking_ref, "bk-original-1");
  assert.equal(bookingReturnDateUpdates[0].return_date, "2026-05-11");
  assert.equal(mailsSent.length, 1);
});

test("sync_recent: deposit PI missing from DB → recovered with reservation_deposit type", async () => {
  reset();
  const piId = "pi_dep_1";
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 15000,       // $150
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   null,
    metadata: {
      payment_type: "reservation_deposit",
      booking_id:   "bk-dep-1",
    },
    latest_charge: {
      id: "ch_dep1",
      billing_details: {},
      balance_transaction: { fee: 480, net: 14520 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.recovered,   1);
  assert.equal(createCalls[0].type,   "reservation_deposit");
});

test("sync_recent: PI in DB with wrong amount → recovered (updated)", async () => {
  reset();
  const piId = "pi_wrong_amt_1";
  rrByPI[piId] = {
    id:               "rr_wa1",
    gross_amount:     49,          // wrong — Stripe says $50
    stripe_fee:       1.75,
    stripe_net:       48.25,
    stripe_charge_id: "ch_wa1",
    payment_status:   "paid",
    payment_intent_id: piId,
  };
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 5000,         // $50
    created:         Math.floor(Date.now() / 1000) - 100,
    receipt_email:   null,
    metadata:        { payment_type: "full_payment" },
    latest_charge:   {
      id: "ch_wa1",
      billing_details: {},
      balance_transaction: { fee: 175, net: 4825 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent", lookback_hours: 1 }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.recovered, 1);
  assert.equal(res._body.details.recovered[0].reason, "amount mismatch (DB: 49, Stripe: 50)");
  // The record should have been updated in rrByPI
  assert.equal(rrByPI[piId].gross_amount, 50);
  assert.equal(mailsSent.length, 1);
});

test("sync_recent: PI in DB with missing stripe_fee → recovered (fee filled in)", async () => {
  reset();
  const piId = "pi_no_fee_1";
  rrByPI[piId] = {
    id:               "rr_nf1",
    gross_amount:     100,
    stripe_fee:       null,        // missing
    stripe_net:       null,
    stripe_charge_id: "ch_nf1",
    payment_status:   "paid",
    payment_intent_id: piId,
  };
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 10000,
    created:         Math.floor(Date.now() / 1000) - 200,
    receipt_email:   null,
    metadata:        { payment_type: "full_payment" },
    latest_charge:   {
      id: "ch_nf1",
      billing_details: {},
      balance_transaction: { fee: 320, net: 9680 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.recovered, 1);
  assert.ok(res._body.details.recovered[0].reason.includes("stripe_fee was missing"));
  assert.equal(rrByPI[piId].stripe_fee, 3.2);
  assert.equal(rrByPI[piId].stripe_net, 96.8);
});

test("sync_recent: DB lookup error → error status, alert sent", async () => {
  reset();
  const piId = "pi_dberr_1";
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 5000,
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   null,
    metadata:        { payment_type: "full_payment" },
    latest_charge:   {
      id: "ch_err1",
      billing_details: {},
      balance_transaction: { fee: 175, net: 4825 },
    },
  }];
  // Inject a Supabase lookup error for this PI
  nextLookupError = { message: "connection timeout" };

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.ok,        false);
  assert.equal(res._body.errors,    1);
  assert.equal(res._body.recovered, 0);
  assert.ok(res._body.details.errors[0].reason.includes("connection timeout"));
  assert.equal(mailsSent.length, 1, "alert sent on error");
});

test("sync_recent: lookback_hours clamped — below 1 treated as 1, above 168 treated as 168", async () => {
  reset();
  // No PIs — just verify the request succeeds without throwing on invalid input
  stripeListPage = [];

  const res1 = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent", lookback_hours: 0 }), res1);
  assert.equal(res1._status,              200);
  assert.equal(res1._body.lookback_hours, 1);

  const res2 = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent", lookback_hours: 9999 }), res2);
  assert.equal(res2._status,              200);
  assert.equal(res2._body.lookback_hours, 168);
});

test("sync_recent: no alert email when all PIs are processed correctly", async () => {
  reset();
  const piId = "pi_all_good_1";
  rrByPI[piId] = {
    id:               "rr_ag1",
    gross_amount:     200,
    stripe_fee:       5.8,
    stripe_net:       194.2,
    stripe_charge_id: "ch_ag1",
    payment_status:   "paid",
    payment_intent_id: piId,
  };
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 20000,
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   null,
    metadata:        { payment_type: "full_payment" },
    latest_charge:   {
      id: "ch_ag1",
      billing_details: {},
      balance_transaction: { fee: 580, net: 19420 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status,        200);
  assert.equal(res._body.processed, 1);
  assert.equal(res._body.recovered, 0);
  assert.equal(res._body.errors,    0);
  assert.equal(mailsSent.length,    0, "no alert when nothing needs fixing");
});

test("sync_recent: empty Stripe window returns ok with zero totals", async () => {
  reset();
  stripeListPage = []; // No PIs

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status,        200);
  assert.equal(res._body.ok,       true);
  assert.equal(res._body.total,    0);
  assert.equal(res._body.processed, 0);
  assert.equal(res._body.recovered, 0);
  assert.equal(res._body.errors,    0);
  assert.equal(mailsSent.length,    0);
});

test("sync_recent: unauthorized request returns 401", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: "wrong-secret", action: "sync_recent" }), res);
  assert.equal(res._status, 401);
});

test("sync_recent: slingshot_security_deposit classified as deposit → reservation_deposit type", async () => {
  reset();
  const piId = "pi_sling_dep_1";
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 15000,       // $150
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   null,
    metadata: {
      payment_type: "slingshot_security_deposit",
      booking_id:   "bk-sling-1",
    },
    latest_charge: {
      id: "ch_sling1",
      billing_details: {},
      balance_transaction: { fee: 480, net: 14520 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.recovered, 1);
  assert.equal(res._body.details.recovered[0].classification, "deposit");
  assert.equal(createCalls[0].type, "reservation_deposit");
});

test("sync_recent: alert email contains PI id and classification in subject and body", async () => {
  reset();
  const piId = "pi_alert_content_1";
  stripeListPage = [{
    id:              piId,
    status:          "succeeded",
    amount_received: 30000,
    created:         Math.floor(Date.now() / 1000) - 60,
    receipt_email:   "customer@example.com",
    metadata: {
      payment_type: "full_payment",
      booking_id:   "bk-alert-1",
    },
    latest_charge: {
      id: "ch_alert1",
      billing_details: { email: "customer@example.com" },
      balance_transaction: { fee: 900, net: 29100 },
    },
  }];

  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync_recent" }), res);

  assert.equal(res._status, 200);
  assert.equal(mailsSent.length, 1);
  const mail = mailsSent[0];
  // Subject must mention the counts and the lookback window.
  assert.match(mail.subject, /Stripe Reconcile Alert/);
  assert.match(mail.subject, /mismatch/);
  // HTML body must contain the PI id and classification.
  assert.ok(mail.html.includes(piId),   "email HTML contains PI id");
  assert.ok(mail.html.includes("rental"), "email HTML contains classification");
  assert.ok(mail.html.includes("recovered"), "email HTML contains status label");
});
