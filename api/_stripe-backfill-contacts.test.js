// api/_stripe-backfill-contacts.test.js
// Tests for the backfill_contacts action added to stripe-backfill.js.
//
// Validates that backfill_contacts:
//   1. Queries bookings with null customer_phone or customer_email
//   2. Fetches contact info from Stripe PaymentIntent metadata / customer_details
//   3. Only patches the null fields (does not overwrite existing data)
//   4. Handles dry_run correctly
//   5. Reports no_data when Stripe has no contact info either
//   6. Reports errors when Stripe retrieval fails
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET      = "test-admin-secret-contacts";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_contacts";

// ─── Mutable state ────────────────────────────────────────────────────────────
// Bookings returned by the Supabase contacts query
let supabaseBookingRows = [];
// Updates captured from Supabase .update() calls
const supabaseUpdates = [];
// PI data returned by stripe.paymentIntents.retrieve
const stripePiStore = {};
// Whether retrieve should throw for a given PI id
const stripeRetrieveErrors = {};

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      list: async () => ({ data: [], has_more: false }),
      retrieve: async (id) => {
        if (stripeRetrieveErrors[id]) throw new Error(stripeRetrieveErrors[id]);
        if (stripePiStore[id]) return { ...stripePiStore[id] };
        throw new Error(`No such payment_intent: ${id}`);
      },
    };
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => {
        const builder = {
          _filters:       {},
          _notFilters:    {},
          _orFilter:      null,
          _updatePayload: null,

          select()             { return builder; },
          not(col, op, val)    { builder._notFilters[col] = { op, val }; return builder; },
          or(filterStr)        { builder._orFilter = filterStr; return builder; },
          eq(col, val)         { builder._filters[col] = val; return builder; },
          update(payload)      { builder._updatePayload = { ...payload }; return builder; },

          then(resolve) {
            if (table === "bookings") {
              // backfill_contacts SELECT query
              if (builder._orFilter && !builder._updatePayload) {
                return Promise.resolve({ data: supabaseBookingRows, error: null }).then(resolve);
              }
              // backfill_contacts UPDATE query
              if (builder._updatePayload) {
                const id = builder._filters["id"];
                supabaseUpdates.push({ id, patch: { ...builder._updatePayload } });
                return Promise.resolve({ data: null, error: null }).then(resolve);
              }
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
    persistBooking: async (opts) => ({
      ok: true, bookingId: opts.bookingId || "mocked-bk", booking: opts, supabaseOk: true, errors: [],
    }),
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
    EXTEND_CONFIRMED_ECONOMY:   "",
  },
});

const { default: handler } = await import("./stripe-backfill.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
  supabaseBookingRows.length = 0;
  supabaseUpdates.length     = 0;
  for (const k of Object.keys(stripePiStore))      delete stripePiStore[k];
  for (const k of Object.keys(stripeRetrieveErrors)) delete stripeRetrieveErrors[k];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("backfill_contacts: updates customer_phone from PI metadata when null", async () => {
  reset();
  supabaseBookingRows = [{
    id:                 "sb-row-1",
    booking_ref:        "bk-3bcf479ac6ec",
    payment_intent_id:  "pi_test_contact_1",
    customer_phone:     null,
    customer_email:     "existing@example.com",
  }];
  stripePiStore["pi_test_contact_1"] = {
    id:             "pi_test_contact_1",
    metadata:       { renter_phone: "+13105551234", email: "" },
    customer_details: null,
    receipt_email:  null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._status, 200);
  const body = res._body;
  assert.equal(body.candidates, 1);
  assert.equal(body.updated, 1);
  assert.equal(body.no_data, 0);
  assert.equal(body.errors, 0);

  assert.equal(supabaseUpdates.length, 1);
  assert.equal(supabaseUpdates[0].id, "sb-row-1");
  assert.equal(supabaseUpdates[0].patch.customer_phone, "+13105551234");
  assert.ok(!("customer_email" in supabaseUpdates[0].patch), "must not overwrite existing email");
});

test("backfill_contacts: updates customer_email from PI metadata when null", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-2",
    booking_ref:       "bk-noemail",
    payment_intent_id: "pi_test_contact_2",
    customer_phone:    "+13105559999",
    customer_email:    null,
  }];
  stripePiStore["pi_test_contact_2"] = {
    id:               "pi_test_contact_2",
    metadata:         { renter_phone: "", email: "renter@example.com" },
    customer_details: null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates.length, 1);
  assert.equal(supabaseUpdates[0].patch.customer_email, "renter@example.com");
  assert.ok(!("customer_phone" in supabaseUpdates[0].patch), "must not overwrite existing phone");
});

