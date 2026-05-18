import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import crypto from "node:crypto";

process.env.OTP_SECRET = "otp-secret-test";
process.env.VERIFF_API_KEY = "veriff_api_test";
process.env.VERIFF_SHARED_SECRET = "veriff_shared_secret_test";
process.env.VERIFF_PROJECT_ID = "veriff_project_test";
process.env.ADMIN_SECRET = "test-admin-secret";
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY = "test-api-key-00000000000000000000000";

const calls = {
  patched: [],
  fetched: [],
  fetchedBySession: [],
  listedReviewQueue: [],
  listedRecoveryCandidates: [],
  fetchedReviewDetail: [],
  eventInserts: [],
  sentMails: [],
  sentMessages: [],
  veriffFetches: [],
  checkrInitiations: [],
};

let fetchResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "submitted" } };
let fetchBySessionResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "submitted" } };
let patchResult = { ok: true, data: { id: "app_1" } };
let duplicateEvent = false;
let insertEventError = null;
let reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };
let recoveryCandidatesResult = { ok: true, data: [] };
let reviewDetailResult = { ok: true, data: null, history: [] };
let veriffDecisionStatus = 404;
let veriffDecisionPayload = { status: "success", verification: { id: "vrf_existing", status: "submitted" } };
let veriffCreateStatus = 200;
let veriffCreatePayload = { status: "success", verification: { id: "vrf_123", status: "created", url: "https://veriff.test/session/vrf_123" } };
let veriffCreateFailureOnce = null;

const fetchRenterApplicationById = mock.fn(async (applicationId) => {
  calls.fetched.push(applicationId);
  return fetchResult;
});

const fetchRenterApplicationByIdentitySessionId = mock.fn(async (identitySessionId) => {
  calls.fetchedBySession.push(identitySessionId);
  return fetchBySessionResult;
});

const patchRenterApplicationIdentityById = mock.fn(async (applicationId, patch) => {
  calls.patched.push({ applicationId, patch });
  return patchResult;
});

const listReviewQueueApplications = mock.fn(async (...args) => {
  calls.listedReviewQueue.push(args);
  return reviewQueueResult;
});

const listPendingIdentityRecoveryApplications = mock.fn(async (...args) => {
  calls.listedRecoveryCandidates.push(args);
  return recoveryCandidatesResult;
});

const fetchReviewApplicationById = mock.fn(async (...args) => {
  calls.fetchedReviewDetail.push(args);
  return reviewDetailResult;
});

mock.module("./_renter-applications.js", {
  namedExports: {
    fetchRenterApplicationById,
    fetchRenterApplicationByIdentitySessionId,
    patchRenterApplicationIdentityById,
    listReviewQueueApplications,
    listPendingIdentityRecoveryApplications,
    fetchReviewApplicationById,
  },
});

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (opts) => { calls.sentMails.push(opts); },
    }),
  },
});

mock.module("./_sms-dispatcher.js", {
  namedExports: {
    dispatchSms: async ({ phone, body }) => {
      calls.sentMessages.push({ phone, body });
      return { sent: true };
    },
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from(table) {
        if (table !== "stripe_identity_webhook_events") {
          throw new Error(`Unexpected table ${table}`);
        }
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => (duplicateEvent
                    ? { data: { id: 1 }, error: null }
                    : { data: null, error: null }),
                };
              },
            };
          },
          insert: async (payload) => {
            calls.eventInserts.push(payload);
            return { error: insertEventError };
          },
        };
      },
    }),
  },
});

mock.module("./_checkr.js", {
  namedExports: {
    initiateCheckrScreening: mock.fn(async (...args) => {
      calls.checkrInitiations.push(args);
      return { ok: true, candidateId: "candidate_123", reportStatus: "pending" };
    }),
  },
});

