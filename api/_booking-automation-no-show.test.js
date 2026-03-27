// api/_booking-automation-no-show.test.js
// Unit tests for autoUpsertCustomer with no_show_count tracking.
//
// Validates:
//  1. isNoShow=true increments no_show_count on an existing customer
//  2. isNoShow=false (default) does NOT touch no_show_count
//  3. New customer INSERT with isNoShow=true starts no_show_count at 1
//  4. New customer INSERT with isNoShow=false starts no_show_count at 0
//  5. countStats=true + isNoShow=true both apply together
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Shared mock state ────────────────────────────────────────────────────────

const sbState = {
  existing:    null,   // value returned by .maybeSingle() — null = customer not found
  updateCalls: [],     // recorded .update(values) calls
  insertCalls: [],     // recorded .insert(values) calls
};

function resetSbState(existing = null) {
  sbState.existing    = existing;
  sbState.updateCalls = [];
  sbState.insertCalls = [];
}

/** Build a minimal Supabase mock that captures update/insert calls. */
function makeSupabase() {
  const builder = (table) => {
    const chain = {
      _table: table,
      select:      () => chain,
      eq:          () => chain,
      is:          () => chain,
      maybeSingle: () => Promise.resolve({ data: sbState.existing, error: null }),
      update: (values) => {
        sbState.updateCalls.push({ table, values });
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert: (values) => {
        sbState.insertCalls.push({ table, values });
        return Promise.resolve({ error: null });
      },
    };
    return chain;
  };
  return { from: (table) => builder(table) };
}

// ─── Module mock ─────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => makeSupabase(),
  },
});

const { autoUpsertCustomer } = await import("./_booking-automation.js");

// ─── Test helpers ─────────────────────────────────────────────────────────────

function baseBooking(overrides = {}) {
  return {
    bookingId:  "bk-test-001",
    vehicleId:  "camry",
    name:       "Bob Tester",
    phone:      "+13105550099",
    email:      "bob@example.com",
    pickupDate: "2026-07-01",
    amountPaid: 150,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Existing customer — no_show_count increment
// ═══════════════════════════════════════════════════════════════════════════════

test("autoUpsertCustomer: isNoShow=true increments no_show_count on existing customer", async () => {
  resetSbState({ total_bookings: 3, total_spent: 450, first_booking_date: "2026-01-01", no_show_count: 1 });

  await autoUpsertCustomer(baseBooking(), true, true);

  assert.equal(sbState.updateCalls.length, 1);
  const updates = sbState.updateCalls[0].values;
  assert.equal(updates.no_show_count, 2, "no_show_count should be incremented from 1 to 2");
});

test("autoUpsertCustomer: isNoShow=false does NOT set no_show_count on existing customer", async () => {
  resetSbState({ total_bookings: 3, total_spent: 450, first_booking_date: "2026-01-01", no_show_count: 0 });

  await autoUpsertCustomer(baseBooking(), true, false);

  assert.equal(sbState.updateCalls.length, 1);
  const updates = sbState.updateCalls[0].values;
  assert.equal(updates.no_show_count, undefined, "no_show_count should not be set when isNoShow=false");
});

test("autoUpsertCustomer: isNoShow=false (default) does NOT set no_show_count", async () => {
  resetSbState({ total_bookings: 2, total_spent: 300, first_booking_date: "2026-01-01", no_show_count: 0 });

  await autoUpsertCustomer(baseBooking());   // no isNoShow arg — defaults to false

  assert.equal(sbState.updateCalls.length, 1);
  const updates = sbState.updateCalls[0].values;
  assert.equal(updates.no_show_count, undefined);
});

test("autoUpsertCustomer: isNoShow=true when no_show_count was 0 → sets to 1", async () => {
  resetSbState({ total_bookings: 1, total_spent: 150, first_booking_date: "2026-01-01", no_show_count: 0 });

  await autoUpsertCustomer(baseBooking(), false, true);

  const updates = sbState.updateCalls[0].values;
  assert.equal(updates.no_show_count, 1);
});

test("autoUpsertCustomer: isNoShow=true when no_show_count is missing (null/undefined) → sets to 1", async () => {
  resetSbState({ total_bookings: 1, total_spent: 150, first_booking_date: "2026-01-01", no_show_count: null });

  await autoUpsertCustomer(baseBooking(), false, true);

  const updates = sbState.updateCalls[0].values;
  assert.equal(updates.no_show_count, 1, "null no_show_count should be treated as 0 before incrementing");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. New customer INSERT — no_show_count
// ═══════════════════════════════════════════════════════════════════════════════

test("autoUpsertCustomer: new customer with isNoShow=true → no_show_count=1", async () => {
  resetSbState(null);   // customer not found

  await autoUpsertCustomer(baseBooking(), true, true);

  assert.equal(sbState.insertCalls.length, 1);
  const record = sbState.insertCalls[0].values;
  assert.equal(record.no_show_count, 1);
  assert.equal(record.total_bookings, 1);
});

test("autoUpsertCustomer: new customer with isNoShow=false → no_show_count=0", async () => {
  resetSbState(null);

  await autoUpsertCustomer(baseBooking(), true, false);

  assert.equal(sbState.insertCalls.length, 1);
  const record = sbState.insertCalls[0].values;
  assert.equal(record.no_show_count, 0);
});

test("autoUpsertCustomer: new customer no_show_count=0 when countStats=false and isNoShow=false", async () => {
  resetSbState(null);

  await autoUpsertCustomer(baseBooking(), false, false);

  const record = sbState.insertCalls[0].values;
  assert.equal(record.no_show_count, 0);
  assert.equal(record.total_bookings, 0);
  assert.equal(record.total_spent, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Combined — countStats + isNoShow together
// ═══════════════════════════════════════════════════════════════════════════════

test("autoUpsertCustomer: countStats=true + isNoShow=true both apply on existing customer", async () => {
  resetSbState({ total_bookings: 5, total_spent: 750, first_booking_date: "2026-01-01", no_show_count: 2 });

  await autoUpsertCustomer(baseBooking({ amountPaid: 150 }), true, true);

  const updates = sbState.updateCalls[0].values;
  assert.equal(updates.total_bookings, 6);
  assert.equal(updates.total_spent, 900);
  assert.equal(updates.no_show_count, 3);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Guard: no phone → silent skip
// ═══════════════════════════════════════════════════════════════════════════════

test("autoUpsertCustomer: missing phone is silently skipped", async () => {
  resetSbState(null);

  await autoUpsertCustomer(baseBooking({ phone: "" }), true, true);

  assert.equal(sbState.updateCalls.length, 0);
  assert.equal(sbState.insertCalls.length, 0);
});
