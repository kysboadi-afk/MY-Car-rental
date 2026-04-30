// api/_extend-rental.test.js
// Tests for POST /api/extend-rental — focused on the conflict-check logic that
// must SKIP the active booking itself so a renter can extend their own rental
// even when the existing return date technically overlaps the new extension
// window (due to the 2-hour preparation buffer in hasDateTimeOverlap).
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.STRIPE_SECRET_KEY    = "sk_test_fake";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  return {
    _status:  200,
    _body:    null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    send(body)   { this._body = body; return this; },
    end()        { return this; },
  };
}

function makeReq(body, origin = "https://www.slytrans.com") {
  return { method: "POST", headers: { origin }, body };
}

// ─── Shared mock state ────────────────────────────────────────────────────────

let mockBookings = {};
let sbClient     = null;   // null = no Supabase

// Camry vehicle data used across tests
const CAMRY_VEHICLE = {
  name:        "Camry 2012",
  pricePerDay: 55,
  weekly:      300,
  biweekly:    null,
  monthly:     null,
};

mock.module("./_vehicles.js", {
  namedExports: {
    getVehicleById: async (id) =>
      id === "camry" ? { ...CAMRY_VEHICLE } : null,
  },
});

mock.module("./_settings.js", {
  namedExports: {
    loadPricingSettings: async () => ({
      camry_daily_rate:    55,
      camry_weekly_rate:   300,
      camry_biweekly_rate: null,
      camry_monthly_rate:  null,
      tax_rate:            0.095,
    }),
    applyTax: (amount, settings) =>
      Math.round(amount * (1 + (settings.tax_rate || 0)) * 100) / 100,
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:  async () => ({ data: mockBookings, sha: "sha1" }),
    updateBooking: async () => {},
    normalizePhone: (p) => p ? p.replace(/\D/g, "") : "",
  },
});

// Real hasDateTimeOverlap is imported so the overlap arithmetic is exercised —
// the fix must suppress the self-overlap the buffer would otherwise produce.
mock.module("./_availability.js", {
  namedExports: {
    // Keep real implementations so the buffer-driven self-conflict is tested.
    hasDateTimeOverlap: (await import("./_availability.js")).hasDateTimeOverlap,
    parseDateTimeMs:    (await import("./_availability.js")).parseDateTimeMs,
  },
});

mock.module("./_supabase.js", {
  namedExports: { getSupabaseAdmin: () => sbClient },
});

// _pricing.js mock — returns a fake vehicle_pricing row so the handler never
// hits the real Supabase vehicle_pricing table during tests.
mock.module("./_pricing.js", {
  namedExports: {
    getVehiclePricing: async (_sb, _id) => ({
      vehicle_id:     "camry",
      daily_price:    55,
      weekly_price:   350,
      biweekly_price: 650,
      monthly_price:  1300,
    }),
    computeAmountFromPricing: (await import("./_pricing.js")).computeAmountFromPricing,
  },
});

// Stripe mock — returns a minimal fake PaymentIntent so the handler can reach 200.
// capturedStripeParams stores the last params passed to paymentIntents.create so
// metadata-content tests can assert on what was sent to Stripe.
let capturedStripeParams = null;
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      create: async (params) => {
        capturedStripeParams = params;
        return {
          id:            "pi_fake_123",
          client_secret: "pi_fake_123_secret_abc",
          amount:        params.amount,
        };
      },
    };
  },
});

const { default: handler } = await import("./extend-rental.js");

// ─── Base booking fixture ────────────────────────────────────────────────────

function makeActiveBooking(overrides = {}) {
  return {
    bookingId:    "bk-camry-active-001",
    name:         "Alice Tester",
    email:        "alice@example.com",
    phone:        "2135550100",
    vehicleId:    "camry",
    vehicleName:  "Camry 2012",
    pickupDate:   "2026-04-15",
    pickupTime:   "10:00 AM",
    returnDate:   "2026-04-30",
    returnTime:   "5:00 PM",
    status:       "active_rental",
    paymentIntentId: "pi_original_xxx",
    smsSentAt:    {},
    ...overrides,
  };
}

