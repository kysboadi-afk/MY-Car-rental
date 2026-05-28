// api/_tenant-context.js
// Multi-tenant migration context helpers (wave 1 foundation).

const VALID_ENFORCEMENT_MODES = new Set(["off", "shadow", "enforce"]);
const MAX_VIOLATIONS = 100;
const tenantViolations = [];

export function normalizeOrganizationId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized) return "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(normalized)) {
    return normalized;
  }
  return "";
}

export function getTenantEnforcementMode() {
  const configured = String(process.env.TENANT_ENFORCEMENT_MODE || "shadow").trim().toLowerCase();
  return VALID_ENFORCEMENT_MODES.has(configured) ? configured : "shadow";
}

export function getTenantMigrationConfig() {
  return {
    enabled: String(process.env.TENANT_MIGRATION_ENABLED || "true").toLowerCase() !== "false",
    enforcementMode: getTenantEnforcementMode(),
    dualWriteEnabled: String(process.env.TENANT_DUAL_WRITE_ENABLED || "true").toLowerCase() !== "false",
    dualReadEnabled: String(process.env.TENANT_DUAL_READ_ENABLED || "true").toLowerCase() !== "false",
    compatibilityFallbackEnabled:
      String(process.env.TENANT_COMPATIBILITY_FALLBACK_ENABLED || "true").toLowerCase() !== "false",
    defaultOrganizationId: normalizeOrganizationId(process.env.DEFAULT_ORGANIZATION_ID || ""),
  };
}

function normalizedNowIso() {
  return new Date().toISOString();
}

export function recordTenantViolation(violation = {}) {
  const entry = {
    code: String(violation.code || "tenant_violation"),
    message: String(violation.message || "Tenant safety violation detected."),
    route: String(violation.route || "unknown"),
    method: String(violation.method || "unknown"),
    organizationId: normalizeOrganizationId(String(violation.organizationId || "")) || null,
    requestedOrganizationId: normalizeOrganizationId(String(violation.requestedOrganizationId || "")) || null,
    authContext: String(violation.authContext || "legacy"),
    actorRole: String(violation.actorRole || "unknown"),
    enforcementMode: String(violation.enforcementMode || getTenantEnforcementMode()),
    createdAt: normalizedNowIso(),
    metadata: violation.metadata && typeof violation.metadata === "object" ? violation.metadata : null,
  };

  tenantViolations.push(entry);
  if (tenantViolations.length > MAX_VIOLATIONS) tenantViolations.splice(0, tenantViolations.length - MAX_VIOLATIONS);

  console.warn("[tenant-migration]", JSON.stringify(entry));
  return entry;
}

export function getTenantViolationSnapshot() {
  return {
    count: tenantViolations.length,
    recent: tenantViolations.slice(-10),
  };
}

export function resetTenantViolationSnapshotForTests() {
  tenantViolations.splice(0, tenantViolations.length);
}

export function resolveOrganizationIdFromRequest(req = {}, claims = null) {
  const headerOrg = normalizeOrganizationId(
    String(req.headers?.["x-organization-id"] || req.headers?.["x-org-id"] || "")
  );
  const queryOrg = normalizeOrganizationId(String(req.query?.organization_id || req.query?.org_id || ""));
  const bodyOrg = normalizeOrganizationId(String(req.body?.organization_id || req.body?.org_id || ""));
  const claimOrg = normalizeOrganizationId(String(claims?.organization_id || claims?.org_id || ""));
  const fallbackOrg = normalizeOrganizationId(process.env.DEFAULT_ORGANIZATION_ID || "");

  if (claimOrg) return { organizationId: claimOrg, source: "claims" };
  if (headerOrg) return { organizationId: headerOrg, source: "header" };
  if (bodyOrg) return { organizationId: bodyOrg, source: "body" };
  if (queryOrg) return { organizationId: queryOrg, source: "query" };
  if (fallbackOrg) return { organizationId: fallbackOrg, source: "default" };
  return { organizationId: "", source: "none" };
}
