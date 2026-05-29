-- supabase/migrations/0179_backfill_audit.sql
-- Post-backfill default-org usage audit for Wave A migrations.
--
-- PURPOSE:
--   Quantifies how many rows across all six backfilled tables resolved to the
--   default organization (slug = 'sly-rides-default') versus resolving through
--   an explicit booking/customer relationship.
--
--   A high default-org rate indicates that the backfill join paths in 0177
--   failed to match records, and those records must be investigated before
--   RLS or hard org enforcement begins.
--
-- HOW TO USE:
--   psql <connection> -f 0179_backfill_audit.sql
--
--   Outputs one summary row per table plus cross-table parity checks.
--
-- INTERPRETATION:
--   default_org_count / total_count = fallback rate.
--   A rate above ~5% on revenue_records, charges, or tickets warrants manual
--   investigation before enforcement proceeds.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   Returns empty results gracefully when tables do not yet exist.

DO $$
BEGIN
  RAISE NOTICE 'Starting Wave A post-backfill default-org usage audit...';
END $$;

-- ─── 1. Default organization UUID ────────────────────────────────────────────
-- Capture once so joins below are efficient.

WITH default_org AS (
  SELECT id AS default_org_id
  FROM public.organizations
  WHERE slug = 'sly-rides-default'
  LIMIT 1
),

-- ─── 2. Per-table fallback counts ─────────────────────────────────────────────

bookings_audit AS (
  SELECT
    'bookings'            AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE b.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE b.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT b.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.bookings b
  CROSS JOIN default_org d
),

customers_audit AS (
  SELECT
    'customers'           AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE c.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE c.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT c.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.customers c
  CROSS JOIN default_org d
),

revenue_records_audit AS (
  SELECT
    'revenue_records'     AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE rr.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE rr.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT rr.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.revenue_records rr
  CROSS JOIN default_org d
),

renter_balance_ledger_audit AS (
  SELECT
    'renter_balance_ledger' AS table_name,
    COUNT(*)                AS total_rows,
    COUNT(*) FILTER (WHERE rbl.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE rbl.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT rbl.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.renter_balance_ledger rbl
  CROSS JOIN default_org d
),

payment_plans_audit AS (
  SELECT
    'payment_plans'       AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE pp.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE pp.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT pp.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.payment_plans pp
  CROSS JOIN default_org d
),

payment_plan_installments_audit AS (
  SELECT
    'payment_plan_installments' AS table_name,
    COUNT(*)                    AS total_rows,
    COUNT(*) FILTER (WHERE ppi.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE ppi.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT ppi.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.payment_plan_installments ppi
  CROSS JOIN default_org d
),

-- ─── 3. Union all tables ───────────────────────────────────────────────────────

all_tables AS (
  SELECT * FROM bookings_audit
  UNION ALL SELECT * FROM customers_audit
  UNION ALL SELECT * FROM revenue_records_audit
  UNION ALL SELECT * FROM renter_balance_ledger_audit
  UNION ALL SELECT * FROM payment_plans_audit
  UNION ALL SELECT * FROM payment_plan_installments_audit
)

-- ─── 4. Final summary with fallback rate ──────────────────────────────────────

SELECT
  table_name,
  total_rows,
  default_org_count,
  null_org_count,
  total_rows - default_org_count - null_org_count AS resolved_via_relationship,
  CASE
    WHEN total_rows = 0 THEN '0.0%'
    ELSE ROUND((default_org_count::numeric / total_rows) * 100, 2)::text || '%'
  END AS default_org_fallback_rate,
  CASE
    WHEN null_org_count > 0       THEN 'ACTION REQUIRED — null org_ids remain'
    WHEN total_rows = 0           THEN 'EMPTY TABLE'
    WHEN (default_org_count::numeric / total_rows) > 0.20
                                  THEN 'INVESTIGATE — fallback rate > 20%'
    WHEN (default_org_count::numeric / total_rows) > 0.05
                                  THEN 'REVIEW — fallback rate > 5%'
    ELSE                               'OK'
  END AS health_status
FROM all_tables
ORDER BY table_name;


-- ─── 5. Cross-table org parity check ─────────────────────────────────────────
-- Surfaces revenue_records rows whose organization_id does not match
-- their linked booking's organization_id.  Mismatches indicate backfill
-- join failures or later manual edits that left cross-org references.

SELECT
  'revenue_records vs bookings parity'  AS check_name,
  COUNT(*)                              AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all resolved revenue_records match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' revenue_records have org mismatch with bookings'
  END AS parity_status
FROM public.revenue_records rr
JOIN public.bookings b
  ON b.booking_ref = rr.booking_ref
     OR b.booking_ref = rr.booking_id
     OR b.booking_ref = rr.original_booking_id
WHERE rr.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND rr.organization_id <> b.organization_id;


-- ─── 6. Ledger vs booking org parity ─────────────────────────────────────────

SELECT
  'renter_balance_ledger vs bookings parity' AS check_name,
  COUNT(*)                                    AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all ledger entries match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' ledger entries have org mismatch with bookings'
  END AS parity_status
FROM public.renter_balance_ledger rbl
JOIN public.bookings b ON b.booking_ref = rbl.booking_id
WHERE rbl.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND rbl.organization_id <> b.organization_id;


-- ─── 7. payment_plans vs bookings parity ──────────────────────────────────────

SELECT
  'payment_plans vs bookings parity'   AS check_name,
  COUNT(*)                             AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all payment_plans match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' payment_plans have org mismatch with bookings'
  END AS parity_status
FROM public.payment_plans pp
JOIN public.bookings b ON b.booking_ref = pp.booking_id
WHERE pp.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND pp.organization_id <> b.organization_id;


-- ─── 8. payment_plan_installments vs payment_plans parity ─────────────────────

SELECT
  'payment_plan_installments vs payment_plans parity' AS check_name,
  COUNT(*)                                             AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all installments match parent plan org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' installments have org mismatch with parent plan'
  END AS parity_status
FROM public.payment_plan_installments ppi
JOIN public.payment_plans pp ON pp.id = ppi.plan_id
WHERE ppi.organization_id IS NOT NULL
  AND pp.organization_id IS NOT NULL
  AND ppi.organization_id <> pp.organization_id;


-- ─── 9. Revenue records with no matching booking (orphan check) ────────────────

SELECT
  'revenue_records orphan check' AS check_name,
  COUNT(*)                       AS orphan_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — no orphan revenue records'
    ELSE 'REVIEW — ' || COUNT(*) || ' revenue_records have no matching booking ref (defaulted)'
  END AS orphan_status
FROM public.revenue_records rr
LEFT JOIN public.bookings b
  ON b.booking_ref = rr.booking_ref
  OR b.booking_ref = rr.booking_id
  OR b.booking_ref = rr.original_booking_id
WHERE b.booking_ref IS NULL
  AND rr.organization_id = (
    SELECT id FROM public.organizations WHERE slug = 'sly-rides-default' LIMIT 1
  );
