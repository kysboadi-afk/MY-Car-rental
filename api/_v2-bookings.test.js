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
const automationCalls = { revenue: [], customer: [], booking: [], blocked: [], releaseBlocked: [] };
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
    autoCreateRevenueRecord:        async (b) => { automationCalls.revenue.push({ ...b }); },
    autoUpsertCustomer:             async (b, s) => { automationCalls.customer.push({ ...b, countStats: s }); },
    autoUpsertBooking:              async (b) => { automationCalls.booking.push({ ...b }); },
    autoCreateBlockedDate:          async (vid, s, e, r) => { automationCalls.blocked.push({ vehicleId: vid, start: s, end: e, reason: r }); },
    autoReleaseBlockedDateOnReturn: async (vid, ref) => { automationCalls.releaseBlocked.push({ vehicleId: vid, bookingRef: ref }); },
    parseTime12h:            (t) => {
      if (!t) return null;
      const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (!m) return null;
      let h = parseInt(m[1], 10);
      const mn = parseInt(m[2], 10);
      const s2 = m[3] ? parseInt(m[3], 10) : 0;
      const ap = (m[4] || "").toUpperCase();
      if (ap === "PM" && h !== 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}:${String(s2).padStart(2,"0")}`;
    },
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
    isSchemaError:     () => false,
  },
});

// Mock _booking-pipeline.js so persistBooking stores the booking in the
// in-memory bookingsStore and populates automationCalls without hitting
// real Supabase or GitHub.  Mirrors booking pipeline behavior:
// revenue + customer only for paid bookings; blocked_dates only for paid bookings.
mock.module("./_booking-pipeline.js", {
  namedExports: {
    persistBooking: async (opts) => {
      const booking = { smsSentAt: {}, createdAt: new Date().toISOString(), ...opts };
      if (booking.status === "booked_paid") {
        automationCalls.revenue.push({ ...booking });
        automationCalls.customer.push({ ...booking, countStats: false });
      }
      automationCalls.booking.push({ ...booking });
      // Only paid/active bookings create blocked_dates entries.
      if (opts.pickupDate && opts.returnDate && booking.status === "booked_paid") {
        automationCalls.blocked.push({
          vehicleId: opts.vehicleId,
          start:     opts.pickupDate,
          end:       opts.returnDate,
          reason:    "booking",
        });
      }
      if (!Array.isArray(bookingsStore[opts.vehicleId])) bookingsStore[opts.vehicleId] = [];
      if (!bookingsStore[opts.vehicleId].some((b) => b.bookingId === booking.bookingId)) {
        bookingsStore[opts.vehicleId].push(booking);
      }
      return { ok: true, bookingId: booking.bookingId, booking, supabaseOk: true, errors: [] };
    },
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
  automationCalls.releaseBlocked.length = 0;
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

test("create: unpaid booking does NOT create blocked dates", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 0 })), res);
  assert.equal(automationCalls.blocked.length, 0, "autoCreateBlockedDate must NOT fire for unpaid bookings");
});

test("create: paid booking creates blocked dates", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150 })), res);
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

  // Simulate Stripe payment succeeding (the webhook sets payment_status='paid')
  const rPay = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { paymentStatus: "paid" },
  }), rPay);
  assert.equal(rPay._status, 200, `Payment simulation failed: ${JSON.stringify(rPay._body)}`);
  resetCalls();

  // Approve (mark paid) — now allowed because payment_status is 'paid'
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

test("lifecycle: completing a booking auto-sets completedAt and actualReturnTime", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  // Must first activate before completing
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r2);
  assert.equal(r2._status, 200);
  assert.ok(r2._body.booking.completedAt, "completedAt must be set automatically on completion");
  assert.ok(r2._body.booking.actualReturnTime, "actualReturnTime must be set automatically on completion");
});

test("lifecycle: activating a booking auto-sets activatedAt", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), r2);
  assert.equal(r2._status, 200);
  assert.ok(r2._body.booking.activatedAt, "activatedAt must be set automatically on activation");
});

test("lifecycle: completing a booking does NOT write to booked-dates.json (Phase 4)", async () => {
  resetStore(); resetCalls();
  // Track GitHub API calls
  const githubPuts = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    try {
      const parsed = new URL(typeof url === "string" ? url : String(url));
      if (parsed.hostname === "api.github.com") {
        if (opts && opts.method === "PUT") githubPuts.push(String(url));
        return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
      }
    } catch { /* not a valid URL — fall through */ }
    return { ok: false };
  };

  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  githubPuts.length = 0; // clear setup calls

  // Activate first (required by the safety guard)
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "active_rental" },
  }), makeRes());
  githubPuts.length = 0; // clear activation calls

  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), makeRes());

  global.fetch = origFetch;
  // Phase 4: booked-dates.json writes are disabled
  assert.ok(!githubPuts.some((u) => u.includes("booked-dates")),
    "Phase 4: booked-dates.json must NOT be written when rental completes");
});

test("lifecycle: cancelling a booking does NOT write to booked-dates.json (Phase 4)", async () => {
  resetStore(); resetCalls();
  const githubPuts = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    try {
      const parsed = new URL(typeof url === "string" ? url : String(url));
      if (parsed.hostname === "api.github.com") {
        if (opts && opts.method === "PUT") githubPuts.push(String(url));
        return { ok: true, json: async () => ({ content: btoa("{}"), sha: "sha1" }) };
      }
    } catch { /* not a valid URL — fall through */ }
    return { ok: false };
  };

  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 50, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  githubPuts.length = 0;

  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "cancelled_rental" },
  }), makeRes());

  global.fetch = origFetch;
  // Phase 4: booked-dates.json writes are disabled
  assert.ok(!githubPuts.some((u) => u.includes("booked-dates")),
    "Phase 4: booked-dates.json must NOT be written when rental is cancelled");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PAYMENT FIELD COMPUTATION (via autoUpsertBooking args)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Safety guard + return flow ──────────────────────────────────────────────

test("returned: completing a non-active booking returns 409", async () => {
  resetStore(); resetCalls();
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 150, totalPrice: 150 })), r1);
  const { bookingId } = r1._body.booking;
  // Booking is currently booked_paid — should NOT be completable without activating first

  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r2);
  assert.equal(r2._status, 409, `Expected 409 when completing non-active booking, got ${r2._status}: ${JSON.stringify(r2._body)}`);
  assert.ok(r2._body.error.includes("active"), "Error must mention active status requirement");
});

test("returned: completing an active booking calls autoReleaseBlockedDateOnReturn", async () => {
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

  // Complete (Return)
  const r2 = makeRes();
  await handler(makeReq({
    secret:    "test-admin-secret",
    action:    "update",
    vehicleId: "camry",
    bookingId,
    updates:   { status: "completed_rental" },
  }), r2);
  assert.equal(r2._status, 200, `Expected 200 on return, got ${r2._status}: ${JSON.stringify(r2._body)}`);
  assert.ok(
    automationCalls.releaseBlocked.some((c) => c.vehicleId === "camry" && c.bookingRef === bookingId),
    "autoReleaseBlockedDateOnReturn must be called with vehicleId and bookingId on completion"
  );
});

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

test("update: returnDate and returnTime are accepted and persisted", async () => {
  resetStore(); resetCalls();
  // Create a booking first
  const createRes = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 300, pickupDate: "2026-04-01", returnDate: "2026-04-07" })), createRes);
  const bookingId = createRes._body.booking.bookingId;

  // Update the return date (simulates admin correcting an extension)
  const updateRes = makeRes();
  await handler(makeReq({
    secret: "test-admin-secret",
    action: "update",
    vehicleId: "camry",
    bookingId,
    updates: { returnDate: "2026-04-10", returnTime: "5:00 PM" },
  }), updateRes);

  assert.equal(updateRes._status, 200, "update should succeed");
  assert.equal(updateRes._body.booking.returnDate, "2026-04-10", "returnDate should be updated");
  assert.equal(updateRes._body.booking.returnTime, "5:00 PM", "returnTime should be updated");
  // autoUpsertBooking should have been called to sync to Supabase
  assert.ok(automationCalls.booking.length > 0, "Supabase booking sync should be triggered");
});

test("list: returns Supabase rows when client is available", async () => {
  resetStore(); resetCalls();
  // Simulate Supabase returning two bookings directly
  const fakeRows = [
    {
      id: "uuid-1", booking_ref: "wh-abc123", vehicle_id: "camry2013",
      pickup_date: "2026-03-29", return_date: "2026-04-01",
      pickup_time: "8:38 PM",   return_time: "8:38 PM",
      status: "booked_paid",    deposit_paid: 231.53, total_price: 231.53,
      remaining_balance: 0,     payment_status: "paid",
      payment_method: "stripe", payment_intent_id: "pi_test123",
      notes: "",                created_at: "2026-03-29T20:38:00.000Z",
      updated_at: null,
      customers: { id: "cu-1", name: "David Agbebaku", phone: "+13463814616", email: "davosama15@gmail.com" },
    },
  ];
  // Build a minimal Supabase-stub that chains eq/in/order and resolves with fakeRows
  const makeChain = (rows) => {
    const chain = {
      select() { return this; },
      eq()     { return this; },
      in()     { return this; },
      order()  { return Promise.resolve({ data: rows, error: null }); },
    };
    return chain;
  };
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].bookingId, "wh-abc123");
    assert.equal(res._body.bookings[0].name, "David Agbebaku");
    assert.equal(res._body.bookings[0].pickupTime, "8:38 PM");
    assert.equal(res._body.bookings[0]._source, "supabase");
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: aggregates revenue rows per booking for total collected display", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-agg-1", booking_ref: "ca8ee28ffb888c41", vehicle_id: "camry2013",
      pickup_date: "2026-04-10", return_date: "2026-04-12",
      pickup_time: "9:00 AM",    return_time: "9:00 AM",
      status: "booked_paid",     deposit_paid: 121.28, total_price: 121.28,
      remaining_balance: 0,      payment_status: "paid",
      payment_method: "stripe",  payment_intent_id: "pi_base",
      notes: "",                 created_at: "2026-04-10T09:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-agg-1", name: "Brandon Bookhart", phone: "+15303285561", email: "brandon.bookhart@gmail.com" },
    },
  ];
  const fakeRevenueRows = [
    {
      booking_id: "ca8ee28ffb888c41",
      gross_amount: 121.28,
      stripe_fee: 4.16,
      stripe_net: 117.12,
      payment_method: "stripe",
      customer_name: "Brandon Bookhart",
      customer_phone: "+15303285561",
      customer_email: "brandon.bookhart@gmail.com",
    },
    {
      booking_id: "ca8ee28ffb888c41",
      gross_amount: 60.64,
      stripe_fee: 2.06,
      stripe_net: 58.58,
      payment_method: "stripe",
      customer_name: "Brandon Bookhart",
      customer_phone: "+15303285561",
      customer_email: "brandon.bookhart@gmail.com",
    },
  ];

  const makeBookingsChain = (rows) => ({
    select() { return this; },
    eq()     { return this; },
    in()     { return this; },
    order()  { return Promise.resolve({ data: rows, error: null }); },
  });

  const makeRevenueChain = (rows) => ({
    select() { return this; },
    in()     { return this; },
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  });

  supabaseMockState.client = {
    from: (table) => {
      if (table === "bookings") return makeBookingsChain(fakeRows);
      if (table === "revenue_records_effective") return makeRevenueChain(fakeRevenueRows);
      return makeBookingsChain([]);
    },
  };

  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].bookingId, "ca8ee28ffb888c41");
    assert.equal(res._body.bookings[0].amountGross, 181.92);
    assert.equal(res._body.bookings[0].stripeFee, 6.22);
    assert.equal(res._body.bookings[0].amountNet, 175.7);
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: falls back to bookings.json when Supabase errors", async () => {
  resetStore(); resetCalls();
  await handler(makeReq(createPayload({ amountPaid: 100 })), makeRes()); // seed one booking
  // Supabase client that always errors
  const errChain = {
    select() { return this; },
    eq()     { return this; },
    in()     { return this; },
    order()  { return Promise.resolve({ data: null, error: { message: "DB down" } }); },
  };
  supabaseMockState.client = { from: () => errChain };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1, "should fall back to bookings.json booking");
  } finally {
    supabaseMockState.client = null;
  }
});

// ── Status mapping tests ──────────────────────────────────────────────────────

test("list: maps Supabase DB status 'approved' → 'booked_paid' in response", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-2", booking_ref: "bk-test-001", vehicle_id: "camry",
      pickup_date: "2026-04-01", return_date: "2026-04-03",
      pickup_time: "10:00 AM",  return_time: "10:00 AM",
      status: "approved",        deposit_paid: 100, total_price: 100,
      remaining_balance: 0,      payment_status: "paid",
      payment_method: "stripe",  payment_intent_id: "pi_test",
      notes: "",                 created_at: "2026-04-01T10:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-2", name: "Test User", phone: "+15555550001", email: "test@example.com" },
    },
  ];
  const makeChain = (rows) => {
    const chain = {
      select() { return this; },
      eq()     { return this; },
      in()     { return this; },
      order()  { return Promise.resolve({ data: rows, error: null }); },
    };
    return chain;
  };
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings.length, 1);
    assert.equal(res._body.bookings[0].status, "booked_paid",
      "Supabase 'approved' status must be mapped to 'booked_paid' for admin UI button compatibility");
  } finally {
    supabaseMockState.client = null;
  }
});

test("list: maps Supabase DB status 'active' → 'active_rental' in response", async () => {
  resetStore(); resetCalls();
  const fakeRows = [
    {
      id: "uuid-3", booking_ref: "bk-test-002", vehicle_id: "camry",
      pickup_date: "2026-04-01", return_date: "2026-04-03",
      pickup_time: "10:00 AM",  return_time: "10:00 AM",
      status: "active",          deposit_paid: 100, total_price: 100,
      remaining_balance: 0,      payment_status: "paid",
      payment_method: "stripe",  payment_intent_id: "pi_test2",
      notes: "",                 created_at: "2026-04-01T10:00:00.000Z",
      updated_at: null,
      customers: { id: "cu-3", name: "Test User 2", phone: "+15555550002", email: "test2@example.com" },
    },
  ];
  const makeChain = (rows) => {
    const chain = {
      select() { return this; },
      eq()     { return this; },
      in()     { return this; },
      order()  { return Promise.resolve({ data: rows, error: null }); },
    };
    return chain;
  };
  supabaseMockState.client = { from: () => makeChain(fakeRows) };
  try {
    const res = makeRes();
    await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.bookings[0].status, "active_rental",
      "Supabase 'active' status must be mapped to 'active_rental'");
  } finally {
    supabaseMockState.client = null;
  }
});

test("update: Supabase direct update is attempted before bookings.json write", async () => {
  resetStore(); resetCalls();
  // Create a booking first
  const r1 = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 100, totalPrice: 100 })), r1);
  const { bookingId } = r1._body.booking;
  resetCalls();

  // Track whether Supabase update was called
  let sbUpdateCalled = false;
  const makeUpdateChain = () => {
    const chain = {};
    chain.update  = () => { sbUpdateCalled = true; return chain; };
    chain.eq      = () => chain;
    chain.select  = () => chain;
    chain.maybeSingle = () => Promise.resolve({ data: { id: "uuid-sb-1" }, error: null });
    return chain;
  };
  supabaseMockState.client = { from: () => makeUpdateChain() };

  try {
    const r2 = makeRes();
    await handler(makeReq({
      secret: "test-admin-secret", action: "update",
      vehicleId: "camry", bookingId,
      updates: { status: "active_rental" },
    }), r2);
    assert.equal(r2._status, 200, "update should succeed");
    assert.equal(r2._body.booking.status, "active_rental", "booking status must reflect new value");
    assert.ok(sbUpdateCalled, "Supabase direct update should have been called");
  } finally {
    supabaseMockState.client = null;
  }
});

test("delete: removes booking from bookings.json by bookingId", async () => {
  resetStore(); resetCalls();

  const created = makeRes();
  await handler(makeReq(createPayload({ amountPaid: 100, totalPrice: 100 })), created);
  const bookingId = created._body?.booking?.bookingId;
  assert.ok(bookingId, "create should return a bookingId");

  const delRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "delete", bookingId }), delRes);
  assert.equal(delRes._status, 200);
  assert.equal(delRes._body?.success, true);

  const listRes = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), listRes);
  assert.equal(listRes._status, 200);
  assert.equal(listRes._body.bookings.length, 0, "deleted booking should not remain in listing");
});

test("delete: returns 400 when bookingId is missing", async () => {
  resetStore(); resetCalls();
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "delete" }), res);
  assert.equal(res._status, 400);
  assert.match(res._body?.error || "", /bookingId is required/);
});
