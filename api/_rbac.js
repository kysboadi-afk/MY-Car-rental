// api/_rbac.js
// Organization-aware RBAC policy helpers (wave 1 foundation).

import { getTenantEnforcementMode } from "./_tenant-context.js";

const ROLE_PERMISSIONS = {
  owner: ["*"],
  admin: [
    "organization:read",
    "organization:update",
    "members:read",
    "members:manage",
    "bookings:read",
    "bookings:write",
    "vehicles:read",
    "vehicles:write",
    "customers:read",
    "customers:write",
    "revenue:read",
    "revenue:write",
    "ledger:read",
    "ledger:write",
    "settings:read",
    "settings:write",
    "diagnostics:read",
  ],
  manager: [
    "organization:read",
    "members:read",
    "bookings:read",
    "bookings:write",
    "vehicles:read",
    "vehicles:write",
    "customers:read",
    "customers:write",
    "revenue:read",
    "ledger:read",
    "settings:read",
    "diagnostics:read",
  ],
  staff: ["organization:read", "bookings:read", "bookings:write", "vehicles:read", "customers:read", "customers:write"],
  viewer: ["organization:read", "bookings:read", "vehicles:read", "customers:read", "revenue:read", "ledger:read"],
  superadmin: ["platform:*"],
};

const OPERATOR_ROLES = new Set(["owner", "admin", "manager", "staff", "viewer"]);

export function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

export function isOperatorRole(role) {
  return OPERATOR_ROLES.has(normalizeRole(role));
}

export function isPlatformRole(role) {
  return normalizeRole(role) === "superadmin";
}

export function canRolePerform(role, permission, authContext = "operator") {
  const normalizedRole = normalizeRole(role);
  const normalizedPermission = String(permission || "").trim().toLowerCase();
  const permissions = ROLE_PERMISSIONS[normalizedRole] || [];
  if (!normalizedPermission) return false;

  if (permissions.includes("*")) return authContext !== "platform";
  if (permissions.includes("platform:*") && authContext === "platform") return true;
  if (permissions.includes(normalizedPermission)) return true;

  const [prefix] = normalizedPermission.split(":");
  if (permissions.includes(`${prefix}:*`)) return true;

  return false;
}

export function evaluateRbacAccess({ role, permission, authContext = "operator", enforcementMode } = {}) {
  const mode = enforcementMode || getTenantEnforcementMode();
  const normalizedRole = normalizeRole(role);
  const normalizedContext = String(authContext || "operator").trim().toLowerCase();

  const allowedByPolicy = canRolePerform(normalizedRole, permission, normalizedContext);
  const result = {
    allowed: allowedByPolicy,
    shadowDenied: false,
    enforcementMode: mode,
    role: normalizedRole,
    authContext: normalizedContext,
    permission: String(permission || ""),
    reason: allowedByPolicy ? "allowed" : `role ${normalizedRole || "unknown"} cannot perform ${permission}`,
  };

  if (allowedByPolicy) return result;
  if (mode === "enforce") return result;

  return {
    ...result,
    allowed: true,
    shadowDenied: true,
    reason: `shadow-allow: ${result.reason}`,
  };
}
