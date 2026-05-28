// api/_admin-auth.js
// Shared admin authentication helper.
//
// Supports:
//   1) Legacy static admin secret (ADMIN_SECRET / ADMIN_PASSWORD)
//   2) Signed short-lived admin session tokens issued by /api/admin-auth-session
//
// This lets the admin UI stop reusing the raw password on every request while
// preserving backward compatibility for existing callers.

import crypto from "crypto";
import { normalizeOrganizationId } from "./_tenant-context.js";

const SESSION_VERSION = "v1";
const DEFAULT_ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h
const MAX_ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h

const OPERATOR_ADMIN_ROLES = new Set(["admin", "support", "owner", "manager"]);

function normalizeSecret(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function getExpectedAdminSecret() {
  return normalizeSecret(process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || "");
}

function getPlatformAdminSecret() {
  return normalizeSecret(process.env.PLATFORM_ADMIN_SECRET || "");
}

function getSessionSigningSecret() {
  // Dedicated secret is preferred; fallbacks preserve existing environments.
  return normalizeSecret(
    process.env.AUTH_SESSION_SECRET ||
    process.env.OTP_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.ADMIN_PASSWORD ||
    ""
  );
}

function safeEqual(aRaw, bRaw) {
  const a = Buffer.from(String(aRaw || ""), "utf8");
  const b = Buffer.from(String(bRaw || ""), "utf8");
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const bPadded = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  if (typeof crypto.timingSafeEqual === "function") {
    return crypto.timingSafeEqual(aPadded, bPadded) && a.length === b.length;
  }
  return Buffer.compare(aPadded, bPadded) === 0 && a.length === b.length;
}

function signPayload(payload) {
  const secret = getSessionSigningSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseSessionToken(token) {
  const raw = normalizeSecret(token);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!payload || !sig) return null;
  const expected = signPayload(payload);
  if (!expected || !safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object") return null;
    if (claims.typ !== "admin_session" || claims.ver !== SESSION_VERSION) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(claims.exp) || now >= Number(claims.exp)) return null;
    if (!Number.isFinite(claims.iat) || Number(claims.iat) <= 0) return null;

    const normalizedRole = String(claims.role || "").toLowerCase();
    const normalizedContext = String(claims.auth_context || "operator").toLowerCase();
    if (!normalizedRole) return null;
    if (normalizedContext === "platform" && normalizedRole !== "superadmin") return null;

    return {
      ...claims,
      role: normalizedRole,
      auth_context: normalizedContext,
      organization_id: normalizeOrganizationId(String(claims.organization_id || "")) || null,
      org_role: String(claims.org_role || normalizedRole || "").toLowerCase() || null,
    };
  } catch {
    return null;
  }
}

/**
 * Creates a signed admin session token.
 *
 * @param {object} [opts]
 * @param {string} [opts.role]
 * @param {string} [opts.sub]
 * @param {string} [opts.authMethod]
 * @param {number} [opts.ttlSeconds]
 * @param {string} [opts.organizationId]
 * @param {string} [opts.authContext]
 * @returns {string}
 */
export function createAdminSessionToken(opts = {}) {
  const secret = getSessionSigningSecret();
  if (!secret) return "";
  const now = Math.floor(Date.now() / 1000);
  const ttlCandidate = Number.parseInt(
    String(opts.ttlSeconds ?? process.env.ADMIN_SESSION_TTL_SECONDS ?? DEFAULT_ADMIN_SESSION_TTL_SECONDS),
    10
  );
  const ttlSeconds = Number.isFinite(ttlCandidate)
    ? Math.max(60, Math.min(MAX_ADMIN_SESSION_TTL_SECONDS, ttlCandidate))
    : DEFAULT_ADMIN_SESSION_TTL_SECONDS;

  const authContext = String(opts.authContext || "operator").toLowerCase() === "platform" ? "platform" : "operator";
  const role = String(opts.role || (authContext === "platform" ? "superadmin" : "admin")).toLowerCase();
  const organizationId = authContext === "platform" ? null : normalizeOrganizationId(String(opts.organizationId || "")) || null;

  const claims = {
    typ: "admin_session",
    ver: SESSION_VERSION,
    sub: String(opts.sub || "admin-dashboard"),
    role,
    org_role: String(opts.orgRole || role).toLowerCase(),
    auth_context: authContext,
    organization_id: organizationId,
    auth_method: String(opts.authMethod || "admin_secret"),
    iat: now,
    exp: now + ttlSeconds,
  };

  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = signPayload(payload);
  if (!sig) return "";
  return `${payload}.${sig}`;
}

/**
 * Verifies and returns admin session claims.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function verifyAdminSessionToken(token) {
  return parseSessionToken(token);
}

/**
 * Extracts admin credential material from request:
 *   1. Authorization: ******
 *   2. req.query.secret
 *   3. req.body.secret
 */
export function extractAdminSecret(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (req.query?.secret) return String(req.query.secret);
  if (req.body?.secret) return String(req.body.secret);
  return "";
}

export function getAdminAuthContextFromCredential(supplied) {
  const claims = parseSessionToken(String(supplied || ""));
  if (!claims) return null;
  return {
    role: claims.role,
    orgRole: claims.org_role || claims.role,
    authContext: claims.auth_context || "operator",
    organizationId: claims.organization_id || null,
    sub: claims.sub || "admin-dashboard",
    iat: claims.iat,
    exp: claims.exp,
  };
}

/**
 * Returns true when supplied credential is either:
 *   - the configured admin secret, or
 *   - a valid signed admin session token (operator admin/support/owner/manager)
 */
export function isAdminAuthorized(supplied) {
  const suppliedNormalized = normalizeSecret(String(supplied || ""));
  if (!suppliedNormalized) return false;

  const expected = getExpectedAdminSecret();
  if (expected && safeEqual(suppliedNormalized, expected)) return true;

  const claims = parseSessionToken(suppliedNormalized);
  if (!claims) return false;
  if (claims.auth_context === "platform") return false;
  return OPERATOR_ADMIN_ROLES.has(String(claims.role || "").toLowerCase());
}

export function isPlatformAdminAuthorized(supplied) {
  const suppliedNormalized = normalizeSecret(String(supplied || ""));
  if (!suppliedNormalized) return false;

  const platformSecret = getPlatformAdminSecret();
  if (platformSecret && safeEqual(suppliedNormalized, platformSecret)) return true;

  const claims = parseSessionToken(suppliedNormalized);
  if (!claims) return false;
  return claims.auth_context === "platform" && claims.role === "superadmin";
}

/**
 * Returns true when the ADMIN_SECRET / ADMIN_PASSWORD env var is configured.
 * (Kept as-is for compatibility while endpoints migrate incrementally.)
 */
export function isAdminConfigured() {
  return Boolean(getExpectedAdminSecret());
}
