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

-- Build canonical keeper + duplicate maps once so all updates share the same winner.
CREATE TEMP TABLE tmp_customer_email_ranked ON COMMIT DROP AS
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
WHERE email IS NOT NULL AND btrim(email) <> '';

CREATE TEMP TABLE tmp_customer_email_dupes ON COMMIT DROP AS
SELECT id, keeper_id
FROM tmp_customer_email_ranked
WHERE rn > 1 AND keeper_id <> id;

CREATE TEMP TABLE tmp_customer_email_keepers ON COMMIT DROP AS
SELECT email_key, keeper_id
FROM tmp_customer_email_ranked
WHERE rn = 1;

-- Re-link duplicate customer_id references to canonical keepers.
UPDATE bookings b
SET customer_id = d.keeper_id,
    updated_at = now()
FROM tmp_customer_email_dupes d
WHERE b.customer_id = d.id;

UPDATE revenue_records r
SET customer_id = d.keeper_id,
    updated_at = now()
FROM tmp_customer_email_dupes d
WHERE r.customer_id = d.id;

-- Backfill missing customer_id by strictly normalized LOWER(email).
UPDATE bookings b
SET customer_id = k.keeper_id,
    updated_at = now()
FROM tmp_customer_email_keepers k
WHERE b.customer_id IS NULL
  AND b.customer_email IS NOT NULL
  AND lower(btrim(b.customer_email)) = k.email_key;

UPDATE revenue_records r
SET customer_id = k.keeper_id,
    updated_at = now()
FROM tmp_customer_email_keepers k
WHERE r.customer_id IS NULL
  AND r.customer_email IS NOT NULL
  AND lower(btrim(r.customer_email)) = k.email_key;

-- Remove orphan duplicate rows only when they have no linked bookings or revenue.
DELETE FROM customers c
USING tmp_customer_email_ranked r
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