test("backfill_contacts: falls back to customer_details.phone when metadata renter_phone is absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-3",
    booking_ref:       "bk-cdphone",
    payment_intent_id: "pi_test_contact_3",
    customer_phone:    null,
    customer_email:    "cd@example.com",
  }];
  stripePiStore["pi_test_contact_3"] = {
    id:               "pi_test_contact_3",
    metadata:         { renter_phone: "", email: "" },
    customer_details: { phone: "+13105550001", email: null },
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_phone, "+13105550001");
});

test("backfill_contacts: falls back to customer_details.email when metadata email is absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-4",
    booking_ref:       "bk-cdemail",
    payment_intent_id: "pi_test_contact_4",
    customer_phone:    "+13109999999",
    customer_email:    null,
  }];
  stripePiStore["pi_test_contact_4"] = {
    id:               "pi_test_contact_4",
    metadata:         { renter_phone: "", email: "" },
    customer_details: { phone: null, email: "cd-email@example.com" },
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_email, "cd-email@example.com");
});

test("backfill_contacts: falls back to receipt_email when all other email sources absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-5",
    booking_ref:       "bk-receiptemail",
    payment_intent_id: "pi_test_contact_5",
    customer_phone:    "+13101111111",
    customer_email:    null,
  }];
  stripePiStore["pi_test_contact_5"] = {
    id:               "pi_test_contact_5",
    metadata:         { renter_phone: "", email: "" },
    customer_details: null,
    receipt_email:    "receipt@example.com",
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_email, "receipt@example.com");
});

test("backfill_contacts: reports no_data when Stripe has no contact info at all", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-6",
    booking_ref:       "bk-nocontact",
    payment_intent_id: "pi_test_contact_6",
    customer_phone:    null,
    customer_email:    null,
  }];
  stripePiStore["pi_test_contact_6"] = {
    id:               "pi_test_contact_6",
    metadata:         { renter_phone: "", email: "" },
    customer_details: null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.candidates, 1);
  assert.equal(res._body.updated,  0);
  assert.equal(res._body.no_data,  1);
  assert.equal(res._body.errors,   0);
  assert.equal(res._body.details[0].status, "no_data");
  assert.equal(supabaseUpdates.length, 0);
});

test("backfill_contacts: reports error when Stripe retrieve fails", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-7",
    booking_ref:       "bk-stripefail",
    payment_intent_id: "pi_test_contact_7",
    customer_phone:    null,
    customer_email:    null,
  }];
  stripeRetrieveErrors["pi_test_contact_7"] = "No such payment_intent";

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.candidates, 1);
  assert.equal(res._body.errors,     1);
  assert.equal(res._body.updated,    0);
  assert.equal(res._body.details[0].status, "error");
  assert.equal(supabaseUpdates.length, 0);
});

test("backfill_contacts: dry_run returns would_update without writing to Supabase", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-8",
    booking_ref:       "bk-dryrun",
    payment_intent_id: "pi_test_contact_8",
    customer_phone:    null,
    customer_email:    null,
  }];
  stripePiStore["pi_test_contact_8"] = {
    id:               "pi_test_contact_8",
    metadata:         { renter_phone: "+13105555555", email: "dry@example.com" },
    customer_details: null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true, dry_run: true }), res);

  assert.equal(res._body.dry_run,   true);
  assert.equal(res._body.updated,   1, "dry_run counts candidate as updated");
  assert.equal(res._body.details[0].status, "would_update");
  assert.ok(res._body.details[0].patch, "should include patch preview");
  assert.equal(supabaseUpdates.length, 0, "must not write to Supabase in dry_run mode");
});

test("backfill_contacts: returns empty result when no bookings have missing contact", async () => {
  reset();
  supabaseBookingRows = [];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._status,         200);
  assert.equal(res._body.candidates, 0);
  assert.equal(res._body.updated,    0);
  assert.equal(res._body.no_data,    0);
  assert.equal(res._body.errors,     0);
});

test("backfill_contacts: updates both phone and email when both are null", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-9",
    booking_ref:       "bk-bothNull",
    payment_intent_id: "pi_test_contact_9",
    customer_phone:    null,
    customer_email:    null,
  }];
  stripePiStore["pi_test_contact_9"] = {
    id:               "pi_test_contact_9",
    metadata:         { renter_phone: "+13105550099", email: "both@example.com" },
    customer_details: null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates.length, 1);
  assert.equal(supabaseUpdates[0].patch.customer_phone, "+13105550099");
  assert.equal(supabaseUpdates[0].patch.customer_email, "both@example.com");
});

