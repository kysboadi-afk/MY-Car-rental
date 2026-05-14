import Stripe from "stripe";
import {
  fetchRenterApplicationById,
  patchRenterApplicationIdentityById,
} from "./_renter-applications.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const DEFAULT_RETURN_URL = "https://www.slytrans.com/thank-you.html?from=apply";

// Application statuses where identity verification is no longer applicable.
// The resolver blocks new session creation for any of these states.
const TERMINAL_APPLICATION_STATUSES = new Set(["approved", "rejected", "expired", "withdrawn"]);

function getReturnUrl(applicationId) {
  const u = new URL(DEFAULT_RETURN_URL);
  u.searchParams.set("identity", "return");
  u.searchParams.set("applicationId", applicationId);
  return u.toString();
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Server configuration error: Stripe credentials are not set." });
  }

  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
  if (!applicationId) return res.status(400).json({ error: "applicationId is required." });

  const appResult = await fetchRenterApplicationById(applicationId);
  if (!appResult.ok) return res.status(appResult.status || 500).json({ error: appResult.error || "Application not found." });

  const application = appResult.data || {};

  // ── Lifecycle guard: block terminal application states ─────────────────────────────────
  // Recovery links become invalid after approval, rejection, expiry, or withdrawal.
  // The client should surface an appropriate message rather than offering verification.
  if (TERMINAL_APPLICATION_STATUSES.has(application.application_status)) {
    return res.status(200).json({
      success: false,
      blocked: true,
      reason: "application_status",
      applicationStatus: application.application_status,
      applicationId,
    });
  }

  // ── Identity already verified ───────────────────────────────────────────────────────────────
  if (application.identity_status === "verified") {
    return res.status(200).json({
      success: true,
      alreadyVerified: true,
      identityStatus: "verified",
      applicationId,
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // ── Session reuse: retrieve existing session before creating a new one ─────────────
  // If an active session already exists, reuse it to avoid duplicate sessions
  // and allow applicants to resume from email/SMS links or other devices.
  if (application.identity_session_id) {
    try {
      const existing = await stripe.identity.verificationSessions.retrieve(
        application.identity_session_id
      );

      if (existing.status === "verified") {
        // Stripe session is verified but our DB may not reflect it yet (webhook missed or
        // still in-flight). Sync the application state here so it appears in the review queue.
        if (application.identity_status !== "verified") {
          const syncPatch = {
            identitySessionId: existing.id,
            identityStatus: "verified",
            identityVerifiedAt: new Date().toISOString(),
          };
          // Only advance application_status if still in the initial submitted state.
          if (!application.application_status || application.application_status === "submitted") {
            syncPatch.applicationStatus = "under_review";
            syncPatch.reviewedAt = new Date().toISOString();
            syncPatch.reviewedBy = "create_session_sync";
          }
          const syncResult = await patchRenterApplicationIdentityById(applicationId, syncPatch);
          if (!syncResult.ok) {
            console.error(
              "create-identity-verification-session verified sync failed:",
              syncResult.error,
              syncResult.details || ""
            );
          }
        }
        return res.status(200).json({
          success: true,
          alreadyVerified: true,
          identityStatus: "verified",
          applicationId,
        });
      }

      if (existing.status === "processing") {
        // Stripe is processing the submission; no action needed from applicant.
        return res.status(200).json({
          success: true,
          processing: true,
          identityStatus: "processing",
          applicationId,
        });
      }

      if (existing.status === "requires_input") {
        // Session is still active and can be resumed. Return the existing
        // client_secret so the frontend mounts the same verification session.
        return res.status(200).json({
          success: true,
          applicationId,
          identityStatus: "requires_input",
          verificationSessionId: existing.id,
          clientSecret: existing.client_secret,
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
          sessionReused: true,
        });
      }

      // Status is "canceled" or an unrecognized terminal state — fall through
      // to create a fresh session below.
    } catch (retrieveErr) {
      // Session may have been deleted or Stripe returned an unexpected error.
      // Log and fall through to create a new session.
      console.warn(
        "create-identity-verification-session: session retrieve failed, creating new session:",
        retrieveErr.message || retrieveErr
      );
    }
  }

  // ── Create a fresh verification session ───────────────────────────────────────────
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: {
        application_id: applicationId,
      },
      options: {
        document: {
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
      return_url: getReturnUrl(applicationId),
    });

    const patchResult = await patchRenterApplicationIdentityById(applicationId, {
      identitySessionId: session.id,
      identityStatus: "requires_input",
      identityLastError: null,
    });
    if (!patchResult.ok) {
      console.error(
        "create-identity-verification-session patch failed:",
        patchResult.error,
        patchResult.details || ""
      );
      return res.status(patchResult.status || 500).json({ error: patchResult.error || "Could not update application." });
    }

    return res.status(200).json({
      success: true,
      applicationId,
      identityStatus: "requires_input",
      verificationSessionId: session.id,
      clientSecret: session.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("create-identity-verification-session failed:", err);
    return res.status(500).json({ error: "Failed to create identity verification session." });
  }
}
