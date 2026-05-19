// api/veriff-identity-recovery-cron.js
// Vercel cron — Automatic Veriff identity recovery worker.
//
// Periodically scans for renter applications whose Veriff identity check is
// stalled in a recoverable state (processing, requires_input, not_started) and
// fetches the latest decision directly from the Veriff API.  This is the
// automatic safety-net that resolves the processing→verified transition without
// requiring manual admin intervention or a fresh terminal webhook from Veriff.
//
// GET  /api/veriff-identity-recovery-cron  — Vercel cron trigger (no auth needed)
// POST /api/veriff-identity-recovery-cron  — Manual trigger; requires
//       Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Run schedule (vercel.json): every 30 minutes  (*/30 * * * *)
//
// Recoverable application states queried:
//   • application_status=submitted  AND identity_status IN (not_started, requires_input, processing)
//   • application_status=under_review AND identity_status=processing
//
// Each candidate is passed through recoverApplicationIdentityFromVeriffDecision,
// which fetches the latest Veriff decision, patches the DB, sends notifications,
// and launches Checkr — identical to the webhook-driven finalization path.
//
// Observability:
//   veriff-recovery-cron: scan started      { candidateCount, batchLimit }
//   veriff-recovery-cron: stuck backlog     { stuckCount, warnThresholdHours }  ← warning
//   veriff-recovery-cron: auth failure      — error, suppresses remaining calls
//   veriff-recovery-cron: scan completed   { scanned, synced, skipped, failed, stuckCount, durationMs }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   VERIFF_API_KEY, VERIFF_PROJECT_ID, VERIFF_SHARED_SECRET

import { getSupabaseAdmin } from "./_supabase.js";
import { listPendingIdentityRecoveryApplications } from "./_renter-applications.js";
import { recoverApplicationIdentityFromVeriffDecision } from "./_veriff-identity-recovery.js";

// Maximum candidates processed per cron invocation.  Capped to keep each run
// well within the 60-second Vercel function timeout (each Veriff API call takes
// ~200–800 ms on average; 50 calls ≈ 10–40 s worst-case).
const RECOVERY_BATCH_LIMIT = 50;

// Warn if any processing-identity application is older than this threshold.
// A high stuck count relative to expected throughput indicates the Veriff
// terminal webhook is still not being delivered, and the cron is the only
// recovery mechanism active.
const STUCK_IDENTITY_WARN_HOURS = 4;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Manual POST requires a valid secret so the endpoint cannot be invoked by
  // unauthenticated callers.
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const startedAt = Date.now();

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({
      skipped: true,
      reason: "Supabase not configured",
      duration_ms: Date.now() - startedAt,
    });
  }

  const candidatesResult = await listPendingIdentityRecoveryApplications({
    limit: RECOVERY_BATCH_LIMIT,
  });

  if (!candidatesResult.ok) {
    console.error("veriff-recovery-cron: candidate scan failed", {
      error: candidatesResult.error || null,
      details: candidatesResult.details || null,
    });
    return res.status(200).json({
      skipped: true,
      reason: "candidate_scan_failed",
      duration_ms: Date.now() - startedAt,
    });
  }

  const candidates = candidatesResult.data || [];

  console.info("veriff-recovery-cron: scan started", {
    candidateCount: candidates.length,
    batchLimit: RECOVERY_BATCH_LIMIT,
  });

  // Count identities that have been stuck in processing beyond the alert
  // threshold.  A non-zero count after the cron has had several opportunities
  // to recover them indicates a persistent upstream problem (e.g., Veriff API
  // returning non-approved decisions, bad credentials, or session not found).
  const warnThresholdMs = STUCK_IDENTITY_WARN_HOURS * 60 * 60 * 1000;
  const stuckCount = candidates.filter((app) => {
    if (app.identity_status !== "processing") return false;
    const ts = app.submitted_at ? new Date(app.submitted_at).getTime() : 0;
    return ts > 0 && Date.now() - ts > warnThresholdMs;
  }).length;

  if (stuckCount > 0) {
    console.warn("veriff-recovery-cron: stuck processing identities detected", {
      stuckCount,
      warnThresholdHours: STUCK_IDENTITY_WARN_HOURS,
      hint: "If stuckCount persists across runs, verify Veriff terminal webhooks are enabled and the decision API is returning approved/declined outcomes.",
    });
  }

  if (candidates.length === 0) {
    const summary = {
      scanned: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
      stuckCount: 0,
      authFailureDetected: false,
      duration_ms: Date.now() - startedAt,
    };
    console.info("veriff-recovery-cron: scan completed", summary);
    return res.status(200).json(summary);
  }

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let authFailureDetected = false;

  for (const app of candidates) {
    let result;
    try {
      result = await recoverApplicationIdentityFromVeriffDecision(app, {
        reviewedBy: "veriff_recovery_cron",
        notify: true,
      });
    } catch (err) {
      failed += 1;
      console.error("veriff-recovery-cron: recovery exception", {
        application_id: app.id || null,
        error: err?.message || String(err),
      });
      continue;
    }

    if (!result.ok) {
      if (result.errorType === "auth_failure") {
        // The module-level auth gate in _veriff-identity-recovery.js will
        // suppress all subsequent calls in this invocation — break early so
        // we do not spin through every remaining candidate pointlessly.
        authFailureDetected = true;
        failed += 1;
        break;
      } else if (result.errorType) {
        // session_not_found / client_error / transient — already logged with
        // full diagnostics inside recoverApplicationIdentityFromVeriffDecision.
        skipped += 1;
      } else {
        failed += 1;
      }
      continue;
    }

    if (result.synced) {
      synced += 1;
    } else {
      skipped += 1;
    }
  }

  if (authFailureDetected) {
    console.error(
      "veriff-recovery-cron: Veriff auth failure — recovery suspended. " +
      "Verify VERIFF_API_KEY, VERIFF_PROJECT_ID, and VERIFF_SHARED_SECRET match " +
      "the project where the webhook is configured.",
    );
  }

  const summary = {
    scanned: candidates.length,
    synced,
    skipped,
    failed,
    stuckCount,
    authFailureDetected,
    duration_ms: Date.now() - startedAt,
  };
  console.info("veriff-recovery-cron: scan completed", summary);
  return res.status(200).json(summary);
}
