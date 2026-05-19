import crypto from "node:crypto";

const VERIFF_API_BASE = "https://stationapi.veriff.com/v1";
const VERIFF_FULLAUTO_VERSION = "1";

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
    const root = rawStatus;
    const nested = rawStatus?.data && typeof rawStatus.data === "object" ? rawStatus.data : null;
    candidates.push(
      root?.verification?.decision?.status,
      root?.verification?.decision?.label,
      root?.verification?.decision?.code,
      root?.verification?.decision?.decision,
      root?.decision?.status,
      root?.decision?.label,
      root?.decision?.code,
      root?.decision?.decision,
      root?.verification?.status,
      root?.verification?.state,
      root?.verification?.decision,
      root?.eventType,
      root?.event_type,
      root?.action,
      root?.verification?.code,
      root?.decision,
      root?.status,
      nested?.verification?.decision?.status,
      nested?.verification?.decision?.label,
      nested?.verification?.decision?.code,
      nested?.verification?.decision?.decision,
      nested?.decision?.status,
      nested?.decision?.label,
      nested?.decision?.code,
      nested?.decision?.decision,
      nested?.verification?.status,
      nested?.verification?.state,
      nested?.verification?.decision,
      nested?.eventType,
      nested?.event_type,
      nested?.action,
      nested?.verification?.code,
      nested?.decision,
      nested?.status,
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
    payload?.data?.verification?.decision?.status,
    payload?.data?.verification?.decision?.label,
    payload?.data?.verification?.decision?.code,
    payload?.data?.verification?.decision?.decision,
    payload?.data?.decision?.status,
    payload?.data?.decision?.label,
    payload?.data?.decision?.code,
    payload?.data?.decision?.decision,
    payload?.data?.verification?.status,
    payload?.data?.verification?.state,
    payload?.data?.verification?.decision,
    payload?.data?.eventType,
    payload?.data?.event_type,
    payload?.data?.action,
    payload?.data?.verification?.code,
    payload?.data?.decision,
    payload?.data?.status,
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
    payload?.data?.verification?.decision?.status,
    payload?.data?.verification?.decision?.label,
    payload?.data?.verification?.decision?.code,
    payload?.data?.verification?.decision?.decision,
    payload?.data?.decision?.status,
    payload?.data?.decision?.label,
    payload?.data?.decision?.code,
    payload?.data?.decision?.decision,
    payload?.data?.decision,
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
    payload?.data?.verification?.vendorData,
    payload?.data?.verification?.vendor_data,
    payload?.data?.vendorData,
    payload?.data?.vendor_data,
    payload?.data?.verification?.metadata?.application_id,
    payload?.data?.metadata?.application_id,
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
    payload?.data?.verification?.id,
    payload?.data?.verification?.sessionId,
    payload?.data?.verification?.session_id,
    payload?.data?.sessionId,
    payload?.data?.session_id,
    payload?.data?.id,
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
    payload?.data?.verification?.url,
    payload?.data?.verification?.hostedUrl,
    payload?.data?.verification?.hosted_url,
    payload?.data?.verification?.sessionUrl,
    payload?.data?.verification?.session_url,
    payload?.data?.url,
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

  const hmacSignature = crypto.createHmac("sha256", cfg.sharedSecret).update(sessionId).digest("hex");
  const requestHeaders = {
    "Content-Type": "application/json",
    "X-AUTH-CLIENT": cfg.apiKey,
    "X-AUTH-CLIENT-PROJECT": cfg.projectId,
    "X-HMAC-SIGNATURE": hmacSignature,
  };
  const enableFullAutoLookup = toLower(process.env.VERIFF_ENABLE_FULLAUTO_DECISION_LOOKUP || "true") !== "false";
  const alwaysCompareFullAuto = toLower(process.env.VERIFF_COMPARE_DECISION_ENDPOINTS || "false") === "true";
  const primaryEndpoint = `${VERIFF_API_BASE}/sessions/${encodeURIComponent(sessionId)}/decision`;
  const fullAutoEndpoint = `${VERIFF_API_BASE}/sessions/${encodeURIComponent(sessionId)}/decision/fullauto?version=${VERIFF_FULLAUTO_VERSION}`;

  async function callDecisionEndpoint(endpoint, endpointKind) {
    const requestMeta = buildVeriffRequestDiagnostics(cfg, endpoint, "GET", requestHeaders);
    console.info("veriff:fetch-decision request", {
      ...requestMeta,
      endpointKind,
    });
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: requestHeaders,
    });
    const payload = await response.json().catch(() => ({}));
    console.info("veriff:fetch-decision response", {
      endpointKind,
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
    return { endpointKind, endpoint, response, payload };
  }

  function parseDecisionPayload(payload = {}) {
    const rawStatus = extractVeriffStatus(payload);
    const decisionStatus = extractVeriffDecisionStatus(payload, rawStatus);
    const mappedStatus = mapVeriffDecisionToIdentityStatus(payload)
      || mapVeriffDecisionToIdentityStatus(decisionStatus || rawStatus);
    const verificationPayload = payload?.verification ?? payload?.data?.verification ?? null;
    const decisionPayload = payload?.decision ?? payload?.verification?.decision ?? payload?.data?.decision ?? null;
    return {
      rawStatus,
      decisionStatus,
      mappedStatus,
      sessionId: extractVeriffSessionId(payload) || sessionId,
      verificationUrl: extractVeriffVerificationUrl(payload),
      applicationId: extractVeriffApplicationId(payload),
      verificationPayload,
      decisionPayload,
    };
  }

  function summarizeParsedDecision(parsed = {}, payload = {}) {
    return {
      rawStatus: parsed.rawStatus || null,
      decisionStatus: parsed.decisionStatus || null,
      mappedStatus: parsed.mappedStatus || null,
      hasVerificationPayload: !!parsed.verificationPayload,
      hasDecisionPayload: !!parsed.decisionPayload,
      topLevelKeys: Object.keys(payload || {}),
      verificationKeys: parsed.verificationPayload && typeof parsed.verificationPayload === "object"
        ? Object.keys(parsed.verificationPayload)
        : [],
      decisionKeys: parsed.decisionPayload && typeof parsed.decisionPayload === "object"
        ? Object.keys(parsed.decisionPayload)
        : [],
      extractionKeys: payload?.extraction && typeof payload.extraction === "object"
        ? Object.keys(payload.extraction)
        : [],
    };
  }

  const primaryResult = await callDecisionEndpoint(primaryEndpoint, "default");
  if (!primaryResult.response.ok) {
    console.warn("veriff:fetch-decision failed", {
      sessionId,
      endpoint: primaryEndpoint,
      endpointKind: "default",
      status: Number(primaryResult.response?.status) || null,
      body: primaryResult.payload,
    });
    return {
      ok: false,
      status: primaryResult.response.status || 500,
      error: primaryResult.payload?.message || primaryResult.payload?.error || "Failed to retrieve verification decision.",
      details: primaryResult.payload,
    };
  }

  const primaryParsed = parseDecisionPayload(primaryResult.payload);
  const shouldCallFullAuto = enableFullAutoLookup && (
    alwaysCompareFullAuto
    || !primaryParsed.mappedStatus
    || !primaryParsed.verificationPayload
  );
  let fullAutoResult = null;
  let fullAutoParsed = null;

  if (shouldCallFullAuto) {
    fullAutoResult = await callDecisionEndpoint(fullAutoEndpoint, "fullauto");
    if (fullAutoResult.response.ok) {
      fullAutoParsed = parseDecisionPayload(fullAutoResult.payload);
    }
    console.info("veriff:fetch-decision comparison", {
      sessionId,
      selectedEndpoint: (fullAutoResult.response.ok && fullAutoParsed?.mappedStatus) ? "fullauto" : "default",
      defaultEndpoint: {
        status: Number(primaryResult.response?.status) || null,
        ok: !!primaryResult.response?.ok,
        ...summarizeParsedDecision(primaryParsed, primaryResult.payload),
      },
      fullAutoEndpoint: {
        status: Number(fullAutoResult.response?.status) || null,
        ok: !!fullAutoResult.response?.ok,
        ...summarizeParsedDecision(fullAutoParsed || {}, fullAutoResult.payload),
      },
      decisionPayloadShapeDiff: {
        defaultTopLevelKeys: Object.keys(primaryResult.payload || {}),
        fullAutoTopLevelKeys: Object.keys(fullAutoResult.payload || {}),
      },
    });
  }

  const selectedKind = (fullAutoResult?.response?.ok && fullAutoParsed?.mappedStatus) ? "fullauto" : "default";
  const selectedPayload = selectedKind === "fullauto" ? fullAutoResult.payload : primaryResult.payload;
  const selectedParsed = selectedKind === "fullauto" ? fullAutoParsed : primaryParsed;
  console.info("veriff:fetch-decision parsed", {
    sessionId,
    endpointKind: selectedKind,
    rawStatus: selectedParsed?.rawStatus || null,
    decisionStatus: selectedParsed?.decisionStatus || null,
    mappedStatus: selectedParsed?.mappedStatus || null,
    rawDecisionPayload: selectedPayload,
  });
  return {
    ok: true,
    payload: selectedPayload,
    rawStatus: selectedParsed?.rawStatus || null,
    decisionStatus: selectedParsed?.decisionStatus || null,
    mappedStatus: selectedParsed?.mappedStatus || null,
    sessionId: selectedParsed?.sessionId || sessionId,
    verificationUrl: selectedParsed?.verificationUrl || null,
    applicationId: selectedParsed?.applicationId || null,
    endpointKind: selectedKind,
    endpointComparison: shouldCallFullAuto
      ? {
        default: summarizeParsedDecision(primaryParsed, primaryResult.payload),
        fullauto: summarizeParsedDecision(fullAutoParsed || {}, fullAutoResult?.payload || {}),
      }
      : null,
  };
}
