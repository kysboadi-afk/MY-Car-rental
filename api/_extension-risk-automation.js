import { loadBooleanSetting, loadNumericSetting } from "./_settings.js";
import { normalizeFleetCategory } from "./_category.js";

export const EXTENSION_RISK_AUTOMATION_STATES = Object.freeze([
  "clear",
  "warning",
  "restricted_extension",
  "manual_review_required",
  "full_payment_required",
]);

const STATE_RANK = {
  clear: 0,
  warning: 1,
  restricted_extension: 2,
  manual_review_required: 3,
  full_payment_required: 4,
};

export const EXTENSION_RISK_AUTOMATION_DEFAULTS = {
  extension_risk_automation_enabled: false,
  extension_risk_alerts_enabled: true,
  extension_risk_warning_exposure_pct: 80,
  extension_risk_warning_partial_count: 2,
  extension_risk_warning_failed_payment_count: 1,
  extension_risk_restricted_partial_count: 3,
  extension_risk_restricted_overdue_count: 2,
  extension_risk_manual_review_exposure: 500,
  extension_risk_manual_review_failed_payment_count: 2,
  extension_risk_full_payment_required_exposure: 750,
  extension_risk_full_payment_required_overdue_count: 3,
  extension_risk_abnormal_frequency_count: 4,
  extension_risk_override_alert_threshold: 3,
  extension_risk_excessive_stack_count: 4,
  extension_max_unpaid_exposure: 500,
};

function toMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function toCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function maxState(...states) {
  return states.reduce((best, state) => {
    const normalized = normalizeRiskState(state) || "clear";
    return STATE_RANK[normalized] > STATE_RANK[best] ? normalized : best;
  }, "clear");
}

function makeAlert(type, severity, message, extra = {}) {
  return { type, severity, message, ...extra };
}

export function normalizeRiskState(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return EXTENSION_RISK_AUTOMATION_STATES.includes(normalized) ? normalized : null;
}

