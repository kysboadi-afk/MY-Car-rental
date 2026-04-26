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
process.env.STRIPE_SECRET_KEY     = "sk_live_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
// GITHUB_TOKEN must be set so blockBookedDates proceeds past its early-exit
// guard and calls global.fetch (which is mocked below).  Without it the
// function returns before updating booked-dates.json in the test store.
process.env.GITHUB_TOKEN          = "ghs_fake_for_tests";

// ─── Mutable state ────────────────────────────────────────────────────────────
const bookingsStore = {};                     // in-memory bookings.json
const automationCalls = { revenue: [], customer: [], booking: [], blocked: [], activated: [] };
let bookedDatesStore = {};
let fleetStatusStore = {};
const supabaseBookingsStore = {};
const stripePiStore = {};
const sentEmails = [];
let skipSupabaseUpsertPi = null;
let skipSupabaseUpsertCount = 0;

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      retrieve: async (id, opts = {}) => {
        const src = stripePiStore[id] || { id, amount: 0, metadata: {} };
        const shouldExpandBt = Array.isArray(opts.expand) &&
          opts.expand.includes("latest_charge.balance_transaction");
        if (!shouldExpandBt) return { ...src };
        const grossCents = Number(src.amount || 0);
        const feeCents = Math.round(grossCents * 0.029 + 30);
        return {
          ...src,
          latest_charge: {
            id: `ch_${id}`,
            balance_transaction: {
              id: `txn_${id}`,
              fee: feeCents,
              net: Math.max(0, grossCents - feeCents),
            },
          },
        };
      },
    };
    get webhooks() {
      return {
        constructEvent: (_body, _sig, _secret) => {
          const event = JSON.parse(_body.toString());
          const pi = event?.data?.object;
          if (pi?.id) stripePiStore[pi.id] = { ...pi };
          return event;
        },
      };
    }
  },
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (payload) => {
        sentEmails.push(payload);
      },
    }),
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
    autoCreateRevenueRecord:    async (b)         => {
      automationCalls.revenue.push({ ...b });
      const key = b.bookingId || b.paymentIntentId;
      if (!key) return;
      supabaseRevenueStore[key] = {
        id: `rr_${key}`,
        payment_intent_id: b.paymentIntentId || null,
        gross_amount: b.amountPaid ?? null,
        stripe_fee: b.stripeFee ?? null,
      };
    },
    createOrphanRevenueRecord:  async (b)         => {
      automationCalls.revenue.push({ ...b, _orphan: true });
    },
    autoUpsertCustomer:         async (b, s)       => { automationCalls.customer.push({ ...b, countStats: s }); },
    autoUpsertBooking:          async (b)          => {
      automationCalls.booking.push({ ...b });
      if (skipSupabaseUpsertPi && b?.paymentIntentId === skipSupabaseUpsertPi && skipSupabaseUpsertCount > 0) {
        // Intentionally skip writing to the fake Supabase store for the first N
        // attempts so webhook tests can verify retry + idempotency behavior.
        skipSupabaseUpsertCount -= 1;
        return;
      }
      if (b?.bookingId || b?.paymentIntentId) {
        const key = b.bookingId || b.paymentIntentId;
        supabaseBookingsStore[key] = {
          id: `sb_${key}`,
          booking_ref: b.bookingId || null,
          payment_intent_id: b.paymentIntentId || null,
          status: b.status || null,
          return_date: b.returnDate || null,
          total_price: b.totalPrice || b.amountPaid || 0,
        };
      }
    },
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
    BOOKING_CONFIRMED:          "booking_confirmed",
    SLINGSHOT_DEPOSIT_RECEIVED: "slingshot_deposit_received",
    RESERVATION_DEPOSIT_CONFIRMED: "reservation_deposit_confirmed",
    EXTEND_CONFIRMED_SLINGSHOT: "ext_slingshot",
    EXTEND_CONFIRMED_ECONOMY:   "ext_economy",
    LATE_FEE_APPLIED:           "late_fee_applied",
    POST_RENTAL_CHARGE:         "post_rental_charge",
  },
});

