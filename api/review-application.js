// api/review-application.js
// Admin-authenticated, concurrency-safe endpoint for manual review decisions.
//
// POST /api/review-application
// Body:
//   {
//     secret:                 string,   // ADMIN_SECRET
//     applicationId:          string,   // UUID of the application
//     action:                 string,   // "approved" | "rejected" | "needs_info"
//     reviewedBy:             string,   // reviewer identifier (name or email)
//     notes:                  string,   // optional reviewer notes
//     expectedStatus:         string,   // application_status observed at queue load time
//     expectedReviewVersion:  number,   // review_version observed at queue load time
//     actionRequestId:        string,   // caller-generated UUID; deduplicates retries/tabs
//   }
//
// Concurrency safety:
//   The underlying UPDATE is conditional on both expectedStatus and
//   expectedReviewVersion matching the current row.  If either has changed since
//   the caller loaded the queue, the write is rejected with 409 STALE_REVIEW_ACTION.
//   The caller should refresh the queue/detail and re-present to the reviewer.
//
// Idempotency:
//   If actionRequestId was already committed for this application, the endpoint
//   returns 200 without re-sending notifications or re-writing state.
//
// Notifications:
//   Approval/rejection/needs_info applicant notifications are sent ONLY after a
//   successful conditional state write — never on conflict or idempotent replay.

import { isAdminAuthorized } from "./_admin-auth.js";
import { performPreAdverseAction, performReviewAction } from "./_renter-applications.js";
import { sendReviewDecisionNotifications } from "./_application-notifications.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const {
    secret,
    applicationId,
    action,
    reviewedBy,
    notes,
    expectedStatus,
    expectedReviewVersion,
    actionRequestId,
  } = req.body || {};

  // ── Admin auth ──────────────────────────────────────────────────────────────
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Basic presence check ───────────────────────────────────────────────────
  if (!applicationId) return res.status(400).json({ error: "applicationId is required." });
  if (!action)        return res.status(400).json({ error: "action is required." });
  if (!reviewedBy)    return res.status(400).json({ error: "reviewedBy is required." });
  if (!expectedStatus) return res.status(400).json({ error: "expectedStatus is required." });
  if (expectedReviewVersion === undefined || expectedReviewVersion === null) {
    return res.status(400).json({ error: "expectedReviewVersion is required." });
  }
  if (!actionRequestId) return res.status(400).json({ error: "actionRequestId is required." });

  // ── Perform conditional review write ───────────────────────────────────────
  const result = action === "pre_adverse"
    ? await performPreAdverseAction(
      applicationId,
      reviewedBy,
      notes,
      expectedStatus,
      expectedReviewVersion,
      actionRequestId,
    )
    : await performReviewAction(
      applicationId,
      action,
      reviewedBy,
      notes,
      expectedStatus,
      expectedReviewVersion,
      actionRequestId,
    );

  if (!result.ok) {
    if (result.details) console.error("review-application: performReviewAction failed:", result.details);

    // 409 Stale — return structured conflict info so the client can refresh.
    if (result.status === 409) {
      return res.status(409).json({
        error: result.error,
        code: result.code || "STALE_REVIEW_ACTION",
        current: result.current || null,
      });
    }

    return res.status(result.status || 500).json({ error: result.error });
  }

  // ── Send applicant notifications (only on first successful write, not replay) ──
  if (!result.idempotent) {
    try {
      await sendReviewDecisionNotifications(result.data, action, { notes });
    } catch (notifyErr) {
      // Notification failure is non-fatal: the state was already written.
      console.error("review-application: notification failed (non-fatal):", notifyErr.message || notifyErr);
    }
  }

  const r = result.data;
  return res.status(200).json({
    success: true,
    idempotent: !!result.idempotent,
    applicationId: r.id,
    action: String(action).trim(),
    newStatus: r.application_status,
    reviewVersion: r.review_version,
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
  });
}
