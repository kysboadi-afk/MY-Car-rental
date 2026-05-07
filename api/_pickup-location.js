// api/_pickup-location.js
// Shared pickup-location routing for booking notifications and reminders.

import { DEFAULT_LOCATION } from "./_sms-templates.js";

export const SLINGSHOT_PICKUP_LOCATION = "475 The Promenade N, Long Beach, CA 90802";

/**
 * Resolve pickup location by booking type / vehicle identifiers.
 * Cars default to SLY Transportation (Los Angeles), slingshots to Long Beach.
 *
 * @param {{ bookingType?: string, vehicleId?: string, vehicleName?: string }} params
 * @returns {string}
 */
export function resolvePickupLocation({ bookingType, vehicleId, vehicleName } = {}) {
  const normalizedBookingType = String(bookingType || "").toLowerCase();
  const vehicleSearchString = `${vehicleId || ""} ${vehicleName || ""}`.toLowerCase();
  return normalizedBookingType === "slingshot" || vehicleSearchString.includes("slingshot")
    ? SLINGSHOT_PICKUP_LOCATION
    : DEFAULT_LOCATION;
}
