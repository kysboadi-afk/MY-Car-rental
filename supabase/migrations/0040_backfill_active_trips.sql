-- 0040_backfill_active_trips.sql
-- Recognise drivers who are currently mid-rental by creating placeholder trips
-- rows for every active booking that has no trips entry yet.
--
-- These are drivers who were already in a rental when migrations 0039 + the
-- booking-automation changes were first deployed.  Without this backfill they
-- would be invisible in the driver_report because no trips row existed for them.
--
-- Strategy:
--   • JOIN bookings (status = 'active') → vehicles (current odometer).
--   • Use the vehicle's current mileage as start_mileage (best estimate for a
--     driver already mid-rental; better than NULL which gives 0 live miles).
--   • Leave end_mileage + distance NULL — the driver_report API computes live
--     miles in real-time as (current_odometer − start_mileage).
--   • driver_name / driver_phone populated from bookings.customer_name / phone.
--
-- Safe to re-run: the NOT EXISTS guard prevents duplicate insertions.

INSERT INTO trips (vehicle_id, booking_id, driver_name, driver_phone, start_mileage, end_mileage, distance)
SELECT
  b.vehicle_id,
  b.booking_ref,
  b.customer_name,
  b.customer_phone,
  v.mileage,   -- current odometer used as best-available start estimate
  NULL,        -- end_mileage unknown until rental completes
  NULL         -- distance computed in real-time from live odometer
FROM bookings b
JOIN vehicles v ON v.vehicle_id = b.vehicle_id
WHERE b.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM trips t WHERE t.booking_id = b.booking_ref
  );
