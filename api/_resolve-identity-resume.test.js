// api/_resolve-identity-resume.test.js
// Unit tests for the resolve-identity-resume endpoint.
//
// Run with: npm test

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.OTP_SECRET = "test-secret-for-identity-resume-tokens";
process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";

const TEST_APP_ID = "8d3b1914-5f12-4f61-a0cb-b57f042080ab";

// ─── Shared mutable state ─────────────────────────────────────────────────────

const calls = {
  createdSessions:   [],
  retrievedSessions: [],
  patched:           [],
  fetched:           [],
};

let fetchResult     = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "submitted" } };
let patchResult     = { ok: true, data: { id: TEST_APP_ID } };
let stripeSession   = { id: "vs_123", client_secret: "vcs_123" };
let stripeRetrieve  = null; // null = throw (session not found / deleted)

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

class StripeMock {
  constructor() {
    this.identity = {
      verificationSessions: {
        create: async (args) => {
          calls.createdSessions.push(args);
          return stripeSession;
        },
        retrieve: async (id) => {
          calls.retrievedSessions.push(id);
          if (!stripeRetrieve) throw new Error(`No session found: ${id}`);
          return stripeRetrieve;
        },
      },
    };
  }
}

mock.module("stripe", { defaultExport: StripeMock });

// ─── Token helper ─────────────────────────────────────────────────────────────

const { createResumeToken } = await import("./_identity-resume-token.js");
const { default: handler }  = await import("./resolve-identity-resume.js");

function makeRes() {
  return {
    _status: 200,
    _body:   null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code)    { this._status = code; return this; },
    json(body)      { this._body   = body; return this; },
    send(body)      { this._body   = body; return this; },
    end()           { return this; },
  };
}

function makeReq(token) {
  return {
    method:  "GET",
    headers: { origin: "https://www.slytrans.com" },
    query:   { token },
  };
}

beforeEach(() => {
  calls.createdSessions.length   = 0;
  calls.retrievedSessions.length = 0;
  calls.patched.length           = 0;
  calls.fetched.length           = 0;
  fetchResult   = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "submitted" } };
  patchResult   = { ok: true, data: { id: TEST_APP_ID } };
  stripeSession = { id: "vs_123", client_secret: "vcs_123" };
  stripeRetrieve = null;
});

// ─── Token validation ─────────────────────────────────────────────────────────

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
  assert.match(res._body.error, /invalid or expired/i);
});

test("resolve-identity-resume: 401 when token is expired", async () => {
  const expired = createResumeToken(TEST_APP_ID, -1);
  const res = makeRes();
  await handler(makeReq(expired), res);
  assert.equal(res._status, 401);
  assert.match(res._body.error, /invalid or expired/i);
});

test("resolve-identity-resume: 405 for non-GET methods", async () => {
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler({ method: "POST", headers: {}, query: { token } }, res);
  assert.equal(res._status, 405);
});

test("resolve-identity-resume: 200 OPTIONS preflight", async () => {
  const res = makeRes();
  await handler({ method: "OPTIONS", headers: {}, query: {} }, res);
  assert.equal(res._status, 200);
});

// ─── Lifecycle guards ─────────────────────────────────────────────────────────

test("resolve-identity-resume: blocked for approved application", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "approved" } };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(res._body.applicationStatus, "approved");
  assert.equal(calls.createdSessions.length, 0);
});

test("resolve-identity-resume: blocked for rejected application", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "rejected" } };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(res._body.applicationStatus, "rejected");
});

test("resolve-identity-resume: blocked for expired application", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "expired" } };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
});

test("resolve-identity-resume: blocked for withdrawn application", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "not_started", application_status: "withdrawn" } };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
});

test("resolve-identity-resume: alreadyVerified when identity_status is verified", async () => {
  fetchResult = { ok: true, data: { id: TEST_APP_ID, identity_status: "verified", application_status: "under_review" } };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(res._body.identityStatus, "verified");
  assert.equal(calls.createdSessions.length, 0);
});

// ─── Session reuse ────────────────────────────────────────────────────────────

