import crypto from "node:crypto";
import { extractAdminSecret, isAdminAuthorized } from "./_admin-auth.js";
import {
  fetchRenterApplicationById,
  listPendingIdentityRecoveryApplications,
  patchRenterApplicationIdentityById,
  performReviewAction,
} from "./_renter-applications.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { createVeriffSession, fetchVeriffDecision } from "./_veriff.js";
import { recoverApplicationIdentityFromVeriffDecision } from "./_veriff-identity-recovery.js";
import { initiateCheckrScreening } from "./_checkr.js";
import {
  createStripeIdentitySession,
  getStripeIdentityConfig,
  isStripeIdentitySessionId,
  retrieveStripeIdentitySession,
} from "./_stripe-identity.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const DEFAULT_RETURN_URL = "https://slycarrentals.com/thank-you.html?from=apply";
const TERMINAL_APPLICATION_STATUSES = new Set(["approved", "rejected", "expired", "withdrawn"]);
const stripeIdentityCfg = getStripeIdentityConfig();

function cleanText(value, maxLen = 2000) {
  if (value == null) return "";
  const out = String(value).trim();
  if (!out) return "";
  return out.slice(0, maxLen);
}

function buildVeriffPersonFromApplication(application = {}) {
  const fullName = cleanText(application.name, 200);
  if (!fullName) return {};
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function getReturnUrl(applicationId) {
  const u = new URL(DEFAULT_RETURN_URL);
  u.searchParams.set("identity", "return");
  u.searchParams.set("applicationId", applicationId);
  return u.toString();
}

function isLikelyTestApplication(app = {}) {
  const name = cleanText(app.name, 200).toLowerCase();
  const email = cleanText(app.email, 320).toLowerCase();
  const phone = cleanText(app.phone, 40).replace(/\D+/g, "");

  const hasTestName = /(test|debug|qa|dummy|sample|sandbox|staging)/i.test(name);
  const hasTestEmail = /(test|debug|qa|dummy|sample|sandbox|staging)/i.test(email)
    || /\+test/.test(email)
    || email.endsWith("@example.com")
    || email.endsWith("@mailinator.com")
    || email.endsWith("@test.com")
    || email.endsWith("@example.org");
  const hasTestPhone = !!phone && (phone.startsWith("555") || /^(\d)\1+$/.test(phone));

  return hasTestName || hasTestEmail || hasTestPhone;
}

async function appendAuditAction(sb, {
  applicationId,
  action,
  performedBy,
  notes = null,
  previousStatus,
  newStatus,
}) {
  const payload = {
    application_id: applicationId,
    action,
    performed_by: performedBy,
    notes: cleanText(notes, 2000) || null,
    previous_status: previousStatus || newStatus || "submitted",
    new_status: newStatus || previousStatus || "submitted",
    action_request_id: crypto.randomUUID(),
  };
  const { error } = await sb.from("application_review_actions").insert(payload);
  if (error) {
    console.error("admin-application-ops: failed to append audit action:", error.message || error);
  }
}

async function fetchRequiredApplication(applicationId) {
  const appResult = await fetchRenterApplicationById(applicationId);
  if (!appResult.ok) return appResult;
  return { ok: true, data: appResult.data || {} };
}

async function handleResendVerification(applicationId, reviewer, notes, sb) {
  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const app = appResult.data;
  const currentStatus = String(app.application_status || "").toLowerCase();

  if (TERMINAL_APPLICATION_STATUSES.has(currentStatus)) {
    return { ok: false, status: 422, error: `Cannot resend verification for terminal status "${currentStatus}".` };
  }
  if (app.identity_status === "verified") {
    return { ok: true, alreadyVerified: true, identityStatus: "verified", applicationStatus: currentStatus };
  }

  if (app.identity_session_id) {
    if (isStripeIdentitySessionId(app.identity_session_id)) {
      const session = await retrieveStripeIdentitySession(app.identity_session_id);
      if (session.ok && session.mappedStatus === "requires_input" && session.verificationUrl) {
        await appendAuditAction(sb, {
          applicationId,
          action: "resend_verification",
          performedBy: reviewer,
          notes: notes || "Reused existing verification session.",
          previousStatus: currentStatus,
          newStatus: currentStatus,
        });
        return {
          ok: true,
          reused: true,
          verificationUrl: session.verificationUrl,
          verificationSessionId: session.sessionId || app.identity_session_id,
          identityClientSecret: session.clientSecret || null,
          identityStatus: "requires_input",
        };
      }
    } else {
      try {
        const decision = await fetchVeriffDecision(app.identity_session_id);
        if (decision.ok && decision.mappedStatus === "requires_input" && decision.verificationUrl) {
          await appendAuditAction(sb, {
            applicationId,
            action: "resend_verification",
            performedBy: reviewer,
            notes: notes || "Reused existing verification session.",
            previousStatus: currentStatus,
            newStatus: currentStatus,
          });
          return {
            ok: true,
            reused: true,
            verificationUrl: decision.verificationUrl,
            verificationSessionId: decision.sessionId || app.identity_session_id,
            identityStatus: "requires_input",
          };
        }
      } catch (err) {
        console.warn("admin-application-ops resend lookup failed; creating fresh session:", err?.message || err);
      }
    }
  }

  const session = stripeIdentityCfg.configured
    ? await createStripeIdentitySession({
      applicationId,
      returnUrl: getReturnUrl(applicationId),
      person: buildVeriffPersonFromApplication(app),
    })
    : await createVeriffSession({
      applicationId,
      returnUrl: getReturnUrl(applicationId),
      person: buildVeriffPersonFromApplication(app),
    });
  if (!session.ok) {
    return { ok: false, status: session.status || 500, error: session.error || "Failed to create verification session." };
  }

  const patchResult = await patchRenterApplicationIdentityById(applicationId, {
    identitySessionId: session.sessionId,
    identityStatus: "requires_input",
    identityLastError: null,
  });
  if (!patchResult.ok) {
    return { ok: false, status: patchResult.status || 500, error: patchResult.error || "Could not update application." };
  }

  await appendAuditAction(sb, {
    applicationId,
    action: "resend_verification",
    performedBy: reviewer,
    notes: notes || "Issued verification session for resend.",
    previousStatus: currentStatus,
    newStatus: patchResult.data?.application_status || currentStatus,
  });

  return {
    ok: true,
    reused: false,
    verificationUrl: session.verificationUrl,
    verificationSessionId: session.sessionId,
    identityClientSecret: session.clientSecret || null,
    identityStatus: "requires_input",
  };
}

async function handleRestartVerification(applicationId, reviewer, notes, sb) {
  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const app = appResult.data;
  const currentStatus = String(app.application_status || "").toLowerCase();

  if (TERMINAL_APPLICATION_STATUSES.has(currentStatus)) {
    return { ok: false, status: 422, error: `Cannot restart verification for terminal status "${currentStatus}".` };
  }

  const session = stripeIdentityCfg.configured
    ? await createStripeIdentitySession({
      applicationId,
      returnUrl: getReturnUrl(applicationId),
      person: buildVeriffPersonFromApplication(app),
    })
    : await createVeriffSession({
      applicationId,
      returnUrl: getReturnUrl(applicationId),
      person: buildVeriffPersonFromApplication(app),
    });
  if (!session.ok) {
    return { ok: false, status: session.status || 500, error: session.error || "Failed to restart verification session." };
  }

  const patchResult = await patchRenterApplicationIdentityById(applicationId, {
    identitySessionId: session.sessionId,
    identityStatus: "requires_input",
    identityLastError: null,
  });
  if (!patchResult.ok) {
    return { ok: false, status: patchResult.status || 500, error: patchResult.error || "Could not update application." };
  }

  await appendAuditAction(sb, {
    applicationId,
    action: "restart_verification",
    performedBy: reviewer,
    notes: notes || "Started fresh verification session.",
    previousStatus: currentStatus,
    newStatus: patchResult.data?.application_status || currentStatus,
  });

  return {
    ok: true,
    verificationUrl: session.verificationUrl,
    verificationSessionId: session.sessionId,
    identityClientSecret: session.clientSecret || null,
    identityStatus: "requires_input",
  };
}

async function handleMoveToReview(applicationId, reviewer, notes, sb) {
  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const app = appResult.data;
  const currentStatus = String(app.application_status || "").toLowerCase();

  if (TERMINAL_APPLICATION_STATUSES.has(currentStatus)) {
    return { ok: false, status: 422, error: `Cannot move terminal status "${currentStatus}" to review.` };
  }
  if (currentStatus === "under_review") {
    return { ok: true, unchanged: true, applicationStatus: currentStatus };
  }

  const now = new Date().toISOString();
  const patchResult = await patchRenterApplicationIdentityById(applicationId, {
    applicationStatus: "under_review",
    reviewedBy: reviewer,
    reviewedAt: now,
  });
  if (!patchResult.ok) {
    return { ok: false, status: patchResult.status || 500, error: patchResult.error || "Could not move application to review." };
  }

  await appendAuditAction(sb, {
    applicationId,
    action: "move_to_review",
    performedBy: reviewer,
    notes: notes || "Moved application to under_review.",
    previousStatus: currentStatus,
    newStatus: "under_review",
  });

  return { ok: true, applicationStatus: "under_review" };
}

async function handleRequestAdditionalInfo(applicationId, reviewer, notes) {
  if (!cleanText(notes, 2000)) {
    return { ok: false, status: 400, error: "notes are required for request_additional_info." };
  }

  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const app = appResult.data;
  const currentStatus = String(app.application_status || "").toLowerCase();
  const currentVersion = Number(app.review_version) || 0;

  const result = await performReviewAction(
    applicationId,
    "needs_info",
    reviewer,
    notes,
    currentStatus,
    currentVersion,
    crypto.randomUUID(),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    applicationStatus: result.data?.application_status || "needs_info",
    reviewVersion: result.data?.review_version ?? null,
  };
}

async function handleManualRecovery(applicationId, reviewer, notes, sb) {
  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const app = appResult.data;
  const currentStatus = String(app.application_status || "").toLowerCase();

  const result = await recoverApplicationIdentityFromVeriffDecision(app, {
    reviewedBy: reviewer || "admin_manual_recovery",
    notify: false,
  });
  if (!result.ok) {
    if (result.errorType) {
      return {
        ok: true,
        synced: false,
        skipped: true,
        errorType: result.errorType,
        recoveryError: result.error || null,
        details: result.details || "",
        veriffStatus: null,
        applicationStatus: currentStatus,
        identityStatus: app.identity_status || null,
      };
    }
    return { ok: false, status: 500, error: result.error || "Recovery failed.", details: result.details };
  }

  if (result.synced) {
    const nextStatus = String(result?.data?.application_status || currentStatus);
    await appendAuditAction(sb, {
      applicationId,
      action: "manual_recovery",
      performedBy: reviewer,
      notes: notes || "Manual Veriff recovery triggered.",
      previousStatus: currentStatus,
      newStatus: nextStatus,
    });
  }

  return {
    ok: true,
    synced: !!result.synced,
    alreadySynced: !!result.alreadySynced,
    skipped: !!result.skipped,
    reason: result.reason || null,
    veriffStatus: result.veriffStatus || null,
    applicationStatus: result?.data?.application_status || currentStatus,
    identityStatus: result?.data?.identity_status || app.identity_status || null,
  };
}

async function handleRetryCheckr(applicationId, reviewer, notes, sb) {
  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const currentStatus = String(appResult.data?.application_status || "").toLowerCase();

  const result = await initiateCheckrScreening(applicationId);
  if (!result.ok) return result;

  await appendAuditAction(sb, {
    applicationId,
    action: "retry_checkr",
    performedBy: reviewer,
    notes: notes || "Retried Checkr initiation.",
    previousStatus: currentStatus,
    newStatus: currentStatus,
  });

  return {
    ok: true,
    alreadyStarted: !!result.alreadyStarted,
    candidateId: result.candidateId || null,
    reportId: result.reportId || null,
    reportStatus: result.reportStatus || null,
    invitationUrl: result.invitationUrl || null,
  };
}

async function handleArchiveApplication(applicationId, reviewer, notes, sb) {
  const appResult = await fetchRequiredApplication(applicationId);
  if (!appResult.ok) return appResult;
  const app = appResult.data;
  const currentStatus = String(app.application_status || "").toLowerCase();

  if (currentStatus === "withdrawn") {
    return { ok: true, archived: true, unchanged: true, applicationStatus: "withdrawn" };
  }
  if (currentStatus === "approved" || currentStatus === "rejected" || currentStatus === "expired") {
    return { ok: false, status: 422, error: `Cannot archive terminal status "${currentStatus}".` };
  }

  const patchResult = await patchRenterApplicationIdentityById(applicationId, {
    applicationStatus: "withdrawn",
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
  });
  if (!patchResult.ok) {
    return { ok: false, status: patchResult.status || 500, error: patchResult.error || "Could not archive application." };
  }

  await appendAuditAction(sb, {
    applicationId,
    action: "delete_application",
    performedBy: reviewer,
    notes: notes || "Archived via admin delete action.",
    previousStatus: currentStatus,
    newStatus: "withdrawn",
  });

  return { ok: true, archived: true, applicationStatus: "withdrawn" };
}

async function handleArchiveTestApplications(reviewer, notes, dryRun, sb) {
  const { data, error } = await sb
    .from("renter_applications")
    .select("id, name, phone, email, application_status")
    .in("application_status", ["submitted", "under_review", "needs_info"])
    .order("submitted_at", { ascending: true })
    .limit(500);
  if (error) {
    return { ok: false, status: 503, error: "Could not load queue for cleanup.", details: error.message };
  }

  const candidates = (data || []).filter(isLikelyTestApplication);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      candidates: candidates.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email || null,
        phone: row.phone,
        applicationStatus: row.application_status,
      })),
      count: candidates.length,
    };
  }

  let archived = 0;
  const failed = [];
  for (const row of candidates) {
    const patchResult = await patchRenterApplicationIdentityById(row.id, {
      applicationStatus: "withdrawn",
      reviewedBy: reviewer,
      reviewedAt: new Date().toISOString(),
    });
    if (!patchResult.ok) {
      failed.push({ id: row.id, error: patchResult.error || "Could not archive." });
      continue;
    }
    archived += 1;
    await appendAuditAction(sb, {
      applicationId: row.id,
      action: "archive_test",
      performedBy: reviewer,
      notes: notes || "Archived as test/debug cleanup.",
      previousStatus: row.application_status,
      newStatus: "withdrawn",
    });
  }

  return {
    ok: true,
    dryRun: false,
    archived,
    failed,
    scanned: (data || []).length,
    count: candidates.length,
  };
}

