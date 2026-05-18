import { getSupabaseAdmin } from "./_supabase.js";
import {
  patchRenterApplicationIdentityById,
  fetchRenterApplicationById,
  fetchRenterApplicationByIdentitySessionId,
  fetchReviewApplicationById,
} from "./_renter-applications.js";
import {
  sendIdentityIssueNotifications,
  sendIdentityVerifiedNotifications,
} from "./_application-notifications.js";
import {
  extractVeriffApplicationId,
  extractVeriffSessionId,
  extractVeriffStatus,
  mapVeriffDecisionToIdentityStatus,
  verifyVeriffWebhookSignature,
  fetchVeriffDecision,
} from "./_veriff.js";
import { initiateCheckrScreening } from "./_checkr.js";

export const config = {
  api: { bodyParser: false },
};

const DEFAULT_IDENTITY_RETURN_URL = "https://www.slytrans.com/thank-you.html?from=apply";

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getBrowserReturnUrl(req) {
  const query = req?.query && typeof req.query === "object" ? req.query : {};
  const parsedUrl = typeof req?.url === "string" ? new URL(req.url, "https://www.slytrans.com") : null;
  const applicationId = pickString(
    query.applicationId,
    query.application_id,
    query.vendorData,
    query.vendor_data,
    parsedUrl?.searchParams.get("applicationId"),
    parsedUrl?.searchParams.get("application_id"),
    parsedUrl?.searchParams.get("vendorData"),
    parsedUrl?.searchParams.get("vendor_data"),
  );
  const redirectUrl = new URL(DEFAULT_IDENTITY_RETURN_URL);
  redirectUrl.searchParams.set("identity", "return");
  if (applicationId) redirectUrl.searchParams.set("applicationId", applicationId);
  return redirectUrl.toString();
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function mapIdentityUpdate(identityStatus, payload = {}) {
  const rawStatus = String(extractVeriffStatus(payload) || "");
  if (identityStatus === "verified") {
    return {
      identityStatus: "verified",
      identityLastError: null,
      identityVerifiedAt: new Date().toISOString(),
      applicationStatus: "under_review",
      reviewedAt: new Date().toISOString(),
      reviewedBy: "veriff_identity_webhook",
    };
  }
  if (identityStatus === "requires_input") {
    return {
      identityStatus: "requires_input",
      identityLastError: rawStatus.slice(0, 2000) || "requires_input",
    };
  }
  if (identityStatus === "processing") {
    return {
      identityStatus: "processing",
      identityLastError: null,
      applicationStatus: "under_review",
      reviewedAt: new Date().toISOString(),
      reviewedBy: "veriff_identity_webhook",
    };
  }
  if (identityStatus === "canceled") {
    return {
      identityStatus: "canceled",
      identityLastError: rawStatus.slice(0, 2000) || "canceled",
    };
  }
  if (identityStatus === "failed") {
    return {
      identityStatus: "failed",
      identityLastError: rawStatus.slice(0, 2000) || "failed",
    };
  }
  return null;
}

function determineNotificationTypeOnTransition(current = {}, nextPatch = {}) {
  const currentIdentity = String(current.identity_status || "");
  const nextIdentity = String(nextPatch.identityStatus || "");

  if (nextIdentity === "verified" && currentIdentity !== "verified") return "verified";
  if (nextIdentity === "requires_input" && currentIdentity !== "requires_input") return "requires_input";
  if (nextIdentity === "failed" && currentIdentity !== "failed") return "failed";
  if (nextIdentity === "canceled" && currentIdentity !== "canceled") return "canceled";
  return null;
}

function isStaleIdentityUpdate(current = {}, nextPatch = {}) {
  const currentIdentity = String(current.identity_status || "");
  const currentApplication = String(current.application_status || "");
  const nextIdentity = String(nextPatch.identityStatus || "");

  if (!nextIdentity) return false;
  if (currentIdentity === "verified" && nextIdentity !== "verified") return true;
  if (["approved", "rejected"].includes(currentApplication) && nextIdentity !== "verified") return true;
  return false;
}

function getEventId(payload = {}, sessionId = "", rawStatus = "") {
  const direct = String(payload?.id || "").trim();
  if (direct && direct !== sessionId) return direct;
  const createdAt = String(payload?.createdAt || payload?.created_at || "").trim();
  const attemptId = pickString(
    payload?.attemptId,
    payload?.attempt_id,
    payload?.verification?.attemptId,
    payload?.verification?.attempt_id,
  );
  return [
    sessionId || direct || "unknown-session",
    rawStatus || "unknown-status",
    attemptId || "unknown-attempt",
    createdAt || "unknown-time",
  ].join(":");
}

function buildDecisionStatus(payload = {}, fallbackStatus = "") {
  return pickString(
    payload?.verification?.decision?.status,
    payload?.verification?.decision?.label,
    payload?.verification?.decision?.code,
    payload?.verification?.decision?.decision,
    payload?.decision?.status,
    payload?.decision?.label,
    payload?.decision?.code,
    payload?.decision?.decision,
    payload?.decision,
    fallbackStatus,
  );
}

function bool(value) {
  return !!value;
}

const EVENT_LOG_TABLES = [
  { name: "veriff_webhook_events", eventIdColumn: "event_id" },
  // Legacy fallback: stripe_identity_webhook_events was the original event log
  // table created during the Stripe Identity era. It is kept here so that
  // environments which have not yet run the migration (or which still have the
  // old table but not the new one) continue to log events without error.
  // New deployments will use veriff_webhook_events exclusively.
  { name: "stripe_identity_webhook_events", eventIdColumn: "stripe_event_id" },
];

function isMissingEventLogTableError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  return code === "42P01"
    || code === "42703"
    || /relation .* does not exist/i.test(msg)
    || /column .* does not exist/i.test(msg)
    || /Unexpected table/i.test(msg);
}

