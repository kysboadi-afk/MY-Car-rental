import { getSupabaseAdmin } from "./_supabase.js";
import { normalizeDocumentMimeType } from "./_document-upload.js";

function cleanText(value, maxLen = 5000) {
  if (value == null) return null;
  const out = String(value).trim();
  if (!out) return null;
  return out.slice(0, maxLen);
}

function cleanAge(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function cleanApps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => cleanText(v, 120))
    .filter(Boolean)
    .slice(0, 30);
}

function cleanStateCode(value) {
  const out = cleanText(value, 2);
  if (!out) return null;
  return /^[a-z]{2}$/i.test(out) ? out.toUpperCase() : null;
}

function cleanZipcode(value) {
  const out = cleanText(value, 10);
  if (!out) return null;
  return /^\d{5}(?:-\d{4})?$/.test(out) ? out : null;
}

function cleanLicenseNumber(value) {
  const out = cleanText(value, 64);
  if (!out) return null;
  return /^[a-z0-9-]{4,64}$/i.test(out) ? out.toUpperCase() : null;
}

function cleanJsonValue(value) {
  if (value == null) return null;
  if (Array.isArray(value) || (typeof value === "object" && value)) {
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return null;
    }
  }
  return null;
}

const APPLICATION_STATUSES = ["submitted", "under_review", "needs_info", "approved", "rejected", "withdrawn", "expired"];
const RECOVERABLE_IDENTITY_STATUSES = ["not_started", "requires_input", "processing", "failed", "canceled"];
const CHECKR_REPORT_STATUSES = ["pending", "clear", "consider", "suspended", "disputed", "complete_no_adj", "error"];
const ADVERSE_ACTION_STEPS = ["pre_notice_sent", "final_notice_sent"];

// Valid manual review actions and the status they produce.
export const REVIEW_ACTION_MAP = {
  approved:   "approved",
  rejected:   "rejected",
  needs_info: "needs_info",
};

// Which source statuses may be acted upon by a manual reviewer.
const REVIEWABLE_STATUSES = new Set(["under_review", "needs_info"]);

// Normalise a UUID-shaped string or return null.
function cleanUuid(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Validate basic UUID format before sending to the database.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return null;
  return trimmed;
}
const IDENTITY_STATUSES = ["not_started", "requires_input", "processing", "verified", "failed", "canceled"];

