// api/_ensure-blocked-date.test.js
// Unit tests for ensureBlockedDate() in _booking-automation.js.
//
// Validates:
//  1. Returns {created:false, reason:"already_exists"} when a blocked_dates row already exists
//  2. Creates a new row and returns {created:true} when no row exists
//  3. Returns {created:false, reason:"missing_args"} when required args are absent
//  4. Returns {created:false, reason:"no_supabase"} when Supabase is not configured
//  5. Handles find errors gracefully
//
// Run with: npm test

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Shared mock state ────────────────────────────────────────────────────────

const sbState = {
  existingRow:   null,   // returned by maybySingle — null means no row found
  findError:     null,
  upsertError:   null,
  updateError:   null,
  upsertCalls:   [],
  updateCalls:   [],
  configured:    true,
};

function resetSbState(overrides = {}) {
  sbState.existingRow = null;
  sbState.findError   = null;
  sbState.upsertError = null;
  sbState.updateError = null;
  sbState.upsertCalls = [];
  sbState.updateCalls = [];
  sbState.configured  = true;
  Object.assign(sbState, overrides);
}

/** Minimal chainable Supabase mock. */
function makeSupabase() {
  function chain() {
    const c = {
      _upsertPayload: null,
      _upsertOptions: null,
      from:          () => c,
      select:        () => c,
      eq:            () => c,
      is:            () => c,
      in:            () => c,
      gte:           () => c,
      maybeSingle:   () => Promise.resolve({
        data: sbState.existingRow,
        error: sbState.findError ? { message: sbState.findError } : null,
      }),
      upsert: (payload, opts) => {
        sbState.upsertCalls.push({ payload, opts });
        return Promise.resolve({ error: sbState.upsertError ? { message: sbState.upsertError } : null });
      },
      update: (payload) => {
        sbState.updateCalls.push({ payload });
        return {
          eq: () => Promise.resolve({ error: sbState.updateError ? { message: sbState.updateError } : null }),
        };
      },
    };
    return c;
  }
  // from() must return a fresh chain each time since Supabase queries are chained
  return { from: () => chain() };
}

// ─── Module mock ──────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => sbState.configured ? makeSupabase() : null,
  },
});

// These modules are imported by _booking-automation.js; provide stubs so the
// test environment doesn't try to load real implementations.
mock.module("./_bookings.js", {
  namedExports: {
    updateBooking:   async () => {},
    normalizePhone:  (p) => p,
  },
});
mock.module("./_settings.js", {
  namedExports: {
    loadBooleanSetting: async () => false,
  },
});
mock.module("./_vehicle-id.js", {
  namedExports: {
    normalizeVehicleId: (id) => id || "",
  },
});
mock.module("./_time.js", {
  namedExports: {
    buildDateTimeLA:    (date, time) => {
      // Minimal: parse "YYYY-MM-DDTHH:MM:SS" as UTC for test purposes
      const dt = new Date(`${date}T${time || "00:00"}:00Z`);
      return dt;
    },
    DEFAULT_RETURN_TIME:    "10:00",
    DEFAULT_RETURN_TIME_PG: "10:00:00",
    normalizeClockTime:     (t) => t || null,
  },
});

const { ensureBlockedDate } = await import("./_booking-automation.js");

// ─── Tests ────────────────────────────────────────────────────────────────────

test("ensureBlockedDate: returns {created:false, reason:'already_exists'} when row exists with end_time set", async () => {
  resetSbState({ existingRow: { id: "existing-uuid", end_time: "12:00:00" } });

  const result = await ensureBlockedDate("camry", "bk-test-001", "2026-04-30", "18:00", "2026-04-27");

  assert.equal(result.created, false);
  assert.equal(result.reason, "already_exists");
  assert.equal(sbState.upsertCalls.length, 0, "should not attempt upsert when row already exists");
  assert.equal(sbState.updateCalls.length, 0, "should not attempt update when end_time is already set");
});

