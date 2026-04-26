// api/_sms-scoring.test.js
// Unit tests for the dynamic SMS scoring engine (_sms-scoring.js).
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_THRESHOLD,
  CRITICAL_SCORE,
  PROXIMITY_SUPPRESS_MIN,
  DAILY_SMS_CAP,
  LOOKBACK_WINDOW_MS,
  RETURN_RELATED_KEYS,
  computeUrgencyScore,
  computeContextScore,
  computeTimeProximityScore,
  computeAntiSpamPenalty,
  computeSmsScore,
  computeSmsScoreWithBreakdown,
  computeEffectiveThreshold,
  isSuppressedByProximity,
  selectTopCandidate,
  buildSmsContext,
  fetchRecentSmsLogs,
} from "./_sms-scoring.js";
import { TIME_CRITICAL_KEYS, PRIORITY } from "./_sms-priority.js";

// ── Constants ─────────────────────────────────────────────────────────────────

test("SCORE_THRESHOLD is 40", () => {
  assert.equal(SCORE_THRESHOLD, 40);
});

test("CRITICAL_SCORE is 100", () => {
  assert.equal(CRITICAL_SCORE, 100);
});

test("PROXIMITY_SUPPRESS_MIN is 60", () => {
  assert.equal(PROXIMITY_SUPPRESS_MIN, 60);
});

test("DAILY_SMS_CAP is 3", () => {
  assert.equal(DAILY_SMS_CAP, 3);
});

test("LOOKBACK_WINDOW_MS is 24 hours in milliseconds", () => {
  assert.equal(LOOKBACK_WINDOW_MS, 24 * 3_600_000);
});

test("RETURN_RELATED_KEYS includes all TIME_CRITICAL_KEYS", () => {
  for (const key of TIME_CRITICAL_KEYS) {
    assert.ok(RETURN_RELATED_KEYS.has(key), `Expected "${key}" in RETURN_RELATED_KEYS`);
  }
});

test("RETURN_RELATED_KEYS includes active_rental_1h_before_end", () => {
  assert.ok(RETURN_RELATED_KEYS.has("active_rental_1h_before_end"));
});

test("RETURN_RELATED_KEYS does NOT include non-return keys", () => {
  for (const key of ["OIL_CHECK_REQUEST", "maint_oil_warn", "post_thank_you", "pickup_24h"]) {
    assert.ok(!RETURN_RELATED_KEYS.has(key), `Did not expect "${key}" in RETURN_RELATED_KEYS`);
  }
});

// ── computeUrgencyScore ───────────────────────────────────────────────────────

test("computeUrgencyScore: late_fee_pending returns 50", () => {
  assert.equal(computeUrgencyScore("late_fee_pending"), 50);
});

test("computeUrgencyScore: late_grace_expired returns 50", () => {
  assert.equal(computeUrgencyScore("late_grace_expired"), 50);
});

test("computeUrgencyScore: late_at_return returns 45", () => {
  assert.equal(computeUrgencyScore("late_at_return"), 45);
});

test("computeUrgencyScore: maint_oil_urgent returns 45", () => {
  assert.equal(computeUrgencyScore("maint_oil_urgent"), 45);
});

test("computeUrgencyScore: OIL_CHECK_REQUEST returns 32", () => {
  assert.equal(computeUrgencyScore("OIL_CHECK_REQUEST"), 32);
});

test("computeUrgencyScore: active_rental_1h_before_end returns 36", () => {
  assert.equal(computeUrgencyScore("active_rental_1h_before_end"), 36);
});

test("computeUrgencyScore: post_thank_you returns 15", () => {
  assert.equal(computeUrgencyScore("post_thank_you"), 15);
});

test("computeUrgencyScore: retention_7d returns 8", () => {
  assert.equal(computeUrgencyScore("retention_7d"), 8);
});

test("computeUrgencyScore: unknown key returns 25 (default)", () => {
  assert.equal(computeUrgencyScore("unknown_template_xyz"), 25);
  assert.equal(computeUrgencyScore(""), 25);
});

