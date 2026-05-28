// api/_tenant-context.js
// Tenant context resolution for multi-tenant SaaS architecture.
//
// This module is the Phase 0 foundation for server-side tenant isolation.
// It defines the contracts that all future multi-tenant queries will use,
// while being completely safe to deploy today: all functions are no-ops or
// pass-throughs until the organizations table is populated in Phase 1.
//
// ── Phase roadmap ─────────────────────────────────────────────────────────────
//
//   Phase 0 (now):
//     • resolveTenantContext() returns null — single-tenant mode, no DB queries
//     • buildTenantQuery() returns the query unmodified — no org filter applied
//     • assertTenantOwnership() always returns true — no cross-tenant enforcement
//     All existing callers are unaffected.
//
//   Phase 1 (after 0175_organizations_foundation migration):
//     • resolveTenantContext() queries organization_users joined to organizations
//     • Returns { organizationId, role, userId } for authenticated operators
//     • withAdminAuth() in _middleware.js calls this and attaches to req.tenantContext
//
//   Phase 2 (full enforcement):
//     • buildTenantQuery() adds .eq('organization_id', ctx.organizationId) to all queries
//     • assertTenantOwnership() throws TENANT_ISOLATION_VIOLATION on org mismatch
//     • RLS policies enforce the same constraint at the DB layer (defense in depth)
//
// ── Architectural note ────────────────────────────────────────────────────────
//
//   Tenant isolation is enforced at TWO layers:
//     1. Application layer — buildTenantQuery() scopes queries by organization_id
//     2. Database layer    — Supabase RLS policies enforce the same constraint
//   Neither layer alone is sufficient; both must be active before real multi-tenant
//   operators are onboarded.

/**
 * @typedef {Object} TenantContext
 * @property {string} organizationId  — UUID of the resolved organization
 * @property {string} role            — 'owner' | 'admin' | 'member' | 'staff'
 * @property {string} userId          — authenticated user's UUID
 */

// ─── Phase 0 stub implementations ────────────────────────────────────────────

/**
 * Resolves the organization and role for an authenticated user.
 *
 * Phase 0: always returns null (organizations table does not exist yet).
 *   Callers should treat null as "single-tenant / no org scope required".
 *
 * Phase 1 implementation (replace this body):
 *   const { data } = await supabase
 *     .from('organization_users')
 *     .select('organization_id, role, organizations(id, slug, status)')
 *     .eq('user_id', userId)
 *     .eq('organizations.status', 'active')
 *     .single();
 *   if (!data) return null;
 *   return { organizationId: data.organization_id, role: data.role, userId };
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} _supabase
 * @param {string} _userId
 * @returns {Promise<TenantContext|null>}
 */
export async function resolveTenantContext(_supabase, _userId) {
  // Phase 0 stub — safe to call everywhere.
  // Returns null so all existing single-tenant queries continue unmodified.
  return null;
}

/**
 * Applies organization_id scoping to a Supabase query builder.
 *
 * Phase 0: returns the query unmodified (no tenant filter applied).
 * Phase 1: adds .eq('organization_id', ctx.organizationId) to scope the query.
 *
 * Usage (write once, automatically enforced in Phase 1):
 *   const query = supabase.from('bookings').select('*');
 *   return buildTenantQuery(query, req.tenantContext).eq('status', 'active');
 *
 * @param {Object}             query — Supabase query builder instance
 * @param {TenantContext|null} ctx
 * @returns {Object} — query builder (scoped in Phase 1, unmodified in Phase 0)
 */
export function buildTenantQuery(query, ctx) {
  if (!ctx?.organizationId) return query;
  return query.eq("organization_id", ctx.organizationId);
}

/**
 * Asserts that a retrieved row belongs to the active tenant context.
 * Throws a structured error on mismatch to prevent cross-tenant data leakage.
 *
 * Phase 0: always returns true (no ctx = no enforcement).
 * Phase 1: enforces strict organizationId match; throws on violation.
 *
 * Usage:
 *   const { data: booking } = await supabase.from('bookings').select('*').eq('id', id).single();
 *   assertTenantOwnership(req.tenantContext, booking?.organization_id);
 *
 * @param {TenantContext|null} ctx
 * @param {string|null}        rowOrgId — the organization_id from the retrieved row
 * @returns {true}
 * @throws {Error} with code 'TENANT_ISOLATION_VIOLATION' on mismatch
 */
export function assertTenantOwnership(ctx, rowOrgId) {
  if (!ctx?.organizationId) return true;
  if (!rowOrgId) return true;
  if (ctx.organizationId !== rowOrgId) {
    const err = new Error(
      `Tenant isolation violation: cross-tenant access attempted ` +
      `(expected org=${ctx.organizationId}, got org=${rowOrgId})`
    );
    err.code = "TENANT_ISOLATION_VIOLATION";
    throw err;
  }
  return true;
}

/**
 * Returns true when the tenant context has an active organization.
 * Convenience helper for conditional org-scoped logic.
 *
 * Phase 0: always false (no context = single-tenant mode).
 *
 * @param {TenantContext|null} ctx
 * @returns {boolean}
 */
export function hasTenantContext(ctx) {
  return !!(ctx?.organizationId);
}
