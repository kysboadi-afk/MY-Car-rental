import crypto from "node:crypto";

const VERIFF_API_BASE = "https://stationapi.veriff.com/v1";

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function toLower(value) {
  return String(value || "").trim().toLowerCase();
}

export function getVeriffConfig() {
  const apiKey = pickString(process.env.VERIFF_API_KEY);
  const sharedSecret = pickString(process.env.VERIFF_SHARED_SECRET);
  const projectId = pickString(process.env.VERIFF_PROJECT_ID);
  return {
    configured: !!(apiKey && sharedSecret && projectId),
    apiKey,
    sharedSecret,
    projectId,
  };
}

function defaultWebhookUrl() {
  const base = pickString(process.env.VERIFF_WEBHOOK_BASE_URL) || "https://sly-rides.vercel.app";
  const sanitized = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${sanitized}/api/veriff-webhook`;
}

export function mapVeriffDecisionToIdentityStatus(rawStatus) {
  const status = toLower(rawStatus);
  if (!status) return null;
  if (status.includes("approved")) return "verified";
  if (status.includes("declined") || status.includes("rejected")) return "failed";
  if (status.includes("resubmission") || status.includes("request_input") || status.includes("requires_input")) {
    return "requires_input";
  }
  if (status.includes("pending") || status.includes("review") || status.includes("submitted")) return "processing";
  if (status.includes("canceled") || status.includes("cancelled") || status.includes("expired")) return "canceled";
  return null;
}

export function extractVeriffStatus(payload = {}) {
  return pickString(
    payload?.verification?.status,
    payload?.verification?.state,
    payload?.verification?.decision,
    payload?.action,
    payload?.eventType,
    payload?.event_type,
    payload?.status,
    payload?.verification?.code,
    payload?.decision,
    payload?.decision?.status,
    payload?.verification?.decision?.status,
  );
}

export function extractVeriffApplicationId(payload = {}) {
  return pickString(
    payload?.verification?.vendorData,
    payload?.verification?.vendor_data,
    payload?.vendorData,
    payload?.vendor_data,
    payload?.verification?.metadata?.application_id,
    payload?.metadata?.application_id,
  );
}

export function extractVeriffSessionId(payload = {}) {
  return pickString(
    payload?.verification?.id,
    payload?.verification?.sessionId,
    payload?.verification?.session_id,
    payload?.sessionId,
    payload?.session_id,
    payload?.id,
  );
}

export function extractVeriffVerificationUrl(payload = {}) {
  return pickString(
    payload?.verification?.url,
    payload?.verification?.hostedUrl,
    payload?.verification?.hosted_url,
    payload?.verification?.sessionUrl,
    payload?.verification?.session_url,
    payload?.url,
  );
}

function buildSignatureCandidates(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return [];
  return headerValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^(sha256|v1|hmac)=/i, "").trim())
    .filter(Boolean);
}

function safeEquals(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isInvalidParametersError(status, payload = {}) {
  if (Number(status) !== 400) return false;
  const message = pickString(payload?.message, payload?.error);
  return /invalid parameters?/i.test(message);
}

export function verifyVeriffWebhookSignature(rawBody, headers = {}, sharedSecret) {
  if (!rawBody || !sharedSecret) return false;
  const signatureHeader = pickString(
    headers["x-hmac-signature"],
    headers["x-veriff-signature"],
    headers["veriff-signature"],
    headers["x-signature"],
  );
  const provided = buildSignatureCandidates(signatureHeader);
  if (!provided.length) return false;

  const hex = crypto.createHmac("sha256", sharedSecret).update(rawBody).digest("hex");
  const base64 = Buffer.from(hex, "hex").toString("base64");
  const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  return provided.some((candidate) => {
    const value = candidate.trim();
    return (
      safeEquals(value, hex) ||
      safeEquals(value.toLowerCase(), hex.toLowerCase()) ||
      safeEquals(value, base64) ||
      safeEquals(value, base64url)
    );
  });
}

export async function createVeriffSession({
  applicationId,
  callbackUrl,
  returnUrl,
  person = {},
  fetchImpl = fetch,
}) {
  const cfg = getVeriffConfig();
  if (!cfg.configured) {
    return { ok: false, status: 500, error: "Server configuration error: Veriff credentials are not set." };
  }

  const firstName = pickString(person.firstName);
  const lastName = pickString(person.lastName);
  const country = pickString(person.country);

  const verification = {
    vendorData: pickString(applicationId),
    callback: callbackUrl || defaultWebhookUrl(),
    timestamp: new Date().toISOString(),
  };
  console.info("createVeriffSession: creating session", {
    applicationId: verification.vendorData || null,
    callbackUrl: verification.callback,
    hasReturnUrl: !!returnUrl,
  });
  if (returnUrl) verification.url = returnUrl;
  if (firstName || lastName) {
    verification.person = {};
    if (firstName) verification.person.firstName = firstName;
    if (lastName) verification.person.lastName = lastName;
  }
  if (country) {
    verification.document = { country };
  }

  const requestHeaders = {
    "Content-Type": "application/json",
    "X-AUTH-CLIENT": cfg.apiKey,
    "X-AUTH-CLIENT-PROJECT": cfg.projectId,
  };

  async function postSession(body) {
    const response = await fetchImpl(`${VERIFF_API_BASE}/sessions`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }

  let body = { verification };
  let { response, payload } = await postSession(body);
  if (!response.ok && isInvalidParametersError(response.status, payload)) {
    body = {
      verification: {
        vendorData: verification.vendorData,
        callback: verification.callback,
        timestamp: verification.timestamp,
      },
    };
    ({ response, payload } = await postSession(body));
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.message || payload?.error || "Failed to create identity verification session.",
      details: payload,
    };
  }

  const sessionId = extractVeriffSessionId(payload);
  const verificationUrl = extractVeriffVerificationUrl(payload);
  const rawStatus = extractVeriffStatus(payload);
  const mappedStatus = mapVeriffDecisionToIdentityStatus(rawStatus) || "requires_input";

  if (!sessionId || !verificationUrl) {
    return { ok: false, status: 502, error: "Veriff returned an incomplete session response.", details: payload };
  }

  return {
    ok: true,
    sessionId,
    verificationUrl,
    rawStatus,
    mappedStatus,
    payload,
  };
}

export async function fetchVeriffDecision(sessionId, fetchImpl = fetch) {
  const cfg = getVeriffConfig();
  if (!cfg.configured) {
    return { ok: false, status: 500, error: "Server configuration error: Veriff credentials are not set." };
  }
  if (!sessionId || typeof sessionId !== "string") {
    return { ok: false, status: 400, error: "sessionId is required." };
  }

  const response = await fetchImpl(`${VERIFF_API_BASE}/sessions/${encodeURIComponent(sessionId)}/decision`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-AUTH-CLIENT": cfg.apiKey,
      "X-AUTH-CLIENT-PROJECT": cfg.projectId,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.message || payload?.error || "Failed to retrieve verification decision.",
      details: payload,
    };
  }

  const rawStatus = extractVeriffStatus(payload);
  return {
    ok: true,
    payload,
    rawStatus,
    mappedStatus: mapVeriffDecisionToIdentityStatus(rawStatus),
    sessionId: extractVeriffSessionId(payload) || sessionId,
    verificationUrl: extractVeriffVerificationUrl(payload),
    applicationId: extractVeriffApplicationId(payload),
  };
}
