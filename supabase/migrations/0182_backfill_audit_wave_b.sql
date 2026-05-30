-- supabase/migrations/0182_backfill_audit_wave_b.sql
-- Post-backfill default-org usage audit for Wave B migration (0180).
--
-- PURPOSE:
--   Quantifies how many rows across the four Wave B tables resolved to the
--   default organization (slug = 'sly-rides-default') versus resolving through
--   an explicit booking/customer relationship.
--
--   A high default-org rate indicates that the backfill join paths in 0180
--   failed to match records, and those records must be investigated before
--   RLS or hard org enforcement begins.
--
-- HOW TO USE:
--   psql <connection> -f 0182_backfill_audit_wave_b.sql
--
--   Outputs one summary row per table plus cross-table parity checks.
--
-- INTERPRETATION:
--   default_org_count / total_count = fallback rate.
--   A rate above ~5% on charges or tickets warrants manual investigation
--   before enforcement proceeds.
--
-- SAFETY:
--   Read-only — no DDL or DML.  Safe to re-run at any time.
--   Returns empty results gracefully when tables do not yet exist.

DO $$
BEGIN
  RAISE NOTICE 'Starting Wave B post-backfill default-org usage audit...';
END $$;

-- ─── 1. Default organization UUID ────────────────────────────────────────────

WITH default_org AS (
  SELECT id AS default_org_id
  FROM public.organizations
  WHERE slug = 'sly-rides-default'
  LIMIT 1
),

-- ─── 2. Per-table fallback counts ─────────────────────────────────────────────

charges_audit AS (
  SELECT
    'charges'             AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE c.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE c.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT c.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.charges c
  CROSS JOIN default_org d
),

tickets_audit AS (
  SELECT
    'tickets'             AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE t.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE t.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT t.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.tickets t
  CROSS JOIN default_org d
),

booking_extensions_audit AS (
  SELECT
    'booking_extensions'  AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE be.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE be.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT be.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.booking_extensions be
  CROSS JOIN default_org d
),

customer_ledger_audit AS (
  SELECT
    'customer_ledger'     AS table_name,
    COUNT(*)              AS total_rows,
    COUNT(*) FILTER (WHERE cl.organization_id = d.default_org_id) AS default_org_count,
    COUNT(*) FILTER (WHERE cl.organization_id IS NULL)             AS null_org_count,
    COUNT(DISTINCT cl.organization_id) - 1                         AS distinct_non_default_orgs
  FROM public.customer_ledger cl
  CROSS JOIN default_org d
),

-- ─── 3. Union all tables ───────────────────────────────────────────────────────

all_tables AS (
  SELECT * FROM charges_audit
  UNION ALL SELECT * FROM tickets_audit
  UNION ALL SELECT * FROM booking_extensions_audit
  UNION ALL SELECT * FROM customer_ledger_audit
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


-- ─── 5. charges vs bookings parity ───────────────────────────────────────────

SELECT
  'charges vs bookings parity'    AS check_name,
  COUNT(*)                        AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all resolved charges match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' charges have org mismatch with bookings'
  END AS parity_status
FROM public.charges c
JOIN public.bookings b ON b.booking_ref = c.booking_id
WHERE c.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND c.organization_id <> b.organization_id;


-- ─── 6. tickets vs bookings parity ───────────────────────────────────────────

SELECT
  'tickets vs bookings parity'    AS check_name,
  COUNT(*)                        AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all tickets with booking links match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with bookings'
  END AS parity_status
FROM public.tickets t
JOIN public.bookings b ON b.booking_ref = t.booking_id
WHERE t.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND t.organization_id <> b.organization_id;


-- ─── 7. tickets vs customers parity (booking-less tickets) ───────────────────

SELECT
  'tickets vs customers parity'   AS check_name,
  COUNT(*)                        AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all booking-less tickets match customer org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with customers'
  END AS parity_status
FROM public.tickets t
JOIN public.customers c ON c.id = t.customer_id
LEFT JOIN public.bookings b ON b.booking_ref = t.booking_id
WHERE b.booking_ref IS NULL          -- only tickets not resolved via booking
  AND t.organization_id IS NOT NULL
  AND c.organization_id IS NOT NULL
  AND t.organization_id <> c.organization_id;


-- ─── 8. booking_extensions vs bookings parity ────────────────────────────────

SELECT
  'booking_extensions vs bookings parity' AS check_name,
  COUNT(*)                                 AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all booking_extensions match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' booking_extensions have org mismatch with bookings'
  END AS parity_status
FROM public.booking_extensions be
JOIN public.bookings b ON b.booking_ref = be.booking_id
WHERE be.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND be.organization_id <> b.organization_id;


-- ─── 9. customer_ledger vs bookings parity ───────────────────────────────────

SELECT
  'customer_ledger vs bookings parity'    AS check_name,
  COUNT(*)                                AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all customer_ledger entries with booking refs match booking org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger entries have org mismatch with bookings'
  END AS parity_status
FROM public.customer_ledger cl
JOIN public.bookings b ON b.booking_ref = cl.booking_ref
WHERE cl.organization_id IS NOT NULL
  AND b.organization_id IS NOT NULL
  AND cl.organization_id <> b.organization_id;


-- ─── 10. customer_ledger vs customers parity (no booking_ref rows) ────────────

SELECT
  'customer_ledger vs customers parity'   AS check_name,
  COUNT(*)                                AS mismatch_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — all booking-less ledger entries match customer org'
    ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger entries have org mismatch with customers'
  END AS parity_status
FROM public.customer_ledger cl
JOIN public.customers c ON c.id = cl.customer_id
LEFT JOIN public.bookings b ON b.booking_ref = cl.booking_ref
WHERE b.booking_ref IS NULL          -- only entries not resolved via booking
  AND cl.organization_id IS NOT NULL
  AND c.organization_id IS NOT NULL
  AND cl.organization_id <> c.organization_id;


-- ─── 11. charges orphan check ─────────────────────────────────────────────────

SELECT
  'charges orphan check'    AS check_name,
  COUNT(*)                  AS orphan_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — no orphan charges'
    ELSE 'REVIEW — ' || COUNT(*) || ' charges have no matching booking ref (defaulted)'
  END AS orphan_status
FROM public.charges c
LEFT JOIN public.bookings b ON b.booking_ref = c.booking_id
WHERE b.booking_ref IS NULL
  AND c.organization_id = (
    SELECT id FROM public.organizations WHERE slug = 'sly-rides-default' LIMIT 1
  );


-- ─── 12. tickets orphan check ─────────────────────────────────────────────────

SELECT
  'tickets orphan check'    AS check_name,
  COUNT(*)                  AS orphan_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'OK — no orphan tickets'
    ELSE 'REVIEW — ' || COUNT(*) || ' tickets have no matching booking or customer ref (defaulted)'
  END AS orphan_status
FROM public.tickets t
LEFT JOIN public.bookings b ON b.booking_ref = t.booking_id
LEFT JOIN public.customers c ON c.id = t.customer_id
WHERE b.booking_ref IS NULL
  AND c.id IS NULL
  AND t.organization_id = (
    SELECT id FROM public.organizations WHERE slug = 'sly-rides-default' LIMIT 1
  );
