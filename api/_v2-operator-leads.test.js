import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let currentClient = null;
let rows = [];
let lastUpdate = null;
let organizations = [];
let organizationUsers = [];
let organizationSettings = [];
let shouldFailWorkspaceProvision = false;

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentClient,
  },
});

mock.module("./_middleware.js", {
  namedExports: {
    withAdminAuth: (handler) => handler,
    sendError: (res, status, message, details) => res.status(status).json({ error: message, ...(details ? { details } : {}) }),
  },
});

const { default: handler } = await import("./v2-operator-leads.js");

function makeRes() {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(obj) { this._body = obj; return this; },
  };
}

function makeReq(body = {}) {
  return { method: "POST", headers: {}, body, authUser: { id: "user-1", email: "jordan@example.com" } };
}

function buildClient() {
  return {
    from(table) {
      if (table === "operator_leads") {
        return {
          select() {
            return {
              order() {
                return {
                  limit: async () => ({ data: rows, error: null }),
                };
              },
              eq(_field, id) {
                const row = rows.find((item) => item.id === id);
                return {
                  async maybeSingle() {
                    return { data: row || null, error: null };
                  },
                };
              },
            };
          },
          update(updates) {
            lastUpdate = updates;
            return {
              eq(_field, id) {
                const row = rows.find((item) => item.id === id);
                if (row) Object.assign(row, updates, { updated_at: "2026-05-31T01:00:00.000Z" });
                return {
                  select() {
                    return {
                      async maybeSingle() {
                        return { data: row || null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "organizations") {
        return {
          select() {
            return {
              eq(_field, email) {
                const found = organizations.filter((org) => org.owner_email === email);
                return {
                  order() {
                    return {
                      limit() {
                        return {
                          async maybeSingle() {
                            return { data: found[0] || null, error: null };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          insert(payload) {
            const row = {
              id: `org-${organizations.length + 1}`,
              created_at: "2026-05-31T01:00:00.000Z",
              ...payload,
            };
            organizations.push(row);
            return {
              select() {
                return {
                  async maybeSingle() {
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "organization_users") {
        return {
          async upsert(payload) {
            const idx = organizationUsers.findIndex((row) => row.organization_id === payload.organization_id && row.email === payload.email);
            if (idx >= 0) organizationUsers[idx] = { ...organizationUsers[idx], ...payload };
            else organizationUsers.push(payload);
            return { error: null };
          },
        };
      }
      if (table === "organization_settings") {
        return {
          async upsert(payload) {
            if (shouldFailWorkspaceProvision) {
              return { error: { message: "workspace write failed" } };
            }
            const idx = organizationSettings.findIndex((row) => row.organization_id === payload.organization_id);
            if (idx >= 0) organizationSettings[idx] = { ...organizationSettings[idx], ...payload };
            else organizationSettings.push(payload);
            return { error: null };
          },
        };
      }
      if (table === "operator_lead_audit_logs") {
        return {
          async insert() {
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

beforeEach(() => {
  rows = [
    {
      id: "lead-1",
      first_name: "Jordan",
      last_name: "Fleet",
      email: "jordan@example.com",
      phone: "3105550101",
      fleet_size: "4-10",
      status: "new_lead",
      notes: "priority=Operations",
      source: "fleet_control_early_access",
      funnel_stage: "notification_sent",
      onboarding_progress: {},
      metadata: {},
      organization_id: null,
      lead_submitted_at: "2026-05-31T00:00:00.000Z",
      notification_status: "sent",
      notification_sent_at: "2026-05-31T00:01:00.000Z",
      lead_managed_at: null,
      lead_converted_at: null,
      organization_created_at: null,
      owner_account_created_at: null,
      workspace_provisioned_at: null,
      conversion_status: "not_started",
      conversion_error_reason: null,
      created_at: "2026-05-31T00:00:00.000Z",
      updated_at: "2026-05-31T00:00:00.000Z",
    },
  ];
  lastUpdate = null;
  organizations = [];
  organizationUsers = [];
  organizationSettings = [];
  shouldFailWorkspaceProvision = false;
  currentClient = buildClient();
});

test("list returns operator leads", async () => {
  const res = makeRes();
  await handler(makeReq({ action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(Array.isArray(res._body.leads), true);
  assert.equal(res._body.leads.length, 1);
});

test("list returns empty array when Supabase is unavailable", async () => {
  currentClient = null;
  const res = makeRes();
  await handler(makeReq({ action: "list" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.leads, []);
});

test("update accepts UI status aliases", async () => {
  const res = makeRes();
  await handler(makeReq({ action: "update", id: "lead-1", status: "Qualified", notes: "Followed up", currentFunnelStage: "notification_sent" }), res);
  assert.equal(res._status, 200);
  assert.equal(lastUpdate.status, "onboarding");
  assert.equal(lastUpdate.notes, "Followed up");
  assert.equal(lastUpdate.funnel_stage, "lead_managed");
  assert.equal(res._body.lead.status, "onboarding");
});

test("update rejects invalid statuses", async () => {
  const res = makeRes();
  await handler(makeReq({ action: "update", id: "lead-1", status: "Invalid Status" }), res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /Invalid lead status/);
});

test("convert provisions organization, owner membership, and workspace", async () => {
  const res = makeRes();
  await handler(makeReq({ action: "convert", id: "lead-1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.lead.status, "active_operator");
  assert.equal(res._body.lead.funnel_stage, "workspace_provisioned");
  assert.equal(res._body.lead.conversion_status, "succeeded");
  assert.equal(organizations.length, 1);
  assert.equal(organizationUsers.length, 1);
  assert.equal(organizationSettings.length, 1);
});

test("convert remains idempotent when lead already provisioned", async () => {
  rows[0].workspace_provisioned_at = "2026-05-31T05:00:00.000Z";
  rows[0].conversion_status = "succeeded";
  rows[0].organization_id = "org-existing";
  const res = makeRes();
  await handler(makeReq({ action: "convert", id: "lead-1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.idempotent, true);
  assert.equal(organizations.length, 0);
  assert.equal(organizationSettings.length, 0);
});

test("convert records failure details for retry when workspace provisioning fails", async () => {
  shouldFailWorkspaceProvision = true;
  const res = makeRes();
  await handler(makeReq({ action: "convert", id: "lead-1" }), res);

  assert.equal(res._status, 500);
  assert.match(res._body.error, /Lead conversion failed/);
  assert.equal(rows[0].conversion_status, "failed");
  assert.match(rows[0].conversion_error_reason, /workspace write failed/);
  assert.equal(organizations.length, 1);
  assert.equal(organizationUsers.length, 1);
});
