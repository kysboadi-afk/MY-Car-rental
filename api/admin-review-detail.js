// api/admin-review-detail.js
// Admin-authenticated endpoint that returns full detail for a single application,
// including the complete review history and the current reviewVersion (concurrency
// token that must be passed back unchanged when submitting a review action).
//
// GET /api/admin-review-detail?secret=<ADMIN_SECRET>&applicationId=<uuid>

import { isAdminAuthorized } from "./_admin-auth.js";
import { fetchReviewApplicationById } from "./_renter-applications.js";
import { recoverVerifiedApplicationFromStripe } from "./_stripe-identity-recovery.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const { secret, applicationId } = req.query || {};
  if (!isAdminAuthorized(secret)) {
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
    const recovery = await recoverVerifiedApplicationFromStripe(r, {
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

  return res.status(200).json({
    success: true,
    applicationId: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email || null,
    age: r.age ?? null,
    experience: r.experience,
    apps: Array.isArray(r.apps) ? r.apps : [],
    hasInsurance: r.has_insurance || null,
    protectionPlanPref: r.protection_plan_pref || null,
    hasLicenseUpload: !!r.has_license_upload,
    hasInsuranceProof: !!r.has_insurance_proof,
    licenseFileName: r.license_file_name || null,
    insuranceFileName: r.insurance_file_name || null,
    precheckDecision: r.precheck_decision || null,
    applicationStatus: r.application_status,
    identityStatus: r.identity_status,
    identitySessionId: r.identity_session_id || null,
    identityVerifiedAt: r.identity_verified_at || null,
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
  });
}
