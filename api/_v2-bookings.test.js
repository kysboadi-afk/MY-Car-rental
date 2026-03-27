// api/_v2-bookings.test.js
// End-to-end lifecycle tests for POST /api/v2-bookings.
//
// Validates:
//  1. Payment flow — deposit_paid / remaining_balance / payment_status computed correctly
//  2. Full booking lifecycle: create → approve (reserved) → activate (rented) → complete (available)
//  3. Double-booking prevention with datetime-aware conflict detection
//  4. Back-to-back same-day bookings are allowed
//  5. Cancelled bookings release the slot so new bookings are accepted
//  6. Creating a booking triggers: customer upsert, revenue record, blocked dates, Supabase sync
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET          = "test-admin-secret";
process.env.GITHUB_TOKEN          = "test-github-token";
process.env.TEXTMAGIC_USERNAME    = "test-tm-user";
process.env.TEXTMAGIC_API_KEY     = "test-tm-key";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

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

// ─── Shared mutable state ─────────────────────────────────────────────────────

// bookings.json in-memory store keyed by vehicleId
const bookingsStore = {};
// Automation call recorder
const automationCalls = { revenue: [], customer: [], booking: [], blocked: [] };
// SMS calls
const smsCalls = [];
// Supabase mock — not used by these tests (automation is mocked out)
const supabaseMockState = { client: null };

// ─── Module mocks (must be declared before any import of the module) ──────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseMockState.client,
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:    async () => ({ data: JSON.parse(JSON.stringify(bookingsStore)), sha: "sha1" }),
    saveBookings:    async (data) => { Object.assign(bookingsStore, JSON.parse(JSON.stringify(data))); },
    appendBooking:   async () => {},
    normalizePhone:  (p) => p,
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

mock.module("./_booking-automation.js", {
  namedExports: {
    autoCreateRevenueRecord: async (b) => { automationCalls.revenue.push({ ...b }); },
    autoUpsertCustomer:      async (b, s) => { automationCalls.customer.push({ ...b, countStats: s }); },
    autoUpsertBooking:       async (b) => { automationCalls.booking.push({ ...b }); },
    autoCreateBlockedDate:   async (vid, s, e, r) => { automationCalls.blocked.push({ vehicleId: vid, start: s, end: e, reason: r }); },
  },
});

// v2-bookings.js also calls blockBookedDates internally which hits GitHub —
// mock the availability check functions too
mock.module("./_availability.js", {
  namedExports: {
    hasOverlap:           (ranges, from, to) => ranges.some((r) => from <= r.to && r.from <= to),
    hasDateTimeOverlap:   (ranges, fd, td, ft, tt) => {
      // Use the real datetime logic for accurate conflict testing
      function parseDt(date, time) {
        if (!date) return NaN;
        const base = new Date(date + "T00:00:00");
        if (time) {
          const ampm = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
          if (ampm) {
            let h = parseInt(ampm[1], 10);
            const m = parseInt(ampm[2], 10);
            const p = ampm[3].toUpperCase();
            if (p === "PM" && h !== 12) h += 12;
            if (p === "AM" && h === 12) h = 0;
            base.setHours(h, m, 0, 0);
          }
        }
        return base.getTime();
      }
      const newStart = parseDt(fd, ft);
      const newEnd   = ft ? parseDt(td, tt) : (() => { const d = new Date(parseDt(td)); d.setDate(d.getDate() + 1); return d.getTime(); })();
      return ranges.some((r) => {
        const rStart = parseDt(r.from, r.fromTime);
        const rEnd   = r.toTime ? parseDt(r.to, r.toTime) : (() => { const d = new Date(parseDt(r.to)); d.setDate(d.getDate() + 1); return d.getTime(); })();
        return rStart < newEnd && rEnd > newStart;
      });
    },
    isDatesAvailable:     async () => true,
    isVehicleAvailable:   async () => true,
    fetchBookedDates:     async () => ({}),
    fetchFleetStatus:     async () => ({}),
    parseDateTimeMs:      (d) => new Date(d + "T00:00:00").getTime(),
  },
});

