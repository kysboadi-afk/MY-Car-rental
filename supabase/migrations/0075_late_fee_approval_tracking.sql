-- Migration 0075: Late-fee approval tracking
--
-- Adds the columns needed to fully track late-fee approvals:
--
-- On bookings:
--   late_fee_status      text   — 'pending_approval' | 'approved' | 'dismissed' | 'failed'
--   late_fee_amount      numeric— assessed fee in USD (set when status is first written)
--   late_fee_approved_at timestamptz — when approve/dismiss was actioned
--   late_fee_approved_by text   — who actioned it ('admin_link' | 'admin_panel' | 'ai')
--
-- On charges (existing table, migration 0036):
--   approved_by text       — 'admin_link' | 'admin_panel' | 'ai'
--   approved_at timestamptz— when this specific charge was approved
--   adjusted_from_amount numeric — original assessed amount if admin adjusted it
--
-- Also widens the existing charges.charged_by CHECK constraint to allow
-- 'admin_link' (the new one-click approval flow value).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS late_fee_status      text
    CHECK (late_fee_status IN ('pending_approval','approved','dismissed','failed')),
  ADD COLUMN IF NOT EXISTS late_fee_amount      numeric(10,2),
  ADD COLUMN IF NOT EXISTS late_fee_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_fee_approved_by text;

ALTER TABLE charges
  ADD COLUMN IF NOT EXISTS approved_by           text,
  ADD COLUMN IF NOT EXISTS approved_at           timestamptz,
  ADD COLUMN IF NOT EXISTS adjusted_from_amount  numeric(10,2);

-- Widen charged_by constraint to include 'admin_link'
-- Drop the old constraint (it was created inline in migration 0036 so may have
-- a generated name — find and drop it, then re-add with the expanded list).
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'charges'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%charged_by%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE charges DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

ALTER TABLE charges
  ADD CONSTRAINT charges_charged_by_check
  CHECK (charged_by IN ('admin', 'ai', 'admin_link'));

CREATE INDEX IF NOT EXISTS bookings_late_fee_status_idx
  ON bookings (late_fee_status)
  WHERE late_fee_status IS NOT NULL;

COMMENT ON COLUMN bookings.late_fee_status IS
  'Tracks where the late-fee approval stands: pending_approval → approved/dismissed/failed.';
COMMENT ON COLUMN bookings.late_fee_amount IS
  'Assessed late-fee amount in USD, set when late_fee_status is first written.';
COMMENT ON COLUMN bookings.late_fee_approved_at IS
  'Timestamp when admin approved or dismissed the late fee.';
COMMENT ON COLUMN bookings.late_fee_approved_by IS
  'Who actioned the approval: admin_link | admin_panel | ai.';

COMMENT ON COLUMN charges.approved_by IS
  'Who approved this charge: admin_link | admin_panel | ai.';
COMMENT ON COLUMN charges.approved_at IS
  'Timestamp when this charge was approved/executed.';
COMMENT ON COLUMN charges.adjusted_from_amount IS
  'If the admin adjusted the fee before charging, the original assessed amount is stored here.';
