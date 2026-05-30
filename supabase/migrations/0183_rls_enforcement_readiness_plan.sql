-- supabase/migrations/0183_rls_enforcement_readiness_plan.sql
-- RLS / enforcement rollout plan (planning-only, no enforcement activation).
--
-- PURPOSE:
--   Produces a structured readiness checklist and rollout sequence without
--   changing any policy, grant, trigger, or table behavior.
--
-- SAFETY:
--   Read-only plan output only.

SELECT *
FROM (
  VALUES
    (1, 'validation_clean', 'Run 0178_staging_validation.sql with no exceptions.', 'PENDING', 'Block enforcement if any 0178 check fails.'),
    (2, 'wave_a_audit_clean', 'Run 0179_backfill_audit.sql and resolve all INVESTIGATE/ACTION REQUIRED results.', 'PENDING', 'Fallback/parity anomalies must be closed first.'),
    (3, 'wave_b_deployed', 'Apply 0180_financial_tenant_wave_b.sql successfully in target environment.', 'PENDING', 'Do not proceed if migration apply is partial.'),
    (4, 'wave_b_audit_clean', 'Run 0181_wave_b_backfill_audit.sql and close mismatch/null-org findings.', 'PENDING', 'No unresolved parity drift before enforcement.'),
    (5, 'ownership_gaps_closed', 'Run 0182_tenant_ownership_inventory.sql; all tenant-sensitive surfaces must be classified READY.', 'PENDING', 'No unresolved ownership surfaces remain.'),
    (6, 'runtime_observability_active', 'Confirm runtime events are emitting for auth_mismatch, parity_drift, tenant_isolation_gap, financial_consistency_alert.', 'PENDING', 'Instrumentation must be active in production paths.'),
    (7, 'rollback_plan_ready', 'Document rollback SQL and feature-flag rollback actions for each enforcement step.', 'PENDING', 'Rollback must be validated before policy activation.'),
    (8, 'enforcement_dry_run', 'Execute read-only dry-run checks in staging and compare with expected tenant partitions.', 'PENDING', 'No cross-tenant leakage in dry-run results.'),
    (9, 'phased_enforcement_activation', 'Activate RLS/policy enforcement in phases (read paths, then write paths) with live monitoring.', 'BLOCKED', 'Remain blocked until gates 1-8 are complete.')
) AS rollout(step_order, gate_key, required_evidence, status, notes)
ORDER BY step_order;

SELECT *
FROM (
  VALUES
    ('phase_1', 'Enable read-path RLS policies for lowest-risk reporting surfaces first.'),
    ('phase_2', 'Enable write-path enforcement for Wave A financial tables after clean read metrics.'),
    ('phase_3', 'Enable write-path enforcement for Wave B tables after clean Wave B audits.'),
    ('phase_4', 'Promote tenant isolation checks from warn-only to hard-fail for admin/operator runtime paths.'),
    ('phase_5', 'Retire compatibility fallback paths only after sustained zero-alert window.')
) AS phases(phase, plan_item)
ORDER BY phase;

SELECT *
FROM (
  VALUES
    ('rollback_trigger', 'Any spike in tenant_isolation_gap, parity_drift, or financial_consistency_alert after activation.'),
    ('rollback_action_1', 'Disable new enforcement flag / policy set for affected phase.'),
    ('rollback_action_2', 'Re-run 0179 + 0181 audits to isolate drift source.'),
    ('rollback_action_3', 'Restore compatibility query path where applicable and continue observability capture.'),
    ('rollback_action_4', 'Publish incident summary and remediation checklist before next activation attempt.')
) AS rollback_plan(item, description)
ORDER BY item;
