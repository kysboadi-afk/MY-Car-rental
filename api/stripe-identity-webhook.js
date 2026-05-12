import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  patchRenterApplicationIdentityById,
  fetchRenterApplicationById,
} from "./_renter-applications.js";

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

function mapIdentityUpdate(session = {}) {
  const status = String(session.status || "").toLowerCase();
  const err = session.last_error || {};

  if (status === "verified") {
    return {
      identityStatus: "verified",
      identityLastError: null,
      identityVerifiedAt: new Date().toISOString(),
      applicationStatus: "under_review",
      reviewedAt: new Date().toISOString(),
      reviewedBy: "stripe_identity_webhook",
    };
  }
  if (status === "requires_input") {
    const reason = err.code || err.reason || err.type || "requires_input";
    return {
      identityStatus: "requires_input",
      identityLastError: String(reason).slice(0, 2000),
    };
  }
  if (status === "processing") {
    return {
      identityStatus: "processing",
      identityLastError: null,
    };
  }
  if (status === "canceled") {
    const reason = err.code || err.reason || err.type || "canceled";
    return {
      identityStatus: "canceled",
      identityLastError: String(reason).slice(0, 2000),
    };
  }

  return null;
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

async function recordEvent(sb, event, applicationId, sessionId) {
  const { error } = await sb
    .from("stripe_identity_webhook_events")
    .insert({
      stripe_event_id: event.id,
      event_type: event.type,
      application_id: applicationId || null,
      identity_session_id: sessionId || null,
      payload: event.data?.object || {},
    });
  if (error) throw error;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_IDENTITY_WEBHOOK_SECRET) {
    return res.status(500).send("Server configuration error");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_IDENTITY_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-identity-webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data?.object || {};
  const applicationId = typeof session?.metadata?.application_id === "string"
    ? session.metadata.application_id.trim()
    : "";
  const identitySessionId = typeof session.id === "string" ? session.id : null;

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("stripe-identity-webhook: Supabase unavailable");
    return res.status(503).json({ error: "Application storage service is not configured." });
  }

  try {
    const duplicate = await isDuplicateEvent(sb, event.id);
    if (duplicate) {
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (dupErr) {
    console.error("stripe-identity-webhook duplicate check failed:", dupErr.message || dupErr);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  try {
    await recordEvent(sb, event, applicationId || null, identitySessionId);
  } catch (recordErr) {
    const msg = String(recordErr?.message || "");
    if (/duplicate key|unique/i.test(msg)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.error("stripe-identity-webhook event record failed:", recordErr);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  const identityPatch = mapIdentityUpdate(session);
  if (!identityPatch) {
    return res.status(200).json({ received: true, ignored: true });
  }

  if (!applicationId) {
    console.warn("stripe-identity-webhook: missing metadata.application_id", {
      eventType: event.type,
      sessionId: identitySessionId,
    });
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const current = await fetchRenterApplicationById(applicationId);
    if (!current.ok) {
      console.error("stripe-identity-webhook application lookup failed:", current.error, current.details || "");
      return res.status(200).json({ received: true, ignored: true });
    }

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
      identitySessionId,
    });
    if (!patchResult.ok) {
      console.error("stripe-identity-webhook patch failed:", patchResult.error, patchResult.details || "");
      return res.status(500).json({ error: patchResult.error || "Could not update application." });
    }
  } catch (err) {
    console.error("stripe-identity-webhook processing failed:", err);
    return res.status(500).json({ error: "Failed to process webhook event." });
  }

  return res.status(200).json({ received: true });
}
