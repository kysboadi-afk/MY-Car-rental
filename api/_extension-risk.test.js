// api/_extension-risk.test.js
// Unit tests for evaluateExtensionRisk and loadExtensionRiskSettings
// exported from _extension-risk.js.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Module mocks ─────────────────────────────────────────────────────────────

let booleanSettings = {};
let numericSettings = {};

mock.module("./_settings.js", {
  namedExports: {
    loadBooleanSetting: async (key, defaultVal) =>
      Object.hasOwn(booleanSettings, key) ? booleanSettings[key] : defaultVal,
    loadNumericSetting: async (key, defaultVal) =>
      Object.hasOwn(numericSettings, key) ? numericSettings[key] : defaultVal,
  },
});

const {
  EXTENSION_RISK_DEFAULTS,
  loadExtensionRiskSettings,
  evaluateExtensionRisk,
} = await import("./_extension-risk.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultRiskSettings(overrides = {}) {
  return { ...EXTENSION_RISK_DEFAULTS, ...overrides };
}

// Builds a chainable Supabase-style stub.
// `tables` maps table name → array of rows returned by that table.
// The `extension_risk_override` value on a bookings row is returned via
// maybeSingle on the bookings table.
function makeSupabase({ bookingOverride = null, partialExts = [] } = {}) {
  return {
    from(table) {
      const ctx = { table, filters: {} };
      const chain = {
        select()    { return this; },
        eq(k, v)    { ctx.filters[k] = v; return this; },
        async maybeSingle() {
          if (ctx.table === "bookings") {
            return { data: { extension_risk_override: bookingOverride }, error: null };
          }
          return { data: null, error: null };
        },
        async then(resolve) {
          if (ctx.table === "booking_extensions") {
            return resolve({ data: partialExts, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

// ── loadExtensionRiskSettings ─────────────────────────────────────────────────

test("loadExtensionRiskSettings: returns defaults when no overrides", async () => {
  booleanSettings = {};
  numericSettings = {};

  const s = await loadExtensionRiskSettings();

  assert.equal(s.extension_partial_block_enabled, true);
  assert.equal(s.extension_max_unpaid_exposure,   500);
  assert.equal(s.extension_max_partial_count,     3);
  assert.equal(s.extension_partial_min_pct,       50);
  assert.equal(s.extension_overdue_block_partial, true);
  assert.equal(s.extension_allow_override,        true);
});

test("loadExtensionRiskSettings: reads numeric overrides from system_settings", async () => {
  booleanSettings = {};
  numericSettings = {
    extension_max_unpaid_exposure: 1000,
    extension_max_partial_count:   5,
    extension_partial_min_pct:     60,
  };

  const s = await loadExtensionRiskSettings();

  assert.equal(s.extension_max_unpaid_exposure, 1000);
  assert.equal(s.extension_max_partial_count,   5);
  assert.equal(s.extension_partial_min_pct,     60);
});

test("loadExtensionRiskSettings: reads boolean overrides from system_settings", async () => {
  booleanSettings = {
    extension_partial_block_enabled: false,
    extension_overdue_block_partial: false,
    extension_allow_override:        false,
  };
  numericSettings = {};

  const s = await loadExtensionRiskSettings();

  assert.equal(s.extension_partial_block_enabled, false);
  assert.equal(s.extension_overdue_block_partial, false);
  assert.equal(s.extension_allow_override,        false);
});

// ── evaluateExtensionRisk: gate disabled ─────────────────────────────────────

test("evaluateExtensionRisk: always allows when extension_partial_block_enabled=false", async () => {
  const settings = defaultRiskSettings({ extension_partial_block_enabled: false });
  const sb = makeSupabase({ partialExts: [{ extension_remaining_balance: 999 }] });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 999, settings);

  assert.equal(result.allowed, true, "gate disabled must allow");
});

// ── evaluateExtensionRisk: no Supabase ────────────────────────────────────────

test("evaluateExtensionRisk: fails open (allows) when Supabase client is null", async () => {
  const settings = defaultRiskSettings();
  const result = await evaluateExtensionRisk(null, "bk-test-001", 200, settings);

  assert.equal(result.allowed, true, "must fail open without Supabase");
});

test("evaluateExtensionRisk: fails open (allows) when bookingRef is missing", async () => {
  const settings = defaultRiskSettings();
  const sb = makeSupabase();
  const result = await evaluateExtensionRisk(sb, "", 200, settings);

  assert.equal(result.allowed, true, "must fail open without bookingRef");
});

// ── evaluateExtensionRisk: admin override ─────────────────────────────────────

test("evaluateExtensionRisk: admin override=allow bypasses all limits", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 100,  // very low limit
    extension_max_partial_count:   1,
  });
  const sb = makeSupabase({
    bookingOverride: "allow",
    partialExts: [
      { extension_remaining_balance: 90 },
      { extension_remaining_balance: 80 }, // 2 partials, exposure=170 — both over limits
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 50, settings);

  assert.equal(result.allowed,      true, "admin allow must bypass limits");
  assert.equal(result.riskOverride, "allow");
});

test("evaluateExtensionRisk: admin override=block always blocks regardless of limits", async () => {
  const settings = defaultRiskSettings();
  const sb = makeSupabase({
    bookingOverride: "block",
    partialExts:     [],  // no partial extensions at all
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 10, settings);

  assert.equal(result.allowed,      false, "admin block must deny");
  assert.equal(result.riskOverride, "block");
  assert.match(String(result.reason), /administrator/i);
});

test("evaluateExtensionRisk: admin override=null proceeds with default evaluation", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 500,
    extension_max_partial_count:   3,
  });
  const sb = makeSupabase({ bookingOverride: null, partialExts: [] });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 100, settings);

  assert.equal(result.allowed,      true);
  assert.equal(result.riskOverride, null);
});

test("evaluateExtensionRisk: admin override check skipped when extension_allow_override=false", async () => {
  // Even if the DB says 'allow', it must be ignored when the feature is disabled.
  const settings = defaultRiskSettings({
    extension_allow_override:      false,
    extension_max_partial_count:   1,
    extension_max_unpaid_exposure: 1000,
  });
  // Two partial extensions already → count limit exceeded.
  const sb = makeSupabase({
    bookingOverride: "allow",   // would bypass if overrides were enabled
    partialExts: [
      { extension_remaining_balance: 50 },
      { extension_remaining_balance: 50 },
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 50, settings);

  assert.equal(result.allowed, false, "override=allow must be ignored when feature is disabled");
  assert.match(String(result.reason), /maximum number/i);
});

// ── evaluateExtensionRisk: partial count limit ────────────────────────────────

test("evaluateExtensionRisk: allows when partial count is below max", async () => {
  const settings = defaultRiskSettings({ extension_max_partial_count: 3 });
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 50 },
      { extension_remaining_balance: 50 },
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 100, settings);

  assert.equal(result.allowed,      true, "2 partials < max 3 must allow");
  assert.equal(result.partialCount, 2);
});

test("evaluateExtensionRisk: blocks when partial count equals max", async () => {
  const settings = defaultRiskSettings({ extension_max_partial_count: 3 });
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 50 },
      { extension_remaining_balance: 50 },
      { extension_remaining_balance: 50 },
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 10, settings);

  assert.equal(result.allowed,      false, "3 partials = max 3 must block");
  assert.equal(result.partialCount, 3);
  assert.match(String(result.reason), /maximum number/i);
});

test("evaluateExtensionRisk: blocks when partial count exceeds max", async () => {
  const settings = defaultRiskSettings({ extension_max_partial_count: 2 });
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 50 },
      { extension_remaining_balance: 50 },
      { extension_remaining_balance: 50 },
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 10, settings);

  assert.equal(result.allowed, false, "3 partials > max 2 must block");
});

