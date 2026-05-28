// api/admin-review-queue.js
// Admin-authenticated endpoint that returns the application lifecycle queue
// used by the admin dashboard and underwriting review page.
//
// GET  /api/admin-review-queue?secret=<ADMIN_SECRET>[&page=1&pageSize=50]
//
// Response:
//   { success: true, applications: [...], total, page, pageSize, summary, filters }
//
// Each item includes: id, name, phone, email, age, experience,
//   applicationStatus, identityStatus, reviewVersion, reviewedBy,
//   reviewedAt, needsInfoReason, precheckDecision, submittedAt.
//
// reviewVersion is the optimistic concurrency token — callers must pass it
// back unchanged as expectedReviewVersion when submitting a review action.

import { isAdminAuthorized, extractAdminSecret } from "./_admin-auth.js";
import {
  getApplicationAttentionFlags,
  listPendingIdentityRecoveryApplications,
  listReviewQueueApplications,
} from "./_renter-applications.js";
import { recoverApplicationIdentityFromVeriffDecision } from "./_veriff-identity-recovery.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const RECOVERY_SCAN_LIMIT = 25;
const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_WAITLIST_CAPTURE_PATH = "fleet-waitlist.json";
const FLEET_WAITLIST_MAX = 200;

function normalizeFleetWaitlistEntry(entry = {}) {
  return {
    submissionId: String(entry.submissionId || "").trim(),
    createdAt: String(entry.createdAt || "").trim(),
    name: String(entry.name || "").trim(),
    phone: String(entry.phone || "").trim(),
    email: String(entry.email || "").trim(),
    preferredVehicle: String(entry.preferredVehicle || "").trim(),
    weeklyBudget: String(entry.weeklyBudget || "").trim(),
    sourcePage: String(entry.sourcePage || "").trim(),
  };
}

async function listFleetWaitlistApplications() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_WAITLIST_CAPTURE_PATH}`;
  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) return [];
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub waitlist fetch failed: ${response.status} ${body}`.slice(0, 500));
  }

  const file = await response.json();
  let parsed = null;
  try {
    const decoded = Buffer.from(String(file?.content || "").replace(/\n/g, ""), "base64").toString("utf8");
    parsed = JSON.parse(decoded);
  } catch {
    parsed = null;
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return entries
    .map((entry) => normalizeFleetWaitlistEntry(entry))
    .filter((entry) => entry.submissionId || entry.name || entry.email || entry.phone)
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || "") || 0;
      const bTime = Date.parse(b.createdAt || "") || 0;
      return bTime - aTime;
    })
    .slice(0, FLEET_WAITLIST_MAX);
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

  const {
    page,
    pageSize,
    lifecycleFilter,
    attentionFilter,
    search,
    sortField,
    sortDir,
  } = req.query || {};
  if (!isAdminAuthorized(extractAdminSecret(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.info("admin-review-queue: fetch started", {
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
      lifecycleFilter: lifecycleFilter || "",
      attentionFilter: attentionFilter || "",
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
        (recoveryCandidates.data || []).map((application) => recoverApplicationIdentityFromVeriffDecision(application, {
          reviewedBy: "admin_review_queue_sync",
        })),
      );
      let authFailureLogged = false;
      recoveryResults.forEach((result) => {
        if (result.status === "fulfilled" && !result.value?.ok) {
          const { errorType } = result.value || {};
          // Auth failures already logged inside recovery function; emit one
          // structured queue-level error the first time so ops can correlate.
          if (errorType === "auth_failure" && !authFailureLogged) {
            authFailureLogged = true;
            console.error("admin-review-queue: Veriff auth failure detected — check VERIFF_API_KEY and VERIFF_PROJECT_ID");
          }
          // session_not_found / client_error / transient are logged with full
          // structured fields inside recoverApplicationIdentityFromVeriffDecision.
        } else if (result.status === "rejected") {
          console.error("admin-review-queue Veriff recovery exception:", result.reason);
        }
      });
    }
  } catch (recoveryErr) {
    console.error("admin-review-queue recovery pass failed:", recoveryErr);
  }

  const result = await listReviewQueueApplications({
    page,
    pageSize,
    lifecycleFilter,
    attentionFilter,
    search,
    sortField,
    sortDir,
  });
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

  let waitlistApplications = [];
  try {
    waitlistApplications = await listFleetWaitlistApplications();
  } catch (waitlistErr) {
    console.error("admin-review-queue waitlist fetch:", waitlistErr);
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
      checkrReportStatus: r.checkr_report_status || null,
      checkrReportId: r.checkr_report_id || null,
      adverseActionStep: r.adverse_action_step || null,
      adverseActionSentAt: r.adverse_action_sent_at || null,
      submittedAt: r.submitted_at || null,
      updatedAt: r.updated_at || null,
      attention: getApplicationAttentionFlags(r),
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    summary: result.summary || null,
    filters: result.filters || null,
    waitlistApplications,
  });
}
