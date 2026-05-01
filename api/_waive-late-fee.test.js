// api/_waive-late-fee.test.js
// Tests for POST /api/waive-late-fee — admin late-fee waiver endpoint.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ──────────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-admin-secret-waive";

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

// ─── Shared Supabase mock state ───────────────────────────────────────────────

let sbClient = null;

// ─── Mock modules ─────────────────────────────────────────────────────────────

mock.module("./_admin-auth.js", {
  namedExports: {
    isAdminAuthorized: (supplied) => supplied === process.env.ADMIN_SECRET,
  },
});

mock.module("./_supabase.js", {
  namedExports: { getSupabaseAdmin: () => sbClient },
});

let auditCalls = [];
mock.module("./_booking-automation.js", {
  namedExports: {
    writeAuditLog: async (bookingRef, changes, changedBy) => {
      auditCalls.push({ bookingRef, changes, changedBy });
    },
  },
});

const { default: handler } = await import("./waive-late-fee.js");

// ─── Supabase client builder ──────────────────────────────────────────────────

function makeSupabaseClient({ bookingRow = null, bookingError = null, updateError = null, insertError = null } = {}) {
  return {
    from(table) {
      const ctx = { table };
      const chain = {
        select()     { return this; },
        eq()         { return this; },
        update(data) { ctx.updateData = data; return this; },
        insert(data) { ctx.insertData = data; return this; },
        async maybeSingle() {
          if (ctx.table === "bookings") {
            return { data: bookingRow, error: bookingError };
          }
          return { data: null, error: null };
        },
        async then(resolve) {
          if (ctx.table === "bookings" && ctx.updateData) {
            return resolve({ data: null, error: updateError });
          }
          if (ctx.table === "revenue_records" && ctx.insertData) {
            return resolve({ data: null, error: insertError });
          }
          return resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}

function reset() {
  auditCalls.length = 0;
  sbClient = null;
}

function makeBookingRow(overrides = {}) {
  return {
    id:                     1,
    booking_ref:            "bk-test-001",
    vehicle_id:             "camry",
    return_time:            "17:00:00",
    status:                 "active_rental",
    late_fee_waived:        false,
    late_fee_waived_amount: 0,
    late_fee_waived_reason: null,
    late_fee_waived_by:     null,
    late_fee_waived_at:     null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("waive-late-fee: 405 for non-POST methods", async () => {
  reset();
  const req = { method: "GET", headers: {}, body: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("waive-late-fee: 200 OPTIONS preflight returns 200", async () => {
  reset();
  const req = { method: "OPTIONS", headers: { origin: "https://www.slytrans.com" }, body: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("waive-late-fee: 401 when admin secret is wrong", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: "wrong-secret", booking_id: "bk-test-001", waiver_type: "full", reason: "emergency" }), res);
  assert.equal(res._status, 401);
});

test("waive-late-fee: 400 when booking_id is missing", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: process.env.ADMIN_SECRET, waiver_type: "full", reason: "emergency" }), res);
  assert.equal(res._status, 400);
});

test("waive-late-fee: 400 when waiver_type is invalid", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: process.env.ADMIN_SECRET, booking_id: "bk-test-001", waiver_type: "none", reason: "emergency" }), res);
  assert.equal(res._status, 400);
});

test("waive-late-fee: 400 when reason is missing", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: process.env.ADMIN_SECRET, booking_id: "bk-test-001", waiver_type: "full", reason: "" }), res);
  assert.equal(res._status, 400);
  assert.ok(res._body?.error?.toLowerCase().includes("reason"), "error must mention reason");
});

test("waive-late-fee: 400 when reason is whitespace only", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: process.env.ADMIN_SECRET, booking_id: "bk-test-001", waiver_type: "full", reason: "   " }), res);
  assert.equal(res._status, 400);
});

test("waive-late-fee: 503 when Supabase is unavailable", async () => {
  reset();
  sbClient = null;
  const res = makeRes();
  await handler(makeReq({ secret: process.env.ADMIN_SECRET, booking_id: "bk-test-001", waiver_type: "full", reason: "accident" }), res);
  assert.equal(res._status, 503);
});

test("waive-late-fee: 404 when booking is not found", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: null });
  const res = makeRes();
  await handler(makeReq({ secret: process.env.ADMIN_SECRET, booking_id: "bk-missing", waiver_type: "full", reason: "accident" }), res);
  assert.equal(res._status, 404);
});