// ─── Supabase client builder ─────────────────────────────────────────────────
// Builds a chainable Supabase-style query stub.  `rows` is returned for ALL
// queries; tests that need different rows per query use `queryMap` instead.

function makeSupabaseClient({ rows = [], error = null, queryMap = null } = {}) {
  // queryMap: array of { match: fn(tableName, filters), rows, error } checked
  // in order.  First match wins; falls back to the default `rows`/`error`.
  const resolveQuery = (tableName, filters) => {
    if (queryMap) {
      for (const entry of queryMap) {
        if (entry.match(tableName, filters)) {
          return { data: entry.rows || [], error: entry.error || null };
        }
      }
    }
    return { data: rows, error };
  };

  return {
    _tableName: null,
    _filters: {},
    from(table) {
      const ctx = { tableName: table, filters: {} };
      const chain = {
        select()     { return this; },
        eq(k, v)     { ctx.filters[k] = v; return this; },
        neq(k, v)    { ctx.filters[`neq_${k}`] = v; return this; },
        in(k, v)     { ctx.filters[`in_${k}`] = v; return this; },
        not(k, op, v){ ctx.filters[`not_${k}`] = v; return this; },
        lte()        { return this; },
        gte()        { return this; },
        limit()      { return this; },
        order()      { return this; },
        update()     { return this; },
        upsert()     { return this; },
        async maybeSingle() {
          const result = resolveQuery(ctx.tableName, ctx.filters);
          const d = Array.isArray(result.data) ? result.data : [];
          return { data: d.length === 1 ? d[0] : null, error: result.error };
        },
        async then(resolve) {
          return resolve(resolveQuery(ctx.tableName, ctx.filters));
        },
      };
      return chain;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("extend-rental: 200 when active booking is the ONLY booking (self-conflict guard, no Supabase)", async () => {
  // Regression test: the active booking's return date (Apr 30) sits exactly
  // at the extension window start. hasDateTimeOverlap detects an overlap via
  // the 2-hour buffer (rEnd = Apr 30 7 PM > newStart = Apr 30 5 PM).
  // The bookingId equality guard must suppress this.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.notEqual(res._status, 409, "should NOT return 409 when only booking is the active one");
  assert.equal(res._status, 200, "should return 200 — extension payment intent created");
  assert.ok(res._body?.clientSecret, "response must include clientSecret");
});

test("extend-rental: 200 when active booking has 'active_rental' status in Supabase (enrichment fix)", async () => {
  // The enrichment block previously only matched status 'active' | 'overdue'.
  // With 'active_rental' status in Supabase, sbActiveBookingRef was never set.
  // Now that 'active_rental' is included, the conflict query correctly uses
  // .neq("booking_ref", sbActiveBookingRef) to exclude the current booking.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  // Supabase returns the active booking with status='active_rental' when
  // queried by booking_ref, and returns no future conflicts.
  sbClient = makeSupabaseClient({
    queryMap: [
      // Enrichment: fetch by booking_ref → returns the active booking
      {
        match: (t) => t === "bookings",
        rows: [{
          booking_ref: "bk-camry-active-001",
          return_date: "2026-04-30",
          return_time: "17:00:00",
          status:      "active_rental",
        }],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.notEqual(res._status, 409, "active_rental Supabase booking must not block itself");
  assert.equal(res._status, 200);
});

test("extend-rental: 409 when there is a genuine future booking conflict (bookings.json)", async () => {
  // A separate future booking starts on May 3, which falls within the
  // Apr 30 → May 7 extension window.  The handler must return 409.
  const active  = makeActiveBooking();
  const future  = {
    bookingId:   "bk-camry-next-001",
    name:        "Bob Renter",
    email:       "bob@example.com",
    phone:       "2135550200",
    vehicleId:   "camry",
    vehicleName: "Camry 2012",
    pickupDate:  "2026-05-03",
    pickupTime:  "10:00 AM",
    returnDate:  "2026-05-07",
    returnTime:  "5:00 PM",
    status:      "booked_paid",
    paymentIntentId: "pi_bob_yyy",
    smsSentAt:   {},
  };
  mockBookings = { camry: [active, future] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-07",
  }), res);

  assert.equal(res._status, 409, "should return 409 when extension overlaps a future booking");
});

test("extend-rental: 409 when future booking has 'booked_paid' status in Supabase", async () => {
  // Previously the Supabase conflict query only checked
  // ["pending","active","overdue","reserved"] — missing "booked_paid".
  // A paid reservation starting May 3 would NOT have been caught.
  // After the fix (not.in cancelled,completed_rental) it IS caught.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    queryMap: [
      // All bookings queries return: active booking for enrichment, future booking for conflict
      {
        match: (t) => t === "bookings",
        rows: [
          // Active booking (used for enrichment and conflict check)
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-30",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-15",
            pickup_time:    "10:00:00",
          },
          // Future booking with "booked_paid" status — should trigger 409
          {
            booking_ref: "bk-camry-future-001",
            pickup_date: "2026-05-03",
            return_date: "2026-05-07",
            pickup_time: "10:00:00",
            return_time: "17:00:00",
            status:      "booked_paid",
          },
        ],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 409, "booked_paid future booking must block the extension");
});

test("extend-rental: 200 for same-day rental (effectiveReturnDate guard prevents self-conflict)", async () => {
  // Same-day rental: pickup and return both today (Apr 25).
  // conflictFloorDate = Apr 25 = pickup_date, so the active booking itself
  // could appear in the Supabase query results when sbActiveBookingRef is null.
  // The fbkReturnDate <= effectiveReturnDate guard must catch this and skip it.
  const active = makeActiveBooking({
    pickupDate:  "2026-04-25",
    returnDate:  "2026-04-25",
  });
  mockBookings = { camry: [active] };

  // Supabase returns the active booking with the same return date as pickup.
  // sbActiveBookingRef will be null (simulate enrichment mismatch by using
  // a legacy PI ID as the bookingId so neither ref check fires).
  const activeWithPiId = { ...active, bookingId: "pi_legacy_pi_id" };
  mockBookings = { camry: [activeWithPiId] };

  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [
          // Active booking (same-day, simulating a Supabase ref mismatch)
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-25",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-25",
            pickup_time:    "10:00:00",
          },
        ],
      },
      { match: (t) => t === "revenue_records", rows: [] },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-04-28",
  }), res);

  assert.notEqual(res._status, 409, "same-day rental must not self-conflict");
  assert.equal(res._status, 200);
});