// ─── Expanded Stripe Customer object fallback ─────────────────────────────────

test("backfill_contacts: uses expanded customer.phone when customer_details and metadata are absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-10",
    booking_ref:       "bk-expandcust",
    payment_intent_id: "pi_expand_cust_1",
    customer_phone:    null,
    customer_email:    "existing@example.com",
  }];
  // customer is the expanded object (as returned by expand: ["customer"])
  stripePiStore["pi_expand_cust_1"] = {
    id:               "pi_expand_cust_1",
    metadata:         { renter_phone: "", email: "" },
    customer_details: null,
    customer:         { id: "cus_123", phone: "+13105550002", email: "cust@example.com" },
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_phone, "+13105550002",
    "should use expanded customer.phone when customer_details is absent");
  assert.ok(!("customer_email" in supabaseUpdates[0].patch), "must not overwrite existing email");
});

test("backfill_contacts: uses expanded customer.email when other email sources are absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-11",
    booking_ref:       "bk-expandcust-email",
    payment_intent_id: "pi_expand_cust_2",
    customer_phone:    "+13105551234",
    customer_email:    null,
  }];
  stripePiStore["pi_expand_cust_2"] = {
    id:               "pi_expand_cust_2",
    metadata:         { renter_phone: "", email: "" },
    customer_details: null,
    customer:         { id: "cus_456", phone: null, email: "custobj@example.com" },
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_email, "custobj@example.com",
    "should use expanded customer.email when other email sources are absent");
});

// ─── meta.customer_phone / meta.customer_email fallbacks ─────────────────────

test("backfill_contacts: uses meta.customer_phone when renter_phone and customer_details are absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-12",
    booking_ref:       "bk-metacustphone",
    payment_intent_id: "pi_meta_cust_phone",
    customer_phone:    null,
    customer_email:    "x@example.com",
  }];
  stripePiStore["pi_meta_cust_phone"] = {
    id:               "pi_meta_cust_phone",
    metadata:         { renter_phone: "", customer_phone: "+13105550077" },
    customer_details: null,
    customer:         null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_phone, "+13105550077",
    "should use meta.customer_phone as a fallback metadata key");
});

test("backfill_contacts: uses meta.customer_email when email and customer_details are absent", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-13",
    booking_ref:       "bk-metacustemail",
    payment_intent_id: "pi_meta_cust_email",
    customer_phone:    "+13105559988",
    customer_email:    null,
  }];
  stripePiStore["pi_meta_cust_email"] = {
    id:               "pi_meta_cust_email",
    metadata:         { email: "", customer_email: "metacust@example.com" },
    customer_details: null,
    customer:         null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.equal(supabaseUpdates[0].patch.customer_email, "metacust@example.com",
    "should use meta.customer_email as a fallback metadata key");
});

// ─── still_missing audit field ────────────────────────────────────────────────

test("backfill_contacts: still_missing lists bookings that had no contact data in Stripe", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-14",
    booking_ref:       "bk-stillmissing",
    payment_intent_id: "pi_still_missing",
    customer_phone:    null,
    customer_email:    null,
  }];
  stripePiStore["pi_still_missing"] = {
    id:               "pi_still_missing",
    metadata:         { renter_phone: "", email: "", customer_phone: "", customer_email: "" },
    customer_details: null,
    customer:         null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.no_data, 1);
  assert.ok(Array.isArray(res._body.still_missing), "should include still_missing array");
  assert.equal(res._body.still_missing.length, 1);
  assert.equal(res._body.still_missing[0].booking_ref, "bk-stillmissing");
});

test("backfill_contacts: still_missing is empty when all bookings were repaired", async () => {
  reset();
  supabaseBookingRows = [{
    id:                "sb-row-15",
    booking_ref:       "bk-repaired",
    payment_intent_id: "pi_repaired",
    customer_phone:    null,
    customer_email:    null,
  }];
  stripePiStore["pi_repaired"] = {
    id:               "pi_repaired",
    metadata:         { renter_phone: "+13105550033", email: "repaired@example.com" },
    customer_details: null,
    customer:         null,
    receipt_email:    null,
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret-contacts", backfill_contacts: true }), res);

  assert.equal(res._body.updated, 1);
  assert.ok(Array.isArray(res._body.still_missing), "still_missing should always be present");
  assert.equal(res._body.still_missing.length, 0, "still_missing should be empty when all rows were repaired");
});

