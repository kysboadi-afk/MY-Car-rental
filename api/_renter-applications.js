import { getSupabaseAdmin } from "./_supabase.js";

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

const APPLICATION_STATUSES = ["submitted", "under_review", "approved", "rejected", "withdrawn", "expired"];
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

  return {
    name: cleanText(payload.name, 200) || "",
    phone: cleanText(payload.phone, 40) || "",
    email: cleanText(payload.email, 320),
    age: cleanAge(payload.age),
    experience: cleanText(payload.experience, 200) || "",
    apps: cleanApps(payload.apps),
    agree_terms: !!payload.agreeTerms,
    agree_sms_consent: !!payload.agreeSmsConsent,
    has_insurance: hasInsurance === "yes" || hasInsurance === "no" ? hasInsurance : null,
    protection_plan_pref: ["basic", "standard", "premium", "none"].includes(protectionPlanPref) ? protectionPlanPref : null,
    license_file_name: cleanText(payload.licenseFileName, 255),
    license_mime_type: cleanText(payload.licenseMimeType, 120),
    insurance_file_name: cleanText(payload.insuranceFileName, 255),
    insurance_mime_type: cleanText(payload.insuranceMimeType, 120),
    has_license_upload: !!(payload.licenseBase64 && payload.licenseFileName && payload.licenseMimeType),
    has_insurance_proof: !!(payload.insuranceBase64 && payload.insuranceFileName && payload.insuranceMimeType),
    precheck_decision: ["approved", "review", "declined"].includes(normalizedPrecheck) ? normalizedPrecheck : null,
    application_status: APPLICATION_STATUSES.includes(applicationStatus)
      ? applicationStatus
      : "submitted",
    identity_status: IDENTITY_STATUSES.includes(identityStatus)
      ? identityStatus
      : "not_started",
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
    hasInsurance: record.has_insurance,
    protectionPlanPref: record.protection_plan_pref,
    precheckDecision: record.precheck_decision,
    decision: record.precheck_decision,
    applicationStatus: record.application_status,
    identityStatus: record.identity_status,
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
