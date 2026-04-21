-- 0058_customer_email_dedup_cleanup.sql
-- Follow-up cleanup to fully collapse customers by LOWER(email).

BEGIN;

-- Re-normalize customer + ledger emails for legacy rows.
UPDATE customers
SET email = NULLIF(lower(btrim(email)), '')
WHERE email IS NOT NULL;

UPDATE bookings
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

UPDATE revenue_records
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

-- Re-link duplicate customer_id references to a canonical keeper per LOWER(email).
WITH ranked AS (
  SELECT
    id,
    lower(btrim(email)) AS email_key,
    row_number() OVER (
      PARTITION BY lower(btrim(email))
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY lower(btrim(email))
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS keeper_id
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
),
dupes AS (
  SELECT id, keeper_id
  FROM ranked
  WHERE rn > 1 AND keeper_id <> id
)
UPDATE bookings b
SET customer_id = d.keeper_id,
    updated_at = now()
FROM dupes d
WHERE b.customer_id = d.id;

WITH ranked AS (
  SELECT
    id,
    lower(btrim(email)) AS email_key,
    row_number() OVER (
      PARTITION BY lower(btrim(email))
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY lower(btrim(email))
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS keeper_id
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
),
dupes AS (
  SELECT id, keeper_id
  FROM ranked
  WHERE rn > 1 AND keeper_id <> id
)
UPDATE revenue_records r
SET customer_id = d.keeper_id,
    updated_at = now()
FROM dupes d
WHERE r.customer_id = d.id;

-- Backfill missing customer_id by strictly normalized LOWER(email).
WITH keeper_by_email AS (
  SELECT
    email_key,
    keeper_id
  FROM (
    SELECT
      lower(btrim(email)) AS email_key,
      id AS keeper_id,
      row_number() OVER (
        PARTITION BY lower(btrim(email))
        ORDER BY created_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM customers
    WHERE email IS NOT NULL AND btrim(email) <> ''
  ) s
  WHERE s.rn = 1
)
UPDATE bookings b
SET customer_id = k.keeper_id,
    updated_at = now()
FROM keeper_by_email k
WHERE b.customer_id IS NULL
  AND b.customer_email IS NOT NULL
  AND lower(btrim(b.customer_email)) = k.email_key;

WITH keeper_by_email AS (
  SELECT
    email_key,
    keeper_id
  FROM (
    SELECT
      lower(btrim(email)) AS email_key,
      id AS keeper_id,
      row_number() OVER (
        PARTITION BY lower(btrim(email))
        ORDER BY created_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM customers
    WHERE email IS NOT NULL AND btrim(email) <> ''
  ) s
  WHERE s.rn = 1
)
UPDATE revenue_records r
SET customer_id = k.keeper_id,
    updated_at = now()
FROM keeper_by_email k
WHERE r.customer_id IS NULL
  AND r.customer_email IS NOT NULL
  AND lower(btrim(r.customer_email)) = k.email_key;

-- Remove orphan duplicate rows only when they have no linked bookings or revenue.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY lower(btrim(email))
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
)
DELETE FROM customers c
USING ranked r
WHERE c.id = r.id
  AND r.rn > 1
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM revenue_records rr WHERE rr.customer_id = c.id);

-- Final guard: keep exactly one row per normalized email forever.
DROP INDEX IF EXISTS unique_customer_email_lower;
CREATE UNIQUE INDEX unique_customer_email_lower
ON public.customers (LOWER(btrim(email)))
WHERE email IS NOT NULL AND btrim(email) <> '';

COMMIT;
