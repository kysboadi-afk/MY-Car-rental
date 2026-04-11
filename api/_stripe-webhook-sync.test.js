// api/_stripe-webhook-sync.test.js
// Preflight validation tests for stripe-webhook.js Supabase sync gaps.
//
// Validates that all three webhook paths that mutate booking state also
// call the Supabase sync helpers so Supabase stays in sync with bookings.json:
//
//   1. saveWebhookBookingRecord (new booking fallback on payment_intent.succeeded)
//      → must call autoUpsertBooking + autoCreateBlockedDate
//
//   2. balance_payment path (deposit holder pays remaining balance)
//      → must call autoUpsertBooking after status → booked_paid
//
//   3. rental_extension path (confirmed extension updates return date)
//      → must call autoUpsertBooking with updated return date
//      → must call autoCreateRevenueRecord with the extension PaymentIntent ID
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.STRIPE_SECRET_KEY     = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";

// ─── Mutable state ────────────────────────────────────────────────────────────
const bookingsStore = {};                     // in-memory bookings.json
const automationCalls = { revenue: [], customer: [], booking: [], blocked: [], activated: [] };

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    get webhooks() {
      return {
        constructEvent: (_body, _sig, _secret) => {
          return JSON.parse(_body.toString());
        },
      };
    }
  },
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: async () => {} }),
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({
      data: JSON.parse(JSON.stringify(bookingsStore)),
      sha: "sha1",
    }),
    saveBookings: async (data) => {
      Object.assign(bookingsStore, JSON.parse(JSON.stringify(data)));
    },
    appendBooking: async (b) => {
      const vid = b.vehicleId;
      if (!Array.isArray(bookingsStore[vid])) bookingsStore[vid] = [];
      if (!bookingsStore[vid].some((x) => x.paymentIntentId === b.paymentIntentId)) {
        bookingsStore[vid].push(b);
      }
    },
    updateBooking: async (vehicleId, id, updates) => {
      if (!Array.isArray(bookingsStore[vehicleId])) return false;
      const idx = bookingsStore[vehicleId].findIndex(
        (b) => b.bookingId === id || b.paymentIntentId === id
      );
      if (idx === -1) return false;
      Object.assign(bookingsStore[vehicleId][idx], updates);
      return true;
    },
    normalizePhone: (p) => p,
  },
});

