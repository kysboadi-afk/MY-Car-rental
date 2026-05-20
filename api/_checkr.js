import crypto from "node:crypto";
import {
  deriveCheckrPhase,
  fetchRenterApplicationById,
  patchRenterApplicationCheckrById,
} from "./_renter-applications.js";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  sendCheckrInvitationNotifications,
} from "./_application-notifications.js";

const CHECKR_API_BASE = "https://api.checkr.com/v1";
const DEFAULT_PACKAGE = "driver_pro";
const CHECKR_PHASES = [
  "not_started",
  "launch_queued",
  "candidate_created",
  "invitation_sent",
  "pending",
  "completed",
  "clear",
  "consider",
  "suspended",
  "failed",
  "webhook_missing",
];

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function cleanObject(value) {
  return value && typeof value === "object" ? value : {};
}

function cleanIsoDateTime(value) {
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function buildCheckrIdempotencyKey(parts = []) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => pickString(part)).join("|"))
    .digest("hex")
    .slice(0, 64);
}

function normalizeCheckrPhase(value) {
  const raw = pickString(value);
  if (!raw) return null;
  if (CHECKR_PHASES.includes(raw)) return raw;
  if (raw === "error") return "failed";
  if (raw === "complete_no_adj") return "completed";
  if (raw === "disputed") return "suspended";
  return null;
}

function isMissingCheckrEventTableError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  return code === "42P01"
    || code === "42703"
    || /relation .* does not exist/i.test(msg)
    || /column .* does not exist/i.test(msg)
    || /checkr_screening_events/i.test(msg);
}

export async function logCheckrEvent({
  eventId,
  eventType,
  applicationId = null,
  candidateId = null,
  reportId = null,
  phase = null,
  payload = {},
} = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, skipped: true, reason: "supabase_unavailable" };

  const id = pickString(eventId) || `generated:${crypto.randomUUID()}`;
  const normalizedPhase = normalizeCheckrPhase(phase);
  const insertPayload = {
    event_id: id,
    event_type: pickString(eventType) || "unknown",
    application_id: pickString(applicationId) || null,
    checkr_candidate_id: pickString(candidateId) || null,
    checkr_report_id: pickString(reportId) || null,
    phase: normalizedPhase,
    payload: cleanObject(payload),
  };
  const table = sb.from("checkr_screening_events");
  const write = typeof table?.upsert === "function"
    ? table.upsert(insertPayload, { onConflict: "event_id", ignoreDuplicates: true })
    : table.insert(insertPayload);
  const { error } = await write;
  if (!error) return { ok: true, eventId: id };
  if (isMissingCheckrEventTableError(error)) {
    return { ok: false, skipped: true, reason: "table_unavailable", details: error.message };
  }
  return { ok: false, skipped: false, reason: "write_failed", details: error.message };
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

function deriveCheckrEnvironment(apiKey) {
  const explicit = pickString(process.env.CHECKR_ENV).toLowerCase();
  if (explicit) return explicit;
  const key = pickString(apiKey).toLowerCase();
  if (!key) return "unknown";
  if (key.includes("test")) return "test";
  if (key.includes("live")) return "production";
  return "unknown";
}

