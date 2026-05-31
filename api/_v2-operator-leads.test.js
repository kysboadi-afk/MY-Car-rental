import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let currentClient = null;
let rows = [];
let lastUpdate = null;

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentClient,
  },
});

mock.module("./_middleware.js", {
  namedExports: {
    withAdminAuth: (handler) => handler,
    sendError: (res, status, message) => res.status(status).json({ error: message }),
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
  return { method: "POST", headers: {}, body };
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
      created_at: "2026-05-31T00:00:00.000Z",
      updated_at: "2026-05-31T00:00:00.000Z",
    },
  ];
  lastUpdate = null;
  currentClient = {
    from() {
      return {
        select() {
          return {
            order() {
              return {
                limit: async () => ({ data: rows, error: null }),
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
                    maybeSingle: async () => ({ data: row ? { id: row.id, status: row.status, notes: row.notes, updated_at: row.updated_at } : null, error: null }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
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
  await handler(makeReq({ action: "update", id: "lead-1", status: "Qualified", notes: "Followed up" }), res);
  assert.equal(res._status, 200);
  assert.equal(lastUpdate.status, "onboarding");
  assert.equal(lastUpdate.notes, "Followed up");
  assert.equal(res._body.lead.status, "onboarding");
});

test("update rejects invalid statuses", async () => {
  const res = makeRes();
  await handler(makeReq({ action: "update", id: "lead-1", status: "Invalid Status" }), res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /Invalid lead status/);
});
