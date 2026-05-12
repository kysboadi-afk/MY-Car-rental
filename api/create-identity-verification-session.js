import Stripe from "stripe";
import {
  fetchRenterApplicationById,
  patchRenterApplicationIdentityById,
} from "./_renter-applications.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const DEFAULT_RETURN_URL = "https://www.slytrans.com/thank-you.html?from=apply";

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
  if (application.identity_status === "verified") {
    return res.status(200).json({
      success: true,
      alreadyVerified: true,
      identityStatus: "verified",
      applicationId,
    });
  }

  const duplicateObserved = !!(
    application.identity_session_id &&
    (application.identity_status === "requires_input" || application.identity_status === "processing")
  );
  if (duplicateObserved) {
    console.warn(
      "create-identity-verification-session duplicate observation:",
      `applicationId=${applicationId} existingSession=${application.identity_session_id}`
    );
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
      duplicateObserved,
    });
  } catch (err) {
    console.error("create-identity-verification-session failed:", err);
    return res.status(500).json({ error: "Failed to create identity verification session." });
  }
}
