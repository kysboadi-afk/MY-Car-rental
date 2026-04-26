-- Migration 0085: fix extension revenue record dates and original_booking_id linkage
--
-- Addresses two related issues with historical extension revenue_records:
--
-- Issue A — original_booking_id normalisation (revenue tracker grouping):
--   Some older extension rows have original_booking_id = NULL or pointing to a
--   different value than booking_id.  The admin revenue tracker groups rows by
--   COALESCE(original_booking_id, booking_id); if original_booking_id is wrong,
--   extension rows end up in a separate group from their parent rental.
--
--   Fix: for every extension row whose booking_id resolves to a valid
--   bookings.booking_ref, set original_booking_id = booking_id.
--
-- Issue B — pickup_date / return_date on historical extension rows:
--   Early extension records were created without the pickup_date field set
--   (or with pickup_date = return_date), so the admin UI could not compute
--   "+N days" correctly and would show "+0 days".
--
--   Fix: use the booking_extensions table (which has a row per paid extension
--   with new_return_date) plus LAG() to reconstruct the previous return date
--   for each extension in sequence.  The base rental's return_date is used as
--   the anchor for the first extension.
--
-- Safe to re-run: both UPDATE statements are guarded by IS DISTINCT FROM /
-- condition checks so already-correct rows are not touched.

-- ── A. Normalise original_booking_id for extension rows ──────────────────────
--
-- Sets original_booking_id = booking_id for every extension row whose
-- booking_id points to a real booking and whose original_booking_id doesn't
-- already match.

UPDATE revenue_records rr
SET    original_booking_id = rr.booking_id,
       updated_at           = now()
WHERE  rr.type              = 'extension'
  AND  rr.sync_excluded     = false
  AND  rr.booking_id        IS NOT NULL
  AND  (rr.original_booking_id IS NULL OR rr.original_booking_id != rr.booking_id)
  AND  EXISTS (
         SELECT 1 FROM bookings b WHERE b.booking_ref = rr.booking_id
       );

-- ── B. Fix pickup_date / return_date for historical extension rows ────────────
--
-- For each extension row matched to a booking_extensions record (via
-- payment_intent_id), we reconstruct:
--   return_date  = booking_extensions.new_return_date  (the date this extension ends)
--   pickup_date  = previous extension's new_return_date (via LAG), or the base
--                  rental revenue_record's return_date for the first extension.
--
-- Only rows where pickup_date or return_date differs from the correct value are
-- updated (IS DISTINCT FROM handles NULLs safely).

WITH ext_sequence AS (
  -- Order extensions by new_return_date ASC (primary) and created_at ASC (tiebreaker).
  -- In normal operation each extension increases new_return_date, so this order
  -- correctly reconstructs the chronological chain of extensions per booking.
  SELECT
    be.booking_id,
    be.payment_intent_id,
    be.new_return_date,
    LAG(be.new_return_date) OVER (
      PARTITION BY be.booking_id
      ORDER BY     be.new_return_date ASC, be.created_at ASC
    ) AS prev_return_date
  FROM booking_extensions be
),
base_rental AS (
  SELECT rr.booking_id,
         rr.return_date AS base_return_date
  FROM   revenue_records rr
  WHERE  rr.type          = 'rental'
    AND  rr.sync_excluded = false
    AND  rr.return_date   IS NOT NULL
)
UPDATE revenue_records rr
SET    pickup_date = COALESCE(es.prev_return_date, br.base_return_date),
       return_date = es.new_return_date,
       updated_at  = now()
FROM   ext_sequence es
LEFT JOIN base_rental br ON br.booking_id = es.booking_id
WHERE  rr.payment_intent_id = es.payment_intent_id
  AND  rr.type              = 'extension'
  AND  rr.sync_excluded     = false
  AND  (
         rr.pickup_date IS DISTINCT FROM COALESCE(es.prev_return_date, br.base_return_date)
      OR rr.return_date IS DISTINCT FROM es.new_return_date
       );