test("ensureBlockedDate: patches end_time when row exists with null end_time and returnTime is provided", async () => {
  resetSbState({ existingRow: { id: "existing-uuid", end_time: null } });

  const result = await ensureBlockedDate("camry", "bk-test-001b", "2026-04-30", "18:00", "2026-04-27");

  assert.equal(result.created, false);
  assert.equal(result.reason, "end_time_patched");
  assert.equal(sbState.upsertCalls.length, 0, "should not upsert when patching");
  assert.equal(sbState.updateCalls.length, 1, "should call update to patch end_time");
  const updatePayload = sbState.updateCalls[0]?.payload;
  assert.ok(updatePayload?.end_time, "update payload should include end_time");
});

test("ensureBlockedDate: returns already_exists when row has null end_time but no returnTime to patch with", async () => {
  resetSbState({ existingRow: { id: "existing-uuid", end_time: null } });

  const result = await ensureBlockedDate("camry", "bk-test-001c", "2026-04-30", null, "2026-04-27");

  assert.equal(result.created, false);
  assert.equal(result.reason, "already_exists");
  assert.equal(sbState.updateCalls.length, 0, "should not update when returnTime is absent");
});

test("ensureBlockedDate: creates row and returns {created:true} when no row found", async () => {
  resetSbState({ existingRow: null });

  const result = await ensureBlockedDate("camry", "bk-test-002", "2026-04-30", "18:00", "2026-04-27");

  assert.equal(result.created, true);
  assert.equal(result.reason, "missing_row_recreated");
  assert.ok(sbState.upsertCalls.length > 0, "should call upsert to create the row");
});

test("ensureBlockedDate: creates row without returnTime (date-only block)", async () => {
  resetSbState({ existingRow: null });

  const result = await ensureBlockedDate("camry", "bk-test-003", "2026-04-30", null, "2026-04-27");

  assert.equal(result.created, true);
  // Without returnTime, no end_time should be set in the upsert payload.
  const payload = sbState.upsertCalls[0]?.payload;
  assert.ok(payload, "upsert should have been called");
  assert.equal(payload.end_time, undefined, "end_time should not be set when returnTime is absent");
});

test("ensureBlockedDate: returns {created:false, reason:'missing_args'} when vehicleId is absent", async () => {
  resetSbState();

  const result = await ensureBlockedDate("", "bk-test-004", "2026-04-30");

  assert.equal(result.created, false);
  assert.equal(result.reason, "missing_args");
  assert.equal(sbState.upsertCalls.length, 0);
});

test("ensureBlockedDate: returns {created:false, reason:'missing_args'} when bookingRef is absent", async () => {
  resetSbState();

  const result = await ensureBlockedDate("camry", "", "2026-04-30");

  assert.equal(result.created, false);
  assert.equal(result.reason, "missing_args");
});

test("ensureBlockedDate: returns {created:false, reason:'missing_args'} when returnDate is absent", async () => {
  resetSbState();

  const result = await ensureBlockedDate("camry", "bk-test-006", "");

  assert.equal(result.created, false);
  assert.equal(result.reason, "missing_args");
});

test("ensureBlockedDate: returns {created:false, reason:'no_supabase'} when Supabase is not configured", async () => {
  resetSbState({ configured: false });

  const result = await ensureBlockedDate("camry", "bk-test-007", "2026-04-30", "18:00");

  assert.equal(result.created, false);
  assert.equal(result.reason, "no_supabase");
});

test("ensureBlockedDate: handles find error gracefully without throwing", async () => {
  resetSbState({ findError: "connection refused" });

  const result = await ensureBlockedDate("camry", "bk-test-008", "2026-04-30", "18:00");

  assert.equal(result.created, false);
  assert.equal(result.reason, "find_error");
  assert.equal(sbState.upsertCalls.length, 0, "should not attempt upsert after find error");
});

test("ensureBlockedDate: falls back to returnDate as startDate when startDate is omitted", async () => {
  resetSbState({ existingRow: null });

  // Pass no startDate
  const result = await ensureBlockedDate("camry", "bk-test-009", "2026-04-30", "18:00");

  assert.equal(result.created, true);
  const payload = sbState.upsertCalls[0]?.payload;
  assert.ok(payload, "upsert should have been called");
  assert.equal(payload.start_date, "2026-04-30", "start_date should fall back to returnDate");
});