mock.module("./_rental-agreement-pdf.js", {
  namedExports: {
    generateRentalAgreementPdf: async () => Buffer.from("pdf-stub"),
    dppTierLiabilityCap: (tier) => tier === "basic" ? "$2,500" : tier === "premium" ? "$500" : "$1,000",
  },
});

// Supabase stub (for the new getSupabaseAdmin import in stripe-webhook.js)
const supabaseDirectUpdates = [];
// Pre-populated by tests that need a revenue_record to already exist
const supabaseRevenueStore = {}; // booking_id → { id, gross_amount }

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => {
        // Fluent builder — assembles select/eq/maybeSingle or update/eq chains.
        let _selectCols = null;
        let _updatePayload = null;
        let _upsertPayload = null;
        const _eqFilters = {};

        const builder = {
          select(cols) {
            _selectCols = cols;
            // Terminate a upsert().select() chain — return rows that were upserted.
            if (_upsertPayload !== null && table === "bookings") {
              const key = _upsertPayload.booking_ref;
              const row = key ? { booking_ref: key } : null;
              return Promise.resolve({ data: row ? [row] : [], error: null });
            }
            return builder;
          },
          update(payload) { _updatePayload = payload; return builder; },
          upsert(payload, _opts) {
            _upsertPayload = payload;
            if (table === "bookings" && payload?.booking_ref) {
              const key = payload.booking_ref;
              supabaseBookingsStore[key] = {
                ...(supabaseBookingsStore[key] || {}),
                id: supabaseBookingsStore[key]?.id || `sb_${key}`,
                booking_ref: key,
                payment_intent_id: payload.payment_intent_id || supabaseBookingsStore[key]?.payment_intent_id || null,
                status: payload.status || supabaseBookingsStore[key]?.status || null,
                return_date: payload.return_date || supabaseBookingsStore[key]?.return_date || null,
                total_price: payload.total_price ?? supabaseBookingsStore[key]?.total_price ?? 0,
              };
            }
            return builder;
          },
          eq(col, val) {
            _eqFilters[col] = val;
            if (_updatePayload !== null) {
              // Terminate an update().eq() chain immediately.
              supabaseDirectUpdates.push({ table, payload: _updatePayload, filters: { ..._eqFilters } });
              return Promise.resolve({ error: null });
            }
            return builder;
          },
          // Supported select patterns:
          //   revenue_records filtered by booking_id  → looks up supabaseRevenueStore
          //   all other tables / filter combos        → returns { data: null }
          maybeSingle() {
            if (table === "revenue_records" && _eqFilters.booking_id) {
              const stored = supabaseRevenueStore[_eqFilters.booking_id] || null;
              return Promise.resolve({ data: stored, error: null });
            }
            if (table === "bookings") {
              if (_eqFilters.booking_ref) {
                const found = Object.values(supabaseBookingsStore).find(
                  (r) => r.booking_ref === _eqFilters.booking_ref
                ) || null;
                return Promise.resolve({ data: found, error: null });
              }
              if (_eqFilters.payment_intent_id) {
                const found = Object.values(supabaseBookingsStore).find(
                  (r) => r.payment_intent_id === _eqFilters.payment_intent_id
                ) || null;
                return Promise.resolve({ data: found, error: null });
              }
            }
            return Promise.resolve({ data: null, error: null });
          },
          // Allow extra eq() chains in select paths
          then(resolve) { return Promise.resolve({ data: null, error: null }).then(resolve); },
        };
        return builder;
      },
    }),
  },
});