function cleanIsoDateTime(value) {
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

export function mapApplicationRecord(payload = {}) {
  const hasInsurance = cleanText(payload.hasInsurance, 10);
  const protectionPlanPref = cleanText(payload.protectionPlanPref, 20);
  const normalizedPrecheck = cleanText(payload.precheckDecision || payload.decision, 20);
  const identityStatus = cleanText(payload.identityStatus, 30);
  const applicationStatus = cleanText(payload.applicationStatus, 30);
  const checkrReportStatus = cleanText(payload.checkrReportStatus, 30);
  const adverseActionStep = cleanText(payload.adverseActionStep, 30);
  const licenseFileName = cleanText(payload.licenseFileName, 255);
  const insuranceFileName = cleanText(payload.insuranceFileName, 255);
  const licenseMimeType = normalizeDocumentMimeType(cleanText(payload.licenseMimeType, 120), licenseFileName, "");
  const insuranceMimeType = normalizeDocumentMimeType(cleanText(payload.insuranceMimeType, 120), insuranceFileName, "");

  return {
    name: cleanText(payload.name, 200) || "",
    phone: cleanText(payload.phone, 40) || "",
    email: cleanText(payload.email, 320),
    age: cleanAge(payload.age),
    experience: cleanText(payload.experience, 200) || "",
    apps: cleanApps(payload.apps),
    agree_terms: !!payload.agreeTerms,
    agree_sms_consent: !!payload.agreeSmsConsent,
    agree_background_check: !!payload.agreeBackgroundCheck,
    has_insurance: hasInsurance === "yes" || hasInsurance === "no" ? hasInsurance : null,
    protection_plan_pref: ["basic", "standard", "premium", "none"].includes(protectionPlanPref) ? protectionPlanPref : null,
    driver_license_number: cleanLicenseNumber(payload.driverLicenseNumber),
    driver_license_state: cleanStateCode(payload.driverLicenseState),
    zipcode: cleanZipcode(payload.zipcode),
    license_file_name: licenseFileName,
    license_mime_type: licenseMimeType || null,
    insurance_file_name: insuranceFileName,
    insurance_mime_type: insuranceMimeType || null,
    has_license_upload: !!(payload.licenseBase64 && licenseFileName && licenseMimeType),
    has_insurance_proof: !!(payload.insuranceBase64 && insuranceFileName && insuranceMimeType),
    precheck_decision: ["approved", "review", "declined"].includes(normalizedPrecheck) ? normalizedPrecheck : null,
    application_status: APPLICATION_STATUSES.includes(applicationStatus)
      ? applicationStatus
      : "submitted",
    identity_status: IDENTITY_STATUSES.includes(identityStatus)
      ? identityStatus
      : "not_started",
    checkr_candidate_id: cleanText(payload.checkrCandidateId, 255),
    checkr_report_id: cleanText(payload.checkrReportId, 255),
    checkr_report_status: CHECKR_REPORT_STATUSES.includes(checkrReportStatus) ? checkrReportStatus : null,
    checkr_adjudication: cleanText(payload.checkrAdjudication, 80),
    checkr_completed_at: cleanIsoDateTime(payload.checkrCompletedAt),
    checkr_last_error: cleanText(payload.checkrLastError, 2000),
    checkr_mvr_violations: cleanJsonValue(payload.checkrMvrViolations),
    adverse_action_step: ADVERSE_ACTION_STEPS.includes(adverseActionStep) ? adverseActionStep : null,
    adverse_action_sent_at: cleanIsoDateTime(payload.adverseActionSentAt),
  };
}

export function toClientApplication(record = {}) {
  return {
    applicationId: record.id,
    name: record.name,
    phone: record.phone,
    email: record.email,
    age: record.age,
    experience: record.experience,
    apps: Array.isArray(record.apps) ? record.apps : [],
    agreeBackgroundCheck: !!record.agree_background_check,
    hasInsurance: record.has_insurance,
    protectionPlanPref: record.protection_plan_pref,
    driverLicenseNumber: record.driver_license_number || null,
    driverLicenseState: record.driver_license_state || null,
    zipcode: record.zipcode || null,
    precheckDecision: record.precheck_decision,
    decision: record.precheck_decision,
    applicationStatus: record.application_status,
    identityStatus: record.identity_status,
    checkrCandidateId: record.checkr_candidate_id || null,
    checkrReportId: record.checkr_report_id || null,
    checkrReportStatus: record.checkr_report_status || null,
    checkrAdjudication: record.checkr_adjudication || null,
    checkrCompletedAt: record.checkr_completed_at || null,
    checkrLastError: record.checkr_last_error || null,
    checkrMvrViolations: record.checkr_mvr_violations || null,
    adverseActionStep: record.adverse_action_step || null,
    adverseActionSentAt: record.adverse_action_sent_at || null,
    createdAt: record.created_at || null,
    updatedAt: record.updated_at || null,
    submittedAt: record.submitted_at || null,
  };
}

export async function insertRenterApplication(payload = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const row = mapApplicationRecord(payload);
  if (!row.name || !row.phone || !row.experience) {
    return { ok: false, status: 400, error: "Missing required fields: name, phone, experience." };
  }

  const { data, error } = await sb
    .from("renter_applications")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    return { ok: false, status: 503, error: "Could not save application.", details: error.message };
  }

  return { ok: true, data };
}