global.fetch = mock.fn(async (url, init = {}) => {
  const method = init.method || "GET";
  let body = null;
  if (typeof init.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  calls.veriffFetches.push({ url: String(url), method, body });
  if (method === "GET") {
    return {
      ok: veriffDecisionStatus >= 200 && veriffDecisionStatus < 300,
      status: veriffDecisionStatus,
      async json() { return veriffDecisionPayload; },
    };
  }
  if (veriffCreateFailureOnce) {
    const failure = veriffCreateFailureOnce;
    veriffCreateFailureOnce = null;
    return {
      ok: false,
      status: failure.status || 400,
      async json() { return failure.payload || { message: "Request includes invalid parameters" }; },
    };
  }
  return {
    ok: veriffCreateStatus >= 200 && veriffCreateStatus < 300,
    status: veriffCreateStatus,
    async json() { return veriffCreatePayload; },
  };
});

const { default: createIdentitySessionHandler } = await import("./create-identity-verification-session.js");
const { default: identityWebhookHandler } = await import("./stripe-identity-webhook.js");
const { default: adminReviewQueueHandler } = await import("./admin-review-queue.js");
const { default: adminReviewDetailHandler } = await import("./admin-review-detail.js");

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

function makeIdentityCreateReq(body = {}) {
  return {
    method: "POST",
    headers: { origin: "https://www.slytrans.com" },
    body,
  };
}

function signPayload(payload) {
  return crypto.createHmac("sha256", process.env.VERIFF_SHARED_SECRET).update(payload).digest("hex");
}

function makeWebhookReq(payloadObj, { validSignature = true } = {}) {
  const body = Buffer.from(JSON.stringify(payloadObj || {}));
  const req = Readable.from([body]);
  req.method = "POST";
  req.headers = {
    "x-hmac-signature": validSignature ? signPayload(body) : "invalid_signature",
  };
  return req;
}

function makeAdminGetReq(query = {}) {
  return {
    method: "GET",
    headers: { origin: "https://www.slytrans.com" },
    query,
  };
}

beforeEach(() => {
  calls.patched.length = 0;
  calls.fetched.length = 0;
  calls.fetchedBySession.length = 0;
  calls.listedReviewQueue.length = 0;
  calls.listedRecoveryCandidates.length = 0;
  calls.fetchedReviewDetail.length = 0;
  calls.eventInserts.length = 0;
  calls.sentMails.length = 0;
  calls.sentMessages.length = 0;
  calls.veriffFetches.length = 0;
  calls.checkrInitiations.length = 0;
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "not_started",
      application_status: "submitted",
    },
  };
  fetchBySessionResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "not_started",
      application_status: "submitted",
      identity_session_id: "vrf_123",
    },
  };
  patchResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "verified",
      application_status: "under_review",
    },
  };
  duplicateEvent = false;
  insertEventError = null;
  reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };
  recoveryCandidatesResult = { ok: true, data: [] };
  reviewDetailResult = { ok: true, data: null, history: [] };
  veriffDecisionStatus = 404;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_existing", status: "submitted" } };
  veriffCreateStatus = 200;
  veriffCreatePayload = { status: "success", verification: { id: "vrf_123", status: "created", url: "https://veriff.test/session/vrf_123" } };
  veriffCreateFailureOnce = null;
});

test("create-identity-verification-session creates a Veriff session and persists linkage", async () => {
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.verificationSessionId, "vrf_123");
  assert.equal(res._body.verificationUrl, "https://veriff.test/session/vrf_123");
  assert.equal(calls.patched[0].patch.identitySessionId, "vrf_123");
  assert.equal(calls.patched[0].patch.identityStatus, "requires_input");
  const createCall = calls.veriffFetches.find((entry) => entry.method === "POST");
  assert.ok(createCall);
  assert.equal(createCall.body?.verification?.vendorData, "app_1");
  assert.equal(createCall.body?.verification?.person?.firstName, "Jane");
  assert.equal(createCall.body?.verification?.person?.lastName, "Driver");
  assert.equal(createCall.body?.verification?.callback, "https://sly-rides.vercel.app/api/veriff-webhook");
  assert.equal("document" in (createCall.body?.verification || {}), false);
});