async function handleBackfillVeriffApproved(reviewer, notes, dryRun, sb) {
  const candidatesResult = await listPendingIdentityRecoveryApplications({ limit: 200 }, sb);
  if (!candidatesResult.ok) {
    return { ok: false, status: candidatesResult.status || 503, error: candidatesResult.error || "Could not load recovery candidates." };
  }

  const candidates = candidatesResult.data;
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      count: candidates.length,
      candidates: candidates.map((row) => ({
        id: row.id,
        applicationStatus: row.application_status,
        identityStatus: row.identity_status,
        identitySessionId: row.identity_session_id,
      })),
    };
  }

  let synced = 0;
  let skipped = 0;
  const failed = [];

  for (const app of candidates) {
    const result = await recoverApplicationIdentityFromVeriffDecision(app, {
      reviewedBy: reviewer || "admin_backfill",
      notify: true,
    });

    if (!result.ok) {
      if (result.errorType) {
        skipped += 1;
      } else {
        failed.push({ id: app.id, error: result.error || "Recovery failed." });
      }
      continue;
    }

    if (result.skipped) {
      skipped += 1;
      continue;
    }

    if (result.synced) {
      synced += 1;
      const nextStatus = String(result?.data?.application_status || app.application_status);
      await appendAuditAction(sb, {
        applicationId: app.id,
        action: "manual_recovery",
        performedBy: reviewer,
        notes: notes || "Backfill: synced approved Veriff identity.",
        previousStatus: String(app.application_status || ""),
        newStatus: nextStatus,
      });
    } else {
      skipped += 1;
    }
  }

  return {
    ok: true,
    dryRun: false,
    scanned: candidates.length,
    synced,
    skipped,
    failed,
  };
}

