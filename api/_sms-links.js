import { createManageToken } from "./_manage-booking-token.js";
import { isFeatureEnabled } from "./_sms-rollout.js";

const DEFAULT_PRIMARY_SMS_ORIGIN = "https://slycarrentals.com";
const DEFAULT_SECONDARY_SMS_ORIGIN = "https://slytrans.com";

function normalizeValue(value) {
  return String(value || "").trim();
}

function normalizeOrigin(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.origin;
  } catch (_) {
    return "";
  }
}

function resolvePrimarySmsOrigin() {
  return normalizeOrigin(
    process.env.SMS_LINK_BASE_ORIGIN ||
    process.env.SMS_PRIMARY_ORIGIN ||
    process.env.FRONTEND_BASE_URL
  ) || DEFAULT_PRIMARY_SMS_ORIGIN;
}

function resolveSecondarySmsOrigin(primaryOrigin) {
  const configuredSecondary = normalizeOrigin(process.env.SMS_LINK_SECONDARY_ORIGIN);
  if (configuredSecondary && configuredSecondary !== primaryOrigin) return configuredSecondary;
  if (primaryOrigin !== DEFAULT_PRIMARY_SMS_ORIGIN) return DEFAULT_PRIMARY_SMS_ORIGIN;
  if (primaryOrigin !== DEFAULT_SECONDARY_SMS_ORIGIN) return DEFAULT_SECONDARY_SMS_ORIGIN;
  return "";
}

function resolveManageToken({ bookingId, manageToken } = {}) {
  const normalizedManageToken = normalizeValue(manageToken);
  if (normalizedManageToken) return normalizedManageToken;

  const normalizedBookingId = normalizeValue(bookingId);
  if (!normalizedBookingId) return "";

  return createManageToken(normalizedBookingId);
}

export function buildManageBookingLink({ token, origin } = {}) {
  const safeOrigin = normalizeOrigin(origin) || resolvePrimarySmsOrigin();
  const base = `${safeOrigin}/manage-booking.html`;
  if (!token) return base;
  return `${base}?t=${encodeURIComponent(String(token))}`;
}

export function buildLegacyBalanceLink({ bookingId, origin } = {}) {
  const safeOrigin = normalizeOrigin(origin) || resolvePrimarySmsOrigin();
  const base = `${safeOrigin}/balance.html`;
  const normalizedBookingId = String(bookingId || "").trim();
  if (!normalizedBookingId) return base;
  return `${base}?b=${encodeURIComponent(normalizedBookingId)}`;
}

export function buildLegacyExtendEntryLink({ vehicleId, origin } = {}) {
  const safeOrigin = normalizeOrigin(origin) || resolvePrimarySmsOrigin();
  const normalizedVehicleId = String(vehicleId || "").trim();
  if (!normalizedVehicleId) return `${safeOrigin}/manage-booking.html`;
  return `${safeOrigin}/car.html?vehicle=${encodeURIComponent(normalizedVehicleId)}&extend=1`;
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
  const primaryOrigin = resolvePrimarySmsOrigin();
  const secondaryOrigin = resolveSecondarySmsOrigin(primaryOrigin);
  const resolvedManageToken = resolveManageToken({ bookingId, manageToken });
  const manageLink = buildManageBookingLink({ token: resolvedManageToken, origin: primaryOrigin });
  const manageLinkSecondary = secondaryOrigin
    ? buildManageBookingLink({ token: resolvedManageToken, origin: secondaryOrigin })
    : "";
  const balanceLink = buildLegacyBalanceLink({ bookingId, origin: primaryOrigin });
  const extendLink = buildDashboardExtendLink({ bookingId, manageToken: resolvedManageToken, vehicleId });
  const dashboardFirst = isDashboardFirstLinksEnabled();
  const primaryLink = dashboardFirst ? manageLink : balanceLink;
  const secondaryLink = dashboardFirst ? balanceLink : manageLink;
  return {
    primaryOrigin,
    secondaryOrigin,
    dashboardFirst,
    manageLink,
    manageLinkSecondary: manageLinkSecondary && manageLinkSecondary !== manageLink ? manageLinkSecondary : "",
    balanceLink,
    extendLink,
    primaryLink,
    secondaryLink,
  };
}
