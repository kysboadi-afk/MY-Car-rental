import crypto from "node:crypto";
import {
  fetchRenterApplicationById,
  patchRenterApplicationCheckrById,
} from "./_renter-applications.js";
import {
  sendCheckrInvitationNotifications,
} from "./_application-notifications.js";

const CHECKR_API_BASE = "https://api.checkr.com/v1";
const DEFAULT_PACKAGE = "driver_pro";

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function cleanObject(value) {
  return value && typeof value === "object" ? value : {};
}

function getAuthHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function splitApplicantName(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "Applicant" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
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

function buildApiHeaders(apiKey) {
  return {
    Authorization: getAuthHeader(apiKey),
    "Content-Type": "application/json",
  };
}

async function postJson(path, body, fetchImpl = fetch) {
  const cfg = getCheckrConfig();
  const response = await fetchImpl(`${CHECKR_API_BASE}${path}`, {
    method: "POST",
    headers: buildApiHeaders(cfg.apiKey),
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

export function getCheckrConfig() {
  const apiKey = pickString(process.env.CHECKR_API_KEY);
  const webhookSecret = pickString(process.env.CHECKR_WEBHOOK_SECRET);
  const packageSlug = pickString(process.env.CHECKR_PACKAGE) || DEFAULT_PACKAGE;
  return {
    configured: !!apiKey,
    apiKey,
    webhookSecret,
    packageSlug,
  };
}

export function mapCheckrReportStatus(status, adjudication) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const normalizedAdjudication = String(adjudication || "").trim().toLowerCase();
  if (normalizedStatus === "pending") return "pending";
  if (normalizedStatus === "suspended") return "suspended";
  if (normalizedStatus === "disputed") return "disputed";
  if (normalizedStatus === "complete" || normalizedStatus === "completed") {
    if (normalizedAdjudication === "clear") return "clear";
    if (normalizedAdjudication === "consider") return "consider";
    return "complete_no_adj";
  }
  return "error";
}

export function verifyCheckrWebhookSignature(rawBody, headers = {}, webhookSecret) {
  if (!rawBody || !webhookSecret) return false;
  const signatureHeader = pickString(
    headers["x-checkr-signature"],
    headers["checkr-signature"],
  );
  const provided = buildSignatureCandidates(signatureHeader);
  if (!provided.length) return false;

  const hex = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return provided.some((candidate) => {
    const value = candidate.trim();
    return safeEquals(value, hex) || safeEquals(value.toLowerCase(), hex.toLowerCase());
  });
}

export function buildCheckrCandidatePayload(application = {}) {
  const { firstName, lastName } = splitApplicantName(application.name);
  const payload = {
    first_name: firstName,
    last_name: lastName,
    work_locations: [{ country: "US" }],
  };
  const email = pickString(application.email);
  const phone = pickString(application.phone);
  const driverLicenseNumber = pickString(application.driver_license_number, application.driverLicenseNumber);
  const driverLicenseState = pickString(application.driver_license_state, application.driverLicenseState);
  const zipcode = pickString(application.zipcode);
  if (email) payload.email = email;
  if (phone) payload.phone = phone;
  if (driverLicenseNumber) payload.driver_license_number = driverLicenseNumber;
  if (driverLicenseState) payload.driver_license_state = driverLicenseState;
  if (zipcode) payload.zipcode = zipcode;
  return payload;
}

export async function createCheckrCandidate(application = {}, fetchImpl = fetch) {
  const cfg = getCheckrConfig();
  if (!cfg.configured) {
    return { ok: false, status: 500, error: "Server configuration error: Checkr credentials are not set." };
  }

  const body = buildCheckrCandidatePayload(application);
  const { response, payload } = await postJson("/candidates", body, fetchImpl);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.error || payload?.message || "Failed to create Checkr candidate.",
      details: payload,
    };
  }

  return {
    ok: true,
    candidateId: pickString(payload?.id),
    payload,
  };
}

export async function createCheckrInvitation({ candidateId, packageSlug }, fetchImpl = fetch) {
  const cfg = getCheckrConfig();
  if (!cfg.configured) {
    return { ok: false, status: 500, error: "Server configuration error: Checkr credentials are not set." };
  }
  if (!candidateId) return { ok: false, status: 400, error: "candidateId is required." };

  const body = {
    candidate_id: candidateId,
    package: packageSlug || cfg.packageSlug,
    work_locations: [{ country: "US" }],
  };
  const { response, payload } = await postJson("/invitations", body, fetchImpl);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.error || payload?.message || "Failed to create Checkr invitation.",
      details: payload,
    };
  }
  return {
    ok: true,
    invitationId: pickString(payload?.id),
    invitationUrl: pickString(payload?.invitation_url, payload?.url),
    reportId: pickString(payload?.report_id),
    payload,
  };
}

