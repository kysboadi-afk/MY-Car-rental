-- Migration 0076: Add 'paid' to late_fee_status CHECK constraint
--
-- After a successful charge, late_fee_status is written as 'paid' to indicate
-- that the late fee has been fully settled.  This distinguishes "charge was
-- attempted and approved" (approved) from "charge succeeded and is complete"
-- (paid), and is used as a hard idempotency guard so no further charge can be
-- issued once the booking is in the paid state.
--
-- Existing values: pending_approval | approved | dismissed | failed
-- New value added: paid

-- Drop the existing CHECK constraint and re-add with the extended list.
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
  CHECK (late_fee_status IN ('pending_approval','approved','dismissed','failed','paid'));

COMMENT ON COLUMN bookings.late_fee_status IS
  'Late-fee approval state: pending_approval → approved/dismissed/failed/paid. '
  'paid = charge succeeded and settled; no further charge may be issued.';