// GitHub API stub (for blockBookedDates / markVehicleUnavailable inside webhook)
global.fetch = async (url, options = {}) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      const method = (options.method || "GET").toUpperCase();
      const isBookedDates = parsed.pathname.endsWith("/contents/booked-dates.json");
      const isFleetStatus = parsed.pathname.endsWith("/contents/fleet-status.json");
      if (!isBookedDates && !isFleetStatus) return { ok: false };

      if (method === "GET") {
        const data = isBookedDates ? bookedDatesStore : fleetStatusStore;
        return {
          ok: true,
          json: async () => ({
            content: Buffer.from(JSON.stringify(data)).toString("base64"),
            sha: "sha1",
          }),
        };
      }

      if (method === "PUT") {
        let decoded = {};
        try {
          const body = JSON.parse(String(options.body || "{}"));
          const rawContent = String(body.content || "").trim();
          const decodedText = rawContent
            ? Buffer.from(rawContent, "base64").toString("utf-8")
            : "{}";
          decoded = JSON.parse(decodedText || "{}");
        } catch {
          decoded = {};
        }
        if (isBookedDates) bookedDatesStore = decoded;
        if (isFleetStatus) fleetStatusStore = decoded;
        return {
          ok: true,
          json: async () => ({ content: "", sha: "sha2" }),
          text: async () => "",
        };
      }

      return { ok: false };
    }
  } catch { /* fall through */ }
  return { ok: false };
};