async function handleClearDeclinedApplications(reviewer, notes, dryRun, sb) {
  const { data, error } = await sb
    .from("renter_applications")
    .select("id, application_status")
    .eq("application_status", "rejected")
    .order("reviewed_at", { ascending: true, nullsFirst: false })
    .limit(1000);
  if (error) {
    return { ok: false, status: 503, error: "Could not load declined applications.", details: error.message };
  }

  const declined = (data || []).filter((row) => String(row.application_status || "").toLowerCase() === "rejected");
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      count: declined.length,
      candidates: declined.map((row) => ({ id: row.id })),
    };
  }

  let archived = 0;
  const failed = [];
  const now = new Date().toISOString();
  for (const row of declined) {
    const patchResult = await patchRenterApplicationIdentityById(row.id, {
      applicationStatus: "withdrawn",
      reviewedBy: reviewer,
      reviewedAt: now,
    });
    if (!patchResult.ok) {
      failed.push({ id: row.id, error: patchResult.error || "Could not clear declined application." });
      continue;
    }
    archived += 1;
    await appendAuditAction(sb, {
      applicationId: row.id,
      action: "clear_declined",
      performedBy: reviewer,
      notes: notes || "Bulk-cleared declined applications.",
      previousStatus: "rejected",
      newStatus: "withdrawn",
    });
  }

  return {
    ok: true,
    dryRun: false,
    archived,
    failed,
    scanned: (data || []).length,
    count: declined.length,
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (!isAdminAuthorized(extractAdminSecret(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const action = cleanText(req.body?.action, 60);
  const applicationId = cleanText(req.body?.applicationId, 100);
  const notes = cleanText(req.body?.notes, 2000) || null;
  const reviewedBy = cleanText(req.body?.reviewedBy, 200) || "admin_ops";
  const dryRun = req.body?.dryRun !== false;
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Application storage service is not configured." });

  try {
    let result = null;
    if (action === "archive_test_applications") {
      result = await handleArchiveTestApplications(reviewedBy, notes, dryRun, sb);
    } else if (action === "clear_declined_applications") {
      result = await handleClearDeclinedApplications(reviewedBy, notes, dryRun, sb);
    } else if (action === "backfill_veriff_approved") {
      result = await handleBackfillVeriffApproved(reviewedBy, notes, dryRun, sb);
    } else {
      if (!applicationId) return res.status(400).json({ error: "applicationId is required." });
      if (action === "resend_verification") {
        result = await handleResendVerification(applicationId, reviewedBy, notes, sb);
      } else if (action === "restart_verification") {
        result = await handleRestartVerification(applicationId, reviewedBy, notes, sb);
      } else if (action === "move_to_review") {
        result = await handleMoveToReview(applicationId, reviewedBy, notes, sb);
      } else if (action === "request_additional_info") {
        result = await handleRequestAdditionalInfo(applicationId, reviewedBy, notes);
      } else if (action === "manual_recovery") {
        result = await handleManualRecovery(applicationId, reviewedBy, notes, sb);
      } else if (action === "retry_checkr") {
        result = await handleRetryCheckr(applicationId, reviewedBy, notes, sb);
      } else if (action === "archive_application") {
        result = await handleArchiveApplication(applicationId, reviewedBy, notes, sb);
      } else {
        return res.status(400).json({ error: "Unsupported action." });
      }
    }

    if (!result?.ok) {
      const status = Number(result?.status) || 500;
      return res.status(status).json({ error: result?.error || "Operation failed." });
    }
    return res.status(200).json({ success: true, action, ...result });
  } catch (err) {
    console.error("admin-application-ops failed:", err);
    return res.status(500).json({ error: "Operation failed." });
  }
}
