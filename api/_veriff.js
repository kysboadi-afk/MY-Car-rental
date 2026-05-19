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

function redactText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 6) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function classifyCredentialEnvironment(value) {
  const text = toLower(value);
  if (!text) return "missing";
  if (/test|sandbox|demo/.test(text)) return "sandbox";
  if (/live|prod|production/.test(text)) return "production";
  return "unknown";
}

function buildCredentialEnvironmentDiagnostics(cfg = {}) {
  const apiKeyEnvironment = classifyCredentialEnvironment(cfg.apiKey);
  const projectIdEnvironment = classifyCredentialEnvironment(cfg.projectId);
  const sameCredentialEnvironment = (
    apiKeyEnvironment !== "missing"
    && projectIdEnvironment !== "missing"
    && apiKeyEnvironment === projectIdEnvironment
  );
  return {
    apiKeyEnvironment,
    projectIdEnvironment,
    sameCredentialEnvironment,
  };
}

function detectLikelyEnvironmentMismatch(cfg = {}) {
  const vercelEnv = toLower(process.env.VERCEL_ENV || process.env.NODE_ENV);
  const key = toLower(cfg.apiKey);
  const project = toLower(cfg.projectId);
  const envDiag = buildCredentialEnvironmentDiagnostics(cfg);
  if (vercelEnv !== "production") return false;
  return (
    /test|sandbox|demo/.test(key)
    || /test|sandbox|demo/.test(project)
    || (envDiag.apiKeyEnvironment !== "missing"
      && envDiag.projectIdEnvironment !== "missing"
      && !envDiag.sameCredentialEnvironment)
  );
}