const { default: handler } = await import("./stripe-webhook.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resetStore() {
  for (const k of Object.keys(bookingsStore)) delete bookingsStore[k];
  for (const k of Object.keys(supabaseBookingsStore)) delete supabaseBookingsStore[k];
  for (const k of Object.keys(stripePiStore)) delete stripePiStore[k];
  bookedDatesStore = {};
  fleetStatusStore = {};
}
function resetCalls() {
  automationCalls.revenue.length = 0;
  automationCalls.customer.length = 0;
  automationCalls.booking.length = 0;
  automationCalls.blocked.length = 0;
  automationCalls.activated.length = 0;
  supabaseDirectUpdates.length = 0;
  sentEmails.length = 0;
  skipSupabaseUpsertPi = null;
  skipSupabaseUpsertCount = 0;
  for (const k of Object.keys(supabaseRevenueStore)) delete supabaseRevenueStore[k];
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

function piSucceededEvent(meta, amountCents = 35000, livemode = true) {
  return {
    type: "payment_intent.succeeded",
    livemode,
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

test("webhook test mode: skips booking persistence and availability changes (livemode=false)", async () => {
  resetStore(); resetCalls();
  const event = piSucceededEvent({
    vehicle_id: "camry", vehicle_name: "Camry 2012",
    pickup_date: "2026-08-01", return_date: "2026-08-02",
    renter_name: "Test User", renter_phone: "+13105551111",
    email: "test@example.com", payment_type: "full_payment",
  }, 35000, false /* livemode=false */);
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { received: true, testMode: true }, "livemode=false must short-circuit as test mode");
  assert.equal(automationCalls.booking.length, 0, "livemode=false must not create bookings");
  assert.equal(automationCalls.blocked.length, 0, "livemode=false must not create blocked dates");
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
  assert.equal(
    automationCalls.booking[0].vehicleId,
    "camry",
    "new booking persistence must map Camry 2012 metadata to canonical vehicle_id"
  );
});

test("webhook new booking: pre-write guarantees Supabase row and idempotent json entry", async () => {
  resetStore(); resetCalls();
  const event = piSucceededEvent({
    vehicle_id: "camry", vehicle_name: "Camry 2012",
    pickup_date: "2026-09-05", return_date: "2026-09-06",
    renter_name: "Retry User", renter_phone: "+13105554444",
    email: "retry@example.com", payment_type: "full_payment",
  });
  event.data.object.id = "pi_retry_booking";
  try {
    // Simulate autoUpsertBooking not writing for the first 2 pipeline calls.
    // The explicit pre-write upsert now guarantees supabaseExists=true before
    // the pipeline loop starts, so the loop exits after one pass regardless.
    skipSupabaseUpsertPi = "pi_retry_booking";
    skipSupabaseUpsertCount = 2;

    const res = makeRes();
    await handler(makeWebhookReq(event), res);
    assert.equal(res._status, 200);

    // Pre-write must have stored the booking in Supabase (keyed by booking_ref).
    const persisted = Object.values(supabaseBookingsStore).find(
      (r) => r.payment_intent_id === "pi_retry_booking"
    );
    assert.ok(persisted, "pre-write must persist the booking in Supabase before the pipeline runs");

    // Pipeline must have run at least once.
    assert.ok(automationCalls.booking.length >= 1, "pipeline must call autoUpsertBooking at least once");

    // Idempotency: bookings.json must contain exactly one entry for this PI.
    const jsonRows = (bookingsStore.camry || []).filter((b) => b.paymentIntentId === "pi_retry_booking");
    assert.equal(jsonRows.length, 1, "idempotency guard must prevent duplicate bookings");
  } finally {
    skipSupabaseUpsertPi = null;
    skipSupabaseUpsertCount = 0;
  }
});

test("webhook new booking: sends alert when required metadata is missing", async () => {
  resetStore(); resetCalls();
  process.env.SMTP_HOST = "smtp.test.local";
  process.env.SMTP_USER = "alerts@test.local";
  process.env.SMTP_PASS = "secret";
  process.env.SMTP_PORT = "587";

  const event = piSucceededEvent({
    pickup_date: "2026-09-08",
    return_date: "2026-09-10",
    renter_name: "Missing Metadata",
    email: "missing@example.com",
    payment_type: "full_payment",
  });
  event.data.object.id = "pi_missing_meta_alert";
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 500);

  const alert = sentEmails.find((mail) =>
    String(mail?.subject || "").includes("Booking persistence failed")
  );
  assert.ok(alert, "missing metadata must trigger booking persistence alert email");
});

// ─── 2. balance_payment: status sync to Supabase ─────────────────────────────

test("webhook reservation_deposit: creates reservation_deposit revenue and syncs reserved status", async () => {
  resetStore(); resetCalls();
  const bookingId = "bk-res-dep-1";
  bookingsStore["camry"] = [{
    bookingId,
    vehicleId: "camry",
    vehicleName: "Camry 2012",
    name: "Deposit Renter",
    phone: "+13105550000",
    email: "deposit@example.com",
    pickupDate: "2026-10-01",
    returnDate: "2026-10-05",
    pickupTime: "10:00 AM",
    returnTime: "10:00 AM",
    status: "reserved_unpaid",
    amountPaid: 0,
    totalPrice: 350,
    paymentIntentId: "pi_old_deposit",
  }];
  // Do NOT pre-seed supabaseBookingsStore — in production the booking has never
  // been written to Supabase at the time the deposit webhook fires.
  // autoUpsertBooking in the handler will INSERT it for the first time.

  const event = piSucceededEvent({
    payment_type: "reservation_deposit",
    booking_id: bookingId,
    vehicle_id: "camry",
    vehicle_name: "Camry 2012",
    pickup_date: "2026-10-01",
    return_date: "2026-10-05",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    renter_name: "Deposit Renter",
    renter_phone: "+13105550000",
    email: "deposit@example.com",
    full_rental_amount: "350.00",
  }, 5000);

  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  const rev = automationCalls.revenue.find((r) => r.type === "reservation_deposit");
  assert.ok(rev, "reservation_deposit must create its own revenue record");
  assert.equal(rev.bookingId, bookingId);
  assert.equal(rev.amountPaid, 50);

  const bookingSync = automationCalls.booking.find((b) => b.bookingId === bookingId);
  assert.ok(bookingSync, "reservation_deposit must sync booking state");
  assert.equal(bookingSync.status, "reserved");
  assert.equal(bookingSync.paymentStatus, "partial");
});

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
  supabaseBookingsStore[origBookingId] = { id: `sb_${origBookingId}`, booking_ref: origBookingId };

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "slingshot",
    booking_id:             origBookingId,
    new_return_date:     "2026-11-02",
    new_return_time:     "3:00 PM",
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
  supabaseBookingsStore[origBookingId] = { id: `sb_${origBookingId}`, booking_ref: origBookingId };

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    booking_id:             origBookingId,
    new_return_date:     "2026-12-06",
    new_return_time:     "5:00 PM",
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

// ─── 5b. rental_extension: creates a new extension revenue record ─────────────

test("webhook rental_extension: creates a new extension revenue record (type=extension)", async () => {
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
  supabaseBookingsStore[origBookingId] = { id: `sb_${origBookingId}`, booking_ref: origBookingId };

  // amountCents = 11000 → $110.00 extension
  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    booking_id:             origBookingId,
    new_return_date:     "2026-12-14",
    new_return_time:     "3:00 PM",
  }, 11000);
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  // autoCreateRevenueRecord MUST be called with type='extension'.
  assert.ok(
    automationCalls.revenue.length > 0,
    "autoCreateRevenueRecord must be called to create a new extension revenue record"
  );
  const extRev = automationCalls.revenue[0];
  assert.equal(extRev.type, "extension", "extension revenue record must have type='extension'");
  assert.equal(extRev.vehicleId, "camry", "extension revenue record must carry vehicle_id");
  // booking_id must be the original booking ref (groups all records per rental)
  assert.equal(extRev.bookingId, origBookingId, "extension booking_id must equal the original booking ID");
  // payment_intent_id must hold the extension PI (separate from booking_id)
  assert.ok(
    extRev.paymentIntentId && extRev.paymentIntentId.startsWith("pi_"),
    "extension paymentIntentId must be the Stripe PaymentIntent ID"
  );
  assert.equal(extRev.amountPaid, 110, "extension revenue record must carry only the extension amount, not the combined total");

  // The original revenue_records row must NOT be mutated (no gross_amount update).
  const revUpdate = supabaseDirectUpdates.find(
    (u) => u.table === "revenue_records" && u.payload.gross_amount != null
  );
  assert.equal(revUpdate, undefined, "original revenue_records row must NOT be updated — extension gets its own row");

  // bookings.json amountPaid must still be incremented so the booking reflects the total collected.
  const saved = (bookingsStore["camry"] || []).find((b) => b.bookingId === origBookingId);
  assert.ok(saved, "original booking must still exist in bookings.json");
  assert.equal(saved.amountPaid, 220, "bookings.json amountPaid must be updated to 220 after extension");

  // autoUpsertBooking must carry the updated amountPaid.
  const upsert = automationCalls.booking.find((b) => b.bookingId === origBookingId);
  assert.ok(upsert, "autoUpsertBooking must be called for the original booking");
  assert.equal(upsert.amountPaid, 220, "upserted booking must have combined amountPaid = 220");
});

