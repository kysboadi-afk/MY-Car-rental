// api/admin-review-detail.js
// Admin-authenticated endpoint that returns full detail for a single application,
// including the complete review history and the current reviewVersion (concurrency
// token that must be passed back unchanged when submitting a review action).
//
// GET /api/admin-review-detail?secret=<ADMIN_SECRET>&applicationId=<uuid>

import { isAdminAuthorized, extractAdminSecret } from "./_admin-auth.js";
import { fetchReviewApplicationById } from "./_renter-applications.js";
import { recoverApplicationIdentityFromVeriffDecision } from "./_veriff-identity-recovery.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { INCOME_VERIFICATION_BUCKET, INCOME_VERIFICATION_DOC_TYPE } from "./_income-verification.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const INCOME_DOCUMENT_SELECT_VARIANTS = [
  "id, doc_type, file_name, mime_type, file_path, file_size, review_status, reviewed_by, reviewed_at, notes, created_at",
  "id, doc_type, file_name, mime_type, file_path, file_size:file_size_bytes, review_status, reviewed_by, reviewed_at, notes, created_at",
  "id, doc_type, file_name, mime_type, file_path, file_size, review_status:verification_status, reviewed_by, reviewed_at, notes, created_at",
  "id, doc_type, file_name, mime_type, file_path, file_size:file_size_bytes, review_status:verification_status, reviewed_by, reviewed_at, notes, created_at",
];

function isMissingColumnError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "42703" || (message.includes("column") && message.includes("does not exist"));
}

async function fetchIncomeDocuments(sb, applicationId) {
  let lastError = null;
  for (const selectClause of INCOME_DOCUMENT_SELECT_VARIANTS) {
    const { data, error } = await sb
      .from("application_documents")
      .select(selectClause)
      .eq("application_id", applicationId)
      .eq("doc_type", INCOME_VERIFICATION_DOC_TYPE)
      .order("created_at", { ascending: true });

    if (!error) {
      return { docs: Array.isArray(data) ? data : [], error: null };
    }
    if (!isMissingColumnError(error)) {
      return { docs: [], error };
    }
    lastError = error;
  }
  return { docs: [], error: lastError };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const { applicationId } = req.query || {};
  if (!isAdminAuthorized(extractAdminSecret(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!applicationId || typeof applicationId !== "string" || !applicationId.trim()) {
    return res.status(400).json({ error: "applicationId is required." });
  }

  const result = await fetchReviewApplicationById(applicationId.trim());
  if (!result.ok) {
    if (result.details) console.error("admin-review-detail:", result.details);
    return res.status(result.status || 500).json({ error: result.error });
  }

  let r = result.data;
  let reviewHistory = result.history || [];
  if (r?.identity_session_id && r?.identity_status !== "verified") {
    const recovery = await recoverApplicationIdentityFromVeriffDecision(r, {
      reviewedBy: "admin_review_detail_sync",
    });
    if (!recovery.ok) {
      if (recovery.details) console.error("admin-review-detail recovery:", recovery.details);
    } else if (recovery.synced) {
      const refreshed = await fetchReviewApplicationById(applicationId.trim());
      if (refreshed.ok) {
        r = refreshed.data;
        reviewHistory = refreshed.history || reviewHistory;
      }
    }
  }

  // Fetch income-verification documents (gracefully skip if table doesn't exist)
  let incomeDocuments = [];
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { docs, error: docsErr } = await fetchIncomeDocuments(sb, r.id);

      if (!docsErr && Array.isArray(docs)) {
        // Generate short-lived signed URLs for admin preview
        incomeDocuments = await Promise.all(
          docs.map(async (doc) => {
            let previewUrl = null;
            if (doc.file_path) {
              const { data: urlData } = await sb.storage
                .from(INCOME_VERIFICATION_BUCKET)
                .createSignedUrl(doc.file_path, 60 * 60 * 4); // 4-hour admin preview
              previewUrl = urlData?.signedUrl || null;
            }
            return {
              id: doc.id,
              docType: doc.doc_type,
              fileName: doc.file_name || null,
              mimeType: doc.mime_type || null,
              fileSize: doc.file_size ?? null,
              reviewStatus: doc.review_status || "pending",
              reviewedBy: doc.reviewed_by || null,
              reviewedAt: doc.reviewed_at || null,
              notes: doc.notes || null,
              uploadedAt: doc.created_at || null,
              previewUrl,
            };
          })
        );
      } else if (docsErr) {
        console.warn("admin-review-detail: could not fetch income docs (table may not exist yet):", docsErr.message);
      }
    } catch (fetchErr) {
      console.warn("admin-review-detail: income docs fetch error (non-fatal):", fetchErr?.message);
    }
  }

  return res.status(200).json({
    success: true,
    applicationId: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email || null,
    age: r.age ?? null,
    experience: r.experience,
    apps: Array.isArray(r.apps) ? r.apps : [],
    agreeBackgroundCheck: !!r.agree_background_check,
    hasInsurance: r.has_insurance || null,
    protectionPlanPref: r.protection_plan_pref || null,
    driverLicenseNumber: r.driver_license_number || null,
    driverLicenseState: r.driver_license_state || null,
    zipcode: r.zipcode || null,
    hasLicenseUpload: !!r.has_license_upload,
    hasInsuranceProof: !!r.has_insurance_proof,
    licenseFileName: r.license_file_name || null,
    insuranceFileName: r.insurance_file_name || null,
    precheckDecision: r.precheck_decision || null,
    applicationStatus: r.application_status,
    identityStatus: r.identity_status,
    identitySessionId: r.identity_session_id || null,
    identityVerifiedAt: r.identity_verified_at || null,
    checkrCandidateId: r.checkr_candidate_id || null,
    checkrReportId: r.checkr_report_id || null,
    checkrReportStatus: r.checkr_report_status || null,
    checkrAdjudication: r.checkr_adjudication || null,
    checkrCompletedAt: r.checkr_completed_at || null,
    checkrLastError: r.checkr_last_error || null,
    checkrMvrViolations: r.checkr_mvr_violations || null,
    adverseActionStep: r.adverse_action_step || null,
    adverseActionSentAt: r.adverse_action_sent_at || null,
    reviewVersion: r.review_version,
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
    needsInfoReason: r.needs_info_reason || null,
    lastReviewerNotes: r.last_reviewer_notes || null,
    submittedAt: r.submitted_at || null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
    reviewHistory: reviewHistory.map((h) => ({
      id: h.id,
      action: h.action,
      performedBy: h.performed_by,
      notes: h.notes || null,
      previousStatus: h.previous_status,
      newStatus: h.new_status,
      createdAt: h.created_at,
    })),
    incomeDocuments,
  });
}
