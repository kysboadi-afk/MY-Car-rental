import { test, mock } from "node:test";
import assert from "node:assert/strict";

const insertRenterApplication = mock.fn();
const fetchRenterApplicationById = mock.fn();

mock.module("./_renter-applications.js", {
  namedExports: {
    insertRenterApplication,
    fetchRenterApplicationById,
    toClientApplication: (record) => ({
      applicationId: record.id,
      name: record.name,
      phone: record.phone,
      email: record.email,
      hasInsurance: record.has_insurance || null,
      protectionPlanPref: record.protection_plan_pref || null,
      decision: record.precheck_decision || "review",
      applicationStatus: record.application_status || "submitted",
      identityStatus: record.identity_status || "not_started",
      createdAt: record.created_at || null,
      updatedAt: record.updated_at || null,
      submittedAt: record.submitted_at || null,
    }),
  },
});

const { default: createHandler } = await import("./create-renter-application.js");
const { default: getHandler } = await import("./get-renter-application.js");

function makeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

test("create-renter-application creates and returns applicationId", async () => {
  insertRenterApplication.mock.mockImplementation(async () => ({
    ok: true,
    data: {
      id: "8d3b1914-5f12-4f61-a0cb-b57f042080ab",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      precheck_decision: "review",
      application_status: "submitted",
      identity_status: "not_started",
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
      submitted_at: "2026-05-12T00:00:00.000Z",
    },
  }));

  const res = makeRes();
  await createHandler({ method: "POST", headers: { origin: "https://www.slytrans.com" }, body: { name: "Jane Driver", phone: "3105550199", experience: "3-5 years" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.applicationId, "8d3b1914-5f12-4f61-a0cb-b57f042080ab");
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("create-renter-application returns helper error status", async () => {
  insertRenterApplication.mock.mockImplementation(async () => ({ ok: false, status: 400, error: "Missing required fields: name, phone, experience." }));

  const res = makeRes();
  await createHandler({ method: "POST", headers: { origin: "https://www.slytrans.com" }, body: {} }, res);

  assert.equal(res._status, 400);
  assert.equal(res._body.error, "Missing required fields: name, phone, experience.");
});

test("get-renter-application returns 400 without applicationId", async () => {
  const res = makeRes();
  await getHandler({ method: "GET", headers: { origin: "https://www.slytrans.com" }, query: {} }, res);
  assert.equal(res._status, 400);
});

test("get-renter-application returns application payload", async () => {
  fetchRenterApplicationById.mock.mockImplementation(async () => ({
    ok: true,
    data: {
      id: "8d3b1914-5f12-4f61-a0cb-b57f042080ab",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      precheck_decision: "approved",
      application_status: "under_review",
      identity_status: "not_started",
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
      submitted_at: "2026-05-12T00:00:00.000Z",
    },
  }));

  const res = makeRes();
  await getHandler({ method: "GET", headers: { origin: "https://www.slytrans.com" }, query: { applicationId: "8d3b1914-5f12-4f61-a0cb-b57f042080ab" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.applicationId, "8d3b1914-5f12-4f61-a0cb-b57f042080ab");
  assert.equal(res._body.applicationStatus, "under_review");
});

test("get-renter-application returns not found", async () => {
  fetchRenterApplicationById.mock.mockImplementation(async () => ({ ok: false, status: 404, error: "Application not found." }));

  const res = makeRes();
  await getHandler({ method: "GET", headers: { origin: "https://www.slytrans.com" }, query: { applicationId: "missing" } }, res);

  assert.equal(res._status, 404);
  assert.equal(res._body.error, "Application not found.");
});