test("waive-late-fee: 200 full waiver sets waived_amount = 35 (max late fee)", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:      process.env.ADMIN_SECRET,
    booking_id:  "bk-test-001",
    waiver_type: "full",
    reason:      "accident",
  }), res);

  assert.equal(res._status, 200, "must return 200");
  assert.equal(res._body.success, true);
  assert.equal(res._body.waiver_type, "full");
  // full waiver = EXTENDED_LATE_FEE = 35
  assert.equal(res._body.waived_amount, 35);
  assert.equal(res._body.new_late_fee,  0, "new_late_fee must be 0 after full waiver");
  assert.equal(res._body.booking_ref,   "bk-test-001");
  assert.ok(res._body.applied_at, "applied_at must be set");
});

test("waive-late-fee: 200 partial waiver returns correct amounts", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    waiver_type:   "partial",
    waived_amount: 10,
    reason:        "emergency",
    waived_by:     "alice-admin",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.waived_amount, 10);
  // new_late_fee = max(0, 35 - 10) = 25
  assert.equal(res._body.new_late_fee, 25);
  assert.equal(res._body.applied_by, "alice-admin");
});

test("waive-late-fee: 400 partial waiver requires positive waived_amount", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    waiver_type:   "partial",
    waived_amount: 0,
    reason:        "emergency",
  }), res);
  assert.equal(res._status, 400);
});

test("waive-late-fee: 200 partial waiver with large amount is allowed (no cap)", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    waiver_type:   "partial",
    waived_amount: 100,  // no longer capped — any positive amount is valid
    reason:        "goodwill",
  }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.waived_amount, 100);
});

test("waive-late-fee: audit log is written with correct fields", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:      process.env.ADMIN_SECRET,
    booking_id:  "bk-test-001",
    waiver_type: "full",
    reason:      "road accident",
    waived_by:   "bob-manager",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(auditCalls.length, 1, "writeAuditLog must be called once");

  const call = auditCalls[0];
  assert.equal(call.bookingRef, "bk-test-001");
  assert.equal(call.changedBy, "bob-manager");

  const waivedField = call.changes.find((c) => c.field === "late_fee_waived");
  assert.ok(waivedField, "audit log must include late_fee_waived field");
  assert.equal(waivedField.newValue, "true");

  const amountField = call.changes.find((c) => c.field === "late_fee_waived_amount");
  assert.ok(amountField, "audit log must include late_fee_waived_amount field");
  assert.equal(amountField.newValue, "35");

  const reasonField = call.changes.find((c) => c.field === "late_fee_waived_reason");
  assert.ok(reasonField, "audit log must include late_fee_waived_reason field");
  assert.equal(reasonField.newValue, "road accident");
});

test("waive-late-fee: is_update=true when replacing existing waiver", async () => {
  reset();
  // Simulate a booking that already has a waiver applied.
  sbClient = makeSupabaseClient({
    bookingRow: makeBookingRow({
      late_fee_waived:        true,
      late_fee_waived_amount: 25,
      late_fee_waived_reason: "first reason",
      late_fee_waived_by:     "prev-admin",
    }),
  });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    waiver_type:   "partial",
    waived_amount: 15,
    reason:        "updated reason",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.is_update, true, "is_update must be true when replacing an existing waiver");
  assert.equal(res._body.waived_amount, 15, "new waived_amount must be 15");

  // Audit log old values should reflect the previous waiver.
  const amountField = auditCalls[0]?.changes.find((c) => c.field === "late_fee_waived_amount");
  assert.ok(amountField, "audit log must include amount field");
  assert.equal(amountField.oldValue, "25", "old value should be the previous waived amount");
  assert.equal(amountField.newValue, "15", "new value should be the new waived amount");
});

test("waive-late-fee: defaults waived_by to 'admin' when not supplied", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:      process.env.ADMIN_SECRET,
    booking_id:  "bk-test-001",
    waiver_type: "full",
    reason:      "test",
    // waived_by intentionally omitted
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.applied_by, "admin");
});

// ── Lookup action ──────────────────────────────────────────────────────────────