test("computeUrgencyScore: all mapped keys return values in range 1–50", () => {
  const keys = [
    "late_fee_pending", "late_grace_expired", "late_at_return", "maint_oil_urgent",
    "late_warning_30min", "maint_brakes_urgent", "OIL_CHECK_FINAL",
    "maint_tires_urgent", "MAINTENANCE_AVAILABILITY_URGENT", "OIL_CHECK_REMINDER",
    "unpaid_final", "active_rental_1h_before_end", "pickup_24h", "unpaid_2h",
    "maint_oil_warn", "OIL_CHECK_REQUEST", "OIL_CHECK_MERGED",
    "MAINTENANCE_AVAILABILITY_REQUEST", "maint_brakes_warn", "maint_tires_warn",
    "HIGH_DAILY_MILEAGE", "post_thank_you", "retention_7d",
  ];
  for (const key of keys) {
    const score = computeUrgencyScore(key);
    assert.ok(score >= 1 && score <= 50, `Urgency score for "${key}" = ${score} out of range 1–50`);
  }
});

// ── computeContextScore ───────────────────────────────────────────────────────

test("computeContextScore: late_fee_pending returns 20", () => {
  assert.equal(computeContextScore("late_fee_pending"), 20);
});

test("computeContextScore: OIL_CHECK_REQUEST returns 14", () => {
  assert.equal(computeContextScore("OIL_CHECK_REQUEST"), 14);
});

test("computeContextScore: retention_7d returns 4 (low relevance)", () => {
  assert.equal(computeContextScore("retention_7d"), 4);
});

test("computeContextScore: unknown key returns 12 (default)", () => {
  assert.equal(computeContextScore("unknown_template_xyz"), 12);
});

test("computeContextScore: all values are in range 1–20", () => {
  const keys = [
    "late_fee_pending", "maint_oil_urgent", "active_rental_1h_before_end",
    "OIL_CHECK_REQUEST", "HIGH_DAILY_MILEAGE", "post_thank_you", "retention_7d",
  ];
  for (const key of keys) {
    const score = computeContextScore(key);
    assert.ok(score >= 1 && score <= 20, `Context score for "${key}" = ${score} out of range 1–20`);
  }
});

// ── computeTimeProximityScore ─────────────────────────────────────────────────

test("computeTimeProximityScore: overdue (minutesToReturn < 0) → 25", () => {
  assert.equal(computeTimeProximityScore({ minutesToReturn: -30 }), 25);
  assert.equal(computeTimeProximityScore({ minutesToReturn: -1 }), 25);
});

test("computeTimeProximityScore: within 1h (≤ 60 min) → 20", () => {
  assert.equal(computeTimeProximityScore({ minutesToReturn: 0 }), 20);
  assert.equal(computeTimeProximityScore({ minutesToReturn: 45 }), 20);
  assert.equal(computeTimeProximityScore({ minutesToReturn: 60 }), 20);
});

test("computeTimeProximityScore: within 2h (61–120 min) → 15", () => {
  assert.equal(computeTimeProximityScore({ minutesToReturn: 61 }), 15);
  assert.equal(computeTimeProximityScore({ minutesToReturn: 120 }), 15);
});

test("computeTimeProximityScore: within 4h (121–240 min) → 10", () => {
  assert.equal(computeTimeProximityScore({ minutesToReturn: 121 }), 10);
  assert.equal(computeTimeProximityScore({ minutesToReturn: 240 }), 10);
});

test("computeTimeProximityScore: within 24h (241–1440 min) → 5", () => {
  assert.equal(computeTimeProximityScore({ minutesToReturn: 241 }), 5);
  assert.equal(computeTimeProximityScore({ minutesToReturn: 1440 }), 5);
});

test("computeTimeProximityScore: beyond 24h → 0", () => {
  assert.equal(computeTimeProximityScore({ minutesToReturn: 1441 }), 0);
  assert.equal(computeTimeProximityScore({ minutesToReturn: 5000 }), 0);
});

test("computeTimeProximityScore: minutesToReturn undefined → 0 base", () => {
  assert.equal(computeTimeProximityScore({}), 0);
});

test("computeTimeProximityScore: recency bonus +3 when minutesSinceLastSms >= 480", () => {
  const base = computeTimeProximityScore({ minutesToReturn: undefined });
  const withBonus = computeTimeProximityScore({ minutesToReturn: undefined, minutesSinceLastSms: 480 });
  assert.equal(base, 0);
  assert.equal(withBonus, 3);
});

test("computeTimeProximityScore: no recency bonus when minutesSinceLastSms < 480", () => {
  assert.equal(computeTimeProximityScore({ minutesSinceLastSms: 479 }), 0);
  assert.equal(computeTimeProximityScore({ minutesSinceLastSms: 30 }), 0);
});