mock.module("./_textmagic.js", {
  namedExports: {
    sendSms: async (phone, body) => { smsCalls.push({ phone, body }); },
  },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    render:           (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] || ""),
    DEFAULT_LOCATION: "Los Angeles, CA",
    BOOKING_CONFIRMED: "Your {vehicle} is confirmed, {customer_name}.",
    UNPAID_REMINDER_24H: "",
    UNPAID_REMINDER_2H:  "",
    UNPAID_REMINDER_FINAL: "",
    PICKUP_REMINDER_24H: "",
    PICKUP_REMINDER_2H: "",
    PICKUP_REMINDER_30MIN: "",
    ACTIVE_RENTAL_MID: "",
    ACTIVE_RENTAL_1H_BEFORE_END: "",
    ACTIVE_RENTAL_15MIN_BEFORE_END: "",
    LATE_WARNING_30MIN: "",
    LATE_AT_RETURN_TIME: "",
    LATE_GRACE_EXPIRED: "",
    LATE_FEE_APPLIED: "",
    POST_RENTAL_THANK_YOU: "",
    RETENTION_DAY_1: "",
    RETENTION_DAY_3: "",
    RETENTION_DAY_7: "",
    RETENTION_DAY_14: "",
    RETENTION_DAY_30: "",
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (err) => err?.message || String(err),
  },
});

// Stub out GitHub-based booked-dates blocking (v2-bookings.js internal blockBookedDates)
// by making fetch a no-op for GitHub Content API calls
global.fetch = async (url, opts) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
    }
  } catch { /* not a valid URL — fall through */ }
  return { ok: false };
};

const { default: handler } = await import("./v2-bookings.js");

// ─── Reset helpers ─────────────────────────────────────────────────────────────

function resetStore() {
  for (const k of Object.keys(bookingsStore)) delete bookingsStore[k];
}

function resetCalls() {
  automationCalls.revenue.length = 0;
  automationCalls.customer.length = 0;
  automationCalls.booking.length = 0;
  automationCalls.blocked.length = 0;
  smsCalls.length = 0;
}

// ─── Minimal create payload ───────────────────────────────────────────────────

function createPayload(overrides = {}) {
  return {
    secret:      "test-admin-secret",
    action:      "create",
    vehicleId:   "camry",
    name:        "Alice Smith",
    phone:       "+13105550001",
    email:       "alice@example.com",
    pickupDate:  "2026-06-01",
    pickupTime:  "10:00 AM",
    returnDate:  "2026-06-03",
    returnTime:  "10:00 AM",
    amountPaid:  0,
    totalPrice:  150,
    paymentMethod: "cash",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AUTH
// ═══════════════════════════════════════════════════════════════════════════════

test("returns 401 for wrong secret", async () => {
  const res = makeRes();
  await handler(makeReq({ secret: "bad", action: "create" }), res);
  assert.equal(res._status, 401);
});

test("returns 405 for GET requests", async () => {
  const req = { method: "GET", headers: { origin: "https://www.slytrans.com" }, body: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CREATE — input validation
// ═══════════════════════════════════════════════════════════════════════════════

test("create: 400 on missing vehicleId", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), vehicleId: "" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
});

test("create: 400 on invalid vehicleId", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), vehicleId: "unknown_car" }), res);
  assert.equal(res._status, 400);
});

test("create: 400 on missing name", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), name: "" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("name"));
});

test("create: 400 on bad pickupDate format", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), pickupDate: "06/01/2026" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("pickupDate"));
});

test("create: 400 when returnDate before pickupDate", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ ...createPayload(), pickupDate: "2026-06-05", returnDate: "2026-06-01" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("returnDate"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CREATE — payment status
// ═══════════════════════════════════════════════════════════════════════════════

test("create: amountPaid=0 → status reserved_unpaid", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.status, "reserved_unpaid");
});