export async function patchRenterApplicationById(applicationId, patchPayload = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const id = cleanText(applicationId, 100);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };

  const patch = mapApplicationRecord(patchPayload);
  const allowedPatch = {
    has_license_upload: patch.has_license_upload,
    has_insurance_proof: patch.has_insurance_proof,
    license_file_name: patch.license_file_name,
    license_mime_type: patch.license_mime_type,
    insurance_file_name: patch.insurance_file_name,
    insurance_mime_type: patch.insurance_mime_type,
    precheck_decision: patch.precheck_decision,
  };
  if ("agreeBackgroundCheck" in patchPayload) allowedPatch.agree_background_check = patch.agree_background_check;
  if ("driverLicenseNumber" in patchPayload) allowedPatch.driver_license_number = patch.driver_license_number;
  if ("driverLicenseState" in patchPayload) allowedPatch.driver_license_state = patch.driver_license_state;
  if ("zipcode" in patchPayload) allowedPatch.zipcode = patch.zipcode;

  const { data, error } = await sb
    .from("renter_applications")
    .update(allowedPatch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return { ok: false, status: 503, error: "Could not update application.", details: error.message };
  }

  return { ok: true, data };
}

export async function fetchRenterApplicationById(applicationId, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const id = cleanText(applicationId, 100);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };

  const { data, error } = await sb
    .from("renter_applications")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 503, error: "Could not load application.", details: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Application not found." };
  }

  return { ok: true, data };
}

export async function fetchRenterApplicationByCheckrCandidateId(candidateId, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const normalized = cleanText(candidateId, 255);
  if (!normalized) return { ok: false, status: 400, error: "candidateId is required." };

  const { data, error } = await sb
    .from("renter_applications")
    .select("*")
    .eq("checkr_candidate_id", normalized)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 503, error: "Could not load application.", details: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Application not found." };
  }
  return { ok: true, data };
}

export async function fetchRenterApplicationByCheckrReportId(reportId, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const normalized = cleanText(reportId, 255);
  if (!normalized) return { ok: false, status: 400, error: "reportId is required." };

  const { data, error } = await sb
    .from("renter_applications")
    .select("*")
    .eq("checkr_report_id", normalized)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 503, error: "Could not load application.", details: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Application not found." };
  }
  return { ok: true, data };
}

export async function patchRenterApplicationIdentityById(applicationId, patchPayload = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const id = cleanText(applicationId, 100);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };

  const requestedIdentityStatus = cleanText(patchPayload.identityStatus, 30);
  const requestedApplicationStatus = cleanText(patchPayload.applicationStatus, 30);

  const identityStatus = IDENTITY_STATUSES.includes(requestedIdentityStatus)
    ? requestedIdentityStatus
    : null;
  const applicationStatus = APPLICATION_STATUSES.includes(requestedApplicationStatus)
    ? requestedApplicationStatus
    : null;

  const identityVerifiedAt = cleanIsoDateTime(patchPayload.identityVerifiedAt);
  const reviewedAt = cleanIsoDateTime(patchPayload.reviewedAt);

  const patch = {};
  if (identityStatus) patch.identity_status = identityStatus;
  if (applicationStatus) patch.application_status = applicationStatus;
  if ("identityLastError" in patchPayload) patch.identity_last_error = cleanText(patchPayload.identityLastError, 2000);
  if ("identitySessionId" in patchPayload) patch.identity_session_id = cleanText(patchPayload.identitySessionId, 255);
  if (identityStatus === "verified") {
    patch.identity_verified_at = identityVerifiedAt || new Date().toISOString();
  } else if ("identityVerifiedAt" in patchPayload || (identityStatus && identityStatus !== "verified")) {
    patch.identity_verified_at = null;
  }
  if ("reviewedBy" in patchPayload) patch.reviewed_by = cleanText(patchPayload.reviewedBy, 200);
  if (reviewedAt) patch.reviewed_at = reviewedAt;

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "No valid identity patch fields were provided." };
  }

  const { data, error } = await sb
    .from("renter_applications")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return { ok: false, status: 503, error: "Could not update application.", details: error.message };
  }

  return { ok: true, data };
}