test("computeTimeProximityScore: return value never exceeds 25", () => {
  // overdue (25) + long silence (3) would be 28 without cap
  const score = computeTimeProximityScore({ minutesToReturn: -1, minutesSinceLastSms: 999 });
  assert.equal(score, 25);
});

// ── computeAntiSpamPenalty ────────────────────────────────────────────────────

test("computeAntiSpamPenalty: 0 recent SMS → 0", () => {
  assert.equal(computeAntiSpamPenalty({}), 0);
  assert.equal(computeAntiSpamPenalty({ recentSmsCount24h: 0 }), 0);
});

test("computeAntiSpamPenalty: 1 recent SMS → −5", () => {
  assert.equal(computeAntiSpamPenalty({ recentSmsCount24h: 1 }), -5);
});

test("computeAntiSpamPenalty: 2 recent SMS → −15", () => {
  assert.equal(computeAntiSpamPenalty({ recentSmsCount24h: 2 }), -15);
});

test("computeAntiSpamPenalty: 3+ recent SMS → −30 (DAILY_SMS_CAP reached)", () => {
  assert.equal(computeAntiSpamPenalty({ recentSmsCount24h: 3 }), -30);
  assert.equal(computeAntiSpamPenalty({ recentSmsCount24h: 10 }), -30);
});

test("computeAntiSpamPenalty: burst penalty −15 when last SMS < 30 min", () => {
  const base = computeAntiSpamPenalty({});
  const burst = computeAntiSpamPenalty({ minutesSinceLastSms: 29 });
  assert.equal(base, 0);
  assert.equal(burst, -15);
});

test("computeAntiSpamPenalty: no burst penalty when last SMS >= 30 min", () => {
  assert.equal(computeAntiSpamPenalty({ minutesSinceLastSms: 30 }), 0);
  assert.equal(computeAntiSpamPenalty({ minutesSinceLastSms: 120 }), 0);
});

test("computeAntiSpamPenalty: same-template < 60 min → −30", () => {
  assert.equal(computeAntiSpamPenalty({ sameTemplateRecentMinutes: 59 }), -30);
});

test("computeAntiSpamPenalty: same-template 60–239 min → −20", () => {
  assert.equal(computeAntiSpamPenalty({ sameTemplateRecentMinutes: 60 }), -20);
  assert.equal(computeAntiSpamPenalty({ sameTemplateRecentMinutes: 239 }), -20);
});

test("computeAntiSpamPenalty: same-template 240–479 min → −10", () => {
  assert.equal(computeAntiSpamPenalty({ sameTemplateRecentMinutes: 240 }), -10);
  assert.equal(computeAntiSpamPenalty({ sameTemplateRecentMinutes: 479 }), -10);
});

test("computeAntiSpamPenalty: same-template >= 480 min → 0", () => {
  assert.equal(computeAntiSpamPenalty({ sameTemplateRecentMinutes: 480 }), 0);
});

test("computeAntiSpamPenalty: result never below −30", () => {
  // Worst case: daily cap (−30) + burst (−15) + same-template (−30) = −75 uncapped
  const penalty = computeAntiSpamPenalty({
    recentSmsCount24h:       10,
    minutesSinceLastSms:      5,
    sameTemplateRecentMinutes: 10,
  });
  assert.equal(penalty, -30);
});

// ── computeSmsScore ───────────────────────────────────────────────────────────

test("computeSmsScore: TIME_CRITICAL_KEYS return CRITICAL_SCORE", () => {
  for (const key of TIME_CRITICAL_KEYS) {
    assert.equal(computeSmsScore(key, {}), CRITICAL_SCORE,
      `Expected CRITICAL_SCORE for TIME_CRITICAL_KEY "${key}"`);
  }
});

test("computeSmsScore: CRITICAL priority key returns CRITICAL_SCORE", () => {
  // late_fee_pending is both TIME_CRITICAL and P1 — confirm capped score
  assert.equal(computeSmsScore("late_fee_pending", {}), CRITICAL_SCORE);
});

test("computeSmsScore: OIL_CHECK_REQUEST with no context returns correct base sum", () => {
  // urgency=32, proximity=0, context=14, spam=0  → 46
  const score = computeSmsScore("OIL_CHECK_REQUEST", {});
  assert.equal(score, 46);
});