export function extractCheckrEventType(payload = {}) {
  return pickString(payload?.type, payload?.event, payload?.event_type);
}

export function extractCheckrReport(payload = {}) {
  return cleanObject(payload?.data?.object?.report || payload?.data?.object || payload?.report);
}

export function extractCheckrCandidate(payload = {}) {
  return cleanObject(payload?.data?.object?.candidate || payload?.candidate || payload?.data?.object);
}

export function extractCheckrMvrViolations(report = {}) {
  const motorVehicleReport = cleanObject(report?.motor_vehicle_report);
  const violations = motorVehicleReport?.violations;
  return Array.isArray(violations) ? violations.slice(0, 25) : null;
}

export function buildCheckrDashboardReportUrl(reportId) {
  const id = pickString(reportId);
  return id ? `https://dashboard.checkr.com/reports/${encodeURIComponent(id)}` : null;
}

export async function initiateCheckrScreening(applicationId, fetchImpl = fetch) {
  const cfg = getCheckrConfig();
  if (!cfg.configured) {
    return { ok: false, status: 500, error: "Server configuration error: Checkr credentials are not set." };
  }

  const appResult = await fetchRenterApplicationById(applicationId);
  if (!appResult.ok) return appResult;
  const application = appResult.data || {};

  if (application.identity_status !== "verified") {
    return { ok: false, status: 409, error: "Identity must be verified before Checkr screening can start." };
  }
  if (!application.agree_background_check) {
    return { ok: false, status: 422, error: "Background-check consent is required before Checkr screening can start." };
  }
  if (!application.driver_license_number || !application.driver_license_state) {
    return { ok: false, status: 422, error: "Driver license number and state are required before Checkr screening can start." };
  }
  if (application.checkr_candidate_id && application.checkr_report_status && application.checkr_report_status !== "error") {
    return {
      ok: true,
      alreadyStarted: true,
      candidateId: application.checkr_candidate_id,
      reportId: application.checkr_report_id || null,
      reportStatus: application.checkr_report_status,
    };
  }

  const candidateResult = await createCheckrCandidate(application, fetchImpl);
  if (!candidateResult.ok) {
    await patchRenterApplicationCheckrById(applicationId, {
      checkrReportStatus: "error",
      checkrLastError: candidateResult.error,
    }).catch(() => {});
    return candidateResult;
  }

  const invitationResult = await createCheckrInvitation({
    candidateId: candidateResult.candidateId,
    packageSlug: cfg.packageSlug,
  }, fetchImpl);
  if (!invitationResult.ok) {
    await patchRenterApplicationCheckrById(applicationId, {
      checkrCandidateId: candidateResult.candidateId,
      checkrReportStatus: "error",
      checkrLastError: invitationResult.error,
    }).catch(() => {});
    return invitationResult;
  }

  const patchResult = await patchRenterApplicationCheckrById(applicationId, {
    checkrCandidateId: candidateResult.candidateId,
    checkrReportId: invitationResult.reportId || null,
    checkrReportStatus: "pending",
    checkrLastError: null,
  });
  if (!patchResult.ok) return patchResult;

  try {
    await sendCheckrInvitationNotifications(
      {
        ...application,
        ...patchResult.data,
      },
      {
        invitationUrl: invitationResult.invitationUrl,
        packageSlug: cfg.packageSlug,
      },
    );
  } catch (notifyErr) {
    console.error("initiateCheckrScreening notification failed:", notifyErr.message || notifyErr);
  }

  return {
    ok: true,
    candidateId: candidateResult.candidateId,
    invitationId: invitationResult.invitationId,
    invitationUrl: invitationResult.invitationUrl,
    reportId: invitationResult.reportId || null,
    reportStatus: "pending",
  };
}