export async function loadExtensionRiskAutomationSettings() {
  const [
    enabled,
    alertsEnabled,
    warningExposurePct,
    warningPartialCount,
    warningFailedPayments,
    restrictedPartialCount,
    restrictedOverdueCount,
    manualReviewExposure,
    manualReviewFailedPayments,
    fullPaymentExposure,
    fullPaymentOverdueCount,
    abnormalFrequencyCount,
    overrideAlertThreshold,
    excessiveStackCount,
    maxExposure,
  ] = await Promise.all([
    loadBooleanSetting("extension_risk_automation_enabled", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_automation_enabled),
    loadBooleanSetting("extension_risk_alerts_enabled", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_alerts_enabled),
    loadNumericSetting("extension_risk_warning_exposure_pct", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_warning_exposure_pct),
    loadNumericSetting("extension_risk_warning_partial_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_warning_partial_count),
    loadNumericSetting("extension_risk_warning_failed_payment_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_warning_failed_payment_count),
    loadNumericSetting("extension_risk_restricted_partial_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_restricted_partial_count),
    loadNumericSetting("extension_risk_restricted_overdue_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_restricted_overdue_count),
    loadNumericSetting("extension_risk_manual_review_exposure", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_manual_review_exposure),
    loadNumericSetting("extension_risk_manual_review_failed_payment_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_manual_review_failed_payment_count),
    loadNumericSetting("extension_risk_full_payment_required_exposure", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_full_payment_required_exposure),
    loadNumericSetting("extension_risk_full_payment_required_overdue_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_full_payment_required_overdue_count),
    loadNumericSetting("extension_risk_abnormal_frequency_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_abnormal_frequency_count),
    loadNumericSetting("extension_risk_override_alert_threshold", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_override_alert_threshold),
    loadNumericSetting("extension_risk_excessive_stack_count", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_risk_excessive_stack_count),
    loadNumericSetting("extension_max_unpaid_exposure", EXTENSION_RISK_AUTOMATION_DEFAULTS.extension_max_unpaid_exposure),
  ]);

  return {
    extension_risk_automation_enabled: !!enabled,
    extension_risk_alerts_enabled: !!alertsEnabled,
    extension_risk_warning_exposure_pct: warningExposurePct,
    extension_risk_warning_partial_count: warningPartialCount,
    extension_risk_warning_failed_payment_count: warningFailedPayments,
    extension_risk_restricted_partial_count: restrictedPartialCount,
    extension_risk_restricted_overdue_count: restrictedOverdueCount,
    extension_risk_manual_review_exposure: manualReviewExposure,
    extension_risk_manual_review_failed_payment_count: manualReviewFailedPayments,
    extension_risk_full_payment_required_exposure: fullPaymentExposure,
    extension_risk_full_payment_required_overdue_count: fullPaymentOverdueCount,
    extension_risk_abnormal_frequency_count: abnormalFrequencyCount,
    extension_risk_override_alert_threshold: overrideAlertThreshold,
    extension_risk_excessive_stack_count: excessiveStackCount,
    extension_max_unpaid_exposure: maxExposure,
  };
}

export function evaluateExtensionRiskAutomation(input = {}) {
  const settings = {
    ...EXTENSION_RISK_AUTOMATION_DEFAULTS,
    ...(input.settings || {}),
  };
  const category = normalizeFleetCategory(input.category) || null;
  const currentState = normalizeRiskState(input.currentState) || "clear";
  const adminRiskStateOverride = normalizeRiskState(input.adminRiskStateOverride);
  const extensionRiskOverride = String(input.extensionRiskOverride || "").trim().toLowerCase() || null;

  const baseLimit = Math.max(0, toMoney(input.maxUnpaidExposure || settings.extension_max_unpaid_exposure));
  const currentExposure = toMoney(input.currentExposure);
  const projectedExposure = toMoney(
    input.projectedExposure != null
      ? input.projectedExposure
      : currentExposure + toMoney(input.proposedNewExposure)
  );
  const partialExtensionCount = toCount(input.partialExtensionCount);
  const overdueCount = toCount(input.overdueCount);
  const failedPaymentCount = toCount(input.failedPaymentCount);
  const lateReturnCount = toCount(input.lateReturnCount);
  const extensionStackCount = toCount(input.extensionStackCount || partialExtensionCount);
  const overrideCount = toCount(input.overrideCount);
  const extensionFrequencyCount = toCount(input.extensionFrequencyCount || partialExtensionCount);

  const exposurePctOfLimit = baseLimit > 0
    ? Math.round((projectedExposure / baseLimit) * 10000) / 100
    : 0;

  const signals = {
    currentExposure,
    projectedExposure,
    maxUnpaidExposure: baseLimit,
    exposurePctOfLimit,
    partialExtensionCount,
    overdueCount,
    failedPaymentCount,
    lateReturnCount,
    extensionStackCount,
    overrideCount,
    extensionFrequencyCount,
    approachingExposureThreshold: baseLimit > 0 && exposurePctOfLimit >= settings.extension_risk_warning_exposure_pct,
    repeatedPartialExtensions: partialExtensionCount >= settings.extension_risk_warning_partial_count,
    overdueEscalationRisk: overdueCount > 0 || lateReturnCount > 0,
    repeatedOverrideUsage: overrideCount >= settings.extension_risk_override_alert_threshold,
    abnormalExtensionFrequency: extensionFrequencyCount >= settings.extension_risk_abnormal_frequency_count,
  };

  if (category !== "car") {
    return {
      appliesToRental: false,
      category,
      currentState,
      recommendedState: "clear",
      effectiveState: "clear",
      stateChanged: currentState !== "clear",
      reasons: [],
      alerts: [],
      signals,
      enforcement: {
        restrictedExtension: false,
        manualReviewRequired: false,
        fullPaymentRequired: false,
        adminBypassActive: false,
      },
      admin: {
        riskStateOverride: adminRiskStateOverride,
        extensionRiskOverride,
      },
    };
  }

  const warningState = maxState(
    signals.approachingExposureThreshold ? "warning" : "clear",
    partialExtensionCount >= settings.extension_risk_warning_partial_count ? "warning" : "clear",
    failedPaymentCount >= settings.extension_risk_warning_failed_payment_count ? "warning" : "clear",
    lateReturnCount >= 1 ? "warning" : "clear"
  );
  const restrictedState = maxState(
    partialExtensionCount >= settings.extension_risk_restricted_partial_count ? "restricted_extension" : "clear",
    overdueCount >= settings.extension_risk_restricted_overdue_count ? "restricted_extension" : "clear",
    extensionStackCount >= settings.extension_risk_excessive_stack_count ? "restricted_extension" : "clear"
  );
  const manualReviewState = maxState(
    projectedExposure >= settings.extension_risk_manual_review_exposure ? "manual_review_required" : "clear",
    failedPaymentCount >= settings.extension_risk_manual_review_failed_payment_count ? "manual_review_required" : "clear"
  );
  const fullPaymentState = maxState(
    projectedExposure >= settings.extension_risk_full_payment_required_exposure ? "full_payment_required" : "clear",
    overdueCount >= settings.extension_risk_full_payment_required_overdue_count ? "full_payment_required" : "clear"
  );

  const recommendedState = settings.extension_risk_automation_enabled
    ? maxState(warningState, restrictedState, manualReviewState, fullPaymentState)
    : "clear";

  const reasons = [];
  if (signals.approachingExposureThreshold) reasons.push("Exposure is approaching the configured unpaid extension limit.");
  if (partialExtensionCount >= settings.extension_risk_warning_partial_count) reasons.push("Repeated partial extensions detected.");
  if (overdueCount > 0) reasons.push("Booking history shows overdue extension behavior.");
  if (failedPaymentCount > 0) reasons.push("Failed extension payment activity detected.");
  if (lateReturnCount > 0) reasons.push("Late return history increases operational risk.");
  if (extensionStackCount >= settings.extension_risk_excessive_stack_count) reasons.push("Extension stacking exceeded the operational threshold.");
  if (signals.repeatedOverrideUsage) reasons.push("Admin overrides have been used repeatedly on this rental.");

  const effectiveState = adminRiskStateOverride
    || (extensionRiskOverride === "block" ? maxState(recommendedState, "restricted_extension") : recommendedState);

  const enforcement = {
    restrictedExtension: STATE_RANK[effectiveState] >= STATE_RANK.restricted_extension,
    manualReviewRequired: STATE_RANK[effectiveState] >= STATE_RANK.manual_review_required,
    fullPaymentRequired: STATE_RANK[effectiveState] >= STATE_RANK.full_payment_required,
    adminBypassActive: extensionRiskOverride === "allow",
  };

  if (adminRiskStateOverride) {
    reasons.unshift(`Admin override is forcing risk state "${adminRiskStateOverride}".`);
  } else if (extensionRiskOverride === "allow") {
    reasons.unshift("Admin extension override keeps renter flexibility available while leaving operational alerts visible.");
    enforcement.restrictedExtension = false;
    enforcement.manualReviewRequired = false;
    enforcement.fullPaymentRequired = false;
  } else if (extensionRiskOverride === "block") {
    reasons.unshift("Existing admin extension override is forcing a restricted-extension posture.");
  }

  const alerts = [];
  if (settings.extension_risk_alerts_enabled) {
    if (signals.approachingExposureThreshold) {
      alerts.push(makeAlert(
        "exposure_threshold",
        projectedExposure >= settings.extension_risk_manual_review_exposure ? "high" : "warning",
        `Exposure is at ${exposurePctOfLimit.toFixed(2)}% of the allowed unpaid extension limit.`,
        { metric: "projected_exposure", value: projectedExposure }
      ));
    }
    if (signals.repeatedPartialExtensions) {
      alerts.push(makeAlert(
        "repeated_partial_extensions",
        partialExtensionCount >= settings.extension_risk_restricted_partial_count ? "high" : "warning",
        `Renter has ${partialExtensionCount} partial extension(s).`,
        { metric: "partial_extension_count", value: partialExtensionCount }
      ));
    }
    if (signals.overdueEscalationRisk) {
      alerts.push(makeAlert(
        "overdue_escalation_risk",
        overdueCount >= settings.extension_risk_restricted_overdue_count ? "high" : "warning",
        `Overdue count=${overdueCount}, late return count=${lateReturnCount}.`,
        { metric: "overdue_count", value: overdueCount }
      ));
    }
    if (STATE_RANK[effectiveState] >= STATE_RANK.manual_review_required) {
      alerts.push(makeAlert(
        "high_risk_extension_behavior",
        effectiveState === "full_payment_required" ? "critical" : "high",
        `Operational escalation reached ${effectiveState}.`,
        { metric: "risk_state", value: effectiveState }
      ));
    }
    if (signals.repeatedOverrideUsage) {
      alerts.push(makeAlert(
        "repeated_override_usage",
        "warning",
        `Override count reached ${overrideCount}.`,
        { metric: "override_count", value: overrideCount }
      ));
    }
    if (signals.abnormalExtensionFrequency) {
      alerts.push(makeAlert(
        "abnormal_extension_frequency",
        "warning",
        `Extension frequency reached ${extensionFrequencyCount}.`,
        { metric: "extension_frequency_count", value: extensionFrequencyCount }
      ));
    }
  }

  return {
    appliesToRental: true,
    category,
    currentState,
    recommendedState,
    effectiveState,
    stateChanged: effectiveState !== currentState,
    reasons,
    alerts,
    signals,
    enforcement,
    admin: {
      riskStateOverride: adminRiskStateOverride,
      extensionRiskOverride,
    },
  };
}

export function buildExtensionRiskEventRecord(decision, context = {}) {
  return {
    booking_ref: String(context.bookingRef || "").trim() || null,
    customer_id: String(context.customerId || "").trim() || null,
    category: decision?.category === "car" ? "car" : null,
    previous_state: decision?.currentState || "clear",
    new_state: decision?.effectiveState || "clear",
    recommended_state: decision?.recommendedState || "clear",
    event_type: decision?.stateChanged ? "risk_state_changed" : "risk_state_evaluated",
    actor_type: context.actorType || "system",
    actor_label: context.actorLabel || "extension-risk-automation",
    trigger_source: context.triggerSource || "manual",
    reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
    signal_snapshot: decision?.signals || {},
    policy_snapshot: context.policySnapshot || null,
    alerts: Array.isArray(decision?.alerts) ? decision.alerts : [],
    created_at: context.createdAt || new Date().toISOString(),
  };
}

export function buildExtensionRiskAlertRecords(decision, context = {}) {
  const bookingRef = String(context.bookingRef || "").trim() || null;
  const customerId = String(context.customerId || "").trim() || null;
  const createdAt = context.createdAt || new Date().toISOString();
  const state = decision?.effectiveState || "clear";

  return (decision?.alerts || []).map((alert) => ({
    booking_ref: bookingRef,
    customer_id: customerId,
    category: decision?.category === "car" ? "car" : null,
    risk_state: state,
    alert_type: alert.type,
    severity: alert.severity,
    status: "pending",
    dedupe_key: [bookingRef || "unknown", state, alert.type].join(":"),
    payload: alert,
    created_at: createdAt,
  }));
}

export function buildExtensionRiskProfilePatch(decision, context = {}) {
  return {
    booking_ref: String(context.bookingRef || "").trim() || null,
    customer_id: String(context.customerId || "").trim() || null,
    category: decision?.category === "car" ? "car" : null,
    current_state: decision?.effectiveState || "clear",
    recommended_state: decision?.recommendedState || "clear",
    last_evaluated_at: context.createdAt || new Date().toISOString(),
    active_override_state: decision?.admin?.riskStateOverride || null,
    extension_override_mode: decision?.admin?.extensionRiskOverride || null,
    restricted_extension: !!decision?.enforcement?.restrictedExtension,
    manual_review_required: !!decision?.enforcement?.manualReviewRequired,
    full_payment_required: !!decision?.enforcement?.fullPaymentRequired,
    signals: decision?.signals || {},
    reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
    open_alert_count: Array.isArray(decision?.alerts) ? decision.alerts.length : 0,
  };
}