test("resolve-identity-resume: reuses existing requires_input session", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_existing",
    },
  };
  stripeRetrieve = { id: "vs_existing", client_secret: "vcs_existing", status: "requires_input" };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.sessionReused, true);
  assert.equal(res._body.verificationSessionId, "vs_existing");
  assert.equal(res._body.clientSecret, "vcs_existing");
  assert.equal(res._body.publishableKey, "pk_test_123");
  assert.equal(calls.createdSessions.length, 0, "should not create new session");
  assert.equal(calls.patched.length, 0, "should not patch when reusing");
});

test("resolve-identity-resume: returns processing when existing session is processing", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vs_proc",
    },
  };
  stripeRetrieve = { id: "vs_proc", client_secret: "vcs_proc", status: "processing" };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.processing, true);
  assert.equal(res._body.identityStatus, "processing");
  assert.equal(calls.createdSessions.length, 0);
});

test("resolve-identity-resume: returns alreadyVerified when Stripe session is verified (webhook lag)", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vs_done",
    },
  };
  stripeRetrieve = { id: "vs_done", client_secret: "vcs_done", status: "verified" };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.createdSessions.length, 0);
});

test("resolve-identity-resume: creates fresh session when existing session is canceled", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "canceled",
      application_status: "submitted",
      identity_session_id: "vs_canceled",
    },
  };
  stripeRetrieve = { id: "vs_canceled", client_secret: "vcs_canceled", status: "canceled" };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.verificationSessionId, "vs_123");
  assert.equal(res._body.clientSecret, "vcs_123");
  assert.equal(calls.createdSessions.length, 1, "should create new session after canceled");
});

test("resolve-identity-resume: creates fresh session when no prior session exists", async () => {
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.verificationSessionId, "vs_123");
  assert.equal(res._body.clientSecret, "vcs_123");
  assert.equal(res._body.publishableKey, "pk_test_123");
  assert.equal(calls.createdSessions.length, 1);
  assert.equal(calls.createdSessions[0].metadata.application_id, TEST_APP_ID);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identitySessionId, "vs_123");
  assert.equal(calls.patched[0].patch.identityStatus, "requires_input");
});

test("resolve-identity-resume: creates fresh session when session retrieve throws (session deleted)", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: TEST_APP_ID,
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_gone",
    },
  };
  // stripeRetrieve stays null so retrieve() throws
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.createdSessions.length, 1, "should create fresh session after retrieve error");
});

// ─── Application lookup failure ───────────────────────────────────────────────

test("resolve-identity-resume: 404 when application is not found", async () => {
  fetchResult = { ok: false, status: 404, error: "Application not found." };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 404);
  assert.match(res._body.error, /not found/i);
});

// ─── Patch failure ────────────────────────────────────────────────────────────

test("resolve-identity-resume: 500 when application patch fails after session creation", async () => {
  patchResult = { ok: false, status: 500, error: "DB write failed." };
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  assert.equal(res._status, 500);
  assert.match(res._body.error, /DB write failed/i);
});

// ─── CORS ─────────────────────────────────────────────────────────────────────

test("resolve-identity-resume: sets CORS header for allowed origin", async () => {
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("resolve-identity-resume: does not set CORS header for disallowed origin", async () => {
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler({ method: "GET", headers: { origin: "https://evil.example.com" }, query: { token } }, res);
  assert.ok(!res._headers["Access-Control-Allow-Origin"]);
});

// ─── Session creation metadata ────────────────────────────────────────────────

test("resolve-identity-resume: new session return_url includes applicationId", async () => {
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  const returnUrl = calls.createdSessions[0]?.return_url || "";
  assert.ok(returnUrl.includes("applicationId=" + TEST_APP_ID), `return_url missing applicationId: ${returnUrl}`);
});

test("resolve-identity-resume: new session return_url includes from=apply", async () => {
  const token = createResumeToken(TEST_APP_ID);
  const res = makeRes();
  await handler(makeReq(token), res);

  const returnUrl = calls.createdSessions[0]?.return_url || "";
  assert.ok(returnUrl.includes("from=apply"), `return_url should use from=apply: ${returnUrl}`);
});
