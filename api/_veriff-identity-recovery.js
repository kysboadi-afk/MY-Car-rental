import { patchRenterApplicationIdentityById } from "./_renter-applications.js";
import { sendIdentityVerifiedNotifications } from "./_application-notifications.js";
import { fetchVeriffDecision } from "./_veriff.js";
import { initiateCheckrScreening } from "./_checkr.js";

const NOTIFIABLE_APPLICATION_STATUSES = ["submitted", "under_review", "needs_info"];

// Application statuses where Veriff identity recovery is not meaningful.
const TERMINAL_APPLICATION_STATUSES = new Set(["rejected", "withdrawn", "expired", "approved"]);

// Cooldown durations for failed recovery attempts.
const COOLDOWN_TRANSIENT_MS = 5 * 60 * 1000;      // 5 min — 5xx / network
const COOLDOWN_PERMANENT_MS = 24 * 60 * 60 * 1000; // 24 h  — 404 / bad session
const COOLDOWN_AUTH_MS = 60 * 60 * 1000;            // 1 h   — 401/403

// In-memory cache: sessionId → cooldownUntil (ms epoch).
// Warm lambda invocations share this state across requests.
//
// IMPORTANT: This cache is per-container/lambda instance and is reset on cold
// starts. Parallel lambda instances do not share state, so in the worst case a
// newly cold instance may issue one redundant Veriff call per session before
// re-populating its own cooldown cache.  This is acceptable: the cooldown is an
// optimisation, not a hard rate-limit.  A future iteration can migrate to a
// shared store (Redis/Upstash, Supabase KV) if duplicate calls become a concern.
const RECOVERY_COOLDOWN_CACHE = new Map();

// Module-level auth-failure gate. When auth is broken every Veriff call fails
// with 401/403, so we suppress all recovery until the cooldown expires.
let _authFailureCooldownUntil = 0;

/** Exported for test isolation — do not call in production code. */
export function clearRecoveryCooldownCache() {
  RECOVERY_COOLDOWN_CACHE.clear();
  _authFailureCooldownUntil = 0;
}

function classifyVeriffHttpError(httpStatus) {
  if (httpStatus === 404) return { errorType: "session_not_found", cooldownMs: COOLDOWN_PERMANENT_MS };
  if (httpStatus === 401 || httpStatus === 403) return { errorType: "auth_failure", cooldownMs: COOLDOWN_AUTH_MS };
  if (httpStatus >= 400 && httpStatus < 500) return { errorType: "client_error", cooldownMs: COOLDOWN_PERMANENT_MS };
  return { errorType: "transient", cooldownMs: COOLDOWN_TRANSIENT_MS };
}

function classifySessionSource(identitySessionId = "") {
  const normalized = String(identitySessionId || "").trim();
  if (!normalized) return "missing_session_id";
  if (normalized.startsWith("vs_")) return "legacy_stripe_identity";
  if (/^vrf_/i.test(normalized)) return "veriff_prefixed";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    return "veriff_uuid";
  }
  return "unknown_format";
}

function classifyDecisionFailureHint(decision = {}) {
  const detailText = String(decision?.error || "").toLowerCase();
  const detailsJson = JSON.stringify(decision?.details || {}).toLowerCase();
  const combined = `${detailText} ${detailsJson}`;
  if (/workspace|project|x-auth-client-project|client project|wrong project/.test(combined)) {
    return "workspace_or_project_mismatch";
  }
  if (/not found|unknown session|session .* does not exist|no such session|invalid session/.test(combined)) {
    return "deleted_or_restarted_or_legacy_session";
  }
  if (/auth|unauthorized|forbidden|credential|token|signature/.test(combined)) {
    return "auth_or_config_failure";
  }
  return null;
}

function isSessionInCooldown(sessionId) {
  const until = RECOVERY_COOLDOWN_CACHE.get(sessionId);
  return !!until && Date.now() < until;
}

function setSessionCooldown(sessionId, cooldownMs) {
  RECOVERY_COOLDOWN_CACHE.set(sessionId, Date.now() + cooldownMs);
  // Evict expired entries to prevent unbounded growth on long-lived instances.
  if (RECOVERY_COOLDOWN_CACHE.size > 500) {
    const now = Date.now();
    for (const [key, until] of RECOVERY_COOLDOWN_CACHE) {
      if (now >= until) RECOVERY_COOLDOWN_CACHE.delete(key);
    }
  }
}