export async function patchRenterApplicationCheckrById(applicationId, patchPayload = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const id = cleanText(applicationId, 100);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };

  const patch = {};
  if ("checkrCandidateId" in patchPayload) patch.checkr_candidate_id = cleanText(patchPayload.checkrCandidateId, 255);
  if ("checkrReportId" in patchPayload) patch.checkr_report_id = cleanText(patchPayload.checkrReportId, 255);
  if ("checkrReportStatus" in patchPayload) {
    const status = cleanText(patchPayload.checkrReportStatus, 30);
    patch.checkr_report_status = CHECKR_REPORT_STATUSES.includes(status) ? status : null;
  }
  if ("checkrAdjudication" in patchPayload) patch.checkr_adjudication = cleanText(patchPayload.checkrAdjudication, 80);
  if ("checkrCompletedAt" in patchPayload) patch.checkr_completed_at = cleanIsoDateTime(patchPayload.checkrCompletedAt);
  if ("checkrLastError" in patchPayload) patch.checkr_last_error = cleanText(patchPayload.checkrLastError, 2000);
  if ("checkrMvrViolations" in patchPayload) patch.checkr_mvr_violations = cleanJsonValue(patchPayload.checkrMvrViolations);
  if ("adverseActionStep" in patchPayload) {
    const step = cleanText(patchPayload.adverseActionStep, 30);
    patch.adverse_action_step = ADVERSE_ACTION_STEPS.includes(step) ? step : null;
  }
  if ("adverseActionSentAt" in patchPayload) patch.adverse_action_sent_at = cleanIsoDateTime(patchPayload.adverseActionSentAt);
  if ("reviewedBy" in patchPayload) patch.reviewed_by = cleanText(patchPayload.reviewedBy, 200);
  if ("reviewedAt" in patchPayload) patch.reviewed_at = cleanIsoDateTime(patchPayload.reviewedAt);
  if ("lastReviewerNotes" in patchPayload) patch.last_reviewer_notes = cleanText(patchPayload.lastReviewerNotes, 2000);

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "No valid Checkr patch fields were provided." };
  }

  const { data, error } = await sb
    .from("renter_applications")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return { ok: false, status: 503, error: "Could not update application.", details: error.message };
  }

  return { ok: true, data };
}