test("extend-rental: 409 when paid extension revenue_record extends a future booking past newReturnDate", async () => {
  // Future booking (status=pending) has return_date=May 3 in bookings table,
  // but has a paid extension revenue_record pushing its effective end to May 8.
  // The renter wants to extend to May 5 which would overlap May 1→May 8.
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [
          // Enrichment: active booking
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-30",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-15",
            pickup_time:    "10:00:00",
          },
          // Future booking: bookings table shows return May 3 but has paid extension to May 8
          {
            booking_ref: "bk-camry-future-002",
            pickup_date: "2026-05-01",
            return_date: "2026-05-03",
            pickup_time: "10:00:00",
            return_time: "17:00:00",
            status:      "pending",
          },
        ],
      },
      // revenue_records: paid extension for the future booking → finalReturnDate May 8
      {
        match: (t) => t === "revenue_records",
        rows: [
          {
            original_booking_id: "bk-camry-future-002",
            return_date:         "2026-05-08",
          },
        ],
      },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",   // overlaps future booking [May 1 → May 8]
  }), res);

  assert.equal(res._status, 409, "paid extension record extending future booking must block extension");
});

test("extend-rental: 200 when future booking has UNPAID extension revenue_record (must not block)", async () => {
  // Future booking has a revenue_record of type=extension but payment_status=pending.
  // Unpaid extensions must NOT extend the blocking window.
  // The future booking's nominal end (May 3) does not overlap [Apr 30→May 2].
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };

  sbClient = makeSupabaseClient({
    queryMap: [
      {
        match: (t) => t === "bookings",
        rows: [
          {
            booking_ref:    "bk-camry-active-001",
            return_date:    "2026-04-30",
            return_time:    "17:00:00",
            status:         "active_rental",
            customer_email: "alice@example.com",
            customer_phone: "2135550100",
            customer_name:  "Alice Tester",
            pickup_date:    "2026-04-15",
            pickup_time:    "10:00:00",
          },
          {
            booking_ref: "bk-camry-future-003",
            pickup_date: "2026-05-04",
            return_date: "2026-05-07",
            pickup_time: "10:00:00",
            return_time: "17:00:00",
            status:      "reserved",
          },
        ],
      },
      // revenue_records returns empty because the mock only responds to
      // is_cancelled=false + payment_status=paid — unpaid records are excluded.
      { match: (t) => t === "revenue_records", rows: [] },
    ],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-02",   // Apr 30 → May 2, does not overlap May 4 pickup
  }), res);

  assert.notEqual(res._status, 409, "unpaid extension record must not expand the blocking window");
  assert.equal(res._status, 200);
});