async function tryLaunchCheckrAfterVerified(application = {}) {
  const applicationId = typeof application?.id === "string" ? application.id : "";
  if (!applicationId) {
    return { executed: false, ok: false, skippedReason: "missing_application_id" };
  }
  try {
    const result = await initiateCheckrScreening(applicationId);
    if (!result?.ok) {
      console.warn("veriff-recovery: checkr launch did not start", {
        application_id: applicationId,
        error: result?.error || null,
        status: Number(result?.status) || null,
      });
      return {
        executed: true,
        ok: false,
        skippedReason: result?.error || "checkr_launch_failed",
        result,
      };
    }
    console.info("veriff-recovery: checkr launch attempted", {
      application_id: applicationId,
      already_started: !!result?.alreadyStarted,
      report_status: result?.reportStatus || null,
      report_id: result?.reportId || null,
      candidate_id: result?.candidateId || null,
    });
    return {
      executed: true,
      ok: true,
      skippedReason: null,
      result,
    };
  } catch (err) {
    console.error("veriff-recovery: checkr launch failed", {
      application_id: applicationId,
      error: err?.message || String(err),
    });
    return {
      executed: true,
      ok: false,
      skippedReason: err?.message || "checkr_launch_exception",
    };
  }
}

export async function recoverApplicationIdentityFromVeriffDecision(
  application = {},
  { reviewedBy = "veriff_identity_recovery", notify = true } = {},
) {
  const applicationId = typeof application?.id === "string" ? application.id : "";
  const identitySessionId = typeof application?.identity_session_id === "string"
    ? application.identity_session_id
    : "";
  const applicationStatus = String(application.application_status || "").toLowerCase();
  const currentIdentityStatus = String(application.identity_status || "").toLowerCase();
  const decisionDiagnostics = {
    applicationId: applicationId || null,
    identitySessionId: identitySessionId || null,
    sessionSource: classifySessionSource(identitySessionId),
    rawDecisionPayload: null,
    rawStatus: null,
    decisionStatus: null,
    mappedStatus: null,
    decisionHttpStatus: null,
    decisionError: null,
    decisionFailureHint: null,
    identityBefore: currentIdentityStatus || null,
    identityAfter: currentIdentityStatus || null,
    finalizationLogicExecuted: false,
    dbPatchOk: null,
    checkrLaunchExecuted: false,
    checkrLaunchOk: null,
    skipReason: null,
  };

  function logDecisionDiagnostics(extra = {}) {
    console.info("veriff-recovery: decision diagnostics", {
      ...decisionDiagnostics,
      ...extra,
    });
  }

  if (!applicationId || !identitySessionId) {
    decisionDiagnostics.skipReason = "missing_identity_session";
    logDecisionDiagnostics();
    return { ok: true, synced: false, skipped: true, reason: "missing_identity_session" };
  }
  if (identitySessionId.startsWith("vs_")) {
    decisionDiagnostics.skipReason = "legacy_session_id";
    logDecisionDiagnostics();
    return { ok: true, synced: false, skipped: true, reason: "legacy_session_id" };
  }

  // Skip terminal application statuses — recovery cannot promote these.
  if (TERMINAL_APPLICATION_STATUSES.has(applicationStatus)) {
    decisionDiagnostics.skipReason = "terminal_application_status";
    logDecisionDiagnostics();
    return { ok: true, synced: false, skipped: true, reason: "terminal_application_status" };
  }

  // Skip if auth is known to be broken (all Veriff calls will fail with 401/403).
  if (Date.now() < _authFailureCooldownUntil) {
    decisionDiagnostics.skipReason = "auth_cooldown";
    logDecisionDiagnostics();
    return { ok: true, synced: false, skipped: true, reason: "auth_cooldown" };
  }

  // Skip sessions whose last lookup recently failed — avoids hammering Veriff.
  if (isSessionInCooldown(identitySessionId)) {
    decisionDiagnostics.skipReason = "cooldown";
    logDecisionDiagnostics();
    return { ok: true, synced: false, skipped: true, reason: "cooldown" };
  }

  const decision = await fetchVeriffDecision(identitySessionId);
  decisionDiagnostics.rawDecisionPayload = decision?.payload || null;
  decisionDiagnostics.rawStatus = decision?.rawStatus || null;
  decisionDiagnostics.decisionStatus = decision?.decisionStatus || null;
  decisionDiagnostics.mappedStatus = decision?.mappedStatus || null;
  decisionDiagnostics.decisionHttpStatus = Number(decision?.status) || null;
  decisionDiagnostics.decisionError = decision?.error || null;
  decisionDiagnostics.decisionFailureHint = classifyDecisionFailureHint(decision);
  if (!decision.ok) {
    const status = Number(decision.status) || 0;
    const detailText = typeof decision.error === "string" && decision.error
      ? decision.error
      : (typeof decision.details === "string" ? decision.details : "");
    const { errorType, cooldownMs } = classifyVeriffHttpError(status);
    const cooldownUntil = Date.now() + cooldownMs;

    setSessionCooldown(identitySessionId, cooldownMs);
    if (errorType === "auth_failure") {
      _authFailureCooldownUntil = cooldownUntil;
    }

    const logPayload = {
      application_id: applicationId,
      session_id: identitySessionId,
      app_status: applicationStatus,
      session_source: decisionDiagnostics.sessionSource,
      error_type: errorType,
      failure_hint: decisionDiagnostics.decisionFailureHint,
      http_status: status || null,
      response_body: decision?.details || null,
      cooldown_until: new Date(cooldownUntil).toISOString(),
    };
    if (errorType === "auth_failure") {
      // Log only the first auth failure per cooldown window — the module gate
      // ensures subsequent calls are skipped before reaching this point.
      console.error("veriff-recovery: auth/config failure — recovery suspended", logPayload);
    } else if (errorType === "session_not_found" || errorType === "client_error") {
      console.warn("veriff-recovery: permanent session failure — cooldown set", logPayload);
    } else {
      console.warn("veriff-recovery: transient failure — will retry after cooldown", logPayload);
    }

    return {
      ok: false,
      synced: false,
      errorType,
      error: "Could not retrieve Veriff identity decision.",
      details: status
        ? `Veriff decision lookup failed (status ${status}): ${detailText}`.trim()
        : (detailText || ""),
    };
  }

  const recoveredIdentityStatus = decision.mappedStatus;
  if (!["verified", "processing", "failed", "requires_input", "canceled"].includes(recoveredIdentityStatus)) {
    decisionDiagnostics.skipReason = "unmapped_decision_status";
    logDecisionDiagnostics();
    return { ok: true, synced: false, veriffStatus: decision.rawStatus || "unknown" };
  }
  decisionDiagnostics.finalizationLogicExecuted = ["verified", "failed", "requires_input", "canceled"].includes(
    recoveredIdentityStatus
  );

  if (currentIdentityStatus === recoveredIdentityStatus) {
    if (recoveredIdentityStatus === "verified") {
      const checkrLaunch = await tryLaunchCheckrAfterVerified(application);
      decisionDiagnostics.checkrLaunchExecuted = !!checkrLaunch?.executed;
      decisionDiagnostics.checkrLaunchOk = checkrLaunch?.ok ?? null;
    }
    decisionDiagnostics.identityAfter = recoveredIdentityStatus;
    decisionDiagnostics.skipReason = "already_synced";
    logDecisionDiagnostics();
    return {
      ok: true,
      synced: false,
      veriffStatus: decision.rawStatus || "unknown",
      alreadySynced: true,
    };
  }

  const shouldNotify = notify && recoveredIdentityStatus === "verified" && NOTIFIABLE_APPLICATION_STATUSES.includes(applicationStatus);
  const now = new Date().toISOString();
  const patch = {
    identitySessionId: decision.sessionId || identitySessionId,
    identityStatus: recoveredIdentityStatus,
  };
  if (recoveredIdentityStatus === "verified") {
    patch.identityVerifiedAt = now;
    patch.identityLastError = null;
  } else if (recoveredIdentityStatus === "processing") {
    patch.identityLastError = null;
  } else {
    patch.identityLastError = String(decision.decisionStatus || decision.rawStatus || recoveredIdentityStatus).slice(0, 2000);
  }

  if (applicationStatus === "submitted" && ["verified", "processing"].includes(recoveredIdentityStatus)) {
    patch.applicationStatus = "under_review";
    patch.reviewedAt = now;
    patch.reviewedBy = reviewedBy;
  }

  const patchResult = await patchRenterApplicationIdentityById(applicationId, patch);
  decisionDiagnostics.dbPatchOk = !!patchResult?.ok;
  if (!patchResult.ok) {
    decisionDiagnostics.identityAfter = recoveredIdentityStatus;
    decisionDiagnostics.skipReason = "identity_patch_failed";
    logDecisionDiagnostics();
    return {
      ok: false,
      synced: false,
      error: patchResult.error || "Could not update application.",
      details: patchResult.details || "",
    };
  }
  decisionDiagnostics.identityAfter = patchResult.data?.identity_status || recoveredIdentityStatus;

  if (shouldNotify) {
    try {
      await sendIdentityVerifiedNotifications(patchResult.data || application);
    } catch (notifyErr) {
      console.error("recoverApplicationIdentityFromVeriffDecision notification failed:", notifyErr);
    }
  }

  if (recoveredIdentityStatus === "verified") {
    const checkrLaunch = await tryLaunchCheckrAfterVerified(patchResult.data || application);
    decisionDiagnostics.checkrLaunchExecuted = !!checkrLaunch?.executed;
    decisionDiagnostics.checkrLaunchOk = checkrLaunch?.ok ?? null;
  }
  logDecisionDiagnostics();

  return {
    ok: true,
    synced: true,
    veriffStatus: decision.rawStatus || "approved",
    data: patchResult.data || application,
  };
}