test("computeSmsScore: OIL_CHECK_REQUEST with return in 2h returns > SCORE_THRESHOLD", () => {
  const score = computeSmsScore("OIL_CHECK_REQUEST", { minutesToReturn: 90 });
  // 32 + 15 + 11 + 0 = 58
  assert.ok(score > SCORE_THRESHOLD, `Expected score ${score} > ${SCORE_THRESHOLD}`);
});

test("computeSmsScore: maint_oil_warn with no context returns > SCORE_THRESHOLD", () => {
  const score = computeSmsScore("maint_oil_warn", {});
  // 32 + 0 + 11 + 0 = 43
  assert.ok(score > SCORE_THRESHOLD, `Expected score ${score} > ${SCORE_THRESHOLD}`);
});

test("computeSmsScore: maint_oil_warn with daily cap hit returns < SCORE_THRESHOLD", () => {
  const score = computeSmsScore("maint_oil_warn", { recentSmsCount24h: 3 });
  // 32 + 0 + 11 − 30 = 13
  assert.ok(score <= SCORE_THRESHOLD, `Expected score ${score} ≤ ${SCORE_THRESHOLD}`);
});

test("computeSmsScore: active_rental_1h_before_end within 1h returns well above threshold", () => {
  const score = computeSmsScore("active_rental_1h_before_end", { minutesToReturn: 50 });
  // near return (50 < 60) + RETURN_RELATED_KEY → anti-spam zeroed
  // 36 + 20 + 16 + 0 = 72
  assert.ok(score > SCORE_THRESHOLD);
  assert.equal(score, 72);
});

test("computeSmsScore: active_rental_1h_before_end near return ignores daily cap (anti-spam exempted)", () => {
  // RETURN_RELATED_KEYS are immune to anti-spam when minutesToReturn < PROXIMITY_SUPPRESS_MIN
  const score = computeSmsScore("active_rental_1h_before_end", {
    minutesToReturn: 50,
    recentSmsCount24h: 3,   // would normally trigger max anti-spam penalty
  });
  // anti-spam zeroed because near return + RETURN_RELATED_KEY: 36 + 20 + 16 + 0 = 72
  assert.ok(score > SCORE_THRESHOLD, `Expected score ${score} > ${SCORE_THRESHOLD}`);
  assert.equal(score, 72);
});

test("computeSmsScore: post_thank_you returns below threshold without proximity", () => {
  const score = computeSmsScore("post_thank_you", {});
  // 15 + 0 + 6 + 0 = 21
  assert.ok(score <= SCORE_THRESHOLD);
});

test("computeSmsScore: maint_oil_urgent returns far above threshold (P2 urgent)", () => {
  const score = computeSmsScore("maint_oil_urgent", {});
  // 45 + 0 + 18 + 0 = 63
  assert.ok(score > SCORE_THRESHOLD);
  assert.equal(score, 63);
});

test("computeSmsScore: score is sum of four components (non-critical key)", () => {
  const templateKey = "pickup_24h";
  const ctx = { minutesToReturn: 1200, recentSmsCount24h: 1 };
  const expectedUrgency   = 35;
  const expectedProximity = 5;    // 1200 > 240 and ≤ 1440 → 5
  const expectedContext   = 14;
  const expectedSpam      = -5;   // 1 recent SMS
  const expected = expectedUrgency + expectedProximity + expectedContext + expectedSpam;
  assert.equal(computeSmsScore(templateKey, ctx), expected);
});

// ── computeSmsScoreWithBreakdown ──────────────────────────────────────────────

test("computeSmsScoreWithBreakdown: returns score and breakdown for normal key", () => {
  const { score, breakdown } = computeSmsScoreWithBreakdown("maint_oil_urgent", {});
  assert.equal(score, 63);  // 45 + 0 + 18 + 0
  assert.equal(breakdown.urgency,   45);
  assert.equal(breakdown.proximity,  0);
  assert.equal(breakdown.context,   18);
  assert.equal(breakdown.spam,       0);
  assert.equal(breakdown.isCritical, false);
});

test("computeSmsScoreWithBreakdown: CRITICAL key returns CRITICAL_SCORE with isCritical=true", () => {
  const { score, breakdown } = computeSmsScoreWithBreakdown("late_fee_pending", {});
  assert.equal(score, CRITICAL_SCORE);
  assert.equal(breakdown.isCritical, true);
  assert.equal(breakdown.urgency, CRITICAL_SCORE);
  assert.equal(breakdown.spam, 0);
});

