import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.OTP_SECRET = "test-secret-for-identity-resume-tokens";
process.env.VERIFF_API_KEY = "veriff_api_key_test";
process.env.VERIFF_SHARED_SECRET = "veriff_shared_secret_test";
process.env.VERIFF_PROJECT_ID = "veriff_project_id_test";
process.env.STRIPE_SECRET_KEY = "";
process.env.STRIPE_PUBLISHABLE_KEY = "";

const TEST_APP_ID = "8d3b1914-5f12-4f61-a0cb-b57f042080ab";

const calls = {
  patched: [],
  fetched: [],
  fetchRequests: [],
};

let fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "submitted" } };
let patchResult = { ok: true, data: { id: TEST_APP_ID } };
let createSessionPayload = { status: "success", verification: { id: "vrf_123", url: "https://veriff.test/session/vrf_123", status: "created" } };
let createSessionStatus = 200;
let decisionPayload = { status: "success", verification: { id: "vrf_existing", status: "submitted", url: "https://veriff.test/session/vrf_existing" } };
let decisionStatus = 404;

const fetchRenterApplicationById = mock.fn(async (applicationId) => {
  calls.fetched.push(applicationId);
  return fetchResult;
});

const patchRenterApplicationIdentityById = mock.fn(async (applicationId, patch) => {
  calls.patched.push({ applicationId, patch });
  return patchResult;
});

mock.module("./_renter-applications.js", {
  namedExports: {
    fetchRenterApplicationById,
    patchRenterApplicationIdentityById,
  },
});

global.fetch = mock.fn(async (url, init = {}) => {
  calls.fetchRequests.push({ url: String(url), method: init.method || "GET" });
  if ((init.method || "GET") === "GET") {
    return {
      ok: decisionStatus >= 200 && decisionStatus < 300,
      status: decisionStatus,
      async json() { return decisionPayload; },
    };
  }
  return {
    ok: createSessionStatus >= 200 && createSessionStatus < 300,
    status: createSessionStatus,
    async json() { return createSessionPayload; },
  };
});

const { createResumeToken } = await import("./_identity-resume-token.js");
const { default: handler } = await import("./resolve-identity-resume.js");

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeReq(token) {
  return {
    method: "GET",
    headers: { origin: "https://slycarrentals.com" },
    query: { token },
  };
}

beforeEach(() => {
  calls.patched.length = 0;
  calls.fetched.length = 0;
  calls.fetchRequests.length = 0;
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "submitted" } };
  patchResult = { ok: true, data: { id: TEST_APP_ID } };
  createSessionPayload = { status: "success", verification: { id: "vrf_123", url: "https://veriff.test/session/vrf_123", status: "created" } };
  createSessionStatus = 200;
  decisionPayload = { status: "success", verification: { id: "vrf_existing", status: "submitted", url: "https://veriff.test/session/vrf_existing" } };
  decisionStatus = 404;
});

test("resolve-identity-resume: 400 when token param is absent", async () => {
  const res = makeRes();
  await handler({ method: "GET", headers: {}, query: {} }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /token is required/i);
});

test("resolve-identity-resume: 401 when token is invalid", async () => {
  const res = makeRes();
  await handler(makeReq("definitely.not.valid"), res);
  assert.equal(res._status, 401);
});

test("resolve-identity-resume: blocks terminal application status", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "approved" } };
  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(calls.fetchRequests.length, 0);
});

test("resolve-identity-resume: returns alreadyVerified when app already verified", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "verified", application_status: "under_review" } };
  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.fetchRequests.length, 0);
});

test("resolve-identity-resume: reuses decision URL when resubmission is requested", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_existing",
    },
  };
  decisionStatus = 200;
  decisionPayload = {
    status: "success",
    verification: {
      id: "vrf_existing",
      status: "resubmission_requested",
      url: "https://veriff.test/session/vrf_existing",
    },
  };

  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.sessionReused, true);
  assert.equal(res._body.verificationUrl, "https://veriff.test/session/vrf_existing");
  assert.equal(calls.patched.length, 0);
});

test("resolve-identity-resume: syncs processing status and advances to under_review when submitted", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_processing",
    },
  };
  decisionStatus = 200;
  decisionPayload = { status: "success", verification: { id: "vrf_processing", status: "submitted" } };

  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.processing, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "processing");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
});

test("resolve-identity-resume: returns processing for submitted decision", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vrf_processing",
    },
  };
  decisionStatus = 200;
  decisionPayload = { status: "success", verification: { id: "vrf_processing", status: "submitted" } };

  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.processing, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "processing");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
});

test("resolve-identity-resume: syncs verified decision from webhook lag", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vrf_done",
    },
  };
  decisionStatus = 200;
  decisionPayload = { status: "success", verification: { id: "vrf_done", status: "approved" } };

  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
});

test("resolve-identity-resume: returns processing when decision lookup is unavailable for existing session", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vrf_existing",
    },
  };
  decisionStatus = 404;
  decisionPayload = { message: "Not found" };

  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.processing, true);
  assert.equal(res._body.decisionUnavailable, true);
  assert.equal(calls.patched.length, 0);
  assert.equal(calls.fetchRequests.length, 1);
  assert.equal(calls.fetchRequests[0].method, "GET");
});

test("resolve-identity-resume: creates fresh session when decision is canceled", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "canceled",
      application_status: "submitted",
      identity_session_id: "vrf_canceled",
    },
  };
  decisionStatus = 200;
  decisionPayload = { status: "success", verification: { id: "vrf_canceled", status: "canceled" } };

  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.verificationSessionId, "vrf_123");
  assert.equal(res._body.verificationUrl, "https://veriff.test/session/vrf_123");
});

test("resolve-identity-resume: returns 500 when patch fails after session creation", async () => {
  patchResult = { ok: false, status: 500, error: "DB write failed." };
  const res = makeRes();
  await handler(makeReq(createResumeToken(TEST_APP_ID)), res);
  assert.equal(res._status, 500);
  assert.match(res._body.error, /DB write failed/i);
});