function buildVeriffRequestDiagnostics(cfg = {}, endpoint = "", method = "GET", requestHeaders = {}) {
  const headerNames = Object.keys(requestHeaders || {}).map((k) => String(k).toLowerCase());
  const hasClientHeader = headerNames.includes("x-auth-client");
  const hasProjectHeader = headerNames.includes("x-auth-client-project");
  const hasHmacHeader = headerNames.includes("x-hmac-signature");
  const credentialEnvironment = buildCredentialEnvironmentDiagnostics(cfg);
  return {
    method,
    endpoint,
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
    configPresent: {
      apiKey: !!cfg.apiKey,
      projectId: !!cfg.projectId,
      sharedSecret: !!cfg.sharedSecret,
    },
    authHeadersPresent: {
      xAuthClient: hasClientHeader,
      xAuthClientProject: hasProjectHeader,
      xHmacSignature: hasHmacHeader,
    },
    authHeaderNamesPresent: headerNames,
    configFingerprints: {
      apiKey: redactText(cfg.apiKey),
      projectId: redactText(cfg.projectId),
      sharedSecret: redactText(cfg.sharedSecret),
    },
    credentialEnvironment,
    likelyEnvMismatch: detectLikelyEnvironmentMismatch(cfg),
  };
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
  const base = pickString(process.env.VERIFF_WEBHOOK_BASE_URL) || "https://slycarrentals.com";
  const sanitized = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${sanitized}/api/veriff-webhook`;
}

export function mapVeriffDecisionToIdentityStatus(rawStatus) {
  const candidates = [];
  if (rawStatus && typeof rawStatus === "object") {
    candidates.push(
      rawStatus?.verification?.decision?.status,
      rawStatus?.verification?.decision?.label,
      rawStatus?.verification?.decision?.code,
      rawStatus?.verification?.decision?.decision,
      rawStatus?.decision?.status,
      rawStatus?.decision?.label,
      rawStatus?.decision?.code,
      rawStatus?.decision?.decision,
      rawStatus?.verification?.status,
      rawStatus?.verification?.state,
      rawStatus?.verification?.decision,
      rawStatus?.eventType,
      rawStatus?.event_type,
      rawStatus?.action,
      rawStatus?.verification?.code,
      rawStatus?.decision,
      rawStatus?.status,
    );
  } else {
    candidates.push(rawStatus);
  }

  for (const candidate of candidates) {
    const status = toLower(candidate);
    if (!status) continue;
    if (status.includes("approved")) return "verified";
    if (status.includes("declined") || status.includes("rejected") || status.includes("denied")) return "failed";
    if (
      status.includes("resubmission")
      || status.includes("request_input")
      || status.includes("requires_input")
      || status.includes("needs_input")
    ) {
      return "requires_input";
    }
    if (
      status.includes("pending")
      || status.includes("review")
      || status.includes("submitted")
      || status.includes("in_progress")
      || status.includes("waiting")
    ) {
      return "processing";
    }
    if (status.includes("canceled") || status.includes("cancelled") || status.includes("expired")) return "canceled";
  }
  return null;
}

export function extractVeriffStatus(payload = {}) {
  return pickString(
    payload?.verification?.decision?.status,
    payload?.verification?.decision?.label,
    payload?.verification?.decision?.code,
    payload?.verification?.decision?.decision,
    payload?.decision?.status,
    payload?.decision?.label,
    payload?.decision?.code,
    payload?.decision?.decision,
    payload?.verification?.status,
    payload?.verification?.state,
    payload?.verification?.decision,
    payload?.eventType,
    payload?.event_type,
    payload?.action,
    payload?.verification?.code,
    payload?.decision,
    payload?.status,
  );
}

export function extractVeriffDecisionStatus(payload = {}, fallbackStatus = "") {
  return pickString(
    payload?.verification?.decision?.status,
    payload?.verification?.decision?.label,
    payload?.verification?.decision?.code,
    payload?.verification?.decision?.decision,
    payload?.decision?.status,
    payload?.decision?.label,
    payload?.decision?.code,
    payload?.decision?.decision,
    payload?.decision,
    fallbackStatus,
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
    const endpoint = `${VERIFF_API_BASE}/sessions`;
    const requestMeta = buildVeriffRequestDiagnostics(cfg, endpoint, "POST", requestHeaders);
    console.info("veriff:create-session request", requestMeta);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    console.info("veriff:create-session response", {
      endpoint,
      status: Number(response?.status) || null,
      ok: !!response?.ok,
      error: payload?.message || payload?.error || null,
    });
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

  const endpoint = `${VERIFF_API_BASE}/sessions/${encodeURIComponent(sessionId)}/decision`;
  const hmacSignature = crypto.createHmac("sha256", cfg.sharedSecret).update(sessionId).digest("hex");
  const requestHeaders = {
    "Content-Type": "application/json",
    "X-AUTH-CLIENT": cfg.apiKey,
    "X-AUTH-CLIENT-PROJECT": cfg.projectId,
    "X-HMAC-SIGNATURE": hmacSignature,
  };
  const requestMeta = buildVeriffRequestDiagnostics(cfg, endpoint, "GET", requestHeaders);
  console.info("veriff:fetch-decision request", requestMeta);
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: requestHeaders,
  });
  const payload = await response.json().catch(() => ({}));
  console.info("veriff:fetch-decision response", {
    endpoint,
    status: Number(response?.status) || null,
    ok: !!response?.ok,
    error: payload?.message || payload?.error || null,
    body: payload,
    authHeaderNamesPresent: requestMeta.authHeaderNamesPresent,
    credentialEnvironment: requestMeta.credentialEnvironment,
    sameCredentialEnvironment: requestMeta?.credentialEnvironment?.sameCredentialEnvironment ?? null,
    likelyEnvMismatch: requestMeta.likelyEnvMismatch,
  });

  if (!response.ok) {
    console.warn("veriff:fetch-decision failed", {
      sessionId,
      endpoint,
      status: Number(response?.status) || null,
      body: payload,
    });
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.message || payload?.error || "Failed to retrieve verification decision.",
      details: payload,
    };
  }

  const rawStatus = extractVeriffStatus(payload);
  const decisionStatus = extractVeriffDecisionStatus(payload, rawStatus);
  const mappedStatus = mapVeriffDecisionToIdentityStatus(payload)
    || mapVeriffDecisionToIdentityStatus(decisionStatus || rawStatus);
  console.info("veriff:fetch-decision parsed", {
    sessionId,
    rawStatus: rawStatus || null,
    decisionStatus: decisionStatus || null,
    mappedStatus: mappedStatus || null,
    rawDecisionPayload: payload,
  });
  return {
    ok: true,
    payload,
    rawStatus,
    decisionStatus,
    mappedStatus,
    sessionId: extractVeriffSessionId(payload) || sessionId,
    verificationUrl: extractVeriffVerificationUrl(payload),
    applicationId: extractVeriffApplicationId(payload),
  };
}
