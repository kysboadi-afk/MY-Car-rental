// api/resolve-identity-resume.js
//
// GET /api/resolve-identity-resume?token=<resume-token>
//
// Validates an HMAC-signed identity resume token (created by
// _identity-resume-token.js / buildResumeUrl), then resolves the applicant's
// current Stripe Identity session state and either reuses an existing
// resumable session or creates a fresh one.
//
// This endpoint is the backend half of the recovery-link flow.  The frontend
// (thank-you.html, from=resume) calls it automatically when an applicant
// arrives via an SMS/email recovery link.
//
// Response shapes:
//   • blocked        — terminal application status (approved/rejected/expired/withdrawn)
//   • alreadyVerified — identity already complete; no action needed
//   • processing     — Stripe is reviewing the submission; nothing to do
//   • clientSecret + publishableKey — session ready; frontend should call
//                     stripe.verifyIdentity(clientSecret) immediately
//   • error          — token invalid/expired, or server error

import Stripe from "stripe";
import { verifyResumeToken } from "./_identity-resume-token.js";
import {
  fetchRenterApplicationById,
  patchRenterApplicationIdentityById,
} from "./_renter-applications.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Use the stable from=apply return path so the existing identity=return handling
// works regardless of how the applicant started verification.
const DEFAULT_RETURN_URL = "https://www.slytrans.com/thank-you.html?from=apply";

// Application statuses where identity verification is no longer applicable.
const TERMINAL_APPLICATION_STATUSES = new Set(["approved", "rejected", "expired", "withdrawn"]);

function getReturnUrl(applicationId) {
  const u = new URL(DEFAULT_RETURN_URL);
  u.searchParams.set("identity",      "return");
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

  // ── Token validation ────────────────────────────────────────────────────────
  // verifyResumeToken performs HMAC-SHA256 + TTL check; returns null on failure.
  const applicationId = verifyResumeToken(rawToken);
  if (!applicationId) {
    return res.status(401).json({ error: "Invalid or expired recovery link." });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Server configuration error: Stripe credentials are not set." });
  }

  // ── Load application ────────────────────────────────────────────────────────
  const appResult = await fetchRenterApplicationById(applicationId);
  if (!appResult.ok) {
    return res.status(appResult.status || 500).json({ error: appResult.error || "Application not found." });
  }
  const application = appResult.data || {};

  // ── Lifecycle guard: block terminal application states ──────────────────────
  if (TERMINAL_APPLICATION_STATUSES.has(application.application_status)) {
    return res.status(200).json({
      success: false,
      blocked: true,
      reason: "application_status",
      applicationStatus: application.application_status,
      applicationId,
    });
  }

  // ── Identity already verified ───────────────────────────────────────────────
  if (application.identity_status === "verified") {
    return res.status(200).json({
      success: true,
      alreadyVerified: true,
      identityStatus: "verified",
      applicationId,
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // ── Session reuse: retrieve existing session before creating a new one ──────
  if (application.identity_session_id) {
    try {
      const existing = await stripe.identity.verificationSessions.retrieve(
        application.identity_session_id
      );

      if (existing.status === "verified") {
        // Webhook not yet processed — identity is complete; don't create a new session.
        return res.status(200).json({
          success: true,
          alreadyVerified: true,
          identityStatus: "verified",
          applicationId,
        });
      }

      if (existing.status === "processing") {
        // Stripe is reviewing the submission; nothing for the applicant to do.
        return res.status(200).json({
          success: true,
          processing: true,
          identityStatus: "processing",
          applicationId,
        });
      }

      if (existing.status === "requires_input") {
        // Session is active and resumable — return the same client_secret so
        // the frontend can mount the existing session without creating a duplicate.
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
        "resolve-identity-resume: session retrieve failed, creating new session:",
        retrieveErr.message || retrieveErr
      );
    }
  }

  // ── Create a fresh verification session ────────────────────────────────────
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: {
        application_id: applicationId,
      },
      options: {
        document: {
          require_live_capture:    true,
          require_matching_selfie: true,
        },
      },
      return_url: getReturnUrl(applicationId),
    });

    const patchResult = await patchRenterApplicationIdentityById(applicationId, {
      identitySessionId: session.id,
      identityStatus:    "requires_input",
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
      identityStatus:        "requires_input",
      verificationSessionId: session.id,
      clientSecret:          session.client_secret,
      publishableKey:        process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("resolve-identity-resume failed:", err);
    return res.status(500).json({ error: "Failed to create identity verification session." });
  }
}
