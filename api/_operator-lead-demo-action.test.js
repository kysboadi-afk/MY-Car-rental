import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createOperatorDemoActionToken } from "./_operator-demo-token.js";

let demoEvents = [];
let auditLogs = [];
let currentClient = null;

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentClient,
  },
});

const { default: handler } = await import("./operator-lead-demo-action.js");

function makeRes() {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

function makeReq({ action, token }) {
  return {
    method: "GET",
    query: { action, token },
    body: {},
    headers: {},
  };
}

function buildClient() {
  return {
    from(table) {
      if (table === "operator_lead_demo_events") {
        return {
          select() {
            const filters = [];
            return {
              eq(field, value) { filters.push({ field, value }); return this; },
              async maybeSingle() {
                const row = demoEvents.find((item) => filters.every((f) => item?.[f.field] === f.value));
                return { data: row || null, error: null };
              },
            };
          },
          update(updates) {
            const filters = [];
            return {
              eq(field, value) {
                filters.push({ field, value });
                const row = demoEvents.find((item) => filters.every((f) => item?.[f.field] === f.value));
                if (row) Object.assign(row, updates);
                return this;
              },
            };
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
  demoEvents = [{
    id: "demo-1",
    lead_id: "lead-1",
    lifecycle_status: "scheduled",
    metadata: {},
  }];
  auditLogs = [];
  currentClient = buildClient();
});

test("confirm action writes metadata and audit event", async () => {
  const token = createOperatorDemoActionToken({ action: "confirm", demoId: "demo-1", leadId: "lead-1" }, 60_000);
  const res = makeRes();
  await handler(makeReq({ action: "confirm", token }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(demoEvents[0].metadata?.link_actions?.confirmed_at);
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].event, "demo_confirmation_link_clicked");
});

test("cancel action changes lifecycle status", async () => {
  const token = createOperatorDemoActionToken({ action: "cancel", demoId: "demo-1", leadId: "lead-1" }, 60_000);
  const res = makeRes();
  await handler(makeReq({ action: "cancel", token }), res);

  assert.equal(res._status, 200);
  assert.equal(demoEvents[0].lifecycle_status, "cancelled");
  assert.ok(demoEvents[0].cancelled_at);
});
