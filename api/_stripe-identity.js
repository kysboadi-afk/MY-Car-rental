import Stripe from "stripe";

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function cleanMetadataValue(value, maxLen = 500) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLen);
}

function buildIdentityVerificationUrl(clientSecret) {
  const secret = pickString(clientSecret);
  if (!secret) return "";
  return `https://verify.stripe.com/start/${encodeURIComponent(secret)}`;
}

export function isStripeIdentitySessionId(value) {
  return /^vs_/i.test(String(value || "").trim());
}

export function getStripeIdentityConfig() {
  const secretKey = pickString(process.env.STRIPE_SECRET_KEY);
  const publishableKey = pickString(process.env.STRIPE_PUBLISHABLE_KEY);
  const webhookSecret = pickString(
    process.env.STRIPE_IDENTITY_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET,
  );
  return {
    configured: !!secretKey,
    webhookConfigured: !!(secretKey && webhookSecret),
    secretKey,
    publishableKey,
    webhookSecret,
  };
}

export function mapStripeIdentityStatusToIdentityStatus(rawStatus = "", eventType = "") {
  const status = String(rawStatus || "").trim().toLowerCase();
  const evt = String(eventType || "").trim().toLowerCase();

  if (status === "verified" || evt.endsWith(".verified")) return "verified";
  if (status === "processing" || evt.endsWith(".processing")) return "processing";
  if (status === "requires_input" || evt.endsWith(".requires_input")) return "requires_input";
  if (status === "canceled" || evt.endsWith(".canceled") || evt.endsWith(".redacted")) return "canceled";
  return null;
}

export function extractStripeApplicationId(source = {}) {
  return pickString(
    source?.metadata?.application_id,
    source?.metadata?.applicationId,
    source?.metadata?.vendorData,
  );
}

function getStripeClient() {
  const cfg = getStripeIdentityConfig();
  if (!cfg.configured) return null;
  return new Stripe(cfg.secretKey);
}

export async function createStripeIdentitySession({
  applicationId,
  returnUrl,
  person = {},
} = {}) {
  const stripe = getStripeClient();
  if (!stripe) {
    return { ok: false, status: 500, error: "Server configuration error: Stripe credentials are not set." };
  }

  const metadata = {
    application_id: cleanMetadataValue(applicationId, 100),
    provider: "stripe_identity",
  };
  const firstName = cleanMetadataValue(person?.firstName, 100);
  const lastName = cleanMetadataValue(person?.lastName, 100);
  if (firstName) metadata.first_name = firstName;
  if (lastName) metadata.last_name = lastName;

  try {
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata,
      options: {
        document: {
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
      return_url: returnUrl || undefined,
    });

    const rawStatus = pickString(session?.status) || "requires_input";
    const mappedStatus = mapStripeIdentityStatusToIdentityStatus(rawStatus) || "requires_input";
    const sessionId = pickString(session?.id);
    const clientSecret = pickString(session?.client_secret);
    // Prefer session.url (the canonical short-lived hosted URL that Stripe provides)
    // over a hand-rolled URL built from client_secret. session.url is valid for 48h
    // and is the correct target for redirect-based identity verification.
    const verificationUrl = pickString(session?.url) || buildIdentityVerificationUrl(clientSecret);
    if (!sessionId) {
      return { ok: false, status: 502, error: "Stripe returned an incomplete session response." };
    }

    return {
      ok: true,
      sessionId,
      clientSecret: clientSecret || null,
      verificationUrl: verificationUrl || null,
      rawStatus,
      mappedStatus,
      payload: session,
    };
  } catch (err) {
    return {
      ok: false,
      status: Number(err?.statusCode) || 500,
      error: err?.message || "Failed to create identity verification session.",
      details: err?.raw || null,
    };
  }
}

export async function retrieveStripeIdentitySession(sessionId) {
  const stripe = getStripeClient();
  if (!stripe) {
    return { ok: false, status: 500, error: "Server configuration error: Stripe credentials are not set." };
  }
  const normalizedSessionId = pickString(sessionId);
  if (!normalizedSessionId) {
    return { ok: false, status: 400, error: "sessionId is required." };
  }

  try {
    const session = await stripe.identity.verificationSessions.retrieve(normalizedSessionId);
    const rawStatus = pickString(session?.status);
    const mappedStatus = mapStripeIdentityStatusToIdentityStatus(rawStatus);
    const clientSecret = pickString(session?.client_secret);
    // Prefer session.url (Stripe re-issues a fresh short-lived hosted URL on every
    // retrieve call) over a hand-rolled URL built from client_secret. Using session.url
    // ensures that requires_input session reuse always provides a valid, unexpired link.
    const verificationUrl = pickString(session?.url) || buildIdentityVerificationUrl(clientSecret);
    return {
      ok: true,
      sessionId: pickString(session?.id) || normalizedSessionId,
      applicationId: extractStripeApplicationId(session),
      rawStatus: rawStatus || null,
      mappedStatus: mappedStatus || null,
      clientSecret: clientSecret || null,
      verificationUrl: verificationUrl || null,
      payload: session,
    };
  } catch (err) {
    return {
      ok: false,
      status: Number(err?.statusCode) || 500,
      error: err?.message || "Failed to retrieve identity verification session.",
      details: err?.raw || null,
    };
  }
}
