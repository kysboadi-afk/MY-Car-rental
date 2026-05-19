// api/customer-identity-report.js
// Phase B — Validation report endpoint.
//
// Returns the 7 metrics required before advancing to Phase C (dual-write):
//   1. Linked customer counts
//   2. Unresolved conflict counts
//   3. Orphan financial record counts
//   4. Reconciliation summaries
//   5. Duplicate prevention metrics
//   6. Stripe linkage coverage stats
//   7. Manual review queue summary
//
// POST /api/customer-identity-report
// Body: { secret, action: "report" }
// Protected by ADMIN_SECRET.
//
// No writes are performed. Read-only.

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });
  }

  const body = req.body ?? {};
  const { secret, action } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (action !== "report") {
    return res.status(400).json({ error: `Unknown action '${action}'. Only 'report' is supported.` });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const errors = [];

  // ── 1. Linked customer counts ─────────────────────────────────────────────
  const linkedMetrics = await (async () => {
    const [
      { data: allCustomers, error: e1 },
      { data: migrationLog, error: e2 },
    ] = await Promise.all([
      supabase.from("customers").select("id, ledger_migration_status, stripe_customer_id, normalized_email, normalized_phone"),
      supabase.from("customer_migration_log").select("action, confidence_tier"),
    ]);

    if (e1) errors.push(`customers fetch: ${e1.message}`);
    if (e2) errors.push(`migration_log fetch: ${e2.message}`);

    const statusCounts = {};
    for (const c of allCustomers ?? []) {
      statusCounts[c.ledger_migration_status] = (statusCounts[c.ledger_migration_status] ?? 0) + 1;
    }

    const tierCounts = {};
    const actionCounts = {};
    for (const row of migrationLog ?? []) {
      tierCounts[row.confidence_tier] = (tierCounts[row.confidence_tier] ?? 0) + 1;
      actionCounts[row.action] = (actionCounts[row.action] ?? 0) + 1;
    }

    const withStripe     = (allCustomers ?? []).filter((c) => c.stripe_customer_id).length;
    const withNormEmail  = (allCustomers ?? []).filter((c) => c.normalized_email).length;
    const withNormPhone  = (allCustomers ?? []).filter((c) => c.normalized_phone).length;

    return {
      total_customers:          (allCustomers ?? []).length,
      by_migration_status:      statusCounts,
      migration_log_by_action:  actionCounts,
      migration_log_by_tier:    tierCounts,
      normalized_email_count:   withNormEmail,
      normalized_phone_count:   withNormPhone,
    };
  })();

  // ── 2. Unresolved conflict counts ─────────────────────────────────────────
  const conflictMetrics = await (async () => {
    const { data: conflicts, error } = await supabase
      .from("customer_identity_conflicts")
      .select("status, conflict_reason, created_at");

    if (error) errors.push(`conflicts fetch: ${error.message}`);

    const bySt = {};
    for (const c of conflicts ?? []) {
      bySt[c.status] = (bySt[c.status] ?? 0) + 1;
    }

    return {
      total:     (conflicts ?? []).length,
      by_status: bySt,
      oldest_pending_at: (conflicts ?? [])
        .filter((c) => c.status === "pending")
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]?.created_at ?? null,
    };
  })();

  // ── 3. Orphan financial record counts ─────────────────────────────────────
  // Bookings with financial activity (revenue_records, charges) but no customer_id link.
  const orphanMetrics = await (async () => {
    const { data: unlinkedBookings, error } = await supabase
      .from("bookings")
      .select("booking_ref, total_price, status")
      .is("customer_id", null)
      .not("booking_ref", "is", null);

    if (error) errors.push(`orphan bookings fetch: ${error.message}`);

    const withRevenue = (unlinkedBookings ?? []).filter(
      (b) => parseFloat(b.total_price ?? 0) > 0
    );

    const byStatus = {};
    for (const b of unlinkedBookings ?? []) {
      byStatus[b.status ?? "unknown"] = (byStatus[b.status ?? "unknown"] ?? 0) + 1;
    }

    return {
      total_unlinked_bookings:           (unlinkedBookings ?? []).length,
      unlinked_bookings_with_revenue:    withRevenue.length,
      unlinked_bookings_by_status:       byStatus,
    };
  })();

  // ── 4. Reconciliation summaries ───────────────────────────────────────────
  const reconciliationMetrics = await (async () => {
    const [{ data: mismatches, error: e1 }, { data: idempotency, error: e2 }] = await Promise.all([
      supabase
        .from("ledger_reconciliation_mismatches")
        .select("status, drift_direction, drift_cents"),
      supabase
        .from("ledger_idempotency_log")
        .select("source_type")
        .order("attempted_at", { ascending: false })
        .limit(1000),
    ]);

    if (e1) errors.push(`mismatches fetch: ${e1.message}`);
    if (e2) errors.push(`idempotency fetch: ${e2.message}`);

    const mmByStatus = {};
    const mmByDirection = {};
    for (const m of mismatches ?? []) {
      mmByStatus[m.status] = (mmByStatus[m.status] ?? 0) + 1;
      mmByDirection[m.drift_direction] = (mmByDirection[m.drift_direction] ?? 0) + 1;
    }

    const drifts = (mismatches ?? [])
      .filter((m) => m.status === "open")
      .map((m) => Math.abs(m.drift_cents));
    const maxDrift = drifts.length > 0 ? Math.max(...drifts) : 0;
    const avgDrift = drifts.length > 0 ? Math.round(drifts.reduce((a, b) => a + b, 0) / drifts.length) : 0;

    return {
      total_mismatches:         (mismatches ?? []).length,
      mismatches_by_status:     mmByStatus,
      mismatches_by_direction:  mmByDirection,
      open_max_drift_cents:     maxDrift,
      open_avg_drift_cents:     avgDrift,
      idempotency_log_entries:  (idempotency ?? []).length,
    };
  })();

  // ── 5. Duplicate prevention metrics ───────────────────────────────────────
  const duplicateMetrics = await (async () => {
    const { data: idempotencyFull, error } = await supabase
      .from("ledger_idempotency_log")
      .select("source_type, caller");

    if (error) errors.push(`idempotency_full fetch: ${error.message}`);

    const bySourceType = {};
    const byCaller = {};
    for (const row of idempotencyFull ?? []) {
      bySourceType[row.source_type] = (bySourceType[row.source_type] ?? 0) + 1;
      if (row.caller) byCaller[row.caller] = (byCaller[row.caller] ?? 0) + 1;
    }

    return {
      total_duplicate_write_attempts: (idempotencyFull ?? []).length,
      by_source_type: bySourceType,
      by_caller:      byCaller,
    };
  })();

  // ── 6. Stripe linkage coverage stats ─────────────────────────────────────
  const stripeLinkageMetrics = await (async () => {
    const [{ data: bookingsWithStripe, error: e1 }, { data: customersWithStripe, error: e2 }] = await Promise.all([
      supabase
        .from("bookings")
        .select("booking_ref, stripe_customer_id, customer_id")
        .not("booking_ref", "is", null),
      supabase
        .from("customers")
        .select("id, stripe_customer_id"),
    ]);

    if (e1) errors.push(`bookings stripe fetch: ${e1.message}`);
    if (e2) errors.push(`customers stripe fetch: ${e2.message}`);

    const bTotal           = (bookingsWithStripe ?? []).length;
    const bWithStripe      = (bookingsWithStripe ?? []).filter((b) => b.stripe_customer_id).length;
    const bLinked          = (bookingsWithStripe ?? []).filter((b) => b.customer_id).length;
    const bLinkedWithStripe = (bookingsWithStripe ?? []).filter((b) => b.customer_id && b.stripe_customer_id).length;

    const cTotal      = (customersWithStripe ?? []).length;
    const cWithStripe = (customersWithStripe ?? []).filter((c) => c.stripe_customer_id).length;

    return {
      total_bookings:                         bTotal,
      bookings_with_stripe_customer_id:       bWithStripe,
      bookings_stripe_coverage_pct:           bTotal > 0 ? Math.round((bWithStripe / bTotal) * 100) : 0,
      bookings_linked_to_customer:            bLinked,
      bookings_link_coverage_pct:             bTotal > 0 ? Math.round((bLinked / bTotal) * 100) : 0,
      bookings_linked_and_stripe:             bLinkedWithStripe,
      customers_with_stripe_customer_id:      cWithStripe,
      customers_stripe_coverage_pct:          cTotal > 0 ? Math.round((cWithStripe / cTotal) * 100) : 0,
    };
  })();

  // ── 7. Manual review queue summary ────────────────────────────────────────
  const reviewQueueMetrics = await (async () => {
    const { data: pending, error } = await supabase
      .from("customer_identity_conflicts")
      .select("booking_ref, conflict_reason, candidate_customer_ids, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) errors.push(`review queue fetch: ${error.message}`);

    const reasonCounts = {};
    for (const row of pending ?? []) {
      reasonCounts[row.conflict_reason] = (reasonCounts[row.conflict_reason] ?? 0) + 1;
    }

    return {
      pending_count:    conflictMetrics.by_status.pending ?? 0,
      oldest_pending:   (pending ?? [])[0]?.created_at ?? null,
      by_reason:        reasonCounts,
      sample_queue:     (pending ?? []).slice(0, 5).map((r) => ({
        booking_ref:         r.booking_ref,
        conflict_reason:     r.conflict_reason,
        candidate_count:     Array.isArray(r.candidate_customer_ids) ? r.candidate_customer_ids.length : 0,
        created_at:          r.created_at,
      })),
    };
  })();

  // ── Phase C readiness assessment ──────────────────────────────────────────
  const pendingConflicts      = conflictMetrics.by_status.pending ?? 0;
  const orphanWithRevenue     = orphanMetrics.unlinked_bookings_with_revenue;
  const openMismatches        = reconciliationMetrics.mismatches_by_status.open ?? 0;
  const linkCoveragePct       = stripeLinkageMetrics.bookings_link_coverage_pct;

  // Heuristic thresholds — operator may adjust before advancing to Phase C.
  const phaseCReadiness = {
    link_coverage_ok:         linkCoveragePct >= 80,
    conflict_backlog_ok:      pendingConflicts <= 10,
    orphan_revenue_ok:        orphanWithRevenue === 0,
    reconciliation_ok:        openMismatches === 0,
    ready_for_phase_c:
      linkCoveragePct >= 80 &&
      pendingConflicts <= 10 &&
      orphanWithRevenue === 0 &&
      openMismatches === 0,
    notes: [
      linkCoveragePct < 80   ? `⚠ Link coverage ${linkCoveragePct}% is below 80% threshold.` : null,
      pendingConflicts > 10  ? `⚠ ${pendingConflicts} unresolved identity conflicts remain.` : null,
      orphanWithRevenue > 0  ? `⚠ ${orphanWithRevenue} unlinked bookings have revenue records.` : null,
      openMismatches > 0     ? `⚠ ${openMismatches} open reconciliation mismatches remain.` : null,
    ].filter(Boolean),
  };

  return res.status(200).json({
    generated_at:                  new Date().toISOString(),
    errors:                        errors.length > 0 ? errors : undefined,

    // 1. Linked customer counts
    linked_customer_counts:        linkedMetrics,

    // 2. Unresolved conflict counts
    unresolved_conflict_counts:    conflictMetrics,

    // 3. Orphan financial record counts
    orphan_financial_counts:       orphanMetrics,

    // 4. Reconciliation summaries
    reconciliation_summary:        reconciliationMetrics,

    // 5. Duplicate prevention metrics
    duplicate_prevention_metrics:  duplicateMetrics,

    // 6. Stripe linkage coverage
    stripe_linkage_coverage:       stripeLinkageMetrics,

    // 7. Manual review queue
    review_queue_summary:          reviewQueueMetrics,

    // Phase C readiness
    phase_c_readiness:             phaseCReadiness,
  });
}