test("computeSmsScoreWithBreakdown: breakdown components sum to score for non-critical key", () => {
  const ctx = { minutesToReturn: 300, recentSmsCount24h: 1 };
  const { score, breakdown } = computeSmsScoreWithBreakdown("OIL_CHECK_REQUEST", ctx);
  const componentSum = breakdown.urgency + breakdown.proximity + breakdown.context + breakdown.spam;
  assert.equal(score, componentSum);
});

test("computeSmsScoreWithBreakdown: anti-spam zeroed for RETURN_RELATED_KEY near return", () => {
  const { score, breakdown } = computeSmsScoreWithBreakdown("active_rental_1h_before_end", {
    minutesToReturn: 50,
    recentSmsCount24h: 3,  // would normally cause max penalty
  });
  assert.equal(breakdown.spam, 0);
  assert.equal(score, 72);  // 36 + 20 + 16 + 0
});

test("computeSmsScoreWithBreakdown: anti-spam applies for RETURN_RELATED_KEY NOT near return", () => {
  const { breakdown } = computeSmsScoreWithBreakdown("active_rental_1h_before_end", {
    minutesToReturn: 300,   // far from return → anti-spam applies
    recentSmsCount24h: 3,
  });
  assert.equal(breakdown.spam, -30);  // daily cap penalty
});

// ── computeEffectiveThreshold ─────────────────────────────────────────────────

test("computeEffectiveThreshold: near return (< 60 min) → 30", () => {
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 30 }), 30);
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 59 }), 30);
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 0  }), 30);
});

test("computeEffectiveThreshold: approaching return (60–119 min) → 35", () => {
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 60  }), 35);
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 119 }), 35);
});

test("computeEffectiveThreshold: active rental (120–1439 min) → SCORE_THRESHOLD (40)", () => {
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 120  }), SCORE_THRESHOLD);
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 500  }), SCORE_THRESHOLD);
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 1439 }), SCORE_THRESHOLD);
});

test("computeEffectiveThreshold: early rental (≥ 1440 min) → 50", () => {
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 1440 }), 50);
  assert.equal(computeEffectiveThreshold({ minutesToReturn: 5000 }), 50);
});

test("computeEffectiveThreshold: minutesToReturn undefined → SCORE_THRESHOLD (40)", () => {
  assert.equal(computeEffectiveThreshold({}), SCORE_THRESHOLD);
  assert.equal(computeEffectiveThreshold(),   SCORE_THRESHOLD);
});

test("computeEffectiveThreshold: threshold lowers as return approaches", () => {
  const far      = computeEffectiveThreshold({ minutesToReturn: 2000 });
  const mid      = computeEffectiveThreshold({ minutesToReturn: 200  });
  const near     = computeEffectiveThreshold({ minutesToReturn: 45   });
  assert.ok(far > mid,  `Far (${far}) should be stricter than mid (${mid})`);
  assert.ok(mid > near, `Mid (${mid}) should be stricter than near (${near})`);
});

test("computeSmsScore: non-RETURN_RELATED_KEY applies anti-spam even near return", () => {
  // maint_oil_warn is NOT in RETURN_RELATED_KEYS so anti-spam still applies near return
  const score = computeSmsScore("maint_oil_warn", {
    minutesToReturn: 50,
    recentSmsCount24h: 3,
  });
  // 32 + 20 + 14 − 30 = 36 ≤ 40
  assert.ok(score <= SCORE_THRESHOLD, `Expected score ${score} ≤ ${SCORE_THRESHOLD}`);
});

// ── isSuppressedByProximity ───────────────────────────────────────────────────

test("isSuppressedByProximity: minutesToReturn undefined → false (not suppressed)", () => {
  assert.equal(isSuppressedByProximity("maint_oil_warn", {}), false);
});

test("isSuppressedByProximity: minutesToReturn >= PROXIMITY_SUPPRESS_MIN → false", () => {
  assert.equal(isSuppressedByProximity("maint_oil_warn", { minutesToReturn: 60 }), false);
  assert.equal(isSuppressedByProximity("maint_oil_warn", { minutesToReturn: 120 }), false);
});

test("isSuppressedByProximity: non-return-related key < 60 min → true (suppressed)", () => {
  assert.equal(isSuppressedByProximity("maint_oil_warn",   { minutesToReturn: 59 }), true);
  assert.equal(isSuppressedByProximity("OIL_CHECK_REQUEST",{ minutesToReturn: 30 }), true);
  assert.equal(isSuppressedByProximity("maint_brakes_urgent", { minutesToReturn: 10 }), true);
});