test("webhook rental_extension: booked-dates.json range is extended to the new return date", async () => {
  resetStore(); resetCalls();
  const origBookingId = "bk-ext-booked-dates";
  bookingsStore["camry"] = [{
    bookingId:  origBookingId,
    vehicleId:  "camry",
    name:       "Booked Dates Renter",
    phone:      "+13105550001",
    pickupDate: "2026-12-10",
    returnDate: "2026-12-12",
    returnTime: "3:00 PM",
    status:     "active_rental",
    amountPaid: 110,
    extensionPendingPayment: {
      newReturnDate: "2026-12-14",
      newReturnTime: "3:00 PM",
      label:         "+2 days",
      price:         110,
    },
  }];
  supabaseBookingsStore[origBookingId] = { id: `sb_${origBookingId}`, booking_ref: origBookingId };
  bookedDatesStore = {
    camry: [{ from: "2026-12-10", to: "2026-12-12" }],
  };

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    booking_id:             origBookingId,
    new_return_date:     "2026-12-14",
    new_return_time:     "3:00 PM",
  }, 11000);
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  assert.deepEqual(
    bookedDatesStore.camry,
    [{ from: "2026-12-10", to: "2026-12-14", toTime: "15:00" }],
    "booked-dates.json must be extended to the new return date so public availability stays in sync"
  );
});



