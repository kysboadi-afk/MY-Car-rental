-- 0059_final_orphan_customer_cleanup.sql
-- Remove remaining orphan customers that are not linked to bookings or revenue.

BEGIN;

DELETE FROM customers
WHERE id NOT IN (
  SELECT DISTINCT customer_id FROM bookings WHERE customer_id IS NOT NULL
  UNION
  SELECT DISTINCT customer_id FROM revenue_records WHERE customer_id IS NOT NULL
)
-- Preserve customers without emails (anonymous/legacy placeholders); cleanup targets email-identified orphans.
AND email IS NOT NULL;

COMMIT;
