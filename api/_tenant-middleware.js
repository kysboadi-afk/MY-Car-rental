// api/_tenant-middleware.js
// Tenant resolution and compatibility-safe enforcement helpers.

import {
  getTenantEnforcementMode,
  recordTenantViolation,
  resolveOrganizationIdFromRequest,
} from "./_tenant-context.js";
import { evaluateRbacAccess, isOperatorRole, isPlatformRole } from "./_rbac.js";

export function resolveTenantRequestContext(req = {}, claims = null, opts = {}) {
  const enforcementMode = opts.enforcementMode || getTenantEnforcementMode();
  const requireOrganization = Boolean(opts.requireOrganization);
  const resolved = resolveOrganizationIdFromRequest(req, claims);

  const claimOrganizationId = String(claims?.organization_id || claims?.org_id || "").trim();
  const authContext = String(claims?.auth_context || "legacy").trim().toLowerCase() || "legacy";
  const role = String(claims?.role || "").trim().toLowerCase();

  const context = {
    organizationId: resolved.organizationId || "",
    source: resolved.source,
    enforcementMode,
    authContext,
    role,
    isPlatformContext: authContext === "platform" || isPlatformRole(role),
    isOperatorContext: authContext === "operator" || isOperatorRole(role),
    violations: [],
  };

  if (claimOrganizationId && resolved.organizationId && claimOrganizationId !== resolved.organizationId) {
    const violation = recordTenantViolation({
      code: "tenant_context_mismatch",
      message: "Request organization_id does not match token organization_id.",
      route: req.url,
      method: req.method,
      organizationId: claimOrganizationId,
      requestedOrganizationId: resolved.organizationId,
      authContext,
      actorRole: role,
      enforcementMode,
    });
    context.violations.push(violation);
  }

  if (requireOrganization && !context.organizationId && !context.isPlatformContext) {
    const violation = recordTenantViolation({
      code: "missing_organization_context",
      message: "Missing required organization_id context.",
      route: req.url,
      method: req.method,
      authContext,
      actorRole: role,
      enforcementMode,
    });
    context.violations.push(violation);
  }

  return context;
}

export function assertTenantPermission(req, context, permission) {
  const decision = evaluateRbacAccess({
    role: context?.role,
    permission,
    authContext: context?.authContext,
    enforcementMode: context?.enforcementMode,
  });

  if (decision.shadowDenied) {
    const violation = recordTenantViolation({
      code: "rbac_shadow_denied",
      message: decision.reason,
      route: req?.url,
      method: req?.method,
      organizationId: context?.organizationId,
      authContext: context?.authContext,
      actorRole: context?.role,
      enforcementMode: context?.enforcementMode,
      metadata: { permission },
    });
    if (context?.violations) context.violations.push(violation);
  }

  if (!decision.allowed) {
    return {
      ok: false,
      statusCode: 403,
      error: "Forbidden",
      reason: decision.reason,
      decision,
    };
  }

  return { ok: true, decision };
}

export function scopeSupabaseQueryToTenant(queryBuilder, context, field = "organization_id") {
  if (!queryBuilder) return queryBuilder;
  const mode = String(context?.enforcementMode || getTenantEnforcementMode());
  const organizationId = String(context?.organizationId || "").trim();

  if (organizationId) {
    return queryBuilder.eq(field, organizationId);
  }

  if (mode === "enforce" && !context?.isPlatformContext) {
    throw new Error("Missing organization_id for tenant-scoped query.");
  }

  return queryBuilder;
}
