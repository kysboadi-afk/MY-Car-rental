// api/_supabase.js
// Server-side Supabase client factory.
// Uses the SERVICE_ROLE key — only import this in Vercel serverless functions,
// never in client-side code.

import { createClient } from "@supabase/supabase-js";
import { getTenantEnforcementMode, normalizeOrganizationId, recordTenantViolation } from "./_tenant-context.js";

/**
 * Returns a fresh Supabase admin client (service role) on every call.
 * Stateless — no singleton caching — so Vercel serverless functions always
 * get a clean connection and are not affected by stale module-level state.
 * Returns null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set,
 * so callers can gracefully fall back to default values.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error("❌ Supabase env vars missing");
    return null;
  }

  try {
    const client = createClient(url, key, {
      auth: {
        persistSession: false,
      },
    });

    return client;
  } catch (err) {
    console.error("❌ Supabase client init failed:", err);
    return null;
  }
}

export function withOrganizationId(payload, organizationId) {
  const orgId = normalizeOrganizationId(organizationId || "");
  if (!orgId) return payload;

  if (Array.isArray(payload)) {
    return payload.map((row) => {
      if (!row || typeof row !== "object") return row;
      if (row.organization_id) return row;
      return { ...row, organization_id: orgId };
    });
  }

  if (!payload || typeof payload !== "object") return payload;
  if (payload.organization_id) return payload;
  return { ...payload, organization_id: orgId };
}

export function enforceOrganizationContext({ organizationId, route, method, authContext } = {}) {
  const normalizedOrgId = normalizeOrganizationId(organizationId || "");
  const mode = getTenantEnforcementMode();
  const normalizedContext = String(authContext || "legacy").toLowerCase();

  if (normalizedOrgId || normalizedContext === "platform") {
    return { ok: true, mode, organizationId: normalizedOrgId };
  }

  const violation = recordTenantViolation({
    code: "missing_organization_context",
    message: "Missing organization_id for tenant-aware operation.",
    route,
    method,
    authContext: normalizedContext,
    enforcementMode: mode,
  });

  if (mode === "enforce") {
    return { ok: false, mode, error: "Missing organization context", violation };
  }

  return { ok: true, mode, organizationId: "", violation };
}

export function applyOrganizationScope(queryBuilder, organizationId, opts = {}) {
  if (!queryBuilder) return queryBuilder;
  const field = String(opts.field || "organization_id");
  const orgId = normalizeOrganizationId(organizationId || "");
  const mode = opts.enforcementMode || getTenantEnforcementMode();

  if (orgId) {
    return queryBuilder.eq(field, orgId);
  }

  if (mode === "enforce" && !opts.allowUnscoped) {
    throw new Error("Tenant enforcement blocked unscoped query.");
  }

  if (mode !== "off") {
    recordTenantViolation({
      code: "unscoped_query",
      message: `Tenant-scoped query executed without ${field}.`,
      route: opts.route,
      method: opts.method,
      enforcementMode: mode,
    });
  }

  return queryBuilder;
}
