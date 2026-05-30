import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let currentClient = null;
const insertCalls = [];

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentClient,
  },
});

const { default: handler } = await import("./operator-leads.js");

function makeRes() {
  return {
    _headers: {},
    _status: 200,
    _body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    end() { return this; },
    json(obj) { this._body = obj; return this; },
    send(obj) { this._body = obj; return this; },
  };
}

function makeReq(method, body = {}, origin = "https://sly-rides-staging.vercel.app") {
  return {
    method,
    headers: {
      origin,
      "user-agent": "FleetControlTest/1.0",
    },
    body,
  };
}

function validBody(overrides = {}) {
  return {
    name: "Jordan Fleet",
    email: "Jordan@example.com",
    phone: "3105550101",
    fleetSize: "4-10 vehicles",
    priority: "Booking and renter workflow control",
    message: "Need a walkthrough for our Uber rental operation.",
    honeypot: "",
    source: "fleet_control_early_access",
    ...overrides,
  };
}

beforeEach(() => {
  insertCalls.length = 0;
  currentClient = {
    from(table) {
      return {
        insert(payload) {
          insertCalls.push({ table, payload });
          return {
            select() {
              return {
                single: async () => ({
                  data: {
                    id: "lead-123",
                    status: "new_lead",
                    created_at: "2026-05-30T08:30:00.000Z",
                  },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };
});

test("OPTIONS returns 200", async () => {
  const res = makeRes();
  await handler(makeReq("OPTIONS"), res);
  assert.equal(res._status, 200);
});

test("sets CORS header for vercel staging origin", async () => {
  const res = makeRes();
  await handler(makeReq("POST", validBody(), "https://sly-rides-staging.vercel.app"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://sly-rides-staging.vercel.app");
});

test("returns 405 for non-POST requests", async () => {
  const res = makeRes();
  await handler(makeReq("GET"), res);
  assert.equal(res._status, 405);
});

test("returns 400 when required fields are missing", async () => {
  const res = makeRes();
  await handler(makeReq("POST", validBody({ priority: "" })), res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /Missing required fields/);
});

test("returns 503 when Supabase is unavailable", async () => {
  currentClient = null;
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);
  assert.equal(res._status, 503);
  assert.match(res._body.error, /Supabase is not configured/);
});

test("logs Supabase env presence booleans without secrets", async (t) => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalAppEnv = process.env.APP_ENV;
  process.env.SUPABASE_URL = "https://db.example.supabase.co";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.APP_ENV = "preview";

  t.after(() => {
    if (typeof originalUrl === "undefined") delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (typeof originalKey === "undefined") delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    if (typeof originalAppEnv === "undefined") delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  const infoSpy = mock.method(console, "info", () => {});
  t.after(() => infoSpy.mock.restore());

  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(infoSpy.mock.callCount(), 1);
  assert.deepEqual(infoSpy.mock.calls[0].arguments, [
    "operator-leads Supabase env presence",
    {
      supabaseUrlPresent: true,
      supabaseServiceRoleKeyPresent: false,
      appEnv: "preview",
    },
  ]);
});

test("stores operator lead in Supabase and returns success metadata", async () => {
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.leadId, "lead-123");
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].table, "operator_leads");
  assert.equal(insertCalls[0].payload.name, "Jordan Fleet");
  assert.equal(insertCalls[0].payload.email, "jordan@example.com");
  assert.equal(insertCalls[0].payload.fleet_size, 4);
  assert.equal(insertCalls[0].payload.source, "fleet_control_early_access");
  assert.equal(insertCalls[0].payload.metadata.fleet_size_label, "4-10 vehicles");
  assert.equal(insertCalls[0].payload.metadata.priority, "Booking and renter workflow control");
  assert.equal(insertCalls[0].payload.metadata.message, "Need a walkthrough for our Uber rental operation.");
});