test("extend-rental: 400 when new return date is not after current return date", async () => {
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-04-28",   // before current return date
  }), res);

  assert.equal(res._status, 400);
});

test("extend-rental: 404 when no active booking matches the provided email", async () => {
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "nobody@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 404);
});

// ── Metadata ──────────────────────────────────────────────────────────────────

test("extend-rental: PaymentIntent is created with type=rental_extension metadata", async () => {
  // Regression guard: ensures the Stripe PI always carries the 'type' and
  // 'payment_type' metadata fields so the webhook can identify extension payments.
  capturedStripeParams = null;
  const active = makeActiveBooking();
  mockBookings = { camry: [active] };
  sbClient     = null;

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200, "handler must return 200");
  assert.ok(capturedStripeParams, "stripe.paymentIntents.create must have been called");

  const meta = capturedStripeParams.metadata;
  assert.ok(meta,                          "metadata must be present on the PaymentIntent");
  assert.equal(meta.type,         "rental_extension", "metadata.type must equal 'rental_extension'");
  assert.equal(meta.payment_type, "rental_extension", "metadata.payment_type must equal 'rental_extension'");
  assert.ok(meta.booking_id,               "metadata.booking_id must be set");
  assert.ok(meta.vehicle_id,               "metadata.vehicle_id must be set");
  assert.ok(meta.new_return_date,          "metadata.new_return_date must be set");
});

test("extend-rental: metadata.booking_id prefers sbActiveBookingRef over bookingId", async () => {
  // When the Supabase lookup resolves a canonical booking_ref, it should be used
  // as metadata.booking_id so the webhook can find the booking via booking_ref.
  capturedStripeParams = null;
  const active = makeActiveBooking({ bookingId: "pi_legacy_original_xxx" });
  mockBookings = { camry: [active] };

  // Return a Supabase row whose booking_ref is the canonical bk-... identifier.
  sbClient = makeSupabaseClient({
    rows: [{
      booking_ref: "bk-camry-canonical-001",
      return_date: "2026-04-30",
      return_time: "17:00:00",
      status:      "active_rental",
    }],
  });

  const res = makeRes();
  await handler(makeReq({
    vehicleId:     "camry",
    email:         "alice@example.com",
    newReturnDate: "2026-05-05",
  }), res);

  assert.equal(res._status, 200);
  const meta = capturedStripeParams?.metadata;
  assert.ok(meta, "metadata must be present");
  assert.equal(meta.booking_id, "bk-camry-canonical-001",
    "booking_id must be the canonical Supabase booking_ref, not the legacy PI id");
});
