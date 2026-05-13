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

import { isAdminAuthorized } from "./_admin-auth.js";
import { listReviewQueueApplications } from "./_renter-applications.js";

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

  const { secret, page, pageSize } = req.query || {};
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const result = await listReviewQueueApplications({ page, pageSize });
  if (!result.ok) {
    if (result.details) console.error("admin-review-queue:", result.details);
    return res.status(result.status || 500).json({ error: result.error });
  }

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
      submittedAt: r.submitted_at || null,
      updatedAt: r.updated_at || null,
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}
