-- Migration 0110: Sync revenue_records.vehicle_id with bookings.vehicle_id
--
-- Problem:
--   Migration 0092 normalised legacy "camry2012" vehicle_id values in
--   revenue_records to the canonical "camry".  However, the corresponding
--   bookings rows still store "camry2012" (old records pre-dating the
--   normalisation code).  This creates a per-row mismatch: the booking says
--   "camry2012" while its revenue record says "camry".
--
--   A secondary issue exists in the code path: autoCreateRevenueRecord()
--   called normalizeVehicleId() on the DB fallback vehicle_id, so every new
--   revenue record written for an old "camry2012" booking also landed as
--   "camry" instead of mirroring the booking.
--
-- Fix:
--   For every revenue_records row whose booking_id matches a bookings row via
--   booking_ref, update revenue_records.vehicle_id to match bookings.vehicle_id.
--   The booking table is the authoritative source for vehicle identity.
--
-- Scope:
--   Only rows where the vehicle_ids actually differ are touched.  Rows without
--   a booking link (orphan records, manually-created entries with no booking_ref)
--   are intentionally left untouched.
--
-- Safe to re-run: the WHERE clause prevents any-op updates when the values
-- are already consistent.

UPDATE revenue_records rr
SET    vehicle_id = b.vehicle_id,
       updated_at = now()
FROM   bookings b
WHERE  b.booking_ref          = rr.booking_id
  AND  b.vehicle_id           IS NOT NULL
  AND  rr.vehicle_id          IS DISTINCT FROM b.vehicle_id;
