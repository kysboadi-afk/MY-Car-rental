// api/_tenant-context.test.js
// Unit tests for api/_tenant-context.js
//
// Verifies:
//   1. resolveTenantContext — safely resolves active org membership
//   2. buildTenantQuery     — passes query through unmodified when ctx is null
//   3. assertTenantOwnership — returns true when ctx is null
//   4. hasTenantContext     — returns false with null ctx, true with populated ctx
//   5. assertTenantOwnership — throws TENANT_ISOLATION_VIOLATION on org mismatch
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTenantContext,
  buildTenantQuery,
  assertTenantOwnership,
  hasTenantContext,
} from "./_tenant-context.js";

function makeSupabaseTenantMock({ data = [], error = null } = {}) {
  const state = { eqCalls: [] };
  return {
    state,
    from(table) {
      assert.equal(table, "organization_users");
      return {
        select(selectClause) {
          state.selectClause = selectClause;
          return {
            eq(column, value) {
              state.eqCalls.push({ column, value });
              return this;
            },
            then(resolve) {
              return Promise.resolve({ data, error }).then(resolve);
            },
          };
        },
      };
    },
  };
}

// ─── resolveTenantContext ─────────────────────────────────────────────────────

test("resolveTenantContext: returns null when Supabase client is missing", async () => {
  const result = await resolveTenantContext(null, "any-user-id");
  assert.equal(result, null);
});

test("resolveTenantContext: returns null when userId is missing", async () => {
  const sb = makeSupabaseTenantMock();
  const r1 = await resolveTenantContext(sb, "");
  const r2 = await resolveTenantContext(sb, null);
  const r3 = await resolveTenantContext(sb, undefined);
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(r3, null);
});

test("resolveTenantContext: resolves active organization membership", async () => {
  const sb = makeSupabaseTenantMock({
    data: [{
      organization_id: "org-123",
      role: "admin",
      status: "active",
      organizations: { id: "org-123", slug: "acme", status: "active" },
    }],
  });

  const result = await resolveTenantContext(sb, "user-1");
  assert.deepEqual(result, {
    organizationId: "org-123",
    role: "admin",
    userId: "user-1",
  });
  assert.equal(sb.state.eqCalls.length, 3);
  assert.deepEqual(sb.state.eqCalls[0], { column: "user_id", value: "user-1" });
});

test("resolveTenantContext: prefers highest-privilege active membership", async () => {
  const sb = makeSupabaseTenantMock({
    data: [
      {
        organization_id: "org-member",
        role: "member",
        status: "active",
        accepted_at: "2026-05-01T00:00:00.000Z",
        organizations: { id: "org-member", slug: "member", status: "active" },
      },
      {
        organization_id: "org-owner",
        role: "owner",
        status: "active",
        accepted_at: "2026-04-01T00:00:00.000Z",
        organizations: { id: "org-owner", slug: "owner", status: "active" },
      },
    ],
  });

  const result = await resolveTenantContext(sb, "user-2");
  assert.equal(result.organizationId, "org-owner");
  assert.equal(result.role, "owner");
});

test("resolveTenantContext: returns null when no active organization membership exists", async () => {
  const sb = makeSupabaseTenantMock({
    data: [{
      organization_id: "org-123",
      role: "admin",
      status: "suspended",
      organizations: { id: "org-123", slug: "acme", status: "active" },
    }],
  });

  const result = await resolveTenantContext(sb, "user-3");
  assert.equal(result, null);
});

test("resolveTenantContext: returns null on schema drift errors", async () => {
  const sb = makeSupabaseTenantMock({
    error: { message: 'relation "organization_users" does not exist' },
  });

  const result = await resolveTenantContext(sb, "user-4");
  assert.equal(result, null);
});

// ─── buildTenantQuery ─────────────────────────────────────────────────────────

test("buildTenantQuery: returns query unmodified when ctx is null", () => {
  const query = { _filters: [] };
  const result = buildTenantQuery(query, null);
  assert.equal(result, query);
  assert.deepEqual(result._filters, []);
});

test("buildTenantQuery: returns query unmodified when ctx has no organizationId", () => {
  const query = { _filters: [] };
  const result = buildTenantQuery(query, {});
  assert.equal(result, query);
});

test("buildTenantQuery: applies org filter when ctx has organizationId", () => {
  const orgId = "org-abc-123";
  const eqCalls = [];
  const query = {
    eq(col, val) {
      eqCalls.push({ col, val });
      return this;
    },
  };
  const ctx = { organizationId: orgId, role: "owner", userId: "user-1" };
  buildTenantQuery(query, ctx);
  assert.equal(eqCalls.length, 1);
  assert.equal(eqCalls[0].col, "organization_id");
  assert.equal(eqCalls[0].val, orgId);
});

test("buildTenantQuery: chains correctly (returns the result of .eq())", () => {
  const orgId = "org-xyz";
  const chainResult = { chained: true };
  const query = { eq: (_c, _v) => chainResult };
  const ctx = { organizationId: orgId, role: "admin", userId: "user-2" };
  const result = buildTenantQuery(query, ctx);
  assert.equal(result, chainResult);
});

// ─── assertTenantOwnership ────────────────────────────────────────────────────

test("assertTenantOwnership: returns true when ctx is null (Phase 0)", () => {
  const result = assertTenantOwnership(null, "org-123");
  assert.equal(result, true);
});

test("assertTenantOwnership: returns true when rowOrgId is null", () => {
  const ctx = { organizationId: "org-abc", role: "owner", userId: "user-1" };
  const result = assertTenantOwnership(ctx, null);
  assert.equal(result, true);
});

test("assertTenantOwnership: returns true when org IDs match", () => {
  const ctx = { organizationId: "org-abc", role: "owner", userId: "user-1" };
  const result = assertTenantOwnership(ctx, "org-abc");
  assert.equal(result, true);
});

test("assertTenantOwnership: throws TENANT_ISOLATION_VIOLATION on mismatch", () => {
  const ctx = { organizationId: "org-abc", role: "owner", userId: "user-1" };
  assert.throws(
    () => assertTenantOwnership(ctx, "org-different"),
    (err) => {
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      assert.ok(err.message.includes("cross-tenant"));
      return true;
    }
  );
});

test("assertTenantOwnership: violation message includes both org IDs", () => {
  const ctx = { organizationId: "org-expected", role: "owner", userId: "u1" };
  try {
    assertTenantOwnership(ctx, "org-actual");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err.message.includes("org-expected"), "should include expected org");
    assert.ok(err.message.includes("org-actual"),   "should include actual org");
  }
});

test("assertTenantOwnership: returns true when ctx.organizationId is empty string", () => {
  const ctx = { organizationId: "", role: "member", userId: "u1" };
  const result = assertTenantOwnership(ctx, "org-123");
  assert.equal(result, true);
});

// ─── hasTenantContext ─────────────────────────────────────────────────────────

test("hasTenantContext: returns false when ctx is null", () => {
  assert.equal(hasTenantContext(null), false);
});

test("hasTenantContext: returns false when ctx is undefined", () => {
  assert.equal(hasTenantContext(undefined), false);
});

test("hasTenantContext: returns false when ctx has no organizationId", () => {
  assert.equal(hasTenantContext({}), false);
});

test("hasTenantContext: returns false when organizationId is empty string", () => {
  assert.equal(hasTenantContext({ organizationId: "" }), false);
});

test("hasTenantContext: returns true when organizationId is set", () => {
  assert.equal(hasTenantContext({ organizationId: "org-123" }), true);
});
