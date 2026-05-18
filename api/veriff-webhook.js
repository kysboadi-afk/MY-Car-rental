import { getSupabaseAdmin } from "./_supabase.js";
import {
  patchRenterApplicationIdentityById,
  fetchRenterApplicationById,
  fetchRenterApplicationByIdentitySessionId,
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
  if (direct) return direct;
  const createdAt = String(payload?.createdAt || payload?.created_at || "").trim();
  return [sessionId || "unknown-session", rawStatus || "unknown-status", createdAt || "unknown-time"].join(":");
}

const EVENT_LOG_TABLES = [
  { name: "veriff_webhook_events", eventIdColumn: "event_id" },
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
    const { error } = await sb
      .from(table.name)
      .insert(insertPayload);
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
  const decisionStatus = pickString(
    payload?.verification?.decision?.status,
    payload?.decision?.status,
    payload?.decision,
  );
  const initialMappedStatus = mapVeriffDecisionToIdentityStatus(decisionStatus || rawStatus);
  const applicationId = extractVeriffApplicationId(payload);
  const identitySessionId = extractVeriffSessionId(payload);
  const webhookEventType = pickString(payload?.eventType, payload?.event_type, payload?.action, rawStatus) || "unknown";
  const eventId = getEventId(payload, identitySessionId, rawStatus);
  const eventType = String(webhookEventType).slice(0, 200);
  let eventLogSkipped = false;
  let mappedStatus = initialMappedStatus;
  let matchedApplicationId = applicationId;

  console.info("veriff-identity-webhook: event received", {
    eventId,
    eventType,
    finalDecision: decisionStatus || null,
    rawStatus: rawStatus || null,
    mappedStatus: mappedStatus || null,
    vendorData: applicationId || null,
    applicationId: applicationId || null,
    identitySessionId: identitySessionId || null,
  });

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("veriff-identity-webhook: Supabase unavailable");
    return res.status(503).json({ error: "Application storage service is not configured." });
  }

  try {
    const duplicate = await isDuplicateEvent(sb, eventId);
    if (duplicate) {
      console.info("veriff-identity-webhook: duplicate event ignored", { eventId, applicationId, identitySessionId });
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
    if (errCode === "23505" || /duplicate key|unique/i.test(msg)) {
      console.info("veriff-identity-webhook: duplicate event ignored from insert conflict", { eventId, applicationId, identitySessionId });
      return res.status(200).json({ received: true, duplicate: true });
    }
    eventLogSkipped = true;
    console.error("veriff-identity-webhook event record failed; continuing without event log:", recordErr);
  }

  if (!mappedStatus) {
    if (identitySessionId) {
      try {
        const decision = await fetchVeriffDecision(identitySessionId);
        if (decision.ok && decision.mappedStatus) {
          mappedStatus = decision.mappedStatus;
          matchedApplicationId = matchedApplicationId || decision.applicationId || "";
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
        console.warn("veriff-identity-webhook decision lookup failed:", decisionErr?.message || decisionErr);
      }
    }
    if (!mappedStatus) {
      return res.status(200).json({ received: true, ignored: true, eventLogSkipped });
    }
  }

  const identityPatch = mapIdentityUpdate(mappedStatus, payload);
  if (!identityPatch) {
    return res.status(200).json({ received: true, ignored: true, eventLogSkipped });
  }

  try {
    let current = null;
    if (matchedApplicationId) {
      current = await fetchRenterApplicationById(matchedApplicationId);
    }
    if ((!current || !current.ok) && identitySessionId) {
      const bySession = await fetchRenterApplicationByIdentitySessionId(identitySessionId);
      if (bySession.ok) {
        current = bySession;
        matchedApplicationId = bySession.data?.id || matchedApplicationId;
      }
    }
    if (!current || !current.ok) {
      console.error("veriff-identity-webhook application lookup failed:", {
        eventId,
        eventType,
        vendorData: applicationId || null,
        sessionId: identitySessionId || null,
        matchedApplicationId: matchedApplicationId || null,
        error: current?.error || "Application not found for webhook mapping.",
        details: current?.details || "",
      });
      return res.status(200).json({ received: true, ignored: true, eventLogSkipped });
    }

    if (isStaleIdentityUpdate(current.data || {}, identityPatch)) {
      return res.status(200).json({ received: true, ignored: true, stale: true });
    }

    const notificationKind = determineNotificationTypeOnTransition(current.data || {}, identityPatch);

    if (identityPatch.applicationStatus === "under_review") {
      const existingStatus = current.data?.application_status;
      if (existingStatus && !["submitted", "under_review"].includes(existingStatus)) {
        delete identityPatch.applicationStatus;
        delete identityPatch.reviewedAt;
        delete identityPatch.reviewedBy;
      }
    }

    const patchResult = await patchRenterApplicationIdentityById(matchedApplicationId, {
      ...identityPatch,
      identitySessionId: identitySessionId || current.data?.identity_session_id || null,
    });
    if (!patchResult.ok) {
      console.error("veriff-identity-webhook patch failed:", patchResult.error, patchResult.details || "");
      return res.status(500).json({ error: patchResult.error || "Could not update application." });
    }

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
      try {
        await sendIdentityVerifiedNotifications(patchResult.data || current.data || {});
      } catch (notifyErr) {
        console.error("veriff-identity-webhook verified notification failed:", notifyErr);
      }
      try {
        const checkrResult = await initiateCheckrScreening(matchedApplicationId);
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
        console.error("veriff-identity-webhook Checkr initiation failed:", checkrErr.message || checkrErr);
      }
    } else if (notificationKind === "requires_input" || notificationKind === "failed" || notificationKind === "canceled") {
      try {
        await sendIdentityIssueNotifications(patchResult.data || current.data || {}, notificationKind);
      } catch (notifyErr) {
        console.error("veriff-identity-webhook issue notification failed:", notifyErr);
      }
    }
  } catch (err) {
    console.error("veriff-identity-webhook processing failed:", err);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  return res.status(200).json({ received: true, eventLogSkipped });
}
