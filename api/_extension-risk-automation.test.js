import { test, mock } from "node:test";
import assert from "node:assert/strict";

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
  EXTENSION_RISK_AUTOMATION_DEFAULTS,
  loadExtensionRiskAutomationSettings,
  evaluateExtensionRiskAutomation,
  buildExtensionRiskEventRecord,
  buildExtensionRiskAlertRecords,
  buildExtensionRiskProfilePatch,
} = await import("./_extension-risk-automation.js");

test("loadExtensionRiskAutomationSettings: returns defaults when settings are absent", async () => {
  booleanSettings = {};
  numericSettings = {};

  const settings = await loadExtensionRiskAutomationSettings();
  assert.equal(settings.extension_risk_automation_enabled, false);
  assert.equal(settings.extension_risk_alerts_enabled, true);
  assert.equal(settings.extension_risk_warning_exposure_pct, 80);
  assert.equal(settings.extension_risk_full_payment_required_exposure, 750);
});

test("loadExtensionRiskAutomationSettings: reads configured overrides", async () => {
  booleanSettings = {
    extension_risk_automation_enabled: true,
    extension_risk_alerts_enabled: false,
  };
  numericSettings = {
    extension_risk_warning_exposure_pct: 70,
    extension_risk_manual_review_exposure: 425,
  };

  const settings = await loadExtensionRiskAutomationSettings();
  assert.equal(settings.extension_risk_automation_enabled, true);
  assert.equal(settings.extension_risk_alerts_enabled, false);
  assert.equal(settings.extension_risk_warning_exposure_pct, 70);
  assert.equal(settings.extension_risk_manual_review_exposure, 425);
});

test("evaluateExtensionRiskAutomation: ignores non-car categories", () => {
  const decision = evaluateExtensionRiskAutomation({
    category: "slingshot",
    currentState: "warning",
    settings: { ...EXTENSION_RISK_AUTOMATION_DEFAULTS, extension_risk_automation_enabled: true },
    currentExposure: 450,
    partialExtensionCount: 4,
  });

  assert.equal(decision.appliesToRental, false);
  assert.equal(decision.effectiveState, "clear");
  assert.equal(decision.alerts.length, 0);
});

test("evaluateExtensionRiskAutomation: recommends warning for near-threshold exposure", () => {
  const decision = evaluateExtensionRiskAutomation({
    category: "car",
    settings: { ...EXTENSION_RISK_AUTOMATION_DEFAULTS, extension_risk_automation_enabled: true },
    currentExposure: 350,
    proposedNewExposure: 60,
    maxUnpaidExposure: 500,
    partialExtensionCount: 1,
  });

  assert.equal(decision.recommendedState, "warning");
  assert.equal(decision.effectiveState, "warning");
  assert.equal(decision.enforcement.restrictedExtension, false);
  assert.ok(decision.alerts.some((a) => a.type === "exposure_threshold"));
});

test("evaluateExtensionRiskAutomation: escalates to full-payment-required for severe stacked risk", () => {
  const decision = evaluateExtensionRiskAutomation({
    category: "car",
    currentState: "warning",
    settings: { ...EXTENSION_RISK_AUTOMATION_DEFAULTS, extension_risk_automation_enabled: true },
    currentExposure: 760,
    partialExtensionCount: 4,
    overdueCount: 3,
    failedPaymentCount: 2,
    lateReturnCount: 1,
    overrideCount: 3,
    extensionFrequencyCount: 5,
  });

  assert.equal(decision.recommendedState, "full_payment_required");
  assert.equal(decision.effectiveState, "full_payment_required");
  assert.equal(decision.stateChanged, true);
  assert.equal(decision.enforcement.fullPaymentRequired, true);
  assert.ok(decision.alerts.some((a) => a.type === "high_risk_extension_behavior"));
  assert.ok(decision.reasons.length >= 4);
});

test("evaluateExtensionRiskAutomation: respects admin risk-state override", () => {
  const decision = evaluateExtensionRiskAutomation({
    category: "car",
    settings: { ...EXTENSION_RISK_AUTOMATION_DEFAULTS, extension_risk_automation_enabled: true },
    currentExposure: 10,
    partialExtensionCount: 0,
    adminRiskStateOverride: "manual_review_required",
  });

  assert.equal(decision.recommendedState, "clear");
  assert.equal(decision.effectiveState, "manual_review_required");
  assert.equal(decision.enforcement.manualReviewRequired, true);
  assert.match(decision.reasons[0], /admin override/i);
});

test("evaluateExtensionRiskAutomation: existing allow override preserves flexibility without dropping alerts", () => {
  const decision = evaluateExtensionRiskAutomation({
    category: "car",
    settings: { ...EXTENSION_RISK_AUTOMATION_DEFAULTS, extension_risk_automation_enabled: true },
    currentExposure: 420,
    proposedNewExposure: 30,
    maxUnpaidExposure: 500,
    partialExtensionCount: 3,
    extensionRiskOverride: "allow",
  });

  assert.equal(decision.recommendedState, "restricted_extension");
  assert.equal(decision.enforcement.restrictedExtension, false);
  assert.equal(decision.enforcement.adminBypassActive, true);
  assert.ok(decision.alerts.some((a) => a.type === "repeated_partial_extensions"));
});

test("risk automation builders: create event, alerts, and profile payloads", () => {
  const decision = evaluateExtensionRiskAutomation({
    category: "car",
    currentState: "clear",
    settings: { ...EXTENSION_RISK_AUTOMATION_DEFAULTS, extension_risk_automation_enabled: true },
    currentExposure: 350,
    proposedNewExposure: 60,
    maxUnpaidExposure: 500,
    partialExtensionCount: 2,
  });

  const event = buildExtensionRiskEventRecord(decision, {
    bookingRef: "bk-100",
    customerId: "cust-100",
    triggerSource: "extend-rental",
    actorType: "system",
    actorLabel: "phase4",
    policySnapshot: { enabled: true },
    createdAt: "2026-05-16T00:00:00.000Z",
  });
  const alerts = buildExtensionRiskAlertRecords(decision, {
    bookingRef: "bk-100",
    customerId: "cust-100",
    createdAt: "2026-05-16T00:00:00.000Z",
  });
  const profile = buildExtensionRiskProfilePatch(decision, {
    bookingRef: "bk-100",
    customerId: "cust-100",
    createdAt: "2026-05-16T00:00:00.000Z",
  });

  assert.equal(event.booking_ref, "bk-100");
  assert.equal(event.new_state, "warning");
  assert.equal(event.trigger_source, "extend-rental");
  assert.ok(alerts.length >= 1);
  assert.equal(alerts[0].booking_ref, "bk-100");
  assert.equal(profile.current_state, "warning");
  assert.equal(profile.open_alert_count, alerts.length);
});