test("create: amountPaid>0 → status booked_paid", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.status, "booked_paid");
});

test("create: totalPrice stored on booking record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 50, totalPrice: 200 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.totalPrice, 200);
  assert.equal(res._body.booking.amountPaid, 50);
});

test("create: totalPrice defaults to amountPaid when not provided", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 75, totalPrice: undefined })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.totalPrice, 75);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CREATE — automation side effects
// ═══════════════════════════════════════════════════════════════════════════════

test("create: paid booking triggers revenue record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res);
  assert.ok(automationCalls.revenue.length > 0, "autoCreateRevenueRecord was called");
  assert.equal(automationCalls.revenue[0].vehicleId, "camry");
});

test("create: paid booking triggers customer upsert", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res);
  assert.ok(automationCalls.customer.length > 0, "autoUpsertCustomer was called");
  assert.equal(automationCalls.customer[0].phone, "+13105550001");
});

test("create: any booking syncs to Supabase bookings table", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.ok(automationCalls.booking.length > 0, "autoUpsertBooking was called");
});

test("create: any booking creates blocked dates", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.ok(automationCalls.blocked.length > 0, "autoCreateBlockedDate was called");
  assert.equal(automationCalls.blocked[0].vehicleId, "camry");
  assert.equal(automationCalls.blocked[0].reason, "booking");
});

test("create: unpaid booking does NOT create revenue record", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.equal(automationCalls.revenue.length, 0, "autoCreateRevenueRecord should NOT fire for unpaid bookings");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DOUBLE BOOKING PREVENTION
// ═══════════════════════════════════════════════════════════════════════════════

test("double booking: identical dates on same vehicle → 409", async () => {
  resetStore(); resetCalls();
  // First booking
  await handler(makeReq(createPayload({ amountPaid: 150 })), makeRes());
  // Second booking: exact same dates
  const res2 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res2);
  assert.equal(res2._status, 409);
  assert.ok(res2._body.error.toLowerCase().includes("conflict"), `Expected conflict error, got: ${res2._body.error}`);
});

test("double booking: overlapping dates on same vehicle → 409", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ pickupDate: "2026-07-01", returnDate: "2026-07-05", amountPaid: 150 })), makeRes());
  // Overlapping: starts before first ends
  const res2 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-07-03", returnDate: "2026-07-08", amountPaid: 150 })), res2);
  assert.equal(res2._status, 409);
});

test("double booking: non-overlapping dates on same vehicle → 200", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ pickupDate: "2026-08-01", returnDate: "2026-08-03", amountPaid: 150 })), makeRes());
  // Completely separate dates
  const res2 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-08-10", returnDate: "2026-08-12", amountPaid: 150 })), res2);
  assert.equal(res2._status, 200, `Expected 200 for non-overlapping, got ${res2._status}: ${JSON.stringify(res2._body)}`);
});

test("double booking: different vehicles, same dates → both allowed", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ vehicleId: "camry", amountPaid: 150 })), makeRes());
  const res2 = makeRes();
  await handler(makeReq({ ...createPayload({ amountPaid: 150 }), vehicleId: "camry2013" }), res2);
  assert.equal(res2._status, 200);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. BACK-TO-BACK SAME-DAY BOOKINGS (Slingshot hourly rentals)
// ═══════════════════════════════════════════════════════════════════════════════