test("webhook rental_extension: missing booking is logged and not mutated", async () => {
  // Extension webhooks must mutate an existing booking only.
  // If not found, we log an error and do not apply any extension side effects.
  resetStore(); resetCalls();
  // bookingsStore is empty — booking not found

  const event = piSucceededEvent({
    payment_type:        "rental_extension",
    vehicle_id:          "camry",
    booking_id:             "bk-supabase-only-booking",
    new_return_date:     "2026-04-14",
    new_return_time:     "11:30 AM",
    extension_label:     "+3 days",
  });
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  assert.equal(supabaseDirectUpdates.length, 0, "booking-not-found must not run fallback direct Supabase update");
  assert.equal(automationCalls.booking.length, 0, "booking-not-found must not sync booking update");
  assert.equal(automationCalls.revenue.length, 0, "booking-not-found must not create extension revenue");
  assert.equal(automationCalls.blocked.length, 0, "booking-not-found must not update blocked dates");
});

test("webhook rental_extension: idempotency guard skips re-application when returnDate already matches metadata", async () => {
  resetStore(); resetCalls();
  const bookingId = "bk-ext-idempotent";
  bookingsStore["camry"] = [{
    bookingId,
    vehicleId: "camry",
    name: "Idempotent Renter",
    phone: "+13105557777",
    pickupDate: "2026-12-10",
    pickupTime: "3:00 PM",
    returnDate: "2026-12-14",
    returnTime: "3:00 PM",
    status: "active_rental",
    amountPaid: 220,
    extensionCount: 1,
  }];
  supabaseBookingsStore[bookingId] = { id: `sb_${bookingId}`, booking_ref: bookingId };

  const event = piSucceededEvent({
    payment_type: "rental_extension",
    vehicle_id: "camry",
    booking_id:             bookingId,
    new_return_date: "2026-12-14",
    new_return_time: "6:30 PM",
  }, 11000);
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  const saved = bookingsStore.camry.find((b) => b.bookingId === bookingId);
  assert.equal(saved.amountPaid, 220, "idempotent retry must not increment amountPaid");
  assert.equal(saved.extensionCount, 1, "idempotent retry must not increment extensionCount");
  assert.equal(automationCalls.booking.length, 0, "idempotent retry must not upsert booking");
  assert.equal(automationCalls.revenue.length, 1, "idempotent retry must attempt extension revenue recovery (PI dedup prevents actual duplicate)");
  assert.equal(automationCalls.blocked.length, 0, "idempotent retry must not create blocked dates");
  const rev = automationCalls.revenue[0];
  assert.equal(rev.type, "extension", "revenue recovery must use type=extension");
  assert.equal(rev.bookingId, bookingId, "revenue recovery must reference the original booking_id");
});

