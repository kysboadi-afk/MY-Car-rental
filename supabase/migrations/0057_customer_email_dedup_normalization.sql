-- 0057_customer_email_dedup_normalization.sql
-- Enforce email normalization + case-insensitive uniqueness for customers.
-- Also performs one-time dedup cleanup by LOWER(email), keeping the earliest row.

BEGIN;

-- Normalize stored emails to lowercase/trimmed form.
UPDATE customers
SET email = NULLIF(lower(btrim(email)), '')
WHERE email IS NOT NULL;

UPDATE bookings
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

UPDATE revenue_records
SET customer_email = NULLIF(lower(btrim(customer_email)), '')
WHERE customer_email IS NOT NULL;

-- Re-link records that already reference duplicate customer IDs.
WITH ranked AS (
  SELECT
    id,
    lower(email) AS email_key,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS keeper_id
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
),
dupes AS (
  SELECT id, keeper_id
  FROM ranked
  WHERE rn > 1 AND keeper_id <> id
),
keeper_by_email AS (
  SELECT DISTINCT email_key, keeper_id
  FROM ranked
)
UPDATE bookings b
SET customer_id = d.keeper_id,
    updated_at = now()
FROM dupes d
WHERE b.customer_id = d.id;

WITH ranked AS (
  SELECT
    id,
    lower(email) AS email_key,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn,
    first_value(id) OVER (
      PARTITION BY lower(email)
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

-- Backfill missing customer_id links by normalized email where possible.
WITH keeper_by_email AS (
  SELECT
    lower(email) AS email_key,
    id AS keeper_id
  FROM (
    SELECT
      id,
      email,
      row_number() OVER (
        PARTITION BY lower(email)
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
  AND lower(b.customer_email) = k.email_key;

WITH keeper_by_email AS (
  SELECT
    lower(email) AS email_key,
    id AS keeper_id
  FROM (
    SELECT
      id,
      email,
      row_number() OVER (
        PARTITION BY lower(email)
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
  AND lower(r.customer_email) = k.email_key;

-- Remove duplicate customer rows (non-keeper rows).
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM customers
  WHERE email IS NOT NULL AND btrim(email) <> ''
)
DELETE FROM customers c
USING ranked r
WHERE c.id = r.id
  AND r.rn > 1;

-- Enforce case-insensitive uniqueness forever.
CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_email_lower
ON public.customers (LOWER(btrim(email)))
WHERE email IS NOT NULL AND btrim(email) <> '';

COMMIT;