test("isSuppressedByProximity: TIME_CRITICAL_KEYS never suppressed", () => {
  for (const key of TIME_CRITICAL_KEYS) {
    assert.equal(isSuppressedByProximity(key, { minutesToReturn: 1 }), false,
      `Expected TIME_CRITICAL_KEY "${key}" not to be suppressed`);
  }
});

test("isSuppressedByProximity: RETURN_RELATED_KEYS never suppressed", () => {
  for (const key of RETURN_RELATED_KEYS) {
    assert.equal(isSuppressedByProximity(key, { minutesToReturn: 1 }), false,
      `Expected RETURN_RELATED_KEY "${key}" not to be suppressed`);
  }
});

test("isSuppressedByProximity: active_rental_1h_before_end is not suppressed at 50 min", () => {
  // Fires at 45–60 min: within proximity window but in RETURN_RELATED_KEYS
  assert.equal(isSuppressedByProximity("active_rental_1h_before_end", { minutesToReturn: 50 }), false);
});

// ── selectTopCandidate ────────────────────────────────────────────────────────

test("selectTopCandidate: empty list returns null", () => {
  assert.equal(selectTopCandidate([]), null);
  assert.equal(selectTopCandidate(null), null);
  assert.equal(selectTopCandidate(undefined), null);
});

test("selectTopCandidate: single candidate below threshold returns null", () => {
  assert.equal(selectTopCandidate([{ templateKey: "retention_7d", score: 20 }]), null);
});

test("selectTopCandidate: single candidate at threshold (score === SCORE_THRESHOLD) returns null", () => {
  assert.equal(selectTopCandidate([{ templateKey: "maint_oil_warn", score: 40 }]), null);
});

test("selectTopCandidate: single candidate above threshold is returned", () => {
  const result = selectTopCandidate([{ templateKey: "maint_oil_warn", score: 43 }]);
  assert.ok(result !== null);
  assert.equal(result.templateKey, "maint_oil_warn");
  assert.equal(result.score, 43);
});

test("selectTopCandidate: CRITICAL (CRITICAL_SCORE) wins over all other candidates", () => {
  const candidates = [
    { templateKey: "OIL_CHECK_REQUEST", score: 70 },
    { templateKey: "late_fee_pending",  score: CRITICAL_SCORE },
    { templateKey: "maint_oil_warn",    score: 55 },
  ];
  const result = selectTopCandidate(candidates);
  assert.equal(result.templateKey, "late_fee_pending");
  assert.equal(result.score, CRITICAL_SCORE);
});

test("selectTopCandidate: highest non-critical score wins when no CRITICAL", () => {
  const candidates = [
    { templateKey: "maint_oil_warn",    score: 43 },
    { templateKey: "maint_oil_urgent",  score: 59 },
    { templateKey: "OIL_CHECK_REQUEST", score: 50 },
  ];
  const result = selectTopCandidate(candidates);
  assert.equal(result.templateKey, "maint_oil_urgent");
  assert.equal(result.score, 59);
});

test("selectTopCandidate: all below threshold returns null", () => {
  const candidates = [
    { templateKey: "retention_7d", score: 7 },
    { templateKey: "post_thank_you", score: 21 },
  ];
  assert.equal(selectTopCandidate(candidates), null);
});

test("selectTopCandidate: multiple CRITICAL picks first (stable sort tie)", () => {
  const candidates = [
    { templateKey: "late_fee_pending",   score: CRITICAL_SCORE },
    { templateKey: "late_grace_expired", score: CRITICAL_SCORE },
  ];
  const result = selectTopCandidate(candidates);
  assert.equal(result.score, CRITICAL_SCORE);
  // Both are valid winners — just verify one of them was picked
  assert.ok(
    result.templateKey === "late_fee_pending" ||
    result.templateKey === "late_grace_expired"
  );
});

test("selectTopCandidate: preserves all original fields on winner", () => {
  const candidate = { templateKey: "maint_oil_urgent", score: 63, template: "TEMPLATE_OBJ", ctx: { minutesToReturn: 300 } };
  const result = selectTopCandidate([candidate]);
  assert.equal(result.template, "TEMPLATE_OBJ");
  assert.deepEqual(result.ctx, { minutesToReturn: 300 });
});

