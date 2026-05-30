-- supabase/migrations/0182_tenant_ownership_inventory.sql
-- Tenant-sensitive ownership verification + readiness classification inventory.
--
-- PURPOSE:
--   Verifies organization ownership coverage across financial/reconciliation
--   tables, reconciliation views, and derived reporting surfaces.
--
-- OUTPUTS:
--   1) Detailed surface inventory with readiness classification
--   2) Classification summary counts (ready / owned-but-unaudited / unresolved ownership)
--   3) Unresolved ownership surface list (action queue)
--
-- SAFETY:
--   Read-only. No schema/data mutation.

WITH target_audit_status AS (
  SELECT *
  FROM (VALUES
    ('bookings', 'wave_a_audited', true,  'financial_table'),
    ('customers', 'wave_a_audited', true, 'financial_table'),
    ('revenue_records', 'wave_a_audited', true, 'financial_table'),
    ('renter_balance_ledger', 'wave_a_audited', true, 'financial_table'),
    ('payment_plans', 'wave_a_audited', true, 'financial_table'),
    ('payment_plan_installments', 'wave_a_audited', true, 'financial_table'),
    ('charges', 'wave_b_pending_audit', false, 'financial_table'),
    ('tickets', 'wave_b_pending_audit', false, 'financial_table'),
    ('booking_extensions', 'wave_b_pending_audit', false, 'financial_table'),
    ('customer_ledger', 'wave_b_pending_audit', false, 'financial_table'),
    ('revenue_records_effective', 'derived_surface_pending_review', false, 'derived_reporting_surface')
  ) AS t(surface_name, audit_status, is_audited, expected_domain)
),

sensitive_surfaces AS (
  SELECT DISTINCT
    t.table_schema,
    t.table_name AS surface_name,
    t.table_type,
    EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = t.table_schema
        AND c.table_name = t.table_name
        AND c.column_name = 'organization_id'
    ) AS has_organization_id,
    EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = t.table_schema
        AND c.table_name = t.table_name
        AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
    ) AS has_tenant_linkage_key,
    CASE
      WHEN t.table_type = 'VIEW' THEN coalesce(v.view_definition, '')
      ELSE ''
    END AS view_definition
  FROM information_schema.tables t
  LEFT JOIN information_schema.views v
    ON v.table_schema = t.table_schema
   AND v.table_name = t.table_name
  WHERE t.table_schema = 'public'
    AND t.table_type IN ('BASE TABLE', 'VIEW')
    AND (
      EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema
          AND c.table_name = t.table_name
          AND c.column_name = 'organization_id'
      )
      OR EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema
          AND c.table_name = t.table_name
          AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
      )
      OR lower(t.table_name) LIKE '%reconcile%'
      OR lower(t.table_name) LIKE '%reconciliation%'
      OR lower(t.table_name) LIKE '%ledger%'
      OR lower(t.table_name) LIKE '%revenue%'
    )
),

classified AS (
  SELECT
    s.table_schema,
    s.surface_name,
    CASE WHEN s.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS surface_type,
    CASE
      WHEN coalesce(a.expected_domain, '') <> '' THEN a.expected_domain
      WHEN s.table_type = 'VIEW' AND (
        lower(s.surface_name) LIKE '%effective%'
        OR lower(s.surface_name) LIKE '%report%'
        OR lower(s.view_definition) LIKE '%revenue%'
      ) THEN 'derived_reporting_surface'
      WHEN lower(s.surface_name) LIKE '%reconcile%' OR lower(s.surface_name) LIKE '%reconciliation%' THEN
        CASE WHEN s.table_type = 'VIEW' THEN 'reconciliation_view' ELSE 'reconciliation_table' END
      ELSE 'financial_table'
    END AS domain,
    s.has_organization_id,
    s.has_tenant_linkage_key,
    coalesce(a.audit_status, 'not_yet_audited') AS audit_status,
    coalesce(a.is_audited, false) AS is_audited,
    CASE
      WHEN NOT s.has_organization_id THEN 'unresolved ownership'
      WHEN coalesce(a.is_audited, false) THEN 'ready'
      ELSE 'owned-but-unaudited'
    END AS readiness_classification,
    CASE
      WHEN NOT s.has_organization_id THEN 'Add organization_id ownership scaffold before enforcement.'
      WHEN coalesce(a.audit_status, '') = 'wave_b_pending_audit' THEN 'Run 0181_wave_b_backfill_audit.sql and review results.'
      WHEN coalesce(a.audit_status, '') = 'derived_surface_pending_review' THEN 'Validate reporting view tenancy parity against source tables.'
      WHEN coalesce(a.audit_status, '') = 'not_yet_audited' THEN 'Scope and execute audit before enforcement.'
      ELSE 'No blocking ownership gaps identified in this inventory.'
    END AS action_note
  FROM sensitive_surfaces s
  LEFT JOIN target_audit_status a
    ON a.surface_name = s.surface_name
)