function redactId(value) {
  const text = pickString(value);
  if (!text) return null;
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-3)}`;
}

async function postJson(path, body, fetchImpl = fetch, extraHeaders = {}) {
  const cfg = getCheckrConfig();
  const endpoint = `${CHECKR_API_BASE}${path}`;
  const headers = { ...buildApiHeaders(cfg.apiKey), ...cleanObject(extraHeaders) };
  console.info("checkr:request", {
    method: "POST",
    endpoint,
    authHeaderPresent: !!headers.Authorization,
    packageSlug: cfg.packageSlug || null,
    packageEnvironment: cfg.packageEnvironment || "unknown",
    packageSource: cfg.packageSource || null,
  });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  console.info("checkr:response", {
    method: "POST",
    endpoint,
    status: Number(response?.status) || null,
    ok: !!response?.ok,
    error: payload?.error || payload?.message || null,
    errorResponse: response?.ok ? null : payload,
  });
  return { response, payload };
}

export function getCheckrConfig() {
  const apiKey = pickString(process.env.CHECKR_API_KEY);
  const webhookSecret = pickString(process.env.CHECKR_WEBHOOK_SECRET);
  const configuredPackage = pickString(process.env.CHECKR_PACKAGE);
  const packageSlug = configuredPackage || DEFAULT_PACKAGE;
  const packageSource = configuredPackage ? "env.CHECKR_PACKAGE" : "default";
  const packageEnvironment = deriveCheckrEnvironment(apiKey);
  return {
    configured: !!apiKey,
    apiKey,
    webhookSecret,
    packageSlug,
    packageSource,
    packageEnvironment,
  };
}

export function mapCheckrReportStatus(status, adjudication) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const normalizedAdjudication = String(adjudication || "").trim().toLowerCase();
  if (normalizedStatus === "pending") return "pending";
  if (normalizedStatus === "suspended") return "suspended";
  if (normalizedStatus === "disputed") return "suspended";
  if (normalizedStatus === "complete" || normalizedStatus === "completed") {
    if (normalizedAdjudication === "clear") return "clear";
    if (normalizedAdjudication === "consider") return "consider";
    return "completed";
  }
  return "failed";
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
  console.info("checkr:candidate create request", {
    applicationId: pickString(application?.id) || null,
    hasEmail: !!pickString(body.email),
    hasPhone: !!pickString(body.phone),
    hasDriverLicense: !!pickString(body.driver_license_number),
    hasLicenseState: !!pickString(body.driver_license_state),
  });
  const idempotencyKey = buildCheckrIdempotencyKey([
    "candidate",
    application?.id,
    body.first_name,
    body.last_name,
    body.email,
    body.driver_license_number,
    body.driver_license_state,
  ]);
  const { response, payload } = await postJson("/candidates", body, fetchImpl, {
    "Idempotency-Key": idempotencyKey,
  });
  if (!response.ok) {
    console.error("checkr:candidate create failed", {
      applicationId: pickString(application?.id) || null,
      status: Number(response?.status) || null,
      error: payload?.error || payload?.message || "Failed to create Checkr candidate.",
      errorResponse: payload,
    });
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.error || payload?.message || "Failed to create Checkr candidate.",
      details: payload,
    };
  }

  console.info("checkr:candidate create succeeded", {
    applicationId: pickString(application?.id) || null,
    candidateId: redactId(payload?.id),
    candidateResult: {
      id: redactId(payload?.id),
      object: pickString(payload?.object) || null,
    },
  });
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
  console.info("checkr:invitation create request", {
    candidateId: redactId(candidateId),
    packageSlug: body.package || null,
    packageEnvironment: cfg.packageEnvironment || "unknown",
    packageSource: cfg.packageSource || null,
    requestPayload: {
      candidate_id: redactId(body.candidate_id),
      package: body.package || null,
      work_locations: body.work_locations,
    },
  });
  const idempotencyKey = buildCheckrIdempotencyKey([
    "invitation",
    candidateId,
    body.package,
  ]);
  const { response, payload } = await postJson("/invitations", body, fetchImpl, {
    "Idempotency-Key": idempotencyKey,
  });
  if (!response.ok) {
    console.error("checkr:invitation create failed", {
      candidateId: redactId(candidateId),
      status: Number(response?.status) || null,
      error: payload?.error || payload?.message || "Failed to create Checkr invitation.",
      errorResponse: payload,
    });
    return {
      ok: false,
      status: response.status || 500,
      error: payload?.error || payload?.message || "Failed to create Checkr invitation.",
      details: payload,
    };
  }
  console.info("checkr:invitation create succeeded", {
    candidateId: redactId(candidateId),
    invitationId: redactId(payload?.id),
    reportId: redactId(payload?.report_id),
    packageSlug: body.package || null,
  });
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

export async function initiateCheckrScreening(applicationId, fetchImpl = fetch, options = {}) {
  const cfg = getCheckrConfig();
  const launchSource = pickString(options?.launchSource) || "unspecified";
  if (!cfg.configured) {
    return { ok: false, status: 500, error: "Server configuration error: Checkr credentials are not set." };
  }

  const appResult = await fetchRenterApplicationById(applicationId);
  if (!appResult.ok) return appResult;
  const application = appResult.data || {};
  const currentPhase = deriveCheckrPhase(application);
  const nowIso = new Date().toISOString();
  const nextAttemptCount = Math.max(0, Number(application.checkr_launch_attempt_count || 0)) + 1;
  const candidateIdFromRecord = pickString(application.checkr_candidate_id);
  const reportIdFromRecord = pickString(application.checkr_report_id);
  console.info("checkr:screening initiation started", {
    applicationId,
    identityStatus: application.identity_status || null,
    applicationStatus: application.application_status || null,
    existingCandidateId: redactId(candidateIdFromRecord),
    existingReportId: redactId(reportIdFromRecord),
    existingReportStatus: application.checkr_report_status || null,
    existingPhase: currentPhase || null,
    nextAttemptCount,
    packageSlug: cfg.packageSlug || null,
    packageEnvironment: cfg.packageEnvironment || "unknown",
    packageSource: cfg.packageSource || null,
    launchSource,
  });

  if (application.identity_status !== "verified") {
    return { ok: false, status: 409, error: "Identity must be verified before Checkr screening can start." };
  }
  if (!application.agree_background_check) {
    return { ok: false, status: 422, error: "Background-check consent is required before Checkr screening can start." };
  }
  if (!application.driver_license_number || !application.driver_license_state) {
    return { ok: false, status: 422, error: "Driver license number and state are required before Checkr screening can start." };
  }
  if (
    reportIdFromRecord
    && ["invitation_sent", "pending", "completed", "clear", "consider", "suspended"].includes(currentPhase)
  ) {
    console.info("checkr:screening already started", {
      applicationId,
      candidateId: redactId(candidateIdFromRecord),
      reportId: redactId(reportIdFromRecord),
      reportStatus: application.checkr_report_status,
      phase: currentPhase,
    });
    return {
      ok: true,
      alreadyStarted: true,
      candidateId: candidateIdFromRecord || null,
      reportId: reportIdFromRecord || null,
      reportStatus: currentPhase || application.checkr_report_status || null,
    };
  }

  await patchRenterApplicationCheckrById(applicationId, {
    checkrReportStatus: "launch_queued",
    checkrPhase: "launch_queued",
    checkrLastLaunchAttemptAt: nowIso,
    checkrLaunchAttemptCount: nextAttemptCount,
    checkrLastLaunchError: null,
  }).catch(() => {});
  await logCheckrEvent({
    eventId: `launch:${applicationId}:${nextAttemptCount}`,
    eventType: "launch.attempted",
    applicationId,
    candidateId: candidateIdFromRecord,
    reportId: reportIdFromRecord,
    phase: "launch_queued",
    payload: {
      attempt: nextAttemptCount,
      packageSlug: cfg.packageSlug,
      packageEnvironment: cfg.packageEnvironment || "unknown",
      packageSource: cfg.packageSource || null,
      triggeredBy: launchSource,
    },
  });

  let candidateId = candidateIdFromRecord;
  if (!candidateId) {
    const candidateResult = await createCheckrCandidate(application, fetchImpl);
    if (!candidateResult.ok) {
      await patchRenterApplicationCheckrById(applicationId, {
        checkrReportStatus: "failed",
        checkrPhase: "failed",
        checkrLastError: candidateResult.error,
        checkrLastLaunchError: candidateResult.error,
      }).catch(() => {});
      await logCheckrEvent({
        eventId: `candidate-failed:${applicationId}:${nextAttemptCount}`,
        eventType: "candidate.create_failed",
        applicationId,
        phase: "failed",
        payload: {
          status: Number(candidateResult.status) || null,
          error: candidateResult.error || null,
          details: candidateResult.details || null,
        },
      });
      console.error("checkr:screening failed during candidate creation", {
        applicationId,
        error: candidateResult.error || null,
        status: Number(candidateResult.status) || null,
      });
      return candidateResult;
    }
    candidateId = candidateResult.candidateId;
    await patchRenterApplicationCheckrById(applicationId, {
      checkrCandidateId: candidateId,
      checkrReportStatus: "candidate_created",
      checkrPhase: "candidate_created",
      checkrLastLaunchError: null,
    }).catch(() => {});
    await logCheckrEvent({
      eventId: `candidate-created:${applicationId}:${candidateId}`,
      eventType: "candidate.created",
      applicationId,
      candidateId,
      phase: "candidate_created",
      payload: candidateResult.payload || {},
    });
  }

  if (reportIdFromRecord) {
    return {
      ok: true,
      alreadyStarted: true,
      candidateId,
      reportId: reportIdFromRecord,
      reportStatus: currentPhase || "invitation_sent",
    };
  }

  const invitationResult = await createCheckrInvitation({
    candidateId,
    packageSlug: cfg.packageSlug,
  }, fetchImpl);
  if (!invitationResult.ok) {
    await patchRenterApplicationCheckrById(applicationId, {
      checkrCandidateId: candidateId,
      checkrReportStatus: "failed",
      checkrPhase: "failed",
      checkrLastError: invitationResult.error,
      checkrLastLaunchError: invitationResult.error,
    }).catch(() => {});
    await logCheckrEvent({
      eventId: `invitation-failed:${applicationId}:${nextAttemptCount}`,
      eventType: "invitation.create_failed",
      applicationId,
      candidateId,
      phase: "failed",
      payload: {
        status: Number(invitationResult.status) || null,
        error: invitationResult.error || null,
        details: invitationResult.details || null,
      },
    });
    console.error("checkr:screening failed during invitation creation", {
      applicationId,
      candidateId: redactId(candidateId),
      error: invitationResult.error || null,
      status: Number(invitationResult.status) || null,
    });
    return invitationResult;
  }

  const patchResult = await patchRenterApplicationCheckrById(applicationId, {
    checkrCandidateId: candidateId,
    checkrReportId: invitationResult.reportId || null,
    checkrInvitationUrl: invitationResult.invitationUrl || null,
    checkrInvitationSentAt: nowIso,
    checkrInvitationReminderSentAt: null,
    checkrReportStatus: "invitation_sent",
    checkrPhase: "invitation_sent",
    checkrLastError: null,
    checkrLastLaunchError: null,
  });
  if (!patchResult.ok) return patchResult;
  await logCheckrEvent({
    eventId: `invitation-created:${applicationId}:${invitationResult.invitationId || invitationResult.reportId || nextAttemptCount}`,
    eventType: "invitation.created",
    applicationId,
    candidateId,
    reportId: invitationResult.reportId || null,
    phase: "invitation_sent",
    payload: invitationResult.payload || {},
  });
  console.info("checkr:screening state persisted", {
    applicationId,
    candidateId: redactId(candidateId),
    reportId: redactId(invitationResult.reportId),
    reportStatus: "invitation_sent",
  });

  try {
    const notificationResult = await sendCheckrInvitationNotifications(
      {
        ...application,
        ...patchResult.data,
      },
      {
        invitationUrl: invitationResult.invitationUrl,
        packageSlug: cfg.packageSlug,
      },
    );
    if (notificationResult?.applicantSmsSent) {
      await patchRenterApplicationCheckrById(applicationId, {
        checkrInvitationSmsSentAt: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch (notifyErr) {
    console.error("initiateCheckrScreening notification failed:", notifyErr.message || notifyErr);
  }

  return {
    ok: true,
    candidateId,
    invitationId: invitationResult.invitationId,
    invitationUrl: invitationResult.invitationUrl,
    reportId: invitationResult.reportId || null,
    reportStatus: "invitation_sent",
  };
}