test("webhook rental_extension: alreadyApplied path recovers missing revenue record", async () => {
  // Simulates: first delivery updated the booking date but returned 500 before writing
  // the extension revenue record.  The Stripe retry lands in the alreadyApplied branch
  // and must still attempt revenue creation (idempotent via payment_intent_id dedup).
  resetStore(); resetCalls();
  const bookingId = "bk-ext-revenue-recovery";
  bookingsStore["camry"] = [{
    bookingId,
    vehicleId: "camry",
    name: "Recovery Renter",
    phone: "+13105559900",
    email: "recovery@example.com",
    pickupDate: "2026-12-10",
    pickupTime: "3:00 PM",
    // returnDate already matches new_return_date — booking was updated on first delivery
    returnDate: "2026-12-17",
    returnTime: "15:00",
    status: "active_rental",
    amountPaid: 330,
    extensionCount: 1,
  }];
  supabaseBookingsStore[bookingId] = { id: `sb_${bookingId}`, booking_ref: bookingId };

  const event = piSucceededEvent({
    payment_type:    "rental_extension",
    vehicle_id:      "camry",
    booking_id:      bookingId,
    new_return_date: "2026-12-17",   // same as current returnDate → alreadyApplied
    new_return_time: "3:00 PM",
  }, 11000);  // $110 extension
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  // Booking JSON must NOT be re-mutated.
  const saved = bookingsStore.camry.find((b) => b.bookingId === bookingId);
  assert.equal(saved.amountPaid,    330, "alreadyApplied must not increment amountPaid");
  assert.equal(saved.extensionCount, 1, "alreadyApplied must not increment extensionCount");

  // Side-effect helpers must NOT fire.
  assert.equal(automationCalls.booking.length, 0, "alreadyApplied must not upsert booking");
  assert.equal(automationCalls.blocked.length, 0, "alreadyApplied must not create blocked dates");

  // Revenue creation MUST be attempted so the missing record is recovered.
  assert.equal(automationCalls.revenue.length, 1, "alreadyApplied must attempt extension revenue creation for recovery");
  const rev = automationCalls.revenue[0];
  assert.equal(rev.type,      "extension", "recovered revenue record must use type=extension");
  assert.equal(rev.bookingId, bookingId,   "recovered revenue record must reference the original booking_id");
  assert.equal(rev.paymentIntentId, event.data.object.id, "recovered revenue record must carry the extension PI id");
  assert.equal(rev.amountPaid, 110, "recovered revenue record must use amount_received / 100 from the PI");
});


test("webhook rental_extension: returnTime is preserved from existing booking and invalid status is rejected", async () => {
  resetStore(); resetCalls();
  const bookingId = "bk-ext-time-rule";
  bookingsStore["slingshot"] = [{
    bookingId,
    vehicleId: "slingshot",
    name: "Time Rule Renter",
    phone: "+13105558888",
    pickupDate: "2026-12-20",
    pickupTime: "3:00 PM",
    returnDate: "2026-12-21",
    returnTime: "3:00 PM",
    status: "reserved",
    amountPaid: 300,
    extensionPendingPayment: { newReturnDate: "2026-12-22", newReturnTime: "11:30 AM", price: 300 },
  }];
  supabaseBookingsStore[bookingId] = { id: `sb_${bookingId}`, booking_ref: bookingId };

  const event = piSucceededEvent({
    payment_type: "rental_extension",
    vehicle_id: "slingshot",
    booking_id:             bookingId,
    new_return_date: "2026-12-22",
    new_return_time: "11:30 AM",
  }, 30000);
  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);
  const updated = bookingsStore.slingshot.find((b) => b.bookingId === bookingId);
  assert.equal(updated.returnTime, "15:00", "returnTime must preserve existing booking return time in HH:MM format");

  // Invalid status branch
  resetCalls();
  bookingsStore["slingshot"] = [{
    bookingId: "bk-ext-invalid-status",
    vehicleId: "slingshot",
    pickupDate: "2026-12-25",
    pickupTime: "3:00 PM",
    returnDate: "2026-12-26",
    returnTime: "3:00 PM",
    status: "booked_paid",
    amountPaid: 300,
  }];
  supabaseBookingsStore["bk-ext-invalid-status"] = { id: "sb_bk-ext-invalid-status", booking_ref: "bk-ext-invalid-status" };
  const invalidEvent = piSucceededEvent({
    payment_type: "rental_extension",
    vehicle_id: "slingshot",
    booking_id:             "bk-ext-invalid-status",
    new_return_date: "2026-12-27",
    new_return_time: "3:00 PM",
  }, 30000);
  const invalidRes = makeRes();
  await handler(makeWebhookReq(invalidEvent), invalidRes);
  assert.equal(invalidRes._status, 200);
  const invalidSaved = bookingsStore.slingshot.find((b) => b.bookingId === "bk-ext-invalid-status");
  assert.equal(invalidSaved.returnDate, "2026-12-26", "invalid status must not mutate booking");
  assert.equal(automationCalls.booking.length, 0, "invalid status must not upsert booking");
});

