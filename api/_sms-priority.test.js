// api/_sms-priority.test.js
// Unit tests for the SMS priority module (_sms-priority.js).
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRIORITY,
  SMS_PRIORITY,
  getSmsPriority,
  TIME_CRITICAL_KEYS,
  checkSmsCooldown,
} from "./_sms-priority.js";

// ─── getSmsPriority ───────────────────────────────────────────────────────────

test("getSmsPriority: returns CRITICAL for late_fee_pending", () => {
  assert.equal(getSmsPriority("late_fee_pending"), PRIORITY.CRITICAL);
});

test("getSmsPriority: returns CRITICAL for late_grace_expired", () => {
  assert.equal(getSmsPriority("late_grace_expired"), PRIORITY.CRITICAL);
});

test("getSmsPriority: returns IMPORTANT for late_at_return", () => {
  assert.equal(getSmsPriority("late_at_return"), PRIORITY.IMPORTANT);
});

test("getSmsPriority: returns IMPORTANT for late_warning_30min", () => {
  assert.equal(getSmsPriority("late_warning_30min"), PRIORITY.IMPORTANT);
});

test("getSmsPriority: returns IMPORTANT for maint_oil_urgent", () => {
  assert.equal(getSmsPriority("maint_oil_urgent"), PRIORITY.IMPORTANT);
});

test("getSmsPriority: returns STANDARD for active_rental_1h_before_end", () => {
  assert.equal(getSmsPriority("active_rental_1h_before_end"), PRIORITY.STANDARD);
});

test("getSmsPriority: returns STANDARD for OIL_CHECK_REQUEST", () => {
  assert.equal(getSmsPriority("OIL_CHECK_REQUEST"), PRIORITY.STANDARD);
});

test("getSmsPriority: returns STANDARD for maint_oil_warn", () => {
  assert.equal(getSmsPriority("maint_oil_warn"), PRIORITY.STANDARD);
});

test("getSmsPriority: returns MARKETING for post_thank_you", () => {
  assert.equal(getSmsPriority("post_thank_you"), PRIORITY.MARKETING);
});

test("getSmsPriority: returns MARKETING for retention_7d", () => {
  assert.equal(getSmsPriority("retention_7d"), PRIORITY.MARKETING);
});

test("getSmsPriority: defaults to STANDARD for unknown keys", () => {
  assert.equal(getSmsPriority("unknown_template_xyz"), PRIORITY.STANDARD);
  assert.equal(getSmsPriority(""), PRIORITY.STANDARD);
});

test("PRIORITY constants form an ordered sequence (CRITICAL < IMPORTANT < STANDARD < MARKETING)", () => {
  assert.ok(PRIORITY.CRITICAL  < PRIORITY.IMPORTANT);
  assert.ok(PRIORITY.IMPORTANT < PRIORITY.STANDARD);
  assert.ok(PRIORITY.STANDARD  < PRIORITY.MARKETING);
});

test("every key in SMS_PRIORITY has a valid numeric priority between 1 and 4", () => {
  for (const [key, p] of Object.entries(SMS_PRIORITY)) {
    assert.ok(
      Number.isInteger(p) && p >= 1 && p <= 4,
      `SMS_PRIORITY["${key}"] = ${p} is not a valid priority (expected 1–4)`
    );
  }
});

// ─── TIME_CRITICAL_KEYS ───────────────────────────────────────────────────────

test("TIME_CRITICAL_KEYS contains all expected return-window keys", () => {
  for (const key of ["late_at_return", "late_warning_30min", "late_grace_expired", "late_fee_pending"]) {
    assert.ok(TIME_CRITICAL_KEYS.has(key), `Expected "${key}" to be in TIME_CRITICAL_KEYS`);
  }
});

test("TIME_CRITICAL_KEYS does NOT contain non-time-critical keys", () => {
  for (const key of ["active_rental_1h_before_end", "OIL_CHECK_REQUEST", "post_thank_you"]) {
    assert.ok(!TIME_CRITICAL_KEYS.has(key), `Did not expect "${key}" in TIME_CRITICAL_KEYS`);
  }
});

// ─── checkSmsCooldown ─────────────────────────────────────────────────────────

test("checkSmsCooldown: always allows TIME_CRITICAL_KEYS regardless of Supabase state", async () => {
  // Simulate Supabase being unavailable (null)
  for (const key of TIME_CRITICAL_KEYS) {
    const result = await checkSmsCooldown(null, "bk-test-001", key);
    assert.equal(result.allowed, true, `Expected TIME_CRITICAL_KEY "${key}" to always be allowed`);
  }
});

