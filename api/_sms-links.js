import { createManageToken } from "./_manage-booking-token.js";
import { isFeatureEnabled } from "./_sms-rollout.js";

function normalizeValue(value) {
  return String(value || "").trim();
}

function resolveManageToken({ bookingId, manageToken } = {}) {
  const normalizedManageToken = normalizeValue(manageToken);
  if (normalizedManageToken) return normalizedManageToken;

  const normalizedBookingId = normalizeValue(bookingId);
  if (!normalizedBookingId) return "";

  return createManageToken(normalizedBookingId);
}

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

export function buildDashboardExtendLink({ bookingId, manageToken, vehicleId } = {}) {
  const resolvedManageToken = resolveManageToken({ bookingId, manageToken });
  if (resolvedManageToken) {
    return buildManageBookingLink({ token: resolvedManageToken });
  }
  return buildLegacyExtendEntryLink({ vehicleId });
}

export function isDashboardFirstLinksEnabled() {
  return isFeatureEnabled("SMS_DASHBOARD_FIRST_LINKS", true);
}

export function buildRenterPortalLinks({ bookingId, manageToken, vehicleId } = {}) {
  const resolvedManageToken = resolveManageToken({ bookingId, manageToken });
  const manageLink = buildManageBookingLink({ token: resolvedManageToken });
  const balanceLink = buildLegacyBalanceLink({ bookingId });
  const extendLink = buildDashboardExtendLink({ bookingId, manageToken: resolvedManageToken, vehicleId });
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