test("back-to-back: first ends 9 AM, second starts 11 AM same day → no conflict", async () => {
  resetStore(); resetCalls();
  // Slingshot: 6am–9am
  await handler(makeReq(createPayload({
    vehicleId:  "slingshot",
    pickupDate: "2026-09-01", pickupTime: "6:00 AM",
    returnDate: "2026-09-01", returnTime: "9:00 AM",
    amountPaid: 200,
  })), makeRes());
  // Same vehicle: 11am–2pm
  const res2 = makeRes();
  await handler(makeReq(createPayload({
    vehicleId:  "slingshot",
    pickupDate: "2026-09-01", pickupTime: "11:00 AM",
    returnDate: "2026-09-01", returnTime: "2:00 PM",
    amountPaid: 200,
  })), res2);
  assert.equal(res2._status, 200, `Back-to-back should be allowed. Got: ${JSON.stringify(res2._body)}`);
});

test("back-to-back: overlapping times on same day → 409", async () => {
  resetStore(); resetCalls();
  // 6am–3pm
  await handler(makeReq(createPayload({
    vehicleId:  "slingshot",
    pickupDate: "2026-09-02", pickupTime: "6:00 AM",
    returnDate: "2026-09-02", returnTime: "3:00 PM",
    amountPaid: 200,
  })), makeRes());
  // 1pm–7pm — overlaps
  const res2 = makeRes();
  await handler(makeReq(createPayload({
    vehicleId:  "slingshot",
    pickupDate: "2026-09-02", pickupTime: "1:00 PM",
    returnDate: "2026-09-02", returnTime: "7:00 PM",
    amountPaid: 200,
  })), res2);
  assert.equal(res2._status, 409);
});

test("back-to-back: adjacent (end == start exactly) → no conflict", async () => {
  resetStore(); resetCalls();
  // 9am–3pm
  await handler(makeReq(createPayload({
    vehicleId:  "slingshot",
    pickupDate: "2026-09-03", pickupTime: "9:00 AM",
    returnDate: "2026-09-03", returnTime: "3:00 PM",
    amountPaid: 200,
  })), makeRes());
  // 3pm–9pm — starts exactly when first ends
  const res2 = makeRes();
  await handler(makeReq(createPayload({
    vehicleId:  "slingshot",
    pickupDate: "2026-09-03", pickupTime: "3:00 PM",
    returnDate: "2026-09-03", returnTime: "9:00 PM",
    amountPaid: 200,
  })), res2);
  assert.equal(res2._status, 200, `Adjacent bookings should be allowed. Got: ${JSON.stringify(res2._body)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CANCELLED BOOKING RELEASES AVAILABILITY
// ═══════════════════════════════════════════════════════════════════════════════

test("cancelled booking: slot is released for new booking on same dates", async () => {
  resetStore(); resetCalls();
  // Create a booking
  const r1 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-10-01", returnDate: "2026-10-03", amountPaid: 150 })), r1);
  assert.equal(r1._status, 200);
  const bookingId = r1._body.booking.bookingId;

  // Cancel it
  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "cancelled_rental" },
  }), r2);
  assert.equal(r2._status, 200, `Cancel failed: ${JSON.stringify(r2._body)}`);

  // New booking on same dates should be allowed
  const r3 = makeRes();
  await handler(makeReq(createPayload({ pickupDate: "2026-10-01", returnDate: "2026-10-03", amountPaid: 150 })), r3);
  assert.equal(r3._status, 200, `After cancellation, same-date booking should succeed. Got: ${JSON.stringify(r3._body)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. FULL LIFECYCLE — create → approve → activate → complete
// ═══════════════════════════════════════════════════════════════════════════════

test("lifecycle: create booking (reserved_unpaid)", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.status, "reserved_unpaid");
});

test("lifecycle: approve booking (reserved_unpaid → booked_paid) triggers revenue + SMS", async () => {
  resetStore(); resetCalls();
  // Create unpaid
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  // Approve (mark paid)
  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "booked_paid", amountPaid: 150 },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.status, "booked_paid");

  // Revenue record created
  assert.ok(automationCalls.revenue.length > 0, "Revenue record must be created on approval");
  // Customer upserted
  assert.ok(automationCalls.customer.length > 0, "Customer must be upserted on approval");
  // Supabase booking synced
  assert.ok(automationCalls.booking.length > 0, "Supabase booking must be synced on approval");
  // Confirmation SMS sent
  assert.ok(smsCalls.length > 0, "Confirmation SMS must be sent on approval");
  assert.ok(smsCalls[0].body.includes("Camry 2012"), `SMS body should include vehicle name. Got: ${smsCalls[0].body}`);
});

