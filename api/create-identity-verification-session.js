import {
  fetchRenterApplicationById,
  patchRenterApplicationIdentityById,
} from "./_renter-applications.js";
import { createVeriffSession, fetchVeriffDecision } from "./_veriff.js";
import {
  createStripeIdentitySession,
  getStripeIdentityConfig,
  isStripeIdentitySessionId,
  retrieveStripeIdentitySession,
} from "./_stripe-identity.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const DEFAULT_RETURN_URL = "https://slycarrentals.com/thank-you.html?from=apply";

// Application statuses where identity verification is no longer applicable.
// The resolver blocks new session creation for any of these states.
const TERMINAL_APPLICATION_STATUSES = new Set(["approved", "rejected", "expired", "withdrawn"]);

function buildVeriffPersonFromApplication(application = {}) {
  const fullName = typeof application.name === "string" ? application.name.trim() : "";
  if (!fullName) return {};
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function getReturnUrl(applicationId, requestOrigin) {
  // Use the request origin (if trusted) so the renter is returned to the same
  // domain they started from after completing Veriff identity verification.
  const base = (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin))
    ? requestOrigin + "/thank-you.html?from=apply"
    : DEFAULT_RETURN_URL;
  const u = new URL(base);
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

  const stripeIdentityCfg = getStripeIdentityConfig();
  const veriffConfigured = !!(process.env.VERIFF_API_KEY && process.env.VERIFF_SHARED_SECRET && process.env.VERIFF_PROJECT_ID);
  if (!stripeIdentityCfg.configured && !veriffConfigured) {
    return res.status(500).json({ error: "Server configuration error: identity verification provider is not configured." });
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

  // ── Session reuse: retrieve existing decision before creating a new session ─────────
  // Veriff does not always expose a resumable link for prior sessions, so if the
  // decision is still actionable we may still create a new session for retries.
  if (application.identity_session_id) {
    if (isStripeIdentitySessionId(application.identity_session_id)) {
      const existing = await retrieveStripeIdentitySession(application.identity_session_id);
      if (!existing.ok) {
        return res.status(200).json({
          success: true,
          processing: true,
          decisionUnavailable: true,
          identityStatus: "processing",
          applicationId,
        });
      }
      if (existing.mappedStatus === "verified") {
        if (application.identity_status !== "verified") {
          const syncPatch = {
            identitySessionId: existing.sessionId || application.identity_session_id,
            identityStatus: "verified",
            identityVerifiedAt: new Date().toISOString(),
          };
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
      if (existing.mappedStatus === "processing") {
        if (application.application_status === "submitted") {
          const syncPatch = {
            identityStatus: "processing",
            applicationStatus: "under_review",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "create_session_sync",
          };
          const syncResult = await patchRenterApplicationIdentityById(applicationId, syncPatch);
          if (!syncResult.ok) {
            console.error(
              "create-identity-verification-session processing sync failed:",
              syncResult.error,
              syncResult.details || ""
            );
          }
        } else if (application.identity_status !== "processing") {
          const syncResult = await patchRenterApplicationIdentityById(applicationId, {
            identityStatus: "processing",
          });
          if (!syncResult.ok) {
            console.error(
              "create-identity-verification-session processing status sync failed:",
              syncResult.error,
              syncResult.details || ""
            );
          }
        }
        return res.status(200).json({
          success: true,
          processing: true,
          identityStatus: "processing",
          applicationId,
        });
      }
      if (existing.mappedStatus === "requires_input" && existing.verificationUrl) {
        return res.status(200).json({
          success: true,
          applicationId,
          identityStatus: "requires_input",
          verificationSessionId: existing.sessionId || application.identity_session_id,
          verificationUrl: existing.verificationUrl,
          identityClientSecret: existing.clientSecret || null,
          sessionReused: true,
        });
      }
    } else {
    try {
      const existing = await fetchVeriffDecision(application.identity_session_id);
      if (!existing.ok) {
        return res.status(200).json({
          success: true,
          processing: true,
          decisionUnavailable: true,
          identityStatus: "processing",
          applicationId,
        });
      }
      if (existing.ok && existing.mappedStatus === "verified") {
        // Veriff decision is approved but our DB may not reflect it yet (webhook missed or
        // still in-flight). Sync the application state here so it appears in the review queue.
        if (application.identity_status !== "verified") {
          const syncPatch = {
            identitySessionId: existing.sessionId || application.identity_session_id,
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

      if (existing.mappedStatus === "processing") {
        // Veriff is processing the submission; advance the application so admin can see it
        // while awaiting the final decision webhook.
        if (application.application_status === "submitted") {
          const syncPatch = {
            identityStatus: "processing",
            applicationStatus: "under_review",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "create_session_sync",
          };
          const syncResult = await patchRenterApplicationIdentityById(applicationId, syncPatch);
          if (!syncResult.ok) {
            console.error(
              "create-identity-verification-session processing sync failed:",
              syncResult.error,
              syncResult.details || ""
            );
          }
        } else if (application.identity_status !== "processing") {
          const syncResult = await patchRenterApplicationIdentityById(applicationId, {
            identityStatus: "processing",
          });
          if (!syncResult.ok) {
            console.error(
              "create-identity-verification-session processing status sync failed:",
              syncResult.error,
              syncResult.details || ""
            );
          }
        }
        return res.status(200).json({
          success: true,
          processing: true,
          identityStatus: "processing",
          applicationId,
        });
      }

      if (existing.mappedStatus === "requires_input" && existing.verificationUrl) {
        // Existing verification can be resumed via hosted URL.
        return res.status(200).json({
          success: true,
          applicationId,
          identityStatus: "requires_input",
          verificationSessionId: existing.sessionId || application.identity_session_id,
          verificationUrl: existing.verificationUrl,
          sessionReused: true,
        });
      }

      // If decision is canceled/failed/unknown or lacks reusable URL, fall through
      // and create a fresh session below for retry/resubmission.
    } catch (retrieveErr) {
      // Decision retrieval is unavailable; avoid creating duplicate verification loops.
      console.warn(
        "create-identity-verification-session: session retrieve failed, returning processing state:",
        retrieveErr.message || retrieveErr
      );
      return res.status(200).json({
        success: true,
        processing: true,
        decisionUnavailable: true,
        identityStatus: "processing",
        applicationId,
      });
    }
    }
  }

  // ── Create a fresh verification session ───────────────────────────────────────────
  if (stripeIdentityCfg.configured) {
    const session = await createStripeIdentitySession({
      applicationId,
      returnUrl: getReturnUrl(applicationId, origin),
      person: buildVeriffPersonFromApplication(application),
    });
    if (!session.ok) {
      return res.status(session.status || 500).json({
        error: session.error || "Failed to create identity verification session.",
      });
    }
    const patchResult = await patchRenterApplicationIdentityById(applicationId, {
      identitySessionId: session.sessionId,
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
      verificationSessionId: session.sessionId,
      verificationUrl: session.verificationUrl,
      identityClientSecret: session.clientSecret || null,
      publishableKey: stripeIdentityCfg.publishableKey || null,
    });
  }

  try {
    const session = await createVeriffSession({
      applicationId,
      returnUrl: getReturnUrl(applicationId, origin),
      person: buildVeriffPersonFromApplication(application),
    });
    if (!session.ok) {
      return res.status(session.status || 500).json({
        error: session.error || "Failed to create identity verification session.",
      });
    }

    const patchResult = await patchRenterApplicationIdentityById(applicationId, {
      identitySessionId: session.sessionId,
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
      verificationSessionId: session.sessionId,
      verificationUrl: session.verificationUrl,
    });
  } catch (err) {
    console.error("create-identity-verification-session failed:", err);
    return res.status(500).json({ error: "Failed to create identity verification session." });
  }
}