function addBusinessDays(startIso, days) {
  const date = new Date(startIso);
  if (!Number.isFinite(date.getTime())) return null;
  let added = 0;
  while (added < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return date.toISOString();
}

function adverseActionFinalEligible(sentAt) {
  const readyAt = addBusinessDays(sentAt, 5);
  if (!readyAt) return { eligible: false, readyAt: null };
  return { eligible: Date.now() >= new Date(readyAt).getTime(), readyAt };
}

/**
 * Perform a manual review action (approved / rejected / needs_info) on an
 * application using optimistic concurrency control.
 *
 * The UPDATE is conditional on BOTH the current application_status AND the
 * current review_version matching the caller's expectations.  If either has
 * changed since the queue was loaded (e.g. another reviewer already acted),
 * the update matches 0 rows and the function returns a 409 STALE_REVIEW_ACTION
 * response — no notification is fired and no audit row is written.
 *
 * @param {string}   applicationId          — target application UUID
 * @param {string}   action                 — "approved" | "rejected" | "needs_info"
 * @param {string}   reviewedBy             — identifier of the acting reviewer
 * @param {string}   [notes]                — optional reviewer notes
 * @param {string}   expectedStatus         — application_status the caller observed
 * @param {number}   expectedReviewVersion  — review_version the caller observed
 * @param {string}   actionRequestId        — UUID; deduplicates repeated submissions
 * @param {object}   [sbClient]             — optional Supabase client override
 * @returns {Promise<{ok:boolean, status:number, code?:string, data?, error?:string}>}
 */
export async function performReviewAction(
  applicationId,
  action,
  reviewedBy,
  notes,
  expectedStatus,
  expectedReviewVersion,
  actionRequestId,
  sbClient = null,
) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  // ── Validate inputs ─────────────────────────────────────────────────────────
  const id = cleanUuid(applicationId);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };

  const normalizedAction = cleanText(action, 20);
  if (!Object.prototype.hasOwnProperty.call(REVIEW_ACTION_MAP, normalizedAction)) {
    return { ok: false, status: 400, error: 'action must be "approved", "rejected", or "needs_info".' };
  }
  const newStatus = REVIEW_ACTION_MAP[normalizedAction];

  const reviewer = cleanText(reviewedBy, 200);
  if (!reviewer) return { ok: false, status: 400, error: "reviewedBy is required." };

  const trimmedNotes = cleanText(notes, 2000);

  if (!REVIEWABLE_STATUSES.has(expectedStatus)) {
    return {
      ok: false,
      status: 422,
      error: `Cannot review an application with status "${expectedStatus}". Only under_review and needs_info applications may be acted upon.`,
    };
  }

  const version = typeof expectedReviewVersion === "number" ? expectedReviewVersion : Number(expectedReviewVersion);
  if (!Number.isFinite(version) || version < 0) {
    return { ok: false, status: 400, error: "expectedReviewVersion must be a non-negative integer." };
  }

  const reqId = cleanUuid(actionRequestId);
  if (!reqId) return { ok: false, status: 400, error: "actionRequestId (UUID) is required." };

  const { data: currentApp, error: currentErr } = await sb
    .from("renter_applications")
    .select("id, application_status, review_version, checkr_report_status, adverse_action_step, adverse_action_sent_at")
    .eq("id", id)
    .maybeSingle();

  if (currentErr) {
    return { ok: false, status: 503, error: "Could not load application for review.", details: currentErr.message };
  }
  if (!currentApp) {
    return { ok: false, status: 404, error: "Application not found." };
  }

  if (normalizedAction === "rejected" && currentApp.checkr_report_status === "consider") {
    if (currentApp.adverse_action_step !== "pre_notice_sent" || !currentApp.adverse_action_sent_at) {
      return {
        ok: false,
        status: 422,
        error: "Pre-adverse action notice is required before rejecting a Checkr consider report.",
      };
    }
    const adverseWindow = adverseActionFinalEligible(currentApp.adverse_action_sent_at);
    if (!adverseWindow.eligible) {
      return {
        ok: false,
        status: 422,
        error: `Final adverse action is not available until ${adverseWindow.readyAt}.`,
      };
    }
  }

  // ── Idempotency check: if this action_request_id was already committed, return the existing result ──
  const { data: existingAudit, error: auditLookupErr } = await sb
    .from("application_review_actions")
    .select("id, new_status, created_at")
    .eq("application_id", id)
    .eq("action_request_id", reqId)
    .maybeSingle();

  if (auditLookupErr) {
    return { ok: false, status: 503, error: "Idempotency check failed.", details: auditLookupErr.message };
  }

  if (existingAudit) {
    // Already committed — fetch the current application row and return as success.
    const { data: appRow, error: fetchErr } = await sb
      .from("renter_applications")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr || !appRow) {
      return { ok: false, status: 503, error: "Could not re-fetch application after idempotency match." };
    }
    return { ok: true, data: appRow, idempotent: true };
  }

  // ── Conditional update (optimistic concurrency) ─────────────────────────────
  // Only applies when application_status = expectedStatus AND review_version = expectedReviewVersion.
  const now = new Date().toISOString();
  const patch = {
    application_status:  newStatus,
    review_version:      version + 1,
    reviewed_by:         reviewer,
    reviewed_at:         now,
    last_reviewer_notes: trimmedNotes,
    updated_at:          now,
  };
  if (normalizedAction === "rejected" && currentApp.checkr_report_status === "consider") {
    patch.adverse_action_step = "final_notice_sent";
    patch.adverse_action_sent_at = now;
  }
  if (normalizedAction === "needs_info") {
    patch.needs_info_reason = trimmedNotes || null;
  } else {
    patch.needs_info_reason = null;
  }

  const { data: updatedRows, error: updateErr } = await sb
    .from("renter_applications")
    .update(patch)
    .eq("id", id)
    .eq("application_status", expectedStatus)
    .eq("review_version", version)
    .select("*");

  if (updateErr) {
    return { ok: false, status: 503, error: "Could not apply review action.", details: updateErr.message };
  }

  // 0 rows → status or version changed between queue load and write (stale action).
  if (!updatedRows || updatedRows.length === 0) {
    // Fetch current state so the caller can surface a meaningful conflict message.
    const { data: current } = await sb
      .from("renter_applications")
      .select("id, application_status, review_version, reviewed_by, reviewed_at")
      .eq("id", id)
      .maybeSingle();

    return {
      ok: false,
      status: 409,
      code: "STALE_REVIEW_ACTION",
      error: "The application was already updated by another reviewer. Please refresh and try again.",
      current: current
        ? {
            applicationStatus: current.application_status,
            reviewVersion: current.review_version,
            reviewedBy: current.reviewed_by || null,
            reviewedAt: current.reviewed_at || null,
          }
        : null,
    };
  }

  const updatedApp = updatedRows[0];

  // ── Append audit row ────────────────────────────────────────────────────────
  const { error: auditErr } = await sb.from("application_review_actions").insert({
    application_id:    id,
    action:            normalizedAction,
    performed_by:      reviewer,
    notes:             trimmedNotes,
    previous_status:   expectedStatus,
    new_status:        newStatus,
    action_request_id: reqId,
  });

  if (auditErr) {
    // Non-fatal: the state transition already succeeded; log and continue.
    console.error("[performReviewAction] audit insert failed (non-fatal):", auditErr.message);
  }

  return { ok: true, data: updatedApp };
}