test("selectTopCandidate: uses provided threshold instead of default", () => {
  // Score of 35 is below default SCORE_THRESHOLD=40 but above threshold=30
  const candidates = [{ templateKey: "maint_oil_warn", score: 35 }];
  assert.equal(selectTopCandidate(candidates),      null);   // below default (40)
  assert.ok(selectTopCandidate(candidates, 30) !== null);    // above custom (30)
});

test("selectTopCandidate: CRITICAL_SCORE candidate wins regardless of custom threshold", () => {
  const candidates = [
    { templateKey: "OIL_CHECK_REQUEST", score: 70 },
    { templateKey: "late_fee_pending",  score: CRITICAL_SCORE },
  ];
  // Even with a very high threshold, CRITICAL always wins
  const result = selectTopCandidate(candidates, 99);
  assert.equal(result.templateKey, "late_fee_pending");
});

// ── buildSmsContext ───────────────────────────────────────────────────────────

test("buildSmsContext: empty rows → count=0, times undefined", () => {
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", [], { minutesToReturn: 200 });
  assert.equal(ctx.recentSmsCount24h, 0);
  assert.equal(ctx.minutesSinceLastSms, undefined);
  assert.equal(ctx.sameTemplateRecentMinutes, undefined);
  assert.equal(ctx.minutesToReturn, 200);  // base context preserved
});

test("buildSmsContext: rows present — count and minutesSinceLastSms computed", () => {
  const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const rows = [
    { template_key: "maint_oil_warn", sent_at: twoMinAgo },
  ];
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", rows, {});
  assert.equal(ctx.recentSmsCount24h, 1);
  assert.ok(ctx.minutesSinceLastSms >= 1.9 && ctx.minutesSinceLastSms <= 2.1,
    `minutesSinceLastSms should be ~2, got ${ctx.minutesSinceLastSms}`);
  assert.equal(ctx.sameTemplateRecentMinutes, undefined); // different template
});

test("buildSmsContext: same template found — sameTemplateRecentMinutes computed", () => {
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = [
    { template_key: "OIL_CHECK_REQUEST", sent_at: tenMinAgo },
  ];
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", rows, {});
  assert.ok(ctx.sameTemplateRecentMinutes >= 9.9 && ctx.sameTemplateRecentMinutes <= 10.1,
    `sameTemplateRecentMinutes should be ~10, got ${ctx.sameTemplateRecentMinutes}`);
});

test("buildSmsContext: most recent row used for minutesSinceLastSms", () => {
  // rows are sorted descending by sent_at — first row is most recent
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const tenMinAgo  = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = [
    { template_key: "maint_oil_warn",   sent_at: fiveMinAgo },
    { template_key: "OIL_CHECK_REQUEST",sent_at: tenMinAgo  },
  ];
  const ctx = buildSmsContext("pickup_24h", rows, {});
  assert.equal(ctx.recentSmsCount24h, 2);
  assert.ok(ctx.minutesSinceLastSms < 6,
    `minutesSinceLastSms should be ~5 (most recent), got ${ctx.minutesSinceLastSms}`);
});

test("buildSmsContext: null recentRows treated as empty array", () => {
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", null, {});
  assert.equal(ctx.recentSmsCount24h, 0);
});

test("buildSmsContext: baseCtx fields merged into result", () => {
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", [], {
    minutesToReturn:  300,
    daysSincePickup:    5,
  });
  assert.equal(ctx.minutesToReturn, 300);
  assert.equal(ctx.daysSincePickup, 5);
});

// ── fetchRecentSmsLogs ────────────────────────────────────────────────────────

test("fetchRecentSmsLogs: null Supabase client returns []", async () => {
  const rows = await fetchRecentSmsLogs(null, "bk-test-001");
  assert.deepEqual(rows, []);
});

test("fetchRecentSmsLogs: empty bookingId returns []", async () => {
  const rows = await fetchRecentSmsLogs({}, "");
  assert.deepEqual(rows, []);
});

test("fetchRecentSmsLogs: Supabase query error returns [] (non-fatal)", async () => {
  const sb = buildMockSb(null, new Error("DB offline"));
  const rows = await fetchRecentSmsLogs(sb, "bk-test-001");
  assert.deepEqual(rows, []);
});