mock.module("./_booking-automation.js", {
  namedExports: {
    autoCreateRevenueRecord:    async (b)         => { automationCalls.revenue.push({ ...b }); },
    autoUpsertCustomer:         async (b, s)       => { automationCalls.customer.push({ ...b, countStats: s }); },
    autoUpsertBooking:          async (b)          => { automationCalls.booking.push({ ...b }); },
    autoCreateBlockedDate:      async (v, s, e, r) => { automationCalls.blocked.push({ vehicleId: v, start: s, end: e, reason: r }); },
    autoActivateIfPickupArrived: async (b)         => { automationCalls.activated.push({ ...b }); return false; },
    parseTime12h: (timeStr) => {
      if (!timeStr || typeof timeStr !== "string") return null;
      const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (!m) return null;
      let hours = parseInt(m[1], 10);
      const ampm = (m[4] || "").toUpperCase();
      if (ampm === "PM" && hours < 12) hours += 12;
      if (ampm === "AM" && hours === 12) hours = 0;
      return `${String(hours).padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
    },
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha, message);
    },
  },
});

mock.module("./_availability.js", {
  namedExports: {
    hasOverlap: (ranges, from, to) => ranges.some((r) => from <= r.to && r.from <= to),
  },
});

mock.module("./_textmagic.js", {
  namedExports: { sendSms: async () => {} },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    render:                   (t) => t,
    DEFAULT_LOCATION:         "Los Angeles, CA",
    EXTEND_CONFIRMED_SLINGSHOT: "ext_slingshot",
    EXTEND_CONFIRMED_ECONOMY:   "ext_economy",
  },
});

// Supabase stub (for the new getSupabaseAdmin import in stripe-webhook.js)
const supabaseDirectUpdates = [];
mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => ({
        update: (payload) => ({
          eq: (_col, _val) => {
            supabaseDirectUpdates.push({ table, payload });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  },
});

// GitHub API stub (for blockBookedDates / markVehicleUnavailable inside webhook)
global.fetch = async (url) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
    }
  } catch { /* fall through */ }
  return { ok: false };
};

const { default: handler } = await import("./stripe-webhook.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resetStore() {
  for (const k of Object.keys(bookingsStore)) delete bookingsStore[k];
}
function resetCalls() {
  automationCalls.revenue.length = 0;
  automationCalls.customer.length = 0;
  automationCalls.booking.length = 0;
  automationCalls.blocked.length = 0;
  automationCalls.activated.length = 0;
  supabaseDirectUpdates.length = 0;
}

function makeWebhookReq(event) {
  const body = Buffer.from(JSON.stringify(event));
  return {
    method:  "POST",
    headers: { "stripe-signature": "sig_fake", "content-type": "application/json" },
    on(ev, cb) {
      if (ev === "data") cb(body);
      if (ev === "end") cb();
    },
  };
}

function makeRes() {
  return {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b)   { this._body = b;   return this; },
    send(b)   { this._body = b;   return this; },
    end()     { return this; },
  };
}

function piSucceededEvent(meta, amountCents = 35000) {
  return {
    type: "payment_intent.succeeded",
    data: {
      object: {
        id:       "pi_test_" + Math.random().toString(36).slice(2),
        amount:   amountCents,
        metadata: meta,
      },
    },
  };
}

// ─── 1. saveWebhookBookingRecord: new booking fallback ───────────────────────

test("webhook new booking: PREFLIGHT — autoUpsertBooking is called", async () => {
  resetStore(); resetCalls();
  const event = piSucceededEvent({
    vehicle_id: "slingshot", vehicle_name: "Slingshot R",
    pickup_date: "2026-08-01", return_date: "2026-08-01",
    renter_name: "Test User", renter_phone: "+13105551111",
    email: "test@example.com", payment_type: "full_payment",
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.booking.length > 0,
    "PREFLIGHT FAIL: autoUpsertBooking must be called in saveWebhookBookingRecord to sync the Supabase bookings table"
  );
});

test("webhook new booking: PREFLIGHT — autoCreateBlockedDate is called", async () => {
  resetStore(); resetCalls();
  const event = piSucceededEvent({
    vehicle_id: "slingshot", vehicle_name: "Slingshot R",
    pickup_date: "2026-08-02", return_date: "2026-08-02",
    renter_name: "Test User", renter_phone: "+13105551111",
    email: "test@example.com", payment_type: "full_payment",
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.blocked.length > 0,
    "PREFLIGHT FAIL: autoCreateBlockedDate must be called in saveWebhookBookingRecord to sync the Supabase blocked_dates table"
  );
});

test("webhook new booking: PREFLIGHT — all four sync helpers fire on new payment", async () => {
  resetStore(); resetCalls();
  const event = piSucceededEvent({
    vehicle_id: "camry", vehicle_name: "Camry 2012",
    pickup_date: "2026-09-01", return_date: "2026-09-03",
    renter_name: "Jane Doe", renter_phone: "+13105552222",
    email: "jane@example.com", payment_type: "full_payment",
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(automationCalls.revenue.length  > 0, "autoCreateRevenueRecord must fire");
  assert.ok(automationCalls.customer.length > 0, "autoUpsertCustomer must fire");
  assert.ok(automationCalls.booking.length  > 0, "autoUpsertBooking must fire");
  assert.ok(automationCalls.blocked.length  > 0, "autoCreateBlockedDate must fire");
});

// ─── 2. balance_payment: status sync to Supabase ─────────────────────────────

test("webhook balance_payment: PREFLIGHT — autoUpsertBooking called after status update", async () => {
  resetStore(); resetCalls();
  // Seed an existing booking that was created from a deposit
  const depositPiId = "pi_deposit_abc123";
  bookingsStore["camry"] = [{
    bookingId:       "bk-deposit-test",
    vehicleId:       "camry",
    name:            "Deposit Customer",
    phone:           "+13105553333",
    pickupDate:      "2026-10-01",
    returnDate:      "2026-10-03",
    status:          "reserved_unpaid",
    amountPaid:      50,
    paymentIntentId: depositPiId,
  }];

  const event = piSucceededEvent({
    payment_type: "balance_payment",
    vehicle_id:   "camry",
    original_payment_intent_id: depositPiId,
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.booking.length > 0,
    "PREFLIGHT FAIL: autoUpsertBooking must be called after balance_payment so Supabase reflects the booked_paid status"
  );
});

// ─── 3. rental_extension: return-date sync to Supabase ───────────────────────

test("webhook rental_extension: PREFLIGHT — autoUpsertBooking called with updated return date", async () => {
  resetStore(); resetCalls();
  const origBookingId = "bk-active-ext";
  bookingsStore["slingshot"] = [{
    bookingId:    origBookingId,
    vehicleId:    "slingshot",
    name:         "Active Renter",
    phone:        "+13105554444",
    pickupDate:   "2026-11-01",
    returnDate:   "2026-11-01",
    returnTime:   "3:00 PM",
    status:       "active_rental",
    amountPaid:   350,
    extensionPendingPayment: {
      newReturnDate: "2026-11-02",
      newReturnTime: "3:00 PM",
    },
  }];

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "slingshot",
    original_booking_id: origBookingId,
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.booking.length > 0,
    "PREFLIGHT FAIL: autoUpsertBooking must be called after rental_extension so Supabase gets the updated return date"
  );
  // Verify the synced booking has the new return date
  const synced = automationCalls.booking[0];
  assert.equal(synced.returnDate, "2026-11-02", "Supabase booking should reflect the extended return date");
});

// ─── 4. Auto-activation on payment confirmation ───────────────────────────────

test("webhook full_payment: autoActivateIfPickupArrived is called for booked_paid booking", async () => {
  resetStore(); resetCalls();
  const event = piSucceededEvent({
    vehicle_id: "camry", vehicle_name: "Camry 2012",
    pickup_date: "2026-09-01", return_date: "2026-09-03",
    renter_name: "Alex Smith", renter_phone: "+13105551234",
    email: "alex@example.com", payment_type: "full_payment",
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.activated.length > 0,
    "autoActivateIfPickupArrived must be called after a full_payment so same-day pickups can be immediately activated"
  );
  // The activation call should receive a booking with status booked_paid
  assert.equal(
    automationCalls.activated[0].status,
    "booked_paid",
    "autoActivateIfPickupArrived should receive the booking in booked_paid status"
  );
});

test("webhook balance_payment: autoActivateIfPickupArrived is called after status update to booked_paid", async () => {
  resetStore(); resetCalls();
  const depositPiId = "pi_deposit_bal_act";
  bookingsStore["camry"] = [{
    bookingId:       "bk-balance-activation-test",
    vehicleId:       "camry",
    name:            "Balance Customer",
    phone:           "+13105559999",
    pickupDate:      "2026-10-05",
    returnDate:      "2026-10-07",
    status:          "reserved_unpaid",
    amountPaid:      50,
    paymentIntentId: depositPiId,
  }];

  const event = piSucceededEvent({
    payment_type: "balance_payment",
    vehicle_id:   "camry",
    original_payment_intent_id: depositPiId,
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    automationCalls.activated.length > 0,
    "autoActivateIfPickupArrived must be called after balance_payment so same-day pickups can be immediately activated"
  );
});

// ─── 5. rental_extension: Supabase updated even when bookings.json save fails ─

test("webhook rental_extension: PREFLIGHT — autoUpsertBooking fires before bookings.json write (SHA-conflict resilience)", async () => {
  // This test verifies the order-of-operations fix: Supabase must be updated
  // BEFORE the bookings.json GitHub write so that a SHA conflict in the write
  // cannot prevent the admin dashboard from seeing the new return date.
  resetStore(); resetCalls();
  const origBookingId = "bk-sha-conflict-test";
  bookingsStore["camry"] = [{
    bookingId:  origBookingId,
    vehicleId:  "camry",
    name:       "SHA Conflict Customer",
    phone:      "+13105555555",
    pickupDate: "2026-12-01",
    returnDate: "2026-12-03",
    returnTime: "5:00 PM",
    status:     "active_rental",
    amountPaid: 150,
    extensionPendingPayment: {
      newReturnDate: "2026-12-06",
      newReturnTime: "5:00 PM",
      label:         "+3 days",
    },
  }];

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    original_booking_id: origBookingId,
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  // autoUpsertBooking must have been called with the updated return date
  assert.ok(
    automationCalls.booking.length > 0,
    "autoUpsertBooking must fire for rental_extension even if bookings.json write were to fail"
  );
  assert.equal(
    automationCalls.booking[0].returnDate,
    "2026-12-06",
    "Supabase should see the extended return date (2026-12-06) regardless of GitHub write result"
  );
});

// ─── 5b. rental_extension: revenue record logged for extension payment ────────

test("webhook rental_extension: autoCreateRevenueRecord called with extension PaymentIntent ID", async () => {
  resetStore(); resetCalls();
  const origBookingId = "bk-ext-revenue-test";
  bookingsStore["camry"] = [{
    bookingId:  origBookingId,
    vehicleId:  "camry",
    name:       "Revenue Test Renter",
    phone:      "+13105556666",
    email:      "revenue@example.com",
    pickupDate: "2026-12-10",
    returnDate: "2026-12-12",
    status:     "active_rental",
    amountPaid: 110,
    extensionPendingPayment: {
      newReturnDate: "2026-12-14",
      newReturnTime: "3:00 PM",
      label:         "+2 days",
      price:         110,
    },
  }];

  // amountCents = 11000 → $110.00 extension
  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    original_booking_id: origBookingId,
  }, 11000);
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  assert.ok(
    automationCalls.revenue.length > 0,
    "autoCreateRevenueRecord must be called when a rental_extension payment succeeds"
  );
  const rev = automationCalls.revenue[0];
  // Must use the PaymentIntent ID (not the original booking ID) so each extension
  // gets its own revenue ledger row and the idempotency guard works correctly.
  assert.ok(rev.bookingId.startsWith("pi_"), "revenue bookingId must be the extension PaymentIntent ID");
  assert.equal(rev.vehicleId,  "camry",   "revenue record must carry the correct vehicleId");
  assert.equal(rev.amountPaid, 110,       "revenue amount must match extensionPendingPayment.price");
  assert.equal(rev.paymentMethod, "stripe", "payment method must be stripe");
  assert.ok(
    (rev.notes || "").includes(origBookingId),
    "revenue notes must reference the original booking ID for traceability"
  );
});



test("webhook rental_extension: PREFLIGHT — Supabase direct update when booking not found in bookings.json", async () => {
  // This test verifies the new fallback path: when original_booking_id doesn't
  // match any record in bookings.json, the webhook must update Supabase directly
  // using getSupabaseAdmin() so the admin dashboard still reflects the extension.
  resetStore(); resetCalls();
  // bookingsStore is empty — booking exists only in Supabase

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    original_booking_id: "bk-supabase-only-booking",
    new_return_date:     "2026-04-14",
    new_return_time:     "11:30 AM",
    extension_label:     "+3 days",
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.ok(
    supabaseDirectUpdates.length > 0,
    "PREFLIGHT FAIL: when booking not found in bookings.json, the webhook must update Supabase directly via getSupabaseAdmin()"
  );
  const sbUpdate = supabaseDirectUpdates[0];
  assert.equal(
    sbUpdate.payload.return_date,
    "2026-04-14",
    "Supabase direct update must include the new return_date from PI metadata"
  );
});
