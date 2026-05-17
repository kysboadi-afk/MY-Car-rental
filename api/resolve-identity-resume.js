// api/resolve-identity-resume.js
import { verifyResumeToken } from "./_identity-resume-token.js";
import {
  fetchRenterApplicationById,
  patchRenterApplicationIdentityById,
} from "./_renter-applications.js";
import { createVeriffSession, fetchVeriffDecision } from "./_veriff.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const DEFAULT_RETURN_URL = "https://www.slytrans.com/thank-you.html?from=apply";
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const rawToken = typeof req.query?.token === "string" ? req.query.token.trim() : "";
  if (!rawToken) return res.status(400).json({ error: "token is required." });

  const applicationId = verifyResumeToken(rawToken);
  if (!applicationId) {
    return res.status(401).json({ error: "Invalid or expired recovery link." });
  }

  if (!process.env.VERIFF_API_KEY || !process.env.VERIFF_SHARED_SECRET || !process.env.VERIFF_PROJECT_ID) {
    return res.status(500).json({ error: "Server configuration error: Veriff credentials are not set." });
  }

  const appResult = await fetchRenterApplicationById(applicationId);
  if (!appResult.ok) {
    return res.status(appResult.status || 500).json({ error: appResult.error || "Application not found." });
  }
  const application = appResult.data || {};

  if (TERMINAL_APPLICATION_STATUSES.has(application.application_status)) {
    return res.status(200).json({
      success: false,
      blocked: true,
      reason: "application_status",
      applicationStatus: application.application_status,
      applicationId,
    });
  }

  if (application.identity_status === "verified") {
    return res.status(200).json({
      success: true,
      alreadyVerified: true,
      identityStatus: "verified",
      applicationId,
    });
  }

  if (application.identity_session_id) {
    try {
      const existing = await fetchVeriffDecision(application.identity_session_id);

      if (existing.ok && existing.mappedStatus === "verified") {
        if (application.identity_status !== "verified") {
          const syncPatch = {
            identitySessionId: existing.sessionId || application.identity_session_id,
            identityStatus: "verified",
            identityVerifiedAt: new Date().toISOString(),
          };
          if (!application.application_status || application.application_status === "submitted") {
            syncPatch.applicationStatus = "under_review";
            syncPatch.reviewedAt = new Date().toISOString();
            syncPatch.reviewedBy = "resolve_resume_sync";
          }
          const syncResult = await patchRenterApplicationIdentityById(applicationId, syncPatch);
          if (!syncResult.ok) {
            console.error(
              "resolve-identity-resume: verified sync failed:",
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

      if (existing.ok && existing.mappedStatus === "processing") {
        return res.status(200).json({
          success: true,
          processing: true,
          identityStatus: "processing",
          applicationId,
        });
      }

      if (existing.ok && existing.mappedStatus === "requires_input" && existing.verificationUrl) {
        return res.status(200).json({
          success: true,
          applicationId,
          identityStatus: "requires_input",
          verificationSessionId: existing.sessionId || application.identity_session_id,
          verificationUrl: existing.verificationUrl,
          sessionReused: true,
        });
      }
    } catch (retrieveErr) {
      console.warn(
        "resolve-identity-resume: decision lookup failed, creating new session:",
        retrieveErr.message || retrieveErr
      );
    }
  }

  try {
    const session = await createVeriffSession({
      applicationId,
      returnUrl: getReturnUrl(applicationId),
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
        "resolve-identity-resume patch failed:",
        patchResult.error,
        patchResult.details || ""
      );
      return res.status(patchResult.status || 500).json({
        error: patchResult.error || "Could not update application.",
      });
    }

    return res.status(200).json({
      success: true,
      applicationId,
      identityStatus: "requires_input",
      verificationSessionId: session.sessionId,
      verificationUrl: session.verificationUrl,
    });
  } catch (err) {
    console.error("resolve-identity-resume failed:", err);
    return res.status(500).json({ error: "Failed to create identity verification session." });
  }
}