test("waive-late-fee: action=lookup returns booking details without applying waiver", async () => {
  reset();
  sbClient = makeSupabaseClient({
    bookingRow: makeBookingRow({
      customer_name:     "Jane Renter",
      pickup_date:       "2026-05-01",
      return_date:       "2026-05-05",
      total_price:       275,
      deposit_paid:      75,
      remaining_balance: 200,
    }),
  });
  const res = makeRes();
  await handler(makeReq({
    secret:     process.env.ADMIN_SECRET,
    booking_id: "bk-test-001",
    action:     "lookup",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.customer_name,    "Jane Renter");
  assert.equal(res._body.total_price,      275);
  assert.equal(res._body.remaining_balance, 200);
  assert.equal(res._body.late_fee_waived,  false);
  // no reason required for lookup
  assert.equal(auditCalls.length, 0, "lookup must not write audit log");
});

// ── fee_type: rental_balance ───────────────────────────────────────────────────

test("waive-late-fee: fee_type=rental_balance full waiver zeros remaining_balance", async () => {
  reset();
  sbClient = makeSupabaseClient({
    bookingRow: makeBookingRow({ remaining_balance: 150 }),
  });
  const res = makeRes();
  await handler(makeReq({
    secret:      process.env.ADMIN_SECRET,
    booking_id:  "bk-test-001",
    fee_type:    "rental_balance",
    waiver_type: "full",
    reason:      "financial hardship",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.fee_type,                     "rental_balance");
  assert.equal(res._body.rental_balance_waived_amount, 150);
  assert.equal(res._body.new_remaining_balance,        0);
  assert.equal(res._body.late_fee_waived_amount,       null, "late fee untouched");
  assert.equal(auditCalls.length, 1);
  const rentalField = auditCalls[0].changes.find((c) => c.field === "rental_balance_waived");
  assert.ok(rentalField, "audit log must include rental_balance_waived");
  assert.equal(rentalField.newValue, "true");
});

test("waive-late-fee: fee_type=rental_balance partial waiver reduces remaining_balance", async () => {
  reset();
  sbClient = makeSupabaseClient({
    bookingRow: makeBookingRow({ remaining_balance: 200 }),
  });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    fee_type:      "rental_balance",
    waiver_type:   "partial",
    waived_amount: 50,
    reason:        "courtesy discount",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.rental_balance_waived_amount, 50);
  assert.equal(res._body.new_remaining_balance,        150);
});

test("waive-late-fee: fee_type=rental_balance partial requires positive amount", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    fee_type:      "rental_balance",
    waiver_type:   "partial",
    waived_amount: -5,
    reason:        "test",
  }), res);
  assert.equal(res._status, 400);
});

// ── fee_type: all_fees ────────────────────────────────────────────────────────

test("waive-late-fee: fee_type=all_fees waives both late fee and remaining balance", async () => {
  reset();
  sbClient = makeSupabaseClient({
    bookingRow: makeBookingRow({ remaining_balance: 120 }),
  });
  const res = makeRes();
  await handler(makeReq({
    secret:      process.env.ADMIN_SECRET,
    booking_id:  "bk-test-001",
    fee_type:    "all_fees",
    reason:      "full courtesy waiver",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.fee_type,                     "all_fees");
  assert.equal(res._body.waiver_type,                  "full");
  assert.equal(res._body.late_fee_waived_amount,       35, "late fee = EXTENDED_LATE_FEE");
  assert.equal(res._body.rental_balance_waived_amount, 120);
  assert.equal(res._body.new_late_fee,                 0);
  assert.equal(res._body.new_remaining_balance,        0);
  assert.equal(res._body.total_waived,                 155);
  assert.equal(auditCalls.length, 1);
  const lateField   = auditCalls[0].changes.find((c) => c.field === "late_fee_waived");
  const rentalField = auditCalls[0].changes.find((c) => c.field === "rental_balance_waived");
  assert.ok(lateField,   "audit log must include late_fee_waived");
  assert.ok(rentalField, "audit log must include rental_balance_waived");
});

test("waive-late-fee: fee_type=all_fees ignores any provided waiver_type and waived_amount", async () => {
  reset();
  sbClient = makeSupabaseClient({
    bookingRow: makeBookingRow({ remaining_balance: 80 }),
  });
  const res = makeRes();
  await handler(makeReq({
    secret:        process.env.ADMIN_SECRET,
    booking_id:    "bk-test-001",
    fee_type:      "all_fees",
    waiver_type:   "partial",   // should be overridden to "full"
    waived_amount: 10,          // should be ignored
    reason:        "admin override",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.waiver_type, "full", "all_fees always forces full waiver");
});

// ── fee_type validation ───────────────────────────────────────────────────────

test("waive-late-fee: 400 for unknown fee_type", async () => {
  reset();
  sbClient = makeSupabaseClient({ bookingRow: makeBookingRow() });
  const res = makeRes();
  await handler(makeReq({
    secret:      process.env.ADMIN_SECRET,
    booking_id:  "bk-test-001",
    fee_type:    "unknown",
    waiver_type: "full",
    reason:      "test",
  }), res);
  assert.equal(res._status, 400);
});