export async function performPreAdverseAction(
  applicationId,
  reviewedBy,
  notes,
  expectedStatus,
  expectedReviewVersion,
  actionRequestId,
  sbClient = null,
) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const id = cleanUuid(applicationId);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };
  const reviewer = cleanText(reviewedBy, 200);
  if (!reviewer) return { ok: false, status: 400, error: "reviewedBy is required." };
  const trimmedNotes = cleanText(notes, 2000);
  if (!REVIEWABLE_STATUSES.has(expectedStatus)) {
    return {
      ok: false,
      status: 422,
      error: `Cannot send pre-adverse action for status "${expectedStatus}". Only under_review and needs_info applications may be acted upon.`,
    };
  }
  const version = typeof expectedReviewVersion === "number" ? expectedReviewVersion : Number(expectedReviewVersion);
  if (!Number.isFinite(version) || version < 0) {
    return { ok: false, status: 400, error: "expectedReviewVersion must be a non-negative integer." };
  }
  const reqId = cleanUuid(actionRequestId);
  if (!reqId) return { ok: false, status: 400, error: "actionRequestId (UUID) is required." };

  const { data: existingAudit, error: auditLookupErr } = await sb
    .from("application_review_actions")
    .select("id")
    .eq("application_id", id)
    .eq("action_request_id", reqId)
    .maybeSingle();
  if (auditLookupErr) {
    return { ok: false, status: 503, error: "Idempotency check failed.", details: auditLookupErr.message };
  }
  if (existingAudit) {
    const { data: appRow, error: fetchErr } = await sb
      .from("renter_applications")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr || !appRow) {
      return { ok: false, status: 503, error: "Could not re-fetch application after idempotency match." };
    }
    return { ok: true, data: appRow, idempotent: true };
  }

  const { data: current, error: currentErr } = await sb
    .from("renter_applications")
    .select("id, application_status, review_version, checkr_report_status, adverse_action_step, adverse_action_sent_at")
    .eq("id", id)
    .maybeSingle();
  if (currentErr) {
    return { ok: false, status: 503, error: "Could not load application for review.", details: currentErr.message };
  }
  if (!current) return { ok: false, status: 404, error: "Application not found." };
  if (current.checkr_report_status !== "consider") {
    return { ok: false, status: 422, error: "Pre-adverse action only applies to Checkr consider reports." };
  }

  const now = new Date().toISOString();
  const patch = {
    review_version: version + 1,
    reviewed_by: reviewer,
    reviewed_at: now,
    last_reviewer_notes: trimmedNotes,
    adverse_action_step: "pre_notice_sent",
    adverse_action_sent_at: now,
    updated_at: now,
  };

  const { data: updatedRows, error: updateErr } = await sb
    .from("renter_applications")
    .update(patch)
    .eq("id", id)
    .eq("application_status", expectedStatus)
    .eq("review_version", version)
    .select("*");
  if (updateErr) {
    return { ok: false, status: 503, error: "Could not apply pre-adverse action.", details: updateErr.message };
  }
  if (!updatedRows || updatedRows.length === 0) {
    const { data: stale } = await sb
      .from("renter_applications")
      .select("id, application_status, review_version, reviewed_by, reviewed_at")
      .eq("id", id)
      .maybeSingle();
    return {
      ok: false,
      status: 409,
      code: "STALE_REVIEW_ACTION",
      error: "The application was already updated by another reviewer. Please refresh and try again.",
      current: stale
        ? {
            applicationStatus: stale.application_status,
            reviewVersion: stale.review_version,
            reviewedBy: stale.reviewed_by || null,
            reviewedAt: stale.reviewed_at || null,
          }
        : null,
    };
  }

  const updatedApp = updatedRows[0];
  const { error: auditErr } = await sb.from("application_review_actions").insert({
    application_id: id,
    action: "pre_adverse",
    performed_by: reviewer,
    notes: trimmedNotes,
    previous_status: expectedStatus,
    new_status: expectedStatus,
    action_request_id: reqId,
  });
  if (auditErr) {
    console.error("[performPreAdverseAction] audit insert failed (non-fatal):", auditErr.message);
  }

  return { ok: true, data: updatedApp };
}

