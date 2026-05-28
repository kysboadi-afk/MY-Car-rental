import { mock, test } from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "fleet@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";

const sentMails = [];
const insertCalls = [];
let currentSupabase = null;
let currentInsertResult = { data: { id: "lead-123", status: "new_lead" }, error: null };

const mockSendMail = mock.fn(async (opts) => {
  sentMails.push(opts);
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({ sendMail: mockSendMail }),
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => currentSupabase,
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
    send(text) { this._body = text; return this; },
  };
}

function makeReq(method, body = {}, origin = "https://slycarrentals.com") {
  return { method, headers: { origin }, body };
}

function validBody(overrides = {}) {
  return {
    companyName: "North Star Mobility",
    contactName: "Taylor Ops",
    workEmail: "ops@example.com",
    phone: "3105550150",
    fleetSize: "11-25 vehicles",
    activeVehicles: "14",
    currentTools: "Spreadsheets and Stripe",
    operationalPriority: "Overdue balances and collections",
    onboardingReadiness: "ready_now",
    integrationSetupStatus: "in_progress",
    stripeReadiness: "needs_setup",
    notes: "Need a walkthrough focused on collections and extension handling.",
    walkthroughRequested: true,
    honeypot: "",
    sourcePage: "fleet-control-onboarding",
    ...overrides,
  };
}

function resetSupabaseSuccess() {
  insertCalls.length = 0;
  sentMails.length = 0;
  currentInsertResult = { data: { id: "lead-123", status: "new_lead" }, error: null };
  currentSupabase = {
    from(table) {
      assert.equal(table, "operator_leads");
      return {
        insert(payload) {
          insertCalls.push(payload);
          return {
            select() {
              return {
                async single() {
                  return currentInsertResult;
                },
              };
            },
          };
        },
      };
    },
  };
}

test("OPTIONS preflight returns 200", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("OPTIONS"), res);
  assert.equal(res._status, 200);
});

test("non-POST returns 405", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("GET"), res);
  assert.equal(res._status, 405);
});

test("requires dedicated lead fields", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("POST", { contactName: "Taylor" }), res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /required/i);
});

test("rejects honeypot submissions", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("POST", validBody({ honeypot: "spam" })), res);
  assert.equal(res._status, 400);
  assert.equal(insertCalls.length, 0);
});

test("returns 500 when Supabase admin is unavailable", async () => {
  currentSupabase = null;
  sentMails.length = 0;
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);
  assert.equal(res._status, 500);
  assert.match(res._body.error, /onboarding/i);
});

test("stores operator lead in canonical backend table and emails owner", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.leadId, "lead-123");
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].contact_name, "Taylor Ops");
  assert.equal(insertCalls[0].company_name, "North Star Mobility");
  assert.equal(insertCalls[0].source_page, "fleet-control-onboarding");
  assert.equal(insertCalls[0].active_vehicles, 14);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, "owner@test.invalid");
});

test("validates work email format", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("POST", validBody({ workEmail: "bad-email" })), res);
  assert.equal(res._status, 400);
  assert.equal(insertCalls.length, 0);
});

test("returns 500 when insert fails", async () => {
  resetSupabaseSuccess();
  currentInsertResult = { data: null, error: { message: "db write failed" } };
  const res = makeRes();
  await handler(makeReq("POST", validBody()), res);
  assert.equal(res._status, 500);
  assert.match(res._body.error, /Unable to save/);
});

test("sets CORS header for allowed origin", async () => {
  resetSupabaseSuccess();
  const res = makeRes();
  await handler(makeReq("POST", validBody(), "https://admin.slycarrentals.com"), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://admin.slycarrentals.com");
});