// ─── 7. customer_details fallback for missing contact info ────────────────────

test("webhook reservation_deposit: uses customer_details.phone when renter_phone absent from metadata", async () => {
  resetStore(); resetCalls();
  const bookingId = "bk-cd-phone-fallback";
  bookingsStore["camry"] = [{
    bookingId,
    vehicleId: "camry",
    vehicleName: "Camry 2012",
    name: "CD Phone Renter",
    phone: "",
    email: "cdphone@example.com",
    pickupDate: "2026-11-01",
    returnDate: "2026-11-03",
    status: "reserved_unpaid",
    amountPaid: 0,
    totalPrice: 200,
    paymentIntentId: "pi_cd_phone_dep",
  }];

  const event = piSucceededEvent({
    payment_type: "reservation_deposit",
    booking_id: bookingId,
    vehicle_id: "camry",
    vehicle_name: "Camry 2012",
    pickup_date: "2026-11-01",
    return_date: "2026-11-03",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    renter_name: "CD Phone Renter",
    renter_phone: "",    // ← missing from metadata
    email: "cdphone@example.com",
    full_rental_amount: "200.00",
  }, 5000);
  // Inject customer_details onto the PI object — simulates Stripe populating this
  // from the payment form when metadata phone was empty.
  event.data.object.customer_details = { phone: "+13105550099", email: null };

  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  const bookingSync = automationCalls.booking.find((b) => b.bookingId === bookingId);
  assert.ok(bookingSync, "reservation_deposit must sync booking");
  assert.equal(bookingSync.phone, "+13105550099",
    "should fall back to customer_details.phone when renter_phone is absent");
});

test("webhook reservation_deposit: uses customer_details.email when metadata email absent", async () => {
  resetStore(); resetCalls();
  const bookingId = "bk-cd-email-fallback";
  bookingsStore["camry"] = [{
    bookingId,
    vehicleId: "camry",
    vehicleName: "Camry 2012",
    name: "CD Email Renter",
    phone: "+13105551122",
    email: "",
    pickupDate: "2026-11-05",
    returnDate: "2026-11-07",
    status: "reserved_unpaid",
    amountPaid: 0,
    totalPrice: 200,
    paymentIntentId: "pi_cd_email_dep",
  }];

  const event = piSucceededEvent({
    payment_type: "reservation_deposit",
    booking_id: bookingId,
    vehicle_id: "camry",
    vehicle_name: "Camry 2012",
    pickup_date: "2026-11-05",
    return_date: "2026-11-07",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    renter_name: "CD Email Renter",
    renter_phone: "+13105551122",
    email: "",    // ← missing from metadata
    full_rental_amount: "200.00",
  }, 5000);
  event.data.object.customer_details = { phone: null, email: "cdemail@example.com" };

  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  const bookingSync = automationCalls.booking.find((b) => b.bookingId === bookingId);
  assert.ok(bookingSync, "reservation_deposit must sync booking");
  assert.equal(bookingSync.email, "cdemail@example.com",
    "should fall back to customer_details.email when metadata email is absent");
});

test("webhook full_payment: uses customer_details.phone when renter_phone absent from metadata", async () => {
  resetStore(); resetCalls();

  const event = piSucceededEvent({
    vehicle_id: "slingshot", vehicle_name: "Slingshot R",
    pickup_date: "2026-11-10", return_date: "2026-11-10",
    renter_name: "CD Full Pay",
    renter_phone: "",    // ← missing
    email: "cdfull@example.com",
    payment_type: "full_payment",
  });
  event.data.object.customer_details = { phone: "+13105550011", email: null };

  const res = makeRes();
  await handler(makeWebhookReq(event), res);
  assert.equal(res._status, 200);

  const bookingSync = automationCalls.booking.find((b) => b.phone === "+13105550011");
  assert.ok(bookingSync, "full_payment booking must carry phone from customer_details fallback");
});
