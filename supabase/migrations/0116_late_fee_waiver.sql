-- Migration 0116: add late-fee waiver fields to bookings
-- These fields store the full audit trail for an admin-applied waiver so that
-- revenue accounting stays accurate and every waiver is traceable.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived        BOOLEAN   DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_amount NUMERIC   DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_by     TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS late_fee_waived_at     TIMESTAMPTZ;

COMMENT ON COLUMN bookings.late_fee_waived        IS 'True when an admin has applied a full or partial waiver to the late fee.';
COMMENT ON COLUMN bookings.late_fee_waived_amount IS 'USD amount waived.  For a full waiver this equals the full penalty; for a partial waiver it is the custom amount.';
COMMENT ON COLUMN bookings.late_fee_waived_reason IS 'Mandatory reason supplied by the admin (e.g. "accident", "emergency").';
COMMENT ON COLUMN bookings.late_fee_waived_by     IS 'Admin identifier who applied the waiver.';
COMMENT ON COLUMN bookings.late_fee_waived_at     IS 'Timestamp when the waiver was applied.';
