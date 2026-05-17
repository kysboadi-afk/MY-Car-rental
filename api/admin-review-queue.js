// api/admin-review-queue.js
// Admin-authenticated endpoint that returns the list of applications awaiting
// manual review (application_status = "under_review" or "needs_info").
//
// GET  /api/admin-review-queue?secret=<ADMIN_SECRET>[&page=1&pageSize=50]
//
// Response:
//   { success: true, applications: [...], total, page, pageSize }
//
// Each item includes: id, name, phone, email, age, experience,
//   applicationStatus, identityStatus, reviewVersion, reviewedBy,
//   reviewedAt, needsInfoReason, precheckDecision, submittedAt.
//
// reviewVersion is the optimistic concurrency token — callers must pass it
// back unchanged as expectedReviewVersion when submitting a review action.

import { isAdminAuthorized, extractAdminSecret } from "./_admin-auth.js";
import {
  listPendingIdentityRecoveryApplications,
  listReviewQueueApplications,
} from "./_renter-applications.js";
import { recoverVerifiedApplicationFromStripe } from "./_stripe-identity-recovery.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const RECOVERY_SCAN_LIMIT = 25;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const { page, pageSize } = req.query || {};
  if (!isAdminAuthorized(extractAdminSecret(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.info("admin-review-queue: fetch started", {
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
      recoveryScanLimit: RECOVERY_SCAN_LIMIT,
    });

    const recoveryCandidates = await listPendingIdentityRecoveryApplications({
      limit: RECOVERY_SCAN_LIMIT,
    });
    if (!recoveryCandidates.ok) {
      if (recoveryCandidates.details) {
        console.error("admin-review-queue recovery lookup:", recoveryCandidates.details);
      }
    } else {
      const recoveryResults = await Promise.allSettled(
        (recoveryCandidates.data || []).map((application) => recoverVerifiedApplicationFromStripe(application, {
          reviewedBy: "admin_review_queue_sync",
        })),
      );
      recoveryResults.forEach((result) => {
        if (result.status === "fulfilled" && !result.value?.ok && result.value?.details) {
          console.error("admin-review-queue Veriff recovery failed:", result.value.details);
        } else if (result.status === "rejected") {
          console.error("admin-review-queue Veriff recovery failed:", result.reason);
        }
      });
    }
  } catch (recoveryErr) {
    console.error("admin-review-queue recovery pass failed:", recoveryErr);
  }

  const result = await listReviewQueueApplications({ page, pageSize });
  if (!result.ok) {
    if (result.details) console.error("admin-review-queue:", result.details);
    return res.status(result.status || 500).json({ error: result.error });
  }

  console.info("admin-review-queue: fetch completed", {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    returned: (result.data || []).length,
  });

  return res.status(200).json({
    success: true,
    applications: result.data.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email || null,
      age: r.age ?? null,
      experience: r.experience,
      applicationStatus: r.application_status,
      identityStatus: r.identity_status,
      reviewVersion: r.review_version,
      reviewedBy: r.reviewed_by || null,
      reviewedAt: r.reviewed_at || null,
      needsInfoReason: r.needs_info_reason || null,
      precheckDecision: r.precheck_decision || null,
      checkrReportStatus: r.checkr_report_status || null,
      checkrReportId: r.checkr_report_id || null,
      adverseActionStep: r.adverse_action_step || null,
      adverseActionSentAt: r.adverse_action_sent_at || null,
      submittedAt: r.submitted_at || null,
      updatedAt: r.updated_at || null,
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}
