-- supabase/migrations/0181_wave_b_backfill_audit.sql
-- Post-backfill default-org usage audit for Wave B (0180).
--
-- PURPOSE:
--   Applies the same audit standards as 0179_backfill_audit.sql to Wave B tables:
--     charges, tickets, booking_extensions, customer_ledger.
--
-- HOW TO USE:
--   psql <connection> -f 0181_wave_b_backfill_audit.sql
--
-- INTERPRETATION:
--   default_org_count / total_rows = fallback rate.
--   A rate above ~5% on tenant-sensitive financial tables requires manual review
--   before RLS or hard org enforcement proceeds.
--
-- SAFETY:
--   Read-only. No DDL or DML against persistent schema objects.

DO $$
DECLARE
  v_default_org_id uuid;
BEGIN
  RAISE NOTICE 'Starting Wave B post-backfill default-org usage audit...';

  SELECT id
    INTO v_default_org_id
    FROM public.organizations
   WHERE slug = 'sly-rides-default'
   LIMIT 1;

  IF v_default_org_id IS NULL THEN
    RAISE EXCEPTION '[0181 FAIL] Default organization (slug=sly-rides-default) is missing. Run 0175/0176 foundation first.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS wave_b_audit_summary (
    table_name text,
    total_rows bigint,
    default_org_count bigint,
    null_org_count bigint,
    resolved_via_relationship bigint,
    default_org_fallback_rate text,
    health_status text
  ) ON COMMIT DROP;

  TRUNCATE wave_b_audit_summary;

  IF to_regclass('public.charges') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'charges' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE c.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE c.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE c.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE c.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.charges c;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('charges', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;

  IF to_regclass('public.tickets') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'tickets' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE t.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE t.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE t.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE t.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.tickets t;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('tickets', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;

  IF to_regclass('public.booking_extensions') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'booking_extensions' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE be.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE be.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE be.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE be.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.booking_extensions be;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('booking_extensions', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;

  IF to_regclass('public.customer_ledger') IS NOT NULL THEN
    INSERT INTO wave_b_audit_summary
    SELECT
      'customer_ledger' AS table_name,
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id) AS default_org_count,
      COUNT(*) FILTER (WHERE cl.organization_id IS NULL) AS null_org_count,
      COUNT(*) - COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id) - COUNT(*) FILTER (WHERE cl.organization_id IS NULL) AS resolved_via_relationship,
      CASE
        WHEN COUNT(*) = 0 THEN '0.0%'
        ELSE ROUND((COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id)::numeric / COUNT(*)) * 100, 2)::text || '%'
      END AS default_org_fallback_rate,
      CASE
        WHEN COUNT(*) FILTER (WHERE cl.organization_id IS NULL) > 0 THEN 'ACTION REQUIRED — null org_ids remain'
        WHEN COUNT(*) = 0 THEN 'EMPTY TABLE'
        WHEN (COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.20 THEN 'INVESTIGATE — fallback rate > 20%'
        WHEN (COUNT(*) FILTER (WHERE cl.organization_id = v_default_org_id)::numeric / COUNT(*)) > 0.05 THEN 'REVIEW — fallback rate > 5%'
        ELSE 'OK'
      END AS health_status
    FROM public.customer_ledger cl;
  ELSE
    INSERT INTO wave_b_audit_summary VALUES
    ('customer_ledger', 0, 0, 0, 0, 'N/A', 'MISSING TABLE');
  END IF;
END $$;

SELECT *
FROM wave_b_audit_summary
ORDER BY table_name;

-- Cross-table parity checks.
DO $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS wave_b_parity_checks (
    check_name text,
    mismatch_count bigint,
    parity_status text
  ) ON COMMIT DROP;

  TRUNCATE wave_b_parity_checks;

  IF to_regclass('public.charges') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'charges vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — all charges match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' charges have org mismatch with bookings'
      END AS parity_status
    FROM public.charges c
    JOIN public.bookings b
      ON b.booking_ref = c.booking_id
   WHERE c.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND c.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('charges vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.tickets') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'tickets vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — tickets linked to bookings match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with bookings'
      END AS parity_status
    FROM public.tickets t
    JOIN public.bookings b
      ON b.booking_ref = t.booking_id
   WHERE t.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND t.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('tickets vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.tickets') IS NOT NULL AND to_regclass('public.customers') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'tickets vs customers parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — tickets linked to customers match customer org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' tickets have org mismatch with customers'
      END AS parity_status
    FROM public.tickets t
    JOIN public.customers c
      ON c.id = t.customer_id
   WHERE t.organization_id IS NOT NULL
     AND c.organization_id IS NOT NULL
     AND t.organization_id <> c.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('tickets vs customers parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.booking_extensions') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'booking_extensions vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — all booking_extensions match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' booking_extensions have org mismatch with bookings'
      END AS parity_status
    FROM public.booking_extensions be
    JOIN public.bookings b
      ON b.booking_ref = be.booking_id
   WHERE be.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND be.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('booking_extensions vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.customer_ledger') IS NOT NULL AND to_regclass('public.bookings') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'customer_ledger vs bookings parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — customer_ledger booking-linked rows match booking org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger rows have org mismatch with bookings'
      END AS parity_status
    FROM public.customer_ledger cl
    JOIN public.bookings b
      ON b.booking_ref = cl.booking_ref
   WHERE cl.booking_ref IS NOT NULL
     AND cl.organization_id IS NOT NULL
     AND b.organization_id IS NOT NULL
     AND cl.organization_id <> b.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('customer_ledger vs bookings parity', 0, 'SKIPPED — required table missing');
  END IF;

  IF to_regclass('public.customer_ledger') IS NOT NULL AND to_regclass('public.customers') IS NOT NULL THEN
    INSERT INTO wave_b_parity_checks
    SELECT
      'customer_ledger vs customers parity' AS check_name,
      COUNT(*) AS mismatch_count,
      CASE
        WHEN COUNT(*) = 0 THEN 'OK — customer_ledger rows match customer org'
        ELSE 'INVESTIGATE — ' || COUNT(*) || ' customer_ledger rows have org mismatch with customers'
      END AS parity_status
    FROM public.customer_ledger cl
    JOIN public.customers c
      ON c.id = cl.customer_id
   WHERE cl.customer_id IS NOT NULL
     AND cl.organization_id IS NOT NULL
     AND c.organization_id IS NOT NULL
     AND cl.organization_id <> c.organization_id;
  ELSE
    INSERT INTO wave_b_parity_checks VALUES
    ('customer_ledger vs customers parity', 0, 'SKIPPED — required table missing');
  END IF;
END $$;

SELECT *
FROM wave_b_parity_checks
ORDER BY check_name;
