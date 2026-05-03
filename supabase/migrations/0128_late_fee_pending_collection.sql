-- Migration 0128: add 'pending_collection' to late_fee_status CHECK constraint
--
-- 'pending_collection' means:
--   A late fee was assessed but could not be charged off-session (e.g. the
--   renter had no saved card, or the charge failed).  The fee will be folded
--   into the renter's NEXT payment (rental extension or balance payment).
--
-- Transition sequence for this status:
--   null → pending_collection  (set by admin / AI tool)
--   pending_collection → paid  (set by webhook when next extension payment is
--                               confirmed by Stripe)

-- Drop the existing constraint so we can widen it.
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'bookings'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%late_fee_status%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_late_fee_status_check
  CHECK (late_fee_status IN (
    'pending_approval',
    'approved',
    'dismissed',
    'failed',
    'paid',
    'pending_collection'
  ));

COMMENT ON COLUMN bookings.late_fee_status IS
  'Tracks where the late-fee stands: '
  'pending_approval → approved/dismissed/failed/paid, '
  'pending_collection → fee owed but no card; added to next payment.';