test("checkSmsCooldown: allows when Supabase client is null (fails open)", async () => {
  const result = await checkSmsCooldown(null, "bk-test-001", "active_rental_1h_before_end");
  assert.equal(result.allowed, true);
});

test("checkSmsCooldown: allows when bookingId is empty (fails open)", async () => {
  const result = await checkSmsCooldown({}, "", "OIL_CHECK_REQUEST");
  assert.equal(result.allowed, true);
});

test("checkSmsCooldown: allows when sms_logs returns empty array (no recent sends)", async () => {
  const sb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
  };
  const result = await checkSmsCooldown(sb, "bk-test-001", "OIL_CHECK_REQUEST");
  assert.equal(result.allowed, true);
});

test("checkSmsCooldown: blocks P3 message when a P3 message was sent recently (stored in metadata)", async () => {
  const recentRow = {
    template_key: "maint_oil_warn",
    sent_at:      new Date().toISOString(),
    metadata:     { priority: PRIORITY.STANDARD },  // P3
  };
  const sb = buildMockSb([recentRow]);
  const result = await checkSmsCooldown(sb, "bk-test-001", "OIL_CHECK_REQUEST");
  // OIL_CHECK_REQUEST is P3; maint_oil_warn is P3 → sentPriority (3) <= incomingPriority (3) → blocked
  assert.equal(result.allowed, false);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("checkSmsCooldown: blocks P3 message when a P2 message was sent recently", async () => {
  const recentRow = {
    template_key: "late_warning_30min",
    sent_at:      new Date().toISOString(),
    metadata:     { priority: PRIORITY.IMPORTANT },  // P2
  };
  const sb = buildMockSb([recentRow]);
  const result = await checkSmsCooldown(sb, "bk-test-001", "active_rental_1h_before_end");
  // active_rental_1h_before_end is P3; late_warning_30min is P2 → sentPriority (2) <= incomingPriority (3) → blocked
  assert.equal(result.allowed, false);
});

test("checkSmsCooldown: allows P2 message when only a P3 message was sent recently", async () => {
  const recentRow = {
    template_key: "OIL_CHECK_REQUEST",
    sent_at:      new Date().toISOString(),
    metadata:     { priority: PRIORITY.STANDARD },  // P3
  };
  const sb = buildMockSb([recentRow]);
  const result = await checkSmsCooldown(sb, "bk-test-001", "maint_oil_urgent");
  // maint_oil_urgent is P2; OIL_CHECK_REQUEST is P3 → sentPriority (3) > incomingPriority (2) → allowed
  assert.equal(result.allowed, true);
});

test("checkSmsCooldown: allows when Supabase query errors (fails open)", async () => {
  const sb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => Promise.resolve({ data: null, error: new Error("DB offline") }),
          }),
        }),
      }),
    }),
  };
  const result = await checkSmsCooldown(sb, "bk-test-001", "OIL_CHECK_REQUEST");
  assert.equal(result.allowed, true);
});

test("checkSmsCooldown: infers priority from template_key when metadata.priority absent", async () => {
  // Legacy row: no metadata — priority inferred from template_key
  const recentRow = {
    template_key: "late_fee_pending",  // P1
    sent_at:      new Date().toISOString(),
    metadata:     null,
  };
  const sb = buildMockSb([recentRow]);
  const result = await checkSmsCooldown(sb, "bk-test-001", "OIL_CHECK_REQUEST");
  // OIL_CHECK_REQUEST is P3; late_fee_pending inferred as P1 → sentPriority (1) <= incomingPriority (3) → blocked
  assert.equal(result.allowed, false);
});

test("checkSmsCooldown: TIME_CRITICAL_KEYS bypass cooldown even if Supabase has matching rows", async () => {
  const recentRow = {
    template_key: "late_fee_pending",
    sent_at:      new Date().toISOString(),
    metadata:     { priority: PRIORITY.CRITICAL },
  };
  const sb = buildMockSb([recentRow]);
  // late_warning_30min is TIME_CRITICAL — must bypass regardless
  const result = await checkSmsCooldown(sb, "bk-test-001", "late_warning_30min");
  assert.equal(result.allowed, true);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal Supabase client mock that returns `rows` for any
 * sms_logs query.  The chain matches the shape used in checkSmsCooldown:
 *   sb.from("sms_logs").select(...).eq(...).gte(...).order(...)
 */
function buildMockSb(rows) {
  const terminal = () => Promise.resolve({ data: rows, error: null });
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: terminal,
          }),
        }),
      }),
    }),
  };
}
