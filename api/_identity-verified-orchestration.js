import {
  fetchRenterApplicationById,
} from "./_renter-applications.js";
import { initiateCheckrScreening } from "./_checkr.js";

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeApplicationSnapshot(applicationId, applicationSnapshot) {
  if (!applicationSnapshot || typeof applicationSnapshot !== "object") return null;
  return {
    id: pickString(applicationSnapshot.id) || applicationId,
    identity_status: pickString(applicationSnapshot.identity_status),
    application_status: pickString(applicationSnapshot.application_status),
    checkr_candidate_id: pickString(applicationSnapshot.checkr_candidate_id),
    checkr_report_id: pickString(applicationSnapshot.checkr_report_id),
    checkr_report_status: pickString(applicationSnapshot.checkr_report_status),
  };
}

function buildAlreadyStartedReason(application = {}) {
  const reportId = pickString(application.checkr_report_id);
  const reportStatus = pickString(application.checkr_report_status);
  if (!reportId) return null;
  if (!reportStatus) return "existing_report_id";
  if (["invitation_sent", "pending", "completed", "clear", "consider", "suspended"].includes(reportStatus)) {
    return `existing_report_${reportStatus}`;
  }
  return null;
}

export async function launchCheckrForVerifiedFinalization({
  applicationId,
  source,
  trigger,
  applicationSnapshot = null,
} = {}) {
  const resolvedApplicationId = pickString(applicationId);
  const resolvedSource = pickString(source) || "unknown";
  const resolvedTrigger = pickString(trigger) || "unknown";

  if (!resolvedApplicationId) {
    console.info("identity-verified-orchestration: Checkr launch skipped", {
      source: resolvedSource,
      trigger: resolvedTrigger,
      reason: "missing_application_id",
    });
    return { executed: false, ok: false, skipped: true, reason: "missing_application_id" };
  }

  let application = normalizeApplicationSnapshot(resolvedApplicationId, applicationSnapshot);
  if (!application) {
    const appResult = await fetchRenterApplicationById(resolvedApplicationId);
    if (!appResult?.ok) {
      console.warn("identity-verified-orchestration: Checkr launch skipped", {
        source: resolvedSource,
        trigger: resolvedTrigger,
        applicationId: resolvedApplicationId,
        reason: "application_lookup_failed",
        error: appResult?.error || null,
      });
      return {
        executed: false,
        ok: false,
        skipped: true,
        reason: "application_lookup_failed",
        status: Number(appResult?.status) || null,
        error: appResult?.error || null,
      };
    }
    application = normalizeApplicationSnapshot(resolvedApplicationId, appResult.data || {});
  }

  console.info("identity-verified-orchestration: Checkr launch attempt", {
    source: resolvedSource,
    trigger: resolvedTrigger,
    applicationId: resolvedApplicationId,
    identityStatus: application?.identity_status || null,
    applicationStatus: application?.application_status || null,
    hasCandidateId: !!pickString(application?.checkr_candidate_id),
    hasReportId: !!pickString(application?.checkr_report_id),
    checkrReportStatus: application?.checkr_report_status || null,
  });

  if (application?.identity_status !== "verified") {
    console.info("identity-verified-orchestration: Checkr launch skipped", {
      source: resolvedSource,
      trigger: resolvedTrigger,
      applicationId: resolvedApplicationId,
      reason: "identity_not_verified",
      identityStatus: application?.identity_status || null,
    });
    return {
      executed: false,
      ok: false,
      skipped: true,
      reason: "identity_not_verified",
      identityStatus: application?.identity_status || null,
    };
  }

  const alreadyStartedReason = buildAlreadyStartedReason(application);
  if (alreadyStartedReason) {
    console.info("identity-verified-orchestration: Checkr launch skipped", {
      source: resolvedSource,
      trigger: resolvedTrigger,
      applicationId: resolvedApplicationId,
      reason: alreadyStartedReason,
      reportStatus: application.checkr_report_status || null,
      hasCandidateId: !!pickString(application.checkr_candidate_id),
      hasReportId: !!pickString(application.checkr_report_id),
    });
    return {
      executed: false,
      ok: true,
      skipped: true,
      alreadyStarted: true,
      reason: alreadyStartedReason,
      reportStatus: application.checkr_report_status || null,
      candidateId: application.checkr_candidate_id || null,
      reportId: application.checkr_report_id || null,
    };
  }

  try {
    const checkrResult = await initiateCheckrScreening(resolvedApplicationId);
    if (!checkrResult?.ok) {
      console.warn("identity-verified-orchestration: Checkr launch failed", {
        source: resolvedSource,
        trigger: resolvedTrigger,
        applicationId: resolvedApplicationId,
        status: Number(checkrResult?.status) || null,
        error: checkrResult?.error || null,
      });
      return {
        executed: true,
        ok: false,
        skipped: false,
        reason: "launch_failed",
        status: Number(checkrResult?.status) || null,
        error: checkrResult?.error || null,
      };
    }
    if (checkrResult?.alreadyStarted) {
      console.info("identity-verified-orchestration: Checkr launch already started", {
        source: resolvedSource,
        trigger: resolvedTrigger,
        applicationId: resolvedApplicationId,
        reportStatus: checkrResult?.reportStatus || null,
        candidateId: checkrResult?.candidateId || null,
        reportId: checkrResult?.reportId || null,
      });
      return {
        executed: true,
        ok: true,
        skipped: true,
        alreadyStarted: true,
        reason: "already_started",
        result: checkrResult,
      };
    }
    console.info("identity-verified-orchestration: Checkr launch started", {
      source: resolvedSource,
      trigger: resolvedTrigger,
      applicationId: resolvedApplicationId,
      reportStatus: checkrResult?.reportStatus || null,
      candidateId: checkrResult?.candidateId || null,
      reportId: checkrResult?.reportId || null,
    });
    return { executed: true, ok: true, skipped: false, reason: null, result: checkrResult };
  } catch (err) {
    console.error("identity-verified-orchestration: Checkr launch exception", {
      source: resolvedSource,
      trigger: resolvedTrigger,
      applicationId: resolvedApplicationId,
      error: err?.message || String(err),
    });
    return {
      executed: true,
      ok: false,
      skipped: false,
      reason: "launch_exception",
      error: err?.message || String(err),
    };
  }
}