/**
 * Fetch a page of applications awaiting manual review (under_review or needs_info).
 *
 * @param {{page?:number, pageSize?:number}} opts
 * @param {object} [sbClient]
 */
export async function listReviewQueueApplications({ page = 1, pageSize = 50 } = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;

  const { data, error, count } = await sb
    .from("renter_applications")
    .select(
      "id, name, phone, email, age, experience, application_status, identity_status, " +
        "review_version, reviewed_by, reviewed_at, needs_info_reason, precheck_decision, " +
        "checkr_report_status, checkr_report_id, adverse_action_step, adverse_action_sent_at, " +
        "submitted_at, created_at, updated_at",
      { count: "exact" },
    )
    .in("application_status", ["under_review", "needs_info"])
    .order("submitted_at", { ascending: true })
    .range(from, to);

  if (error) {
    return { ok: false, status: 503, error: "Could not load review queue.", details: error.message };
  }

  return { ok: true, data: data || [], total: count ?? 0, page: safePage, pageSize: safePageSize };
}

export async function listPendingIdentityRecoveryApplications({ limit = 25 } = {}, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));

  const { data, error } = await sb
    .from("renter_applications")
    .select("*")
    .or(
      `and(application_status.eq.submitted,identity_status.in.(${RECOVERABLE_IDENTITY_STATUSES.join(",")})),` +
      `and(application_status.eq.under_review,identity_status.eq.processing)`,
    )
    .not("identity_session_id", "is", null)
    .order("submitted_at", { ascending: true })
    .limit(safeLimit);

  if (error) {
    return {
      ok: false,
      status: 503,
      error: "Could not load Stripe identity recovery candidates.",
      details: error.message,
    };
  }

  return { ok: true, data: data || [] };
}

/**
 * Fetch a single application (full detail) for admin review.
 *
 * Returns the full row including review_version (concurrency token) and audit history.
 */
export async function fetchReviewApplicationById(applicationId, sbClient = null) {
  const sb = sbClient || getSupabaseAdmin();
  if (!sb) return { ok: false, status: 503, error: "Application storage service is not configured." };

  const id = cleanUuid(applicationId);
  if (!id) return { ok: false, status: 400, error: "applicationId is required." };

  const { data, error } = await sb
    .from("renter_applications")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 503, error: "Could not load application.", details: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, error: "Application not found." };
  }

  // Also fetch review history (most recent first).
  const { data: history } = await sb
    .from("application_review_actions")
    .select("id, action, performed_by, notes, previous_status, new_status, created_at")
    .eq("application_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  return { ok: true, data, history: history || [] };
}
