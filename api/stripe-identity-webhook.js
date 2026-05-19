export const config = {
  api: { bodyParser: false },
};

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  fetchRenterApplicationById,
  fetchRenterApplicationByIdentitySessionId,
  patchRenterApplicationIdentityById,
} from "./_renter-applications.js";
import {
  extractStripeApplicationId,
  getStripeIdentityConfig,
  mapStripeIdentityStatusToIdentityStatus,
} from "./_stripe-identity.js";
import {
  sendIdentityIssueNotifications,
  sendIdentityVerifiedNotifications,
} from "./_application-notifications.js";
import { initiateCheckrScreening } from "./_checkr.js";

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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

function mapIdentityUpdate(identityStatus, rawStatus = "", currentStatus = "") {
  const patch = { identityStatus };
  const current = String(currentStatus || "").toLowerCase();
  if (identityStatus === "verified") {
    patch.identityVerifiedAt = new Date().toISOString();
    patch.identityLastError = null;
    if (current === "submitted") {
      patch.applicationStatus = "under_review";
      patch.reviewedAt = new Date().toISOString();
      patch.reviewedBy = "stripe_identity_webhook";
    }
    return patch;
  }
  if (identityStatus === "processing") {
    patch.identityLastError = null;
    if (current === "submitted") {
      patch.applicationStatus = "under_review";
      patch.reviewedAt = new Date().toISOString();
      patch.reviewedBy = "stripe_identity_webhook";
    }
    return patch;
  }
  if (identityStatus === "requires_input") {
    patch.identityLastError = String(rawStatus || "requires_input").slice(0, 2000);
    return patch;
  }
  if (identityStatus === "canceled") {
    patch.identityLastError = String(rawStatus || "canceled").slice(0, 2000);
    return patch;
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

async function isDuplicateEvent(sb, eventId) {
  const { data, error } = await sb
    .from("stripe_identity_webhook_events")
    .select("id")
    .eq("stripe_event_id", eventId)
    .maybeSingle();
  if (error) throw error;
  return !!data?.id;
}

async function recordEvent(sb, eventId, eventType, applicationId, sessionId, payload) {
  const { error } = await sb
    .from("stripe_identity_webhook_events")
    .insert({
      stripe_event_id: eventId,
      event_type: eventType,
      application_id: applicationId || null,
      identity_session_id: sessionId || null,
      payload: payload || {},
    });
  return { error };
}

async function enrichRecordedEvent(sb, eventId, applicationId, sessionId) {
  if (applicationId) {
    const { error } = await sb
      .from("stripe_identity_webhook_events")
      .update({ application_id: applicationId })
      .eq("stripe_event_id", eventId)
      .is("application_id", null);
    if (error) return { error };
  }

  if (sessionId) {
    const { error } = await sb
      .from("stripe_identity_webhook_events")
      .update({ identity_session_id: sessionId })
      .eq("stripe_event_id", eventId)
      .is("identity_session_id", null);
    if (error) return { error };
  }

  return { error: null };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const cfg = getStripeIdentityConfig();
  if (!cfg.webhookConfigured) {
    return res.status(500).send("Server configuration error");
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Application storage service is not configured." });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    return res.status(400).send("Invalid request body");
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).send("Webhook Error: missing stripe signature");

  const stripe = new Stripe(cfg.secretKey);
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event?.data?.object || {};
  const eventId = pickString(event?.id);
  const eventType = pickString(event?.type) || "unknown";
  const sessionId = pickString(session?.id);
  let applicationId = extractStripeApplicationId(session);
  const rawStatus = pickString(session?.status, eventType);
  const mappedStatus = mapStripeIdentityStatusToIdentityStatus(rawStatus, eventType);

  if (!eventId) return res.status(400).send("Webhook Error: missing event id");

  if (!applicationId && sessionId) {
    const bySession = await fetchRenterApplicationByIdentitySessionId(sessionId);
    if (bySession?.ok) {
      applicationId = bySession.data?.id || applicationId;
    }
  }

  try {
    if (await isDuplicateEvent(sb, eventId)) {
      const enrichResult = await enrichRecordedEvent(sb, eventId, applicationId, sessionId);
      if (enrichResult.error) {
        console.error("stripe-identity-webhook duplicate enrichment failed:", enrichResult.error.message || enrichResult.error);
      }
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (dupErr) {
    console.error("stripe-identity-webhook duplicate check failed:", dupErr.message || dupErr);
  }

  const recordResult = await recordEvent(sb, eventId, eventType, applicationId, sessionId, event);
  if (recordResult.error) {
    const code = String(recordResult.error?.code || "");
    if (code === "23505") {
      const enrichResult = await enrichRecordedEvent(sb, eventId, applicationId, sessionId);
      if (enrichResult.error) {
        console.error("stripe-identity-webhook duplicate enrichment failed:", enrichResult.error.message || enrichResult.error);
      }
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error("stripe-identity-webhook event logging failed:", recordResult.error.message || recordResult.error);
  }

  if (!mappedStatus) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const current = applicationId
    ? await fetchRenterApplicationById(applicationId)
    : await fetchRenterApplicationByIdentitySessionId(sessionId);
  if (!current?.ok) {
    if (!applicationId && sessionId) {
      const bySession = await fetchRenterApplicationByIdentitySessionId(sessionId);
      if (bySession?.ok) {
        applicationId = bySession.data?.id || applicationId;
      } else {
        return res.status(200).json({ received: true, ignored: true });
      }
    } else {
      return res.status(200).json({ received: true, ignored: true });
    }
  }

  const currentApp = current?.ok ? current.data : (await fetchRenterApplicationByIdentitySessionId(sessionId))?.data;
  if (!currentApp) return res.status(200).json({ received: true, ignored: true });
  applicationId = applicationId || currentApp.id || null;
  if (applicationId || sessionId) {
    const enrichResult = await enrichRecordedEvent(sb, eventId, applicationId, sessionId);
    if (enrichResult.error) {
      console.error("stripe-identity-webhook event enrichment failed:", enrichResult.error.message || enrichResult.error);
    }
  }
  const identityPatch = mapIdentityUpdate(mappedStatus, rawStatus, currentApp.application_status);
  if (!identityPatch) return res.status(200).json({ received: true, ignored: true });
  if (isStaleIdentityUpdate(currentApp, identityPatch)) {
    return res.status(200).json({ received: true, ignored: true, stale: true });
  }

  const notificationKind = determineNotificationTypeOnTransition(currentApp, identityPatch);
  const patchResult = await patchRenterApplicationIdentityById(currentApp.id, {
    ...identityPatch,
    identitySessionId: sessionId || currentApp.identity_session_id || null,
  });
  if (!patchResult.ok) {
    console.error("stripe-identity-webhook patch failed:", patchResult.error, patchResult.details || "");
    return res.status(500).json({ error: patchResult.error || "Could not update application." });
  }

  if (notificationKind === "verified") {
    try {
      await sendIdentityVerifiedNotifications(patchResult.data || currentApp);
    } catch (notifyErr) {
      console.error("stripe-identity-webhook verified notification failed:", notifyErr);
    }
    try {
      await initiateCheckrScreening(currentApp.id);
    } catch (checkrErr) {
      console.error("stripe-identity-webhook Checkr initiation failed:", checkrErr?.message || checkrErr);
    }
  } else if (notificationKind === "requires_input" || notificationKind === "failed" || notificationKind === "canceled") {
    try {
      await sendIdentityIssueNotifications(patchResult.data || currentApp, notificationKind);
    } catch (notifyErr) {
      console.error("stripe-identity-webhook issue notification failed:", notifyErr);
    }
  }

  return res.status(200).json({ received: true });
}