test("create-identity-verification-session returns alreadyVerified when identity is complete", async () => {
  fetchResult = { ok: true, data: { id: "app_1", identity_status: "verified", application_status: "under_review" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.veriffFetches.length, 0);
});

test("create-identity-verification-session retries with minimal payload on invalid parameters", async () => {
  veriffCreateFailureOnce = { status: 400, payload: { message: "Request includes invalid parameters" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  const createCalls = calls.veriffFetches.filter((entry) => entry.method === "POST");
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[0].body?.verification?.person?.firstName, "Jane");
  assert.equal("person" in (createCalls[1].body?.verification || {}), false);
  assert.equal("document" in (createCalls[1].body?.verification || {}), false);
  assert.equal("url" in (createCalls[1].body?.verification || {}), false);
});

test("create-identity-verification-session returns processing when existing decision lookup is unavailable", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vrf_existing",
    },
  };
  veriffDecisionStatus = 404;
  veriffDecisionPayload = { message: "Not found" };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.processing, true);
  assert.equal(res._body.decisionUnavailable, true);
  assert.equal(calls.patched.length, 0);
  const methods = calls.veriffFetches.map((entry) => entry.method);
  assert.deepEqual(methods, ["GET"]);
});

test("stripe-identity-webhook maps approved Veriff decision to verified", async () => {
  const payload = {
    id: "evt_veriff_approved_1",
    verification: {
      id: "vrf_123",
      status: "approved",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.received, true);
  assert.equal(calls.eventInserts.length, 1);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
  assert.equal(calls.sentMails.length, 2);
  assert.equal(calls.sentMessages.length, 1);
  assert.equal(calls.checkrInitiations.length, 1);
});

test("stripe-identity-webhook maps approved Veriff decision with status:success envelope to verified", async () => {
  // Real Veriff decision webhooks wrap the payload with status:"success" at the
  // top level.  Ensure the envelope field does not shadow verification.status.
  const payload = {
    status: "success",
    verification: {
      id: "vrf_envelope_1",
      status: "approved",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.received, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
  assert.equal(calls.checkrInitiations.length, 1);
});

test("stripe-identity-webhook maps verification.completed decision payload to verified", async () => {
  const payload = {
    id: "evt_veriff_completed_1",
    eventType: "verification.completed",
    verification: {
      id: "vrf_123",
      vendorData: "app_1",
    },
    decision: {
      status: "approved",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.patched[0].applicationId, "app_1");
});

test("stripe-identity-webhook maps approved by session lookup when vendorData is absent", async () => {
  fetchResult = { ok: false, status: 404, error: "Application not found." };
  fetchBySessionResult = {
    ok: true,
    data: {
      id: "app_session_match",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_session_lookup",
    },
  };
  const payload = {
    id: "evt_veriff_session_lookup_1",
    verification: {
      id: "vrf_session_lookup",
      status: "approved",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.fetchedBySession.length, 1);
  assert.equal(calls.fetchedBySession[0], "vrf_session_lookup");
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].applicationId, "app_session_match");
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
});

test("stripe-identity-webhook advances processing identity to under_review", async () => {
  const payload = {
    id: "evt_veriff_processing_1",
    verification: {
      id: "vrf_123",
      status: "submitted",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.received, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "processing");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
  assert.equal(calls.checkrInitiations.length, 0);
  assert.equal(calls.sentMails.length, 0);
});

test("create-identity-verification-session syncs processing status and advances to under_review", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_existing",
    },
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_existing", status: "submitted" } };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.processing, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "processing");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
  const methods = calls.veriffFetches.map((e) => e.method);
  assert.deepEqual(methods, ["GET"]);
});

test("stripe-identity-webhook redirects browser GET requests to identity return page", async () => {
  const res = makeRes();
  await identityWebhookHandler({ method: "GET", query: { applicationId: "app_1" } }, res);

  assert.equal(res._status, 302);
  assert.equal(
    res._headers.Location,
    "https://www.slytrans.com/thank-you.html?from=apply&identity=return&applicationId=app_1"
  );
});

test("stripe-identity-webhook maps resubmission_requested to requires_input", async () => {
  patchResult = {
    ok: true,
    data: {
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
    },
  };
  const payload = {
    id: "evt_veriff_resubmit_1",
    verification: {
      id: "vrf_123",
      status: "resubmission_requested",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.patched[0].patch.identityStatus, "requires_input");
  assert.equal(calls.sentMails.length, 1);
  assert.equal(calls.sentMessages.length, 1);
});

test("stripe-identity-webhook returns duplicate without patching when event is already processed", async () => {
  duplicateEvent = true;
  const payload = {
    id: "evt_veriff_duplicate_1",
    verification: {
      id: "vrf_999",
      status: "submitted",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.duplicate, true);
  assert.equal(calls.patched.length, 0);
});

test("stripe-identity-webhook continues processing when event logging insert fails", async () => {
  insertEventError = { message: "relation stripe_identity_webhook_events does not exist", code: "42P01" };
  const payload = {
    id: "evt_veriff_log_fail_1",
    verification: {
      id: "vrf_777",
      status: "approved",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.received, true);
  assert.equal(res._body.eventLogSkipped, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
});

test("stripe-identity-webhook returns 400 when signature verification fails", async () => {
  const payload = {
    id: "evt_veriff_bad_sig_1",
    verification: { id: "vrf_123", status: "approved", vendorData: "app_1" },
  };
  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload, { validSignature: false }), res);
  assert.equal(res._status, 400);
});

test("admin-review-queue recovers approved Veriff applications before loading queue", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_recover_1",
    }],
  };
  reviewQueueResult = {
    ok: true,
    data: [{
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      age: 28,
      experience: "3 years",
      application_status: "under_review",
      identity_status: "verified",
      review_version: 0,
      reviewed_by: "admin_review_queue_sync",
      reviewed_at: "2026-05-14T03:00:00.000Z",
      submitted_at: "2026-05-14T02:00:00.000Z",
      updated_at: "2026-05-14T03:00:00.000Z",
    }],
    total: 1,
    page: 1,
    pageSize: 50,
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_recover_1", status: "approved" } };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret", page: 1, pageSize: 50 }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-queue recovers processing Veriff applications before loading queue", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_recover_processing_1",
    }],
  };
  reviewQueueResult = {
    ok: true,
    data: [{
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      age: 28,
      experience: "3 years",
      application_status: "under_review",
      identity_status: "processing",
      review_version: 0,
      reviewed_by: "admin_review_queue_sync",
      reviewed_at: "2026-05-14T03:00:00.000Z",
      submitted_at: "2026-05-14T02:00:00.000Z",
      updated_at: "2026-05-14T03:00:00.000Z",
    }],
    total: 1,
    page: 1,
    pageSize: 50,
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_recover_processing_1", status: "submitted" } };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret", page: 1, pageSize: 50 }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.patched[0].patch.identityStatus, "processing");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-queue skips Stripe identity session ids during Veriff recovery", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_1TWOMNPo7fICjrtZ2ybppeVC",
    }],
  };
  reviewQueueResult = {
    ok: true,
    data: [{
      id: "app_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      age: 28,
      experience: "3 years",
      application_status: "submitted",
      identity_status: "requires_input",
      review_version: 0,
      reviewed_by: null,
      reviewed_at: null,
      submitted_at: "2026-05-14T02:00:00.000Z",
      updated_at: "2026-05-14T02:00:00.000Z",
    }],
    total: 1,
    page: 1,
    pageSize: 50,
  };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret", page: 1, pageSize: 50 }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.patched.length, 0);
  assert.equal(calls.veriffFetches.length, 0);
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-detail recovers approved Veriff application before returning detail", async () => {
  const submittedDetail = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Jane Driver",
    phone: "3105550199",
    email: "jane@example.com",
    application_status: "submitted",
    identity_status: "requires_input",
    identity_session_id: "vrf_detail_sync",
    review_version: 0,
  };
  const syncedDetail = {
    ...submittedDetail,
    application_status: "under_review",
    identity_status: "verified",
    identity_verified_at: "2026-05-14T03:00:00.000Z",
    reviewed_by: "admin_review_detail_sync",
    reviewed_at: "2026-05-14T03:00:00.000Z",
  };

  let detailFetchCount = 0;
  fetchReviewApplicationById.mock.mockImplementation(async (...args) => {
    calls.fetchedReviewDetail.push(args);
    detailFetchCount += 1;
    return detailFetchCount === 1
      ? { ok: true, data: submittedDetail, history: [] }
      : { ok: true, data: syncedDetail, history: [] };
  });
  patchResult = { ok: true, data: syncedDetail };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_detail_sync", status: "approved" } };

  const res = makeRes();
  await adminReviewDetailHandler(makeAdminGetReq({
    secret: "test-admin-secret",
    applicationId: "11111111-1111-1111-1111-111111111111",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.identityStatus, "verified");
  assert.equal(detailFetchCount, 2);
});
