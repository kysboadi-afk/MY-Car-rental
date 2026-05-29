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

const TENANT_MEMBERSHIP_SELECT = `
  organization_id,
  role,
  status,
  accepted_at,
  invited_at,
  created_at,
  organizations!inner (
    id,
    slug,
    status
  )
`;

const ROLE_PRIORITY = {
  owner: 0,
  admin: 1,
  member: 2,
  staff: 3,
};

function getRolePriority(role) {
  return ROLE_PRIORITY[String(role || "").toLowerCase()] ?? 99;
}

function parseSortTime(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : 0;
}

function isTenantSchemaError(err) {
  const message = String(err?.message || "").toLowerCase();
  const details = String(err?.details || "").toLowerCase();
  const hint = String(err?.hint || "").toLowerCase();
  const combined = `${message} ${details} ${hint}`;
  return (
    combined.includes("organization_users") ||
    combined.includes("organizations") ||
    combined.includes("schema cache") ||
    combined.includes("does not exist")
  );
}

function selectPreferredMembership(rows) {
  const memberships = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.organization_id)
    .filter((row) => String(row?.status || "").toLowerCase() === "active")
    .filter((row) => String(row?.organizations?.status || "").toLowerCase() === "active");

  if (!memberships.length) return null;

  memberships.sort((a, b) => {
    const roleDiff = getRolePriority(a?.role) - getRolePriority(b?.role);
    if (roleDiff !== 0) return roleDiff;

    const acceptedDiff = parseSortTime(b?.accepted_at) - parseSortTime(a?.accepted_at);
    if (acceptedDiff !== 0) return acceptedDiff;

    const invitedDiff = parseSortTime(b?.invited_at) - parseSortTime(a?.invited_at);
    if (invitedDiff !== 0) return invitedDiff;

    return parseSortTime(b?.created_at) - parseSortTime(a?.created_at);
  });

  return memberships[0];
}

// ─── Phase 1-compatible implementations ──────────────────────────────────────

/**
 * Resolves the organization and role for an authenticated user.
 *
 * Returns null when organization membership tables are not ready yet so callers
 * stay compatibility-safe during rollout.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<TenantContext|null>}
 */
export async function resolveTenantContext(supabase, userId) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!supabase || typeof supabase.from !== "function" || !normalizedUserId) {
    return null;
  }

  try {
    const { data, error } = await supabase
      .from("organization_users")
      .select(TENANT_MEMBERSHIP_SELECT)
      .eq("user_id", normalizedUserId)
      .eq("status", "active")
      .eq("organizations.status", "active");

    if (error) {
      if (isTenantSchemaError(error)) {
        console.warn("[tenant-context] Organization schema not ready; using single-tenant mode.");
        return null;
      }
      console.error("[tenant-context] Membership lookup failed:", error?.message || error);
      return null;
    }

    const membership = selectPreferredMembership(data);
    if (!membership?.organization_id) return null;

    return {
      organizationId: membership.organization_id,
      role: String(membership.role || "member").toLowerCase(),
      userId: normalizedUserId,
    };
  } catch (err) {
    if (isTenantSchemaError(err)) {
      console.warn("[tenant-context] Organization schema not ready; using single-tenant mode.");
      return null;
    }
    console.error("[tenant-context] Unexpected resolution failure:", err?.message || err);
    return null;
  }
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
