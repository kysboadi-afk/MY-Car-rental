-- Migration 0081: Expand bookings.status to include all modern status values
--
-- Problem: The bookings.status CHECK constraint (last set in migration 0066) only
-- allows: 'pending', 'reserved', 'pending_verification', 'active', 'overdue', 'completed'
-- This causes silent failures when application code tries to write:
--   • 'active_rental'    — used throughout JS app layer since migration 0064
--   • 'booked_paid'      — used in booking pipeline and admin status updates
--   • 'completed_rental' — used in booking pipeline and admin status updates
--   • 'cancelled_rental' — used in booking pipeline and admin status updates
--
-- The admin panel v2-bookings.js "Mark Cancelled" action writes status='cancelled_rental'
-- to Supabase, but the constraint rejects it silently (non-fatal error path), so the
-- Supabase row stays as 'active' while bookings.json says 'cancelled_rental'.
-- Similarly, 'approved' (used by some admin flows) is no longer in the constraint.
--
-- Fix: expand the constraint to accept all status values used anywhere in the system.
-- Also adds back 'approved' and 'cancelled' for backward compatibility with any
-- legacy rows or flows that still use those legacy values.
--
-- Safe to re-run: idempotent constraint drop + re-add.

DO $$ BEGIN
  ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    -- Legacy values (written by autoUpsertBooking / stripe-webhook pre-0064)
    'pending',
    'approved',
    'active',
    'overdue',
    'completed',
    'cancelled',
    -- Post-0066 values
    'reserved',
    'pending_verification',
    -- Modern app-layer values (written directly by booking pipeline / admin panel)
    'active_rental',
    'booked_paid',
    'completed_rental',
    'cancelled_rental'
  ));