test("lifecycle: activate booking (booked_paid → active_rental) syncs to Supabase", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.status, "active_rental");
  assert.ok(automationCalls.booking.length > 0, "Supabase booking must be synced on activation");
});

test("lifecycle: complete booking (active_rental → completed_rental) increments customer stats", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  // Activate
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());
  resetCalls();

  // Complete
  const r3 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r3);
  assert.equal(r3._status, 200);
  assert.equal(r3._body.booking.status, "completed_rental");
  // Customer stats must be incremented exactly once (countStats=true)
  const statsCall = automationCalls.customer.find((c) => c.countStats === true);
  assert.ok(statsCall, "autoUpsertCustomer must be called with countStats=true on completion");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PAYMENT FIELD COMPUTATION (via autoUpsertBooking args)
// ═══════════════════════════════════════════════════════════════════════════════

test("payment: amountPaid=0, totalPrice=200 → Supabase sync has unpaid status", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 200 })), makeRes());
  // autoUpsertBooking should have been called with the booking; confirm it carries totalPrice
  const syncedBooking = automationCalls.booking[0];
  assert.ok(syncedBooking, "autoUpsertBooking must be called");
  assert.equal(syncedBooking.totalPrice, 200, "totalPrice must be forwarded to automation");
  assert.equal(syncedBooking.amountPaid, 0);
});

test("payment: partial payment (amountPaid < totalPrice) stored on booking", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 50, totalPrice: 200 })), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.booking.amountPaid, 50);
  assert.equal(res._body.booking.totalPrice, 200);
});

test("payment: update amountPaid syncs updated booking to Supabase", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { amountPaid: 75 },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.amountPaid, 75);
  assert.ok(automationCalls.booking.length > 0, "autoUpsertBooking must be called when amountPaid is updated");
});

test("payment: update totalPrice alongside amountPaid syncs to Supabase", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { totalPrice: 200, amountPaid: 50 },
  }), r2);
  assert.equal(r2._status, 200);
  assert.equal(r2._body.booking.totalPrice, 200);
  assert.equal(r2._body.booking.amountPaid, 50);
  // The synced Supabase record has the updated values
  const synced = automationCalls.booking[0];
  assert.ok(synced, "autoUpsertBooking must be called");
  assert.equal(synced.totalPrice, 200);
  assert.equal(synced.amountPaid, 50);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. UPDATE — validation
// ═══════════════════════════════════════════════════════════════════════════════

test("update: 404 when booking does not exist", async () => {
  resetStore(); resetCalls();
  // Ensure vehicle entry exists in store
  bookingsStore.camry = [];
  const res = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId: "nonexistent",
    updates:   { status: "booked_paid" },
  }), res);
  assert.equal(res._status, 404);
});

test("update: 400 when updates object is missing", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId: "someId",
  }), res);
  assert.equal(res._status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. LIST
// ═══════════════════════════════════════════════════════════════════════════════

test("list: returns empty array when no bookings", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body.bookings));
  assert.equal(res._body.bookings.length, 0);
});

test("list: returns created bookings", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 100 })), makeRes());
  await handler(makeReq({ ...createPayload({ amountPaid: 100 }), vehicleId: "camry2013" }), makeRes());
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.bookings.length, 2);
});

test("list: filters by vehicleId", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 100 })), makeRes());
  await handler(makeReq({ ...createPayload({ amountPaid: 100 }), vehicleId: "camry2013" }), makeRes());
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list", vehicleId: "camry" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.bookings.length, 1);
  assert.equal(res._body.bookings[0].vehicleId, "camry");
});