// ── evaluateExtensionRisk: unpaid exposure limit ──────────────────────────────

test("evaluateExtensionRisk: allows when total exposure after new extension is within limit", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 500,
    extension_max_partial_count:   5,
  });
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 200 },
      { extension_remaining_balance: 150 },
    ],
  });

  // existing exposure = 350, new = 100 → total = 450 ≤ 500 → allowed
  const result = await evaluateExtensionRisk(sb, "bk-test-001", 100, settings);

  assert.equal(result.allowed,        true);
  assert.equal(result.exposureAmount, 350);
});

test("evaluateExtensionRisk: blocks when total exposure after new extension exceeds limit", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 500,
    extension_max_partial_count:   5,
  });
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 200 },
      { extension_remaining_balance: 200 },
    ],
  });

  // existing exposure = 400, new = 150 → total = 550 > 500 → blocked
  const result = await evaluateExtensionRisk(sb, "bk-test-001", 150, settings);

  assert.equal(result.allowed, false, "total exposure 550 > 500 must block");
  assert.match(String(result.reason), /unpaid.*balance|balance.*unpaid|limit/i);
});

test("evaluateExtensionRisk: blocks at exact exposure limit boundary", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 300,
    extension_max_partial_count:   5,
  });
  const sb = makeSupabase({
    partialExts: [{ extension_remaining_balance: 200 }],
  });

  // 200 + 101 = 301 > 300 → blocked
  const result = await evaluateExtensionRisk(sb, "bk-test-001", 101, settings);
  assert.equal(result.allowed, false, "exposure 301 > limit 300 must block");
});

test("evaluateExtensionRisk: allows at exactly the exposure limit", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 300,
    extension_max_partial_count:   5,
  });
  const sb = makeSupabase({
    partialExts: [{ extension_remaining_balance: 200 }],
  });

  // 200 + 100 = 300 = 300 → allowed (≤ not >)
  const result = await evaluateExtensionRisk(sb, "bk-test-001", 100, settings);
  assert.equal(result.allowed, true, "exposure exactly at limit must allow");
});

// ── evaluateExtensionRisk: zero exposure (full payment) ──────────────────────

test("evaluateExtensionRisk: full payment (proposedNewExposure=0) always passes exposure check", async () => {
  const settings = defaultRiskSettings({
    extension_max_unpaid_exposure: 500,
    extension_max_partial_count:   5,
  });
  const sb = makeSupabase({ partialExts: [] });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 0, settings);

  assert.equal(result.allowed, true, "zero new exposure must always pass");
});

// ── evaluateExtensionRisk: returns correct metadata ───────────────────────────

test("evaluateExtensionRisk: returns partialCount and exposureAmount on success", async () => {
  const settings = defaultRiskSettings();
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 75 },
      { extension_remaining_balance: 125 },
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 50, settings);

  assert.equal(result.partialCount,   2);
  assert.equal(result.exposureAmount, 200);
});

test("evaluateExtensionRisk: returns partialCount and exposureAmount on block", async () => {
  const settings = defaultRiskSettings({ extension_max_partial_count: 2 });
  const sb = makeSupabase({
    partialExts: [
      { extension_remaining_balance: 100 },
      { extension_remaining_balance: 100 },
    ],
  });

  const result = await evaluateExtensionRisk(sb, "bk-test-001", 50, settings);

  assert.equal(result.allowed,        false);
  assert.equal(result.partialCount,   2);
  assert.equal(result.exposureAmount, 200);
});
