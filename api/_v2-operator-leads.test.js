import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let currentClient = null;
let rows = [];
let lastUpdate = null;
let organizations = [];
let organizationUsers = [];
let organizationSettings = [];
let websiteUpsells = [];
let servicePackages = [];
let auditLogs = [];
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

function buildQueryable(sourceRows, transforms = {}) {
  const state = {
    rows: sourceRows,
    eqFilters: [],
    inFilters: [],
    orders: [],
    limitCount: null,
  };

  function run() {
    let result = [...state.rows];
    for (const filter of state.eqFilters) {
      result = result.filter((row) => row?.[filter.field] === filter.value);
    }
    for (const filter of state.inFilters) {
      result = result.filter((row) => filter.values.includes(row?.[filter.field]));
    }
    for (const order of state.orders) {
      result.sort((a, b) => {
        const left = a?.[order.field];
        const right = b?.[order.field];
        if (left === right) return 0;
        if (left == null) return 1;
        if (right == null) return -1;
        if (left > right) return order.ascending ? 1 : -1;
        return order.ascending ? -1 : 1;
      });
    }
    if (typeof transforms.mapRows === "function") {
      result = transforms.mapRows(result);
    }
    if (Number.isFinite(state.limitCount)) result = result.slice(0, state.limitCount);
    return { data: result, error: null };
  }

  const query = {
    eq(field, value) {
      state.eqFilters.push({ field, value });
      return query;
    },
    in(field, values) {
      state.inFilters.push({ field, values: Array.isArray(values) ? values : [] });
      return query;
    },
    order(field, options = {}) {
      state.orders.push({ field, ascending: options.ascending !== false });
      return query;
    },
    limit(count) {
      state.limitCount = Number(count);
      return query;
    },
    async maybeSingle() {
      const { data } = run();
      return { data: data[0] || null, error: null };
    },
    async single() {
      const { data } = run();
      return { data: data[0] || null, error: null };
    },
    then(resolve, reject) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return query;
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
          select() {
            return {
              eq(_field, organizationId) {
                const row = organizationSettings.find((item) => item.organization_id === organizationId);
                return {
                  async maybeSingle() {
                    return { data: row || null, error: null };
                  },
                };
              },
            };
          },
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
      if (table === "organization_service_upsells") {
        return {
          select() {
            return buildQueryable(websiteUpsells);
          },
          update(updates) {
            const filters = [];
            return {
              eq(field, value) {
                filters.push({ field, value });
                return this;
              },
              select() {
                return {
                  async maybeSingle() {
                    const row = websiteUpsells.find((item) => filters.every((f) => item?.[f.field] === f.value));
                    if (row) {
                      Object.assign(row, updates, { updated_at: "2026-05-31T01:00:00.000Z" });
                    }
                    return { data: row || null, error: null };
                  },
                };
              },
            };
          },
          async upsert(payload) {
            const idx = websiteUpsells.findIndex(
              (row) => row.organization_id === payload.organization_id && row.service_key === payload.service_key
            );
            const merged = {
              interest_status: "not_asked",
              acceptance_status: "not_offered",
              completion_status: "not_started",
              website_status: "none",
              selected_package_code: null,
              package_snapshot: null,
              offered_at: null,
              accepted_at: null,
              completed_at: null,
              updated_by: null,
              metadata: {},
              created_at: "2026-05-31T01:00:00.000Z",
              updated_at: "2026-05-31T01:00:00.000Z",
              ...payload,
            };
            if (idx >= 0) {
              websiteUpsells[idx] = { ...websiteUpsells[idx], ...merged, updated_at: "2026-05-31T01:00:00.000Z" };
            } else {
              websiteUpsells.push(merged);
            }
            return { error: null };
          },
        };
      }
      if (table === "service_package_catalog") {
        return {
          select() {
            return buildQueryable(servicePackages);
          },
        };
      }
      if (table === "operator_lead_audit_logs") {
        return {
          async insert(payload) {
            auditLogs.push(payload);
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
  websiteUpsells = [];
  servicePackages = [
    {
      service_key: "website_services",
      package_code: "website_starter",
      package_name: "Website Starter",
      deliverables: ["Hosted booking landing page"],
      pricing_metadata: { currency: "USD", amount_cents: 14900 },
      billing_metadata: { payment_terms: "due_on_acceptance" },
      version: 1,
      is_active: true,
      metadata: {},
    },
    {
      service_key: "website_services",
      package_code: "website_growth",
      package_name: "Website Growth",
      deliverables: ["Custom multipage website"],
      pricing_metadata: { currency: "USD", amount_cents: 39900 },
      billing_metadata: { payment_terms: "50_50_milestone" },
      version: 1,
      is_active: true,
      metadata: {},
    },
  ];
  auditLogs = [];
  shouldFailWorkspaceProvision = false;
  currentClient = buildClient();
});

test("list returns operator leads", async () => {
  const res = makeRes();
  await handler(makeReq({ action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(Array.isArray(res._body.leads), true);
  assert.equal(res._body.leads.length, 1);
  assert.equal(res._body.leads[0].website_services.website_status, "none");
  assert.equal(res._body.websiteServicesKpis.total, 1);
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
  assert.equal(websiteUpsells.length, 1);
  assert.equal(websiteUpsells[0].service_key, "website_services");
  assert.equal(websiteUpsells[0].website_status, "none");
  assert.equal(
    organizationSettings[0].settings?.onboarding?.steps?.website_services?.status,
    "not_started"
  );
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
  assert.equal(websiteUpsells.length, 0);
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

test("website services completion is blocked before acceptance", async () => {
  await handler(makeReq({ action: "convert", id: "lead-1" }), makeRes());
  const res = makeRes();
  await handler(makeReq({ action: "website_services_completion", id: "lead-1", completionStatus: "completed" }), res);

  assert.equal(res._status, 409);
  assert.match(res._body.error, /before package acceptance/i);
});

test("website services acceptance stores immutable package snapshot", async () => {
  await handler(makeReq({ action: "convert", id: "lead-1" }), makeRes());
  await handler(makeReq({ action: "website_services_interest", id: "lead-1", interestStatus: "interested" }), makeRes());
  await handler(makeReq({ action: "website_services_offer", id: "lead-1", packageCode: "website_growth" }), makeRes());

  const acceptRes = makeRes();
  await handler(makeReq({ action: "website_services_accept", id: "lead-1", packageCode: "website_growth" }), acceptRes);

  assert.equal(acceptRes._status, 200);
  assert.equal(acceptRes._body.website_services.acceptance_status, "accepted");
  assert.equal(acceptRes._body.website_services.selected_package_code, "website_growth");
  assert.equal(acceptRes._body.website_services.package_snapshot.package_code, "website_growth");
  assert.equal(acceptRes._body.website_services.package_snapshot.package_name, "Website Growth");
});

test("website services get state returns onboarding + package catalog", async () => {
  await handler(makeReq({ action: "convert", id: "lead-1" }), makeRes());
  const res = makeRes();
  await handler(makeReq({ action: "website_services_get_state", id: "lead-1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.website_services.service_key, "website_services");
  assert.equal(Array.isArray(res._body.packages), true);
  assert.equal(res._body.packages.length, 2);
  assert.equal(res._body.onboarding.steps.website_services.status, "not_started");
});

test("website services completion succeeds after acceptance", async () => {
  await handler(makeReq({ action: "convert", id: "lead-1" }), makeRes());
  await handler(makeReq({ action: "website_services_interest", id: "lead-1", interestStatus: "interested" }), makeRes());
  await handler(makeReq({ action: "website_services_offer", id: "lead-1", packageCode: "website_starter" }), makeRes());
  await handler(makeReq({ action: "website_services_accept", id: "lead-1", packageCode: "website_starter" }), makeRes());

  const completionRes = makeRes();
  await handler(makeReq({ action: "website_services_completion", id: "lead-1", completionStatus: "completed" }), completionRes);

  assert.equal(completionRes._status, 200);
  assert.equal(completionRes._body.website_services.completion_status, "completed");
  assert.ok(completionRes._body.website_services.completed_at);
  assert.equal(completionRes._body.onboarding.steps.website_services.status, "completed");
});
