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
  isSlingshot: false,
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
      slingshot_daily_rate: 350,
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

// Stripe mock — returns a minimal fake PaymentIntent so the handler can reach 200.
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      create: async (params) => ({
        id:            "pi_fake_123",
        client_secret: "pi_fake_123_secret_abc",
        amount:        params.amount,
      }),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

test("extend-rental: 200 when active booking is the ONLY booking (self-conflict guard)", async () => {
  // This is the regression test for the false-conflict bug: the active booking's
  // return date (Apr 30) sits exactly at the extension window start (Apr 30),
  // which means hasDateTimeOverlap detects an overlap via the 2-hour buffer
  // (rEnd = Apr 30 7 PM > newStart = Apr 30 5 PM).  The fix adds a bookingId
  // equality guard so the active booking is never treated as a conflicting booking.
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

test("extend-rental: 409 when there is a genuine future booking conflict", async () => {
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
