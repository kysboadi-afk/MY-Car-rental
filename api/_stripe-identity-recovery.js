import Stripe from "stripe";
import { patchRenterApplicationIdentityById } from "./_renter-applications.js";
import { sendIdentityVerifiedNotifications } from "./_application-notifications.js";

const NOTIFIABLE_APPLICATION_STATUSES = ["submitted", "under_review", "needs_info"];

function getStripeClient(existingClient = null) {
  if (existingClient) return existingClient;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

export async function recoverVerifiedApplicationFromStripe(
  application = {},
  { reviewedBy = "stripe_identity_recovery", stripeClient = null, notify = true } = {},
) {
  const applicationId = typeof application?.id === "string" ? application.id : "";
  const identitySessionId = typeof application?.identity_session_id === "string"
    ? application.identity_session_id
    : "";

  if (!applicationId || !identitySessionId) {
    return { ok: true, synced: false, skipped: true, reason: "missing_identity_session" };
  }

  const stripe = getStripeClient(stripeClient);
  if (!stripe) {
    return { ok: true, synced: false, skipped: true, reason: "stripe_unconfigured" };
  }

  let session;
  try {
    session = await stripe.identity.verificationSessions.retrieve(identitySessionId);
  } catch (err) {
    return {
      ok: false,
      synced: false,
      error: "Could not retrieve Stripe Identity session.",
      details: err?.message || String(err),
    };
  }

  const stripeStatus = String(session?.status || "").toLowerCase();
  if (stripeStatus !== "verified") {
    return { ok: true, synced: false, stripeStatus };
  }

  if (String(application.identity_status || "").toLowerCase() === "verified") {
    return { ok: true, synced: false, stripeStatus, alreadyVerified: true };
  }

  const applicationStatus = String(application.application_status || "").toLowerCase();
  const shouldNotify = notify && NOTIFIABLE_APPLICATION_STATUSES.includes(applicationStatus);
  const now = new Date().toISOString();
  const patch = {
    identitySessionId: session.id || identitySessionId,
    identityStatus: "verified",
    identityVerifiedAt: now,
  };

  if (applicationStatus === "submitted") {
    patch.applicationStatus = "under_review";
    patch.reviewedAt = now;
    patch.reviewedBy = reviewedBy;
  }

  const patchResult = await patchRenterApplicationIdentityById(applicationId, patch);
  if (!patchResult.ok) {
    return {
      ok: false,
      synced: false,
      error: patchResult.error || "Could not update application.",
      details: patchResult.details || "",
    };
  }

  if (shouldNotify) {
    try {
      await sendIdentityVerifiedNotifications(patchResult.data || application);
    } catch (notifyErr) {
      console.error("recoverVerifiedApplicationFromStripe notification failed:", notifyErr);
    }
  }

  return {
    ok: true,
    synced: true,
    stripeStatus,
    data: patchResult.data || application,
  };
}