test("fetchRecentSmsLogs: returns rows on success", async () => {
  const mockRows = [
    { template_key: "OIL_CHECK_REQUEST", sent_at: new Date().toISOString() },
  ];
  const sb = buildMockSb(mockRows, null);
  const rows = await fetchRecentSmsLogs(sb, "bk-test-001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].template_key, "OIL_CHECK_REQUEST");
});

test("fetchRecentSmsLogs: returns [] when Supabase returns null data", async () => {
  const sb = buildMockSb(null, null);
  const rows = await fetchRecentSmsLogs(sb, "bk-test-001");
  assert.deepEqual(rows, []);
});

// ── End-to-end scoring scenarios ─────────────────────────────────────────────

test("E2E: oil check with no recent activity exceeds threshold", () => {
  const rows = [];
  const baseCtx = { minutesToReturn: 300 };  // 5h to return
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", rows, baseCtx);
  const score = computeSmsScore("OIL_CHECK_REQUEST", ctx);
  // urgency=32 + proximity=10 + context=14 + spam=0 = 56
  assert.ok(score > SCORE_THRESHOLD, `score=${score} should be > ${SCORE_THRESHOLD}`);
});

test("E2E: oil check with 3 recent messages today is suppressed by anti-spam", () => {
  const now = Date.now();
  const rows = [
    { template_key: "maint_oil_warn",   sent_at: new Date(now - 60_000).toISOString() },
    { template_key: "OIL_CHECK_REQUEST",sent_at: new Date(now - 120_000).toISOString() },
    { template_key: "maint_brakes_warn",sent_at: new Date(now - 180_000).toISOString() },
  ];
  const ctx = buildSmsContext("OIL_CHECK_REQUEST", rows, { minutesToReturn: 300 });
  const score = computeSmsScore("OIL_CHECK_REQUEST", ctx);
  // OIL_CHECK_REQUEST NOT in RETURN_RELATED_KEYS, far from return → anti-spam applies
  // 32 + 10 + 14 − 30 (daily cap, capped) = 26 — well below threshold
  assert.ok(score <= SCORE_THRESHOLD, `score=${score} should be ≤ ${SCORE_THRESHOLD}`);
});

test("E2E: maintenance urgent overcomes 2 recent messages (high urgency wins)", () => {
  const now = Date.now();
  const rows = [
    { template_key: "OIL_CHECK_REQUEST", sent_at: new Date(now - 2 * 3_600_000).toISOString() },
    { template_key: "maint_oil_warn",    sent_at: new Date(now - 4 * 3_600_000).toISOString() },
  ];
  const ctx = buildSmsContext("maint_oil_urgent", rows, { minutesToReturn: 240 });
  const score = computeSmsScore("maint_oil_urgent", ctx);
  // urgency=45 + proximity=10 + context=18 − 15 (2 SMS, no burst) = 58
  assert.ok(score > SCORE_THRESHOLD, `score=${score} should be > ${SCORE_THRESHOLD}`);
});

test("E2E: selectTopCandidate picks urgent over warn when both eligible", () => {
  const candidates = [
    { templateKey: "maint_oil_warn",   score: computeSmsScore("maint_oil_warn",   {}) },
    { templateKey: "maint_oil_urgent", score: computeSmsScore("maint_oil_urgent", {}) },
  ];
  const winner = selectTopCandidate(candidates);
  assert.equal(winner.templateKey, "maint_oil_urgent");
});

test("E2E: CRITICAL message selected even when competing against high-scoring P3", () => {
  const candidates = [
    { templateKey: "maint_oil_urgent", score: 63 },
    { templateKey: "late_fee_pending", score: CRITICAL_SCORE },  // CRITICAL
  ];
  const winner = selectTopCandidate(candidates);
  assert.equal(winner.templateKey, "late_fee_pending");
});

test("E2E: dynamic threshold lowers send barrier near return time", () => {
  // A score of 35 is below default threshold (40) but above near-return threshold (30)
  const candidates = [{ templateKey: "maint_oil_warn", score: 35 }];
  const nearCtx     = { minutesToReturn: 45 };
  const threshold   = computeEffectiveThreshold(nearCtx);
  const winner      = selectTopCandidate(candidates, threshold);
  assert.ok(winner !== null, `Expected score 35 to pass near-return threshold ${threshold}`);
});

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Supabase mock that returns `rows`/`error` for any
 * sms_logs query chain:
 *   sb.from("sms_logs").select(...).eq(...).gte(...).order(...)
 */
function buildMockSb(rows, error) {
  const terminal = () => Promise.resolve({ data: rows, error });
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
