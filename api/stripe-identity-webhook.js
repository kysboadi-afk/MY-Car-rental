import { getSupabaseAdmin } from "./_supabase.js";
import {
  patchRenterApplicationIdentityById,
  fetchRenterApplicationById,
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
} from "./_veriff.js";

export const config = {
  api: { bodyParser: false },
};

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

async function isDuplicateEvent(sb, stripeEventId) {
  const { data, error } = await sb
    .from("stripe_identity_webhook_events")
    .select("id")
    .eq("stripe_event_id", stripeEventId)
    .maybeSingle();
  if (error) throw error;
  return !!data?.id;
}

async function recordEvent(sb, eventId, payload, eventType, applicationId, sessionId) {
  const { error } = await sb
    .from("stripe_identity_webhook_events")
    .insert({
      stripe_event_id: eventId,
      event_type: eventType,
      application_id: applicationId || null,
      identity_session_id: sessionId || null,
      payload,
    });
  if (error) throw error;
}

export default async function handler(req, res) {
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
  const mappedStatus = mapVeriffDecisionToIdentityStatus(rawStatus);
  const applicationId = extractVeriffApplicationId(payload);
  const identitySessionId = extractVeriffSessionId(payload);
  const eventId = getEventId(payload, identitySessionId, rawStatus);
  const eventType = String(rawStatus || payload?.eventType || payload?.event_type || "unknown").slice(0, 200);

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("veriff-identity-webhook: Supabase unavailable");
    return res.status(503).json({ error: "Application storage service is not configured." });
  }

  try {
    const duplicate = await isDuplicateEvent(sb, eventId);
    if (duplicate) {
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (dupErr) {
    console.error("veriff-identity-webhook duplicate check failed:", dupErr.message || dupErr);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  try {
    await recordEvent(sb, eventId, payload, eventType, applicationId, identitySessionId);
  } catch (recordErr) {
    const errCode = String(recordErr?.code || "");
    const msg = String(recordErr?.message || "");
    if (errCode === "23505" || /duplicate key|unique/i.test(msg)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error("veriff-identity-webhook event record failed:", recordErr);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  if (!mappedStatus) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const identityPatch = mapIdentityUpdate(mappedStatus, payload);
  if (!identityPatch) {
    return res.status(200).json({ received: true, ignored: true });
  }

  if (!applicationId) {
    console.warn("veriff-identity-webhook: missing application id in webhook payload", {
      eventType,
      sessionId: identitySessionId,
    });
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const current = await fetchRenterApplicationById(applicationId);
    if (!current.ok) {
      console.error("veriff-identity-webhook application lookup failed:", current.error, current.details || "");
      return res.status(200).json({ received: true, ignored: true });
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

    const patchResult = await patchRenterApplicationIdentityById(applicationId, {
      ...identityPatch,
      identitySessionId: identitySessionId || current.data?.identity_session_id || null,
    });
    if (!patchResult.ok) {
      console.error("veriff-identity-webhook patch failed:", patchResult.error, patchResult.details || "");
      return res.status(500).json({ error: patchResult.error || "Could not update application." });
    }

    if (notificationKind === "verified") {
      try {
        await sendIdentityVerifiedNotifications(patchResult.data || current.data || {});
      } catch (notifyErr) {
        console.error("veriff-identity-webhook verified notification failed:", notifyErr);
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

  return res.status(200).json({ received: true });
}
