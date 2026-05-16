import { isFeatureEnabled } from "./_sms-rollout.js";

export function buildManageBookingLink({ token } = {}) {
  const base = "https://www.slytrans.com/manage-booking.html";
  if (!token) return base;
  return `${base}?t=${encodeURIComponent(String(token))}`;
}

export function buildLegacyBalanceLink({ bookingId } = {}) {
  const base = "https://www.slytrans.com/balance.html";
  const normalizedBookingId = String(bookingId || "").trim();
  if (!normalizedBookingId) return base;
  return `${base}?b=${encodeURIComponent(normalizedBookingId)}`;
}

export function buildLegacyExtendEntryLink({ vehicleId } = {}) {
  const normalizedVehicleId = String(vehicleId || "").trim();
  if (!normalizedVehicleId) return "https://www.slytrans.com/manage-booking.html";
  return `https://www.slytrans.com/car.html?vehicle=${encodeURIComponent(normalizedVehicleId)}&extend=1`;
}

export function isDashboardFirstLinksEnabled() {
  return isFeatureEnabled("SMS_DASHBOARD_FIRST_LINKS", true);
}

export function buildRenterPortalLinks({ bookingId, manageToken, vehicleId } = {}) {
  const manageLink = buildManageBookingLink({ token: manageToken });
  const balanceLink = buildLegacyBalanceLink({ bookingId });
  const extendLink = buildLegacyExtendEntryLink({ vehicleId });
  const dashboardFirst = isDashboardFirstLinksEnabled();
  const primaryLink = dashboardFirst ? manageLink : balanceLink;
  const secondaryLink = dashboardFirst ? balanceLink : manageLink;
  return {
    dashboardFirst,
    manageLink,
    balanceLink,
    extendLink,
    primaryLink,
    secondaryLink,
  };
}