SELECT
  table_schema,
  surface_name,
  surface_type,
  domain,
  has_organization_id,
  has_tenant_linkage_key,
  audit_status,
  readiness_classification,
  action_note
FROM classified
ORDER BY
  CASE readiness_classification
    WHEN 'unresolved ownership' THEN 0
    WHEN 'owned-but-unaudited' THEN 1
    ELSE 2
  END,
  domain,
  surface_name;

WITH target_audit_status AS (
  SELECT *
  FROM (VALUES
    ('bookings', 'wave_a_audited', true,  'financial_table'),
    ('customers', 'wave_a_audited', true, 'financial_table'),
    ('revenue_records', 'wave_a_audited', true, 'financial_table'),
    ('renter_balance_ledger', 'wave_a_audited', true, 'financial_table'),
    ('payment_plans', 'wave_a_audited', true, 'financial_table'),
    ('payment_plan_installments', 'wave_a_audited', true, 'financial_table'),
    ('charges', 'wave_b_pending_audit', false, 'financial_table'),
    ('tickets', 'wave_b_pending_audit', false, 'financial_table'),
    ('booking_extensions', 'wave_b_pending_audit', false, 'financial_table'),
    ('customer_ledger', 'wave_b_pending_audit', false, 'financial_table'),
    ('revenue_records_effective', 'derived_surface_pending_review', false, 'derived_reporting_surface')
  ) AS t(surface_name, audit_status, is_audited, expected_domain)
),
classified AS (
  SELECT
    s.table_name AS surface_name,
    CASE
      WHEN NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = s.table_schema
          AND c.table_name = s.table_name
          AND c.column_name = 'organization_id'
      ) THEN 'unresolved ownership'
      WHEN coalesce(a.is_audited, false) THEN 'ready'
      ELSE 'owned-but-unaudited'
    END AS readiness_classification
  FROM information_schema.tables s
  LEFT JOIN target_audit_status a
    ON a.surface_name = s.table_name
  WHERE s.table_schema = 'public'
    AND s.table_type IN ('BASE TABLE', 'VIEW')
    AND (
      EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = s.table_schema
          AND c.table_name = s.table_name
          AND c.column_name = 'organization_id'
      )
      OR EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = s.table_schema
          AND c.table_name = s.table_name
          AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
      )
      OR lower(s.table_name) LIKE '%reconcile%'
      OR lower(s.table_name) LIKE '%reconciliation%'
      OR lower(s.table_name) LIKE '%ledger%'
      OR lower(s.table_name) LIKE '%revenue%'
    )
)
SELECT readiness_classification, COUNT(*) AS surface_count
FROM classified
GROUP BY readiness_classification
ORDER BY readiness_classification;

WITH target_audit_status AS (
  SELECT *
  FROM (VALUES
    ('bookings', 'wave_a_audited', true,  'financial_table'),
    ('customers', 'wave_a_audited', true, 'financial_table'),
    ('revenue_records', 'wave_a_audited', true, 'financial_table'),
    ('renter_balance_ledger', 'wave_a_audited', true, 'financial_table'),
    ('payment_plans', 'wave_a_audited', true, 'financial_table'),
    ('payment_plan_installments', 'wave_a_audited', true, 'financial_table'),
    ('charges', 'wave_b_pending_audit', false, 'financial_table'),
    ('tickets', 'wave_b_pending_audit', false, 'financial_table'),
    ('booking_extensions', 'wave_b_pending_audit', false, 'financial_table'),
    ('customer_ledger', 'wave_b_pending_audit', false, 'financial_table'),
    ('revenue_records_effective', 'derived_surface_pending_review', false, 'derived_reporting_surface')
  ) AS t(surface_name, audit_status, is_audited, expected_domain)
)
SELECT
  s.table_name AS surface_name,
  CASE WHEN s.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS surface_type,
  CASE
    WHEN lower(s.table_name) LIKE '%reconcile%' OR lower(s.table_name) LIKE '%reconciliation%'
      THEN CASE WHEN s.table_type = 'VIEW' THEN 'reconciliation_view' ELSE 'reconciliation_table' END
    WHEN s.table_type = 'VIEW' THEN 'derived_reporting_surface'
    ELSE 'financial_table'
  END AS domain,
  'missing organization_id ownership' AS unresolved_reason
FROM information_schema.tables s
LEFT JOIN target_audit_status a
  ON a.surface_name = s.table_name
WHERE s.table_schema = 'public'
  AND s.table_type IN ('BASE TABLE', 'VIEW')
  AND (
    EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = s.table_schema
        AND c.table_name = s.table_name
        AND c.column_name IN ('booking_id', 'booking_ref', 'customer_id', 'payment_intent_id')
    )
    OR lower(s.table_name) LIKE '%reconcile%'
    OR lower(s.table_name) LIKE '%reconciliation%'
    OR lower(s.table_name) LIKE '%ledger%'
    OR lower(s.table_name) LIKE '%revenue%'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = s.table_schema
      AND c.table_name = s.table_name
      AND c.column_name = 'organization_id'
  )
ORDER BY domain, surface_name;
