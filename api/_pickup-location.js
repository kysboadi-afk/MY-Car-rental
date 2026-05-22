// api/_pickup-location.js
// Shared pickup-location routing for booking notifications and reminders.

export const CAR_PICKUP_LOCATION = "1200 S Figueroa St, Los Angeles, CA 90015";
/**
 * Resolve pickup location for bookings.
 *
 * @returns {string}
 */
export function resolvePickupLocation() {
  return CAR_PICKUP_LOCATION;
}