function classifyEventLogFailure(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  const text = `${code} ${msg}`.toLowerCase();
  if (code === "42P01" || code === "42703" || /relation .* does not exist|column .* does not exist/.test(text)) {
    return "missing_db_migration";
  }
  if (code === "42501" || /row-level security|permission denied|not allowed/.test(text)) {
    return "rls_or_permission";
  }
  if (code === "23505" || /duplicate key|unique constraint|already exists/.test(text)) {
    return "unique_constraint";
  }
  if (["22P02", "22023", "23502", "23503", "23514"].includes(code)
    || /invalid input syntax|malformed|violates .* constraint/.test(text)) {
    return "malformed_payload_insert";
  }
  return "unknown_event_log_failure";
}

async function isDuplicateEvent(sb, eventId) {
  for (const table of EVENT_LOG_TABLES) {
    const { data, error } = await sb
      .from(table.name)
      .select("id")
      .eq(table.eventIdColumn, eventId)
      .maybeSingle();
    if (!error) return !!data?.id;
    if (isMissingEventLogTableError(error)) continue;
    throw error;
  }
  return false;
}

async function recordEvent(sb, eventId, payload, eventType, applicationId, sessionId) {
  for (const table of EVENT_LOG_TABLES) {
    const insertPayload = {
      event_type: eventType,
      application_id: applicationId || null,
      identity_session_id: sessionId || null,
      payload,
    };
    insertPayload[table.eventIdColumn] = eventId;
    const tableClient = sb.from(table.name);
    const write = typeof tableClient?.upsert === "function"
      ? tableClient.upsert(insertPayload, { onConflict: table.eventIdColumn, ignoreDuplicates: true })
      : tableClient.insert(insertPayload);
    const { error } = await write;
    if (!error) return;
    if (isMissingEventLogTableError(error)) continue;
    throw error;
  }
  throw new Error("No veriff webhook event log table is available.");
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", getBrowserReturnUrl(req));
    return res.status(302).send("Redirecting…");
  }
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.VERIFF_SHARED_SECRET || !process.env.VERIFF_API_KEY || !process.env.VERIFF_PROJECT_ID) {
    return res.status(500).send("Server configuration error");
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("veriff-identity-webhook failed to read body:", err);
    return res.status(400).send("Invalid request body");
  }

  if (!verifyVeriffWebhookSignature(rawBody, req.headers, process.env.VERIFF_SHARED_SECRET)) {
    return res.status(400).send("Webhook Error: signature verification failed");
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch (err) {
    return res.status(400).send("Webhook Error: invalid JSON");
  }

  const rawStatus = extractVeriffStatus(payload);
  const decisionStatus = buildDecisionStatus(payload, rawStatus);
  const initialMappedStatus = mapVeriffDecisionToIdentityStatus(decisionStatus || rawStatus);
  const applicationId = extractVeriffApplicationId(payload);
  const identitySessionId = extractVeriffSessionId(payload);
  const attemptId = pickString(
    payload?.attemptId,
    payload?.attempt_id,
    payload?.verification?.attemptId,
    payload?.verification?.attempt_id,
  );
  const clientId = pickString(
    payload?.clientId,
    payload?.client_id,
    payload?.verification?.clientId,
    payload?.verification?.client_id,
  );
  const webhookEventType = pickString(payload?.eventType, payload?.event_type, payload?.action, rawStatus) || "unknown";
  const eventId = getEventId(payload, identitySessionId, rawStatus);
  const eventType = String(webhookEventType).slice(0, 200);
  let eventLogSkipped = false;
  let mappedStatus = initialMappedStatus;
  let matchedApplicationId = applicationId;
  const eventDiagnostics = {
    eventId,
    eventType,
    rawStatus: rawStatus || null,
    decisionStatus: decisionStatus || null,
    mappedStatusInitial: mappedStatus || null,
    mappedStatusFinal: mappedStatus || null,
    identitySessionId: identitySessionId || null,
    vendorApplicationId: applicationId || null,
    matchedApplicationId: matchedApplicationId || null,
    attemptId: attemptId || null,
    clientId: clientId || null,
    decisionLookupExecuted: false,
    decisionLookupOk: null,
    decisionLookupPayload: null,
    decisionLookupRawStatus: null,
    decisionLookupDecisionStatus: null,
    lookupByApplicationIdExecuted: false,
    lookupBySessionIdExecuted: false,
    lookupMatchedBy: null,
    lookupResult: null,
    identityBefore: null,
    applicationBefore: null,
    identityAfter: null,
    applicationAfter: null,
    staleGuardHit: false,
    staleGuardReason: null,
    finalizationLogicExecuted: false,
    checkrLaunchExecuted: false,
    checkrLaunchOk: null,
    checkrLaunchSkippedReason: null,
    dbPatchExecuted: false,
    dbPatchOk: null,
    dbPatchError: null,
    patchPayload: null,
    dbResponsePayload: null,
    identityAfterReload: null,
    applicationStatusAfterReload: null,
    reloadFetchExecuted: false,
    reloadFetchOk: null,
    reloadFetchError: null,
    eventLogErrorType: null,
    eventLogErrorCode: null,
    notificationKind: null,
    eventLogSkipped: false,
    skipReason: null,
    earlyReturnReason: null,
    error: null,
  };
  const setEarlyReturnReason = (reason) => {
    eventDiagnostics.skipReason = reason;
    eventDiagnostics.earlyReturnReason = reason;
  };

  console.info("veriff-identity-webhook: event received", {
    eventId,
    eventType,
    finalDecision: decisionStatus || null,
    rawStatus: rawStatus || null,
    mappedStatus: mappedStatus || null,
    vendorData: applicationId || null,
    applicationId: applicationId || null,
    identitySessionId: identitySessionId || null,
    attemptId: attemptId || null,
    clientId: clientId || null,
  });

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("veriff-identity-webhook: Supabase unavailable");
    return res.status(503).json({ error: "Application storage service is not configured." });
  }

  try {
    const duplicate = await isDuplicateEvent(sb, eventId);
    if (duplicate) {
      setEarlyReturnReason("duplicate_event");
      console.info("veriff-identity-webhook: duplicate event ignored", { eventId, applicationId, identitySessionId });
      console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (dupErr) {
    eventLogSkipped = true;
    console.error("veriff-identity-webhook duplicate check failed; continuing without dedupe:", dupErr.message || dupErr);
  }

  try {
    await recordEvent(sb, eventId, payload, eventType, applicationId, identitySessionId);
  } catch (recordErr) {
    const errCode = String(recordErr?.code || "");
    const msg = String(recordErr?.message || "");
    const classifiedError = classifyEventLogFailure(recordErr);
    if (errCode === "23505" || /duplicate key|unique/i.test(msg)) {
      setEarlyReturnReason("duplicate_event_conflict");
      eventDiagnostics.eventLogErrorType = classifiedError;
      eventDiagnostics.eventLogErrorCode = errCode || null;
      console.info("veriff-identity-webhook: duplicate event ignored from insert conflict", { eventId, applicationId, identitySessionId });
      console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
      return res.status(200).json({ received: true, duplicate: true });
    }
    eventLogSkipped = true;
    eventDiagnostics.eventLogErrorType = classifiedError;
    eventDiagnostics.eventLogErrorCode = errCode || null;
    console.error("veriff-identity-webhook event record failed; continuing without event log:", {
      errorType: classifiedError,
      code: errCode || null,
      message: msg || String(recordErr),
      details: recordErr?.details || null,
      hint: recordErr?.hint || null,
    });
  }

  if (!mappedStatus) {
    if (identitySessionId) {
      eventDiagnostics.decisionLookupExecuted = true;
      try {
        const decision = await fetchVeriffDecision(identitySessionId);
        eventDiagnostics.decisionLookupOk = bool(decision?.ok);
        eventDiagnostics.decisionLookupPayload = decision?.payload || null;
        eventDiagnostics.decisionLookupRawStatus = decision?.rawStatus || null;
        eventDiagnostics.decisionLookupDecisionStatus = decision?.decisionStatus || null;
        if (decision.ok && decision.mappedStatus) {
          mappedStatus = decision.mappedStatus;
          matchedApplicationId = matchedApplicationId || decision.applicationId || "";
          eventDiagnostics.mappedStatusFinal = mappedStatus || null;
          eventDiagnostics.matchedApplicationId = matchedApplicationId || null;
          console.info("veriff-identity-webhook: mapped status recovered from decision lookup", {
            eventId,
            eventType,
            sessionId: identitySessionId,
            decisionStatus: decision.rawStatus || null,
            mappedStatus,
            vendorData: applicationId || null,
            matchedApplicationId: matchedApplicationId || null,
          });
        }
      } catch (decisionErr) {
        eventDiagnostics.decisionLookupOk = false;
        console.warn("veriff-identity-webhook decision lookup failed:", decisionErr?.message || decisionErr);
      }
    }
    if (!mappedStatus) {
      setEarlyReturnReason(
        eventDiagnostics.decisionLookupExecuted
          ? "unmapped_status_after_decision_lookup"
          : "unmapped_status_no_session_id"
      );
      eventDiagnostics.eventLogSkipped = eventLogSkipped;
      console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
      return res.status(200).json({ received: true, ignored: true, eventLogSkipped });
    }
  }

  const identityPatch = mapIdentityUpdate(mappedStatus, payload);
  if (!identityPatch) {
    setEarlyReturnReason("unmapped_identity_patch");
    eventDiagnostics.eventLogSkipped = eventLogSkipped;
    console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
    return res.status(200).json({ received: true, ignored: true, eventLogSkipped });
  }

  try {
    let current = null;
    if (matchedApplicationId) {
      eventDiagnostics.lookupByApplicationIdExecuted = true;
      current = await fetchRenterApplicationById(matchedApplicationId);
      if (current?.ok) eventDiagnostics.lookupMatchedBy = "application_id";
    }
    if ((!current || !current.ok) && identitySessionId) {
      eventDiagnostics.lookupBySessionIdExecuted = true;
      const bySession = await fetchRenterApplicationByIdentitySessionId(identitySessionId);
      if (bySession.ok) {
        current = bySession;
        matchedApplicationId = bySession.data?.id || matchedApplicationId;
        eventDiagnostics.lookupMatchedBy = "identity_session_id";
        eventDiagnostics.matchedApplicationId = matchedApplicationId || null;
      } else if (bySession?.error) {
        eventDiagnostics.lookupResult = bySession.error;
      }
    }
    if (!current || !current.ok) {
      setEarlyReturnReason("application_lookup_failed");
      eventDiagnostics.lookupResult = current?.error || "application_not_found";
      eventDiagnostics.eventLogSkipped = eventLogSkipped;
      console.error("veriff-identity-webhook application lookup failed:", {
        eventId,
        eventType,
        vendorData: applicationId || null,
        sessionId: identitySessionId || null,
        matchedApplicationId: matchedApplicationId || null,
        error: current?.error || "Application not found for webhook mapping.",
        details: current?.details || "",
        attemptId: attemptId || null,
        clientId: clientId || null,
      });
      console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
      return res.status(200).json({ received: true, ignored: true, eventLogSkipped });
    }

    if (isStaleIdentityUpdate(current.data || {}, identityPatch)) {
      eventDiagnostics.staleGuardHit = true;
      eventDiagnostics.staleGuardReason = "terminal_or_verified_guard";
      setEarlyReturnReason("stale_identity_update");
      eventDiagnostics.lookupResult = "matched";
      eventDiagnostics.identityBefore = current.data?.identity_status || null;
      eventDiagnostics.applicationBefore = current.data?.application_status || null;
      eventDiagnostics.eventLogSkipped = eventLogSkipped;
      console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
      return res.status(200).json({ received: true, ignored: true, stale: true });
    }

    const notificationKind = determineNotificationTypeOnTransition(current.data || {}, identityPatch);
    eventDiagnostics.notificationKind = notificationKind || null;
    eventDiagnostics.lookupResult = "matched";
    eventDiagnostics.identityBefore = current.data?.identity_status || null;
    eventDiagnostics.applicationBefore = current.data?.application_status || null;

    if (identityPatch.applicationStatus === "under_review") {
      const existingStatus = current.data?.application_status;
      if (existingStatus && !["submitted", "under_review"].includes(existingStatus)) {
        delete identityPatch.applicationStatus;
        delete identityPatch.reviewedAt;
        delete identityPatch.reviewedBy;
      }
    }

    eventDiagnostics.patchPayload = {
      ...identityPatch,
      identitySessionId: identitySessionId || current.data?.identity_session_id || null,
    };
    console.info("veriff-identity-webhook: identity patch attempt", {
      applicationId: matchedApplicationId || null,
      identityBefore: eventDiagnostics.identityBefore || null,
      mappedStatus: mappedStatus || null,
      patchPayload: eventDiagnostics.patchPayload,
      finalizationLogicExecuted: eventDiagnostics.finalizationLogicExecuted,
      checkrLaunchExecuted: eventDiagnostics.checkrLaunchExecuted,
      earlyReturnReason: eventDiagnostics.earlyReturnReason,
    });
    const patchResult = await patchRenterApplicationIdentityById(matchedApplicationId, eventDiagnostics.patchPayload);
    eventDiagnostics.dbPatchExecuted = true;
    eventDiagnostics.dbPatchOk = bool(patchResult?.ok);
    eventDiagnostics.dbResponsePayload = patchResult?.data || null;
    if (!patchResult.ok) {
      eventDiagnostics.dbPatchError = patchResult.error || null;
      setEarlyReturnReason("identity_patch_failed");
      eventDiagnostics.error = patchResult.details || patchResult.error || null;
      eventDiagnostics.eventLogSkipped = eventLogSkipped;
      console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
      console.error("veriff-identity-webhook patch failed:", patchResult.error, patchResult.details || "");
      return res.status(500).json({ error: patchResult.error || "Could not update application." });
    }
    let reloaded = null;
    try {
      eventDiagnostics.reloadFetchExecuted = true;
      reloaded = await fetchReviewApplicationById(matchedApplicationId);
      eventDiagnostics.reloadFetchOk = bool(reloaded?.ok);
      if (reloaded?.ok) {
        eventDiagnostics.identityAfterReload = reloaded?.data?.identity_status || null;
        eventDiagnostics.applicationStatusAfterReload = reloaded?.data?.application_status || null;
      } else {
        eventDiagnostics.reloadFetchError = reloaded?.error || null;
      }
    } catch (reloadErr) {
      eventDiagnostics.reloadFetchOk = false;
      eventDiagnostics.reloadFetchError = reloadErr?.message || String(reloadErr);
    }
    eventDiagnostics.identityAfter = eventDiagnostics.identityAfterReload
      || patchResult.data?.identity_status
      || identityPatch.identityStatus
      || null;
    eventDiagnostics.applicationAfter = eventDiagnostics.applicationStatusAfterReload
      || patchResult.data?.application_status
      || identityPatch.applicationStatus
      || null;
    eventDiagnostics.matchedApplicationId = matchedApplicationId || null;
    eventDiagnostics.finalizationLogicExecuted = ["verified", "failed", "requires_input", "canceled"].includes(
      eventDiagnostics.identityAfter || ""
    );
    eventDiagnostics.mappedStatusFinal = mappedStatus || null;
    console.info("veriff-identity-webhook: identity patch result", {
      applicationId: matchedApplicationId || null,
      identityBefore: eventDiagnostics.identityBefore || null,
      mappedStatus: mappedStatus || null,
      patchPayload: eventDiagnostics.patchPayload,
      dbResponsePayload: eventDiagnostics.dbResponsePayload,
      identityAfterReload: eventDiagnostics.identityAfterReload,
      applicationStatusAfterReload: eventDiagnostics.applicationStatusAfterReload,
      finalizationLogicExecuted: eventDiagnostics.finalizationLogicExecuted,
      checkrLaunchExecuted: eventDiagnostics.checkrLaunchExecuted,
      earlyReturnReason: eventDiagnostics.earlyReturnReason,
    });

    console.info("veriff-identity-webhook: application identity updated", {
      eventId,
      eventType,
      finalDecision: decisionStatus || null,
      vendorData: applicationId || null,
      matchedApplicationId,
      identityStatus: patchResult.data?.identity_status || identityPatch.identityStatus || null,
      applicationStatus: patchResult.data?.application_status || identityPatch.applicationStatus || null,
      identitySessionId: patchResult.data?.identity_session_id || identitySessionId || null,
      patchOk: true,
      eventLogSkipped,
    });

    if (notificationKind === "verified") {
      eventDiagnostics.checkrLaunchExecuted = true;
      try {
        await sendIdentityVerifiedNotifications(patchResult.data || current.data || {});
      } catch (notifyErr) {
        console.error("veriff-identity-webhook verified notification failed:", notifyErr);
      }
      try {
        const checkrResult = await initiateCheckrScreening(matchedApplicationId);
        eventDiagnostics.checkrLaunchOk = bool(checkrResult?.ok);
        if (!checkrResult?.ok) {
          eventDiagnostics.checkrLaunchSkippedReason = checkrResult?.error || "checkr_launch_failed";
        }
        console.info("veriff-identity-webhook: Checkr initiation result", {
          matchedApplicationId,
          ok: !!checkrResult?.ok,
          alreadyStarted: !!checkrResult?.alreadyStarted,
          candidateId: checkrResult?.candidateId || null,
          reportId: checkrResult?.reportId || null,
          reportStatus: checkrResult?.reportStatus || null,
          error: checkrResult?.ok ? null : (checkrResult?.error || null),
          status: checkrResult?.ok ? null : (Number(checkrResult?.status) || null),
        });
      } catch (checkrErr) {
        eventDiagnostics.checkrLaunchOk = false;
        eventDiagnostics.checkrLaunchSkippedReason = checkrErr?.message || "checkr_launch_exception";
        console.error("veriff-identity-webhook Checkr initiation failed:", checkrErr.message || checkrErr);
      }
    } else if (notificationKind === "requires_input" || notificationKind === "failed" || notificationKind === "canceled") {
      eventDiagnostics.checkrLaunchSkippedReason = `notification_kind_${notificationKind}`;
      try {
        await sendIdentityIssueNotifications(patchResult.data || current.data || {}, notificationKind);
      } catch (notifyErr) {
        console.error("veriff-identity-webhook issue notification failed:", notifyErr);
      }
    } else {
      eventDiagnostics.checkrLaunchSkippedReason = "no_verified_transition";
    }
    eventDiagnostics.eventLogSkipped = eventLogSkipped;
    console.info("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
  } catch (err) {
    eventDiagnostics.error = err?.message || String(err);
    setEarlyReturnReason("webhook_processing_exception");
    eventDiagnostics.eventLogSkipped = eventLogSkipped;
    console.error("veriff-identity-webhook: decision diagnostics", eventDiagnostics);
    console.error("veriff-identity-webhook processing failed:", err);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  return res.status(200).json({ received: true, eventLogSkipped });
}
