import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import crypto from "node:crypto";

process.env.OTP_SECRET = "otp-secret-test";
process.env.VERIFF_API_KEY = "veriff_api_test";
process.env.VERIFF_SHARED_SECRET = "veriff_shared_secret_test";
process.env.VERIFF_PROJECT_ID = "veriff_project_test";
process.env.STRIPE_SECRET_KEY = "";
process.env.STRIPE_PUBLISHABLE_KEY = "";
process.env.STRIPE_IDENTITY_WEBHOOK_SECRET = "";
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
  incomeDocSelects: [],
  signedUrlRequests: [],
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
let veriffDecisionEndpointOverrides = {};
let veriffCreateStatus = 200;
let veriffCreatePayload = { status: "success", verification: { id: "vrf_123", status: "created", url: "https://veriff.test/session/vrf_123" } };
let veriffCreateFailureOnce = null;
let missingVeriffEventTable = false;
let missingVeriffEventTableError = null;
let incomeDocumentsResponses = [];

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
const getApplicationAttentionFlags = mock.fn(() => ({
  isRecentHour: false,
  isRecentDay: false,
  isUnreviewed: false,
  isNewAttention: false,
}));

mock.module("./_renter-applications.js", {
  namedExports: {
    deriveCheckrPhase: (record = {}) => {
      if (record.checkr_report_status) return record.checkr_report_status;
      if (record.checkr_report_id) return "invitation_sent";
      if (record.checkr_candidate_id) return "candidate_created";
      return "not_started";
    },
    fetchRenterApplicationById,
    fetchRenterApplicationByIdentitySessionId,
    patchRenterApplicationIdentityById,
    listReviewQueueApplications,
    listPendingIdentityRecoveryApplications,
    fetchReviewApplicationById,
    getApplicationAttentionFlags,
    performReviewAction: mock.fn(async () => ({ ok: true, data: {} })),
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
        if (table === "application_documents") {
          return {
            select(columns) {
              calls.incomeDocSelects.push(columns);
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        order: async () => incomeDocumentsResponses.shift() || { data: [], error: null },
                      };
                    },
                  };
                },
              };
            },
          };
        }
        if (table === "application_review_actions") {
          return {
            insert: async () => ({ error: null }),
          };
        }
        if (!["veriff_webhook_events", "stripe_identity_webhook_events"].includes(table)) {
          throw new Error(`Unexpected table ${table}`);
        }
        const isMissingVeriffTable = missingVeriffEventTable && table === "veriff_webhook_events";
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => {
                    if (isMissingVeriffTable) {
                      return {
                        data: null,
                        error: missingVeriffEventTableError || { code: "42P01", message: 'relation "veriff_webhook_events" does not exist' },
                      };
                    }
                    return duplicateEvent
                      ? { data: { id: 1 }, error: null }
                      : { data: null, error: null };
                  },
                };
              },
            };
          },
          insert: async (payload) => {
            if (isMissingVeriffTable) {
              return {
                error: missingVeriffEventTableError || { code: "42P01", message: 'relation "veriff_webhook_events" does not exist' },
              };
            }
            calls.eventInserts.push({ table, payload });
            return { error: insertEventError };
          },
        };
      },
      storage: {
        from(bucket) {
          return {
            createSignedUrl: async (path, expiresIn) => {
              calls.signedUrlRequests.push({ bucket, path, expiresIn });
              return { data: { signedUrl: `https://signed.test/${encodeURIComponent(path)}` } };
            },
          };
        },
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
  const requestUrl = String(url);
  let body = null;
  const headers = Object.fromEntries(
    Object.entries(init.headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  if (typeof init.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  calls.veriffFetches.push({ url: requestUrl, method, body, headers });
  if (method === "GET") {
    const override = Object.entries(veriffDecisionEndpointOverrides || {}).find(([needle]) => requestUrl.includes(needle));
    const status = override ? Number(override[1]?.status || 0) : veriffDecisionStatus;
    const payload = override ? (override[1]?.payload || {}) : veriffDecisionPayload;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload; },
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
const { default: identityWebhookHandler } = await import("./veriff-webhook.js");
const { default: deprecatedStripeIdentityWebhookHandler } = await import("./stripe-identity-webhook.js");
const { default: adminReviewQueueHandler } = await import("./admin-review-queue.js");
const { default: adminReviewDetailHandler } = await import("./admin-review-detail.js");
const { default: adminApplicationOpsHandler } = await import("./admin-application-ops.js");
const { default: veriffRecoveryCronHandler } = await import("./veriff-identity-recovery-cron.js");
const { clearRecoveryCooldownCache } = await import("./_veriff-identity-recovery.js");
const { mapVeriffDecisionToIdentityStatus } = await import("./_veriff.js");

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
    headers: { origin: "https://slycarrentals.com" },
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
    headers: { origin: "https://slycarrentals.com" },
    query,
  };
}

function makeAdminPostReq(body = {}) {
  return {
    method: "POST",
    headers: { origin: "https://slycarrentals.com" },
    body: { reviewedBy: "test-admin", secret: "test-admin-secret", ...body },
  };
}

function makeCronGetReq() {
  return { method: "GET", headers: {} };
}

function makeCronPostReq({ auth = "test-admin-secret" } = {}) {
  return {
    method: "POST",
    headers: { authorization: auth ? `Bearer ${auth}` : "" },
  };
}

beforeEach(() => {
  clearRecoveryCooldownCache();
  calls.patched.length = 0;
  calls.fetched.length = 0;
  calls.fetchedBySession.length = 0;
  calls.listedReviewQueue.length = 0;
  calls.listedRecoveryCandidates.length = 0;
  calls.fetchedReviewDetail.length = 0;
  calls.incomeDocSelects.length = 0;
  calls.signedUrlRequests.length = 0;
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
  // Reset any custom mockImplementation set by previous tests.
  fetchReviewApplicationById.mock.mockImplementation(async (...args) => {
    calls.fetchedReviewDetail.push(args);
    return reviewDetailResult;
  });
  veriffDecisionStatus = 404;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_existing", status: "submitted" } };
  veriffDecisionEndpointOverrides = {};
  veriffCreateStatus = 200;
  veriffCreatePayload = { status: "success", verification: { id: "vrf_123", status: "created", url: "https://veriff.test/session/vrf_123" } };
  veriffCreateFailureOnce = null;
  missingVeriffEventTable = false;
  missingVeriffEventTableError = null;
  incomeDocumentsResponses = [];
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
  assert.equal(createCall.body?.verification?.callback, "https://slycarrentals.com/api/veriff-webhook");
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

test("create-identity-verification-session uses fullauto decision when default decision is empty", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vrf_fullauto_existing",
    },
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: null };
  veriffDecisionEndpointOverrides = {
    "/decision/fullauto?version=1": {
      status: 200,
      payload: {
        status: "success",
        verification: {
          id: "vrf_fullauto_existing",
          vendorData: "app_1",
          decision: { status: "approved" },
        },
      },
    },
  };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(
    calls.veriffFetches.filter((entry) => entry.method === "GET").length,
    2,
    "default + fullauto decision lookups are executed"
  );
});

test("veriff-webhook maps approved Veriff decision to verified", async () => {
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

test("veriff-webhook maps approved Veriff decision with status:success envelope to verified", async () => {
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

test("veriff-webhook maps verification.completed decision payload to verified", async () => {
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

test("veriff-webhook maps fullauto-style combined payload envelope to verified", async () => {
  const payload = {
    status: "success",
    data: {
      eventType: "verification.completed",
      verification: {
        id: "vrf_fullauto_evt_1",
        vendorData: "app_1",
      },
      decision: {
        status: "approved",
      },
      extraction: {
        person: { firstName: "Jane", lastName: "Driver" },
      },
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.patched[0].applicationId, "app_1");
});

test("veriff-webhook maps terminal eventType when payload status is success and decision fields are absent", async () => {
  veriffDecisionStatus = 404;
  const payload = {
    id: "evt_veriff_declined_event_type_1",
    status: "success",
    eventType: "verification.declined",
    verification: {
      id: "vrf_declined_1",
      vendorData: "app_1",
    },
  };

  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.received, true);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "failed");
  assert.equal(calls.checkrInitiations.length, 0);
  const methods = calls.veriffFetches.map((entry) => entry.method);
  assert.deepEqual(methods, []);
});

test("veriff-webhook maps approved by session lookup when vendorData is absent", async () => {
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

test("veriff-webhook advances processing identity to under_review", async () => {
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

test("veriff-webhook redirects browser GET requests to identity return page", async () => {
  const res = makeRes();
  await identityWebhookHandler({ method: "GET", query: { applicationId: "app_1" } }, res);

  assert.equal(res._status, 302);
  assert.equal(
    res._headers.Location,
    "https://slycarrentals.com/thank-you.html?from=apply&identity=return&applicationId=app_1"
  );
});

test("veriff-webhook maps resubmission_requested to requires_input", async () => {
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

test("mapVeriffDecisionToIdentityStatus handles production decision payload objects", () => {
  assert.equal(
    mapVeriffDecisionToIdentityStatus({
      status: "success",
      verification: {
        status: "submitted",
        decision: {
          status: "declined",
        },
      },
    }),
    "failed"
  );
});

test("veriff-webhook returns duplicate without patching when event is already processed", async () => {
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

test("veriff-webhook continues processing when event logging insert fails", async () => {
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

test("veriff-webhook returns 400 when signature verification fails", async () => {
  const payload = {
    id: "evt_veriff_bad_sig_1",
    verification: { id: "vrf_123", status: "approved", vendorData: "app_1" },
  };
  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload, { validSignature: false }), res);
  assert.equal(res._status, 400);
});

test("veriff-webhook logs events in veriff_webhook_events table by default", async () => {
  const payload = {
    id: "evt_veriff_table_1",
    verification: { id: "vrf_123", status: "approved", vendorData: "app_1" },
  };
  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.eventInserts[0]?.table, "veriff_webhook_events");
});

test("veriff-webhook event id includes status metadata when payload id equals session id", async () => {
  const payload = {
    id: "319b4473-9b2f-4c08-9e89-9f95a97c7973",
    action: "submitted",
    attemptId: "3d934df3-5e01-48f7-b903-ee4b760be098",
    verification: {
      id: "319b4473-9b2f-4c08-9e89-9f95a97c7973",
      status: "submitted",
    },
  };
  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.eventInserts[0]?.table, "veriff_webhook_events");
  assert.equal(calls.eventInserts[0]?.payload.event_id, "319b4473-9b2f-4c08-9e89-9f95a97c7973:submitted:3d934df3-5e01-48f7-b903-ee4b760be098:unknown-time");
});

test("veriff-webhook falls back to legacy event log table when veriff_webhook_events is missing", async () => {
  missingVeriffEventTable = true;
  const payload = {
    id: "evt_veriff_fallback_1",
    verification: { id: "vrf_123", status: "approved", vendorData: "app_1" },
  };
  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.eventInserts[0]?.table, "stripe_identity_webhook_events");
});

test("veriff-webhook falls back when veriff table is missing from schema cache", async () => {
  missingVeriffEventTable = true;
  missingVeriffEventTableError = {
    code: "PGRST205",
    message: "Could not find the table 'public.veriff_webhook_events' in the schema cache",
  };
  const payload = {
    id: "evt_veriff_fallback_schema_cache_1",
    verification: { id: "vrf_123", status: "approved", vendorData: "app_1" },
  };
  const res = makeRes();
  await identityWebhookHandler(makeWebhookReq(payload), res);

  assert.equal(res._status, 200);
  assert.equal(calls.eventInserts[0]?.table, "stripe_identity_webhook_events");
  assert.equal(calls.patched[0]?.patch?.identityStatus, "verified");
});

test("stripe-identity-webhook only accepts POST", async () => {
  const res = makeRes();
  await deprecatedStripeIdentityWebhookHandler(makeAdminGetReq({}), res);
  assert.equal(res._status, 405);
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
  assert.equal(calls.checkrInitiations.length, 1);
  assert.deepEqual(calls.checkrInitiations[0], ["app_1"]);
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
  assert.equal(calls.checkrInitiations.length, 0);
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-queue finalizes declined Veriff decisions without launching Checkr", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_declined_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "processing",
      application_status: "under_review",
      identity_session_id: "vrf_recover_declined_1",
    }],
  };
  reviewQueueResult = {
    ok: true,
    data: [{
      id: "app_declined_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      age: 28,
      experience: "3 years",
      application_status: "under_review",
      identity_status: "failed",
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
  veriffDecisionPayload = {
    status: "success",
    verification: {
      id: "vrf_recover_declined_1",
      status: "submitted",
      decision: {
        status: "declined",
      },
    },
  };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret", page: 1, pageSize: 50 }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.patched[0].patch.identityStatus, "failed");
  assert.equal(calls.patched[0].patch.identityLastError, "declined");
  assert.equal(calls.checkrInitiations.length, 0);
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-queue skips legacy (non-Veriff) session ids during recovery", async () => {
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
  assert.equal(calls.checkrInitiations.length, 1);
  assert.deepEqual(calls.checkrInitiations[0], ["11111111-1111-1111-1111-111111111111"]);
  assert.equal(detailFetchCount, 2);
});

test("admin-review-detail falls back across legacy income document columns", async () => {
  reviewDetailResult = {
    ok: true,
    data: {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      application_status: "under_review",
      identity_status: "verified",
      identity_session_id: "vrf_detail_sync",
      review_version: 2,
    },
    history: [],
  };
  incomeDocumentsResponses = [
    { data: null, error: { code: "42703", message: "column application_documents.file_size does not exist" } },
    { data: null, error: { code: "42703", message: "column application_documents.review_status does not exist" } },
    { data: null, error: { code: "42703", message: "column application_documents.file_size does not exist" } },
    {
      data: [{
        id: "doc_1",
        doc_type: "income_verification",
        file_name: "weekly-summary.pdf",
        mime_type: "application/pdf",
        file_path: "income/app_1/weekly-summary.pdf",
        file_size: 2048,
        review_status: "pending",
        reviewed_by: null,
        reviewed_at: null,
        notes: null,
        created_at: "2026-05-14T03:00:00.000Z",
      }],
      error: null,
    },
  ];

  const res = makeRes();
  await adminReviewDetailHandler(makeAdminGetReq({
    secret: "test-admin-secret",
    applicationId: "11111111-1111-1111-1111-111111111111",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.incomeDocuments.length, 1);
  assert.equal(res._body.incomeDocuments[0].fileSize, 2048);
  assert.equal(res._body.incomeDocuments[0].reviewStatus, "pending");
  assert.equal(calls.incomeDocSelects.length, 4);
  assert.match(calls.incomeDocSelects[1], /file_size:file_size_bytes/);
  assert.match(calls.incomeDocSelects[3], /review_status:verification_status/);
  assert.equal(calls.signedUrlRequests.length, 1);
});

test("admin-review-queue skips Veriff recovery for terminal application status", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_rejected_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "rejected",
      identity_session_id: "vrf_terminal_q1",
    }],
  };
  reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._status, 200);
  assert.equal(calls.veriffFetches.length, 0, "no Veriff API call for rejected application");
  assert.equal(calls.patched.length, 0);
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-queue handles session_not_found (404) gracefully and returns 200", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_stale_1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_stale_404_q1",
    }],
  };
  veriffDecisionStatus = 404;
  reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.veriffFetches.length, 1, "Veriff is called once");
  assert.equal(calls.patched.length, 0, "no patch on 404");
  assert.equal(calls.listedReviewQueue.length, 1);
});

test("admin-review-queue decision fetch sends Veriff auth headers including x-hmac-signature", async () => {
  const sessionId = "vrf_auth_headers_q1";
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_auth_headers_q1",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: sessionId,
    }],
  };
  veriffDecisionStatus = 401;
  veriffDecisionPayload = { status: "fail", message: "Unauthorized" };
  reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };

  const res = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res);

  assert.equal(res._status, 200);
  assert.equal(calls.veriffFetches.length, 1);
  const fetchCall = calls.veriffFetches[0];
  assert.equal(fetchCall.method, "GET");
  assert.equal(fetchCall.headers["x-auth-client"], process.env.VERIFF_API_KEY);
  assert.equal(fetchCall.headers["x-auth-client-project"], process.env.VERIFF_PROJECT_ID);
  assert.equal(fetchCall.headers["x-hmac-signature"], signPayload(sessionId));
});

test("admin-review-queue clears auth cooldown after Veriff credential change", async () => {
  const originalApiKey = process.env.VERIFF_API_KEY;
  try {
    recoveryCandidatesResult = {
      ok: true,
      data: [{
        id: "app_auth_cooldown_q1",
        name: "Jane Driver",
        phone: "3105550199",
        email: "jane@example.com",
        identity_status: "requires_input",
        application_status: "submitted",
        identity_session_id: "vrf_auth_cooldown_q1",
      }],
    };
    veriffDecisionStatus = 401;
    veriffDecisionPayload = { status: "fail", message: "Unauthorized" };
    reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };

    const res1 = makeRes();
    await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res1);
    assert.equal(res1._status, 200);
    assert.equal(calls.veriffFetches.length, 1, "Veriff called on first request");

    calls.veriffFetches.length = 0;
    process.env.VERIFF_API_KEY = `${originalApiKey}_rotated`;
    recoveryCandidatesResult = {
      ok: true,
      data: [{
        id: "app_auth_cooldown_q2",
        name: "Jane Driver",
        phone: "3105550199",
        email: "jane@example.com",
        identity_status: "requires_input",
        application_status: "submitted",
        identity_session_id: "vrf_auth_cooldown_q2",
      }],
    };

    const res2 = makeRes();
    await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res2);
    assert.equal(res2._status, 200);
    assert.equal(calls.veriffFetches.length, 1, "Veriff called again after credential change");
  } finally {
    process.env.VERIFF_API_KEY = originalApiKey;
  }
});

test("admin-review-queue respects session cooldown after 404 — no repeat Veriff call", async () => {
  const candidate = {
    id: "app_cooldown_q1",
    name: "Jane Driver",
    phone: "3105550199",
    email: "jane@example.com",
    identity_status: "requires_input",
    application_status: "submitted",
    identity_session_id: "vrf_cooldown_q1",
  };
  recoveryCandidatesResult = { ok: true, data: [candidate] };
  veriffDecisionStatus = 404;
  reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };

  // First request — sets cooldown for vrf_cooldown_q1
  const res1 = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res1);
  assert.equal(res1._status, 200);
  assert.equal(calls.veriffFetches.length, 1, "Veriff called on first request");

  // Reset tracking state only (not the module-level cooldown cache).
  calls.veriffFetches.length = 0;
  calls.patched.length = 0;
  calls.listedReviewQueue.length = 0;
  calls.listedRecoveryCandidates.length = 0;

  // Second request — same session must be skipped due to cooldown.
  recoveryCandidatesResult = { ok: true, data: [candidate] };
  reviewQueueResult = { ok: true, data: [], total: 0, page: 1, pageSize: 50 };
  const res2 = makeRes();
  await adminReviewQueueHandler(makeAdminGetReq({ secret: "test-admin-secret" }), res2);

  assert.equal(res2._status, 200);
  assert.equal(calls.veriffFetches.length, 0, "Veriff NOT called again — cooldown active");
});

test("admin-review-detail skips Veriff recovery for terminal application status", async () => {
  reviewDetailResult = {
    ok: true,
    data: {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Jane Driver",
      phone: "3105550199",
      email: "jane@example.com",
      application_status: "rejected",
      identity_status: "requires_input",
      identity_session_id: "vrf_terminal_d1",
      review_version: 0,
    },
    history: [],
  };

  const res = makeRes();
  await adminReviewDetailHandler(makeAdminGetReq({
    secret: "test-admin-secret",
    applicationId: "11111111-1111-1111-1111-111111111111",
  }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(calls.veriffFetches.length, 0, "no Veriff API call for rejected application");
  assert.equal(calls.patched.length, 0);
});

test("admin-review-detail skips Veriff recovery when session is in cooldown", async () => {
  const appId = "22222222-2222-2222-2222-222222222222";
  const appData = {
    id: appId,
    name: "Jane Driver",
    phone: "3105550199",
    email: "jane@example.com",
    application_status: "submitted",
    identity_status: "requires_input",
    identity_session_id: "vrf_cooldown_d1",
    review_version: 0,
  };

  // First detail load — triggers a 404 → sets cooldown.
  reviewDetailResult = { ok: true, data: appData, history: [] };
  veriffDecisionStatus = 404;
  let res1 = makeRes();
  await adminReviewDetailHandler(makeAdminGetReq({ secret: "test-admin-secret", applicationId: appId }), res1);
  assert.equal(res1._status, 200);
  assert.equal(calls.veriffFetches.length, 1, "Veriff called on first load");

  // Reset tracking only (not the cooldown cache).
  calls.veriffFetches.length = 0;
  calls.patched.length = 0;

  // Second detail load — same session must be skipped.
  reviewDetailResult = { ok: true, data: appData, history: [] };
  let res2 = makeRes();
  await adminReviewDetailHandler(makeAdminGetReq({ secret: "test-admin-secret", applicationId: appId }), res2);

  assert.equal(res2._status, 200);
  assert.equal(calls.veriffFetches.length, 0, "Veriff NOT called again — cooldown active");
});

test("backfill_veriff_approved dry run returns candidate count without patching", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [
      {
        id: "app_bf_1",
        name: "Alice Renter",
        phone: "3105550111",
        email: "alice@example.com",
        identity_status: "requires_input",
        application_status: "submitted",
        identity_session_id: "vrf_bf_session_1",
      },
      {
        id: "app_bf_2",
        name: "Bob Renter",
        phone: "3105550222",
        email: "bob@example.com",
        identity_status: "processing",
        application_status: "under_review",
        identity_session_id: "vrf_bf_session_2",
      },
    ],
  };

  const res = makeRes();
  await adminApplicationOpsHandler(makeAdminPostReq({ action: "backfill_veriff_approved" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.dryRun, true);
  assert.equal(res._body.count, 2);
  assert.equal(res._body.candidates.length, 2);
  assert.equal(calls.patched.length, 0, "no patch in dry run");
  assert.equal(calls.veriffFetches.length, 0, "no Veriff calls in dry run");
});

test("backfill_veriff_approved syncs approved applications and launches Checkr", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_bf_3",
      name: "Carol Renter",
      phone: "3105550333",
      email: "carol@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_bf_approved_1",
    }],
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_bf_approved_1", status: "approved" } };

  const res = makeRes();
  await adminApplicationOpsHandler(makeAdminPostReq({ action: "backfill_veriff_approved", dryRun: false }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.dryRun, false);
  assert.equal(res._body.synced, 1);
  assert.equal(res._body.skipped, 0);
  assert.equal(res._body.failed.length, 0);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.checkrInitiations.length, 1);
});

test("backfill_veriff_approved skips legacy session IDs", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_bf_4",
      name: "Dave Renter",
      phone: "3105550444",
      email: "dave@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_legacy_stripe_session",
    }],
  };

  const res = makeRes();
  await adminApplicationOpsHandler(makeAdminPostReq({ action: "backfill_veriff_approved", dryRun: false }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 0);
  assert.equal(res._body.skipped, 1);
  assert.equal(calls.veriffFetches.length, 0, "no Veriff call for legacy session");
  assert.equal(calls.patched.length, 0);
});

test("backfill_veriff_approved handles 404 session not found gracefully", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_bf_5",
      name: "Eve Renter",
      phone: "3105550555",
      email: "eve@example.com",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vrf_bf_stale_404",
    }],
  };
  veriffDecisionStatus = 404;

  const res = makeRes();
  await adminApplicationOpsHandler(makeAdminPostReq({ action: "backfill_veriff_approved", dryRun: false }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.synced, 0);
  assert.equal(res._body.skipped, 1, "404 is classified as skipped (errorType set)");
  assert.equal(res._body.failed.length, 0);
  assert.equal(calls.patched.length, 0);
});

test("backfill_veriff_approved skips already-synced verified applications but attempts Checkr", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_bf_6",
      name: "Frank Renter",
      phone: "3105550666",
      email: "frank@example.com",
      identity_status: "verified",
      application_status: "under_review",
      identity_session_id: "vrf_bf_already_verified",
    }],
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_bf_already_verified", status: "approved" } };

  const res = makeRes();
  await adminApplicationOpsHandler(makeAdminPostReq({ action: "backfill_veriff_approved", dryRun: false }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 0);
  assert.equal(res._body.skipped, 1, "already verified counts as skipped");
  assert.equal(calls.patched.length, 0);
  assert.equal(calls.checkrInitiations.length, 1, "Checkr still attempted for already-verified");
});

// ── veriff-identity-recovery-cron.js ─────────────────────────────────────────

test("recovery cron GET returns empty summary when no candidates", async () => {
  recoveryCandidatesResult = { ok: true, data: [] };

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.scanned, 0);
  assert.equal(res._body.synced, 0);
  assert.equal(res._body.skipped, 0);
  assert.equal(res._body.failed, 0);
  assert.equal(res._body.stuckCount, 0);
  assert.equal(res._body.authFailureDetected, false);
  assert.equal(calls.veriffFetches.length, 0, "no Veriff calls when no candidates");
});

test("recovery cron GET syncs approved candidate and launches Checkr", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_cron_1",
      name: "Cron Renter",
      phone: "3105550001",
      email: "cron@example.com",
      application_status: "submitted",
      identity_status: "processing",
      identity_session_id: "vrf_cron_approved_1",
    }],
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_cron_approved_1", status: "approved" } };

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.scanned, 1);
  assert.equal(res._body.synced, 1);
  assert.equal(res._body.skipped, 0);
  assert.equal(res._body.failed, 0);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.checkrInitiations.length, 1);
});

test("recovery cron POST with valid auth runs recovery", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_cron_2",
      name: "Manual Renter",
      phone: "3105550002",
      email: "manual@example.com",
      application_status: "under_review",
      identity_status: "processing",
      identity_session_id: "vrf_cron_manual_1",
    }],
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_cron_manual_1", status: "approved" } };

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronPostReq({ auth: "test-admin-secret" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.scanned, 1);
  assert.equal(res._body.synced, 1);
});

test("recovery cron POST with wrong auth returns 401", async () => {
  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronPostReq({ auth: "wrong-secret" }), res);

  assert.equal(res._status, 401);
  assert.equal(calls.listedRecoveryCandidates.length, 0, "no DB query on unauthorized request");
});

test("recovery cron POST with missing auth returns 401", async () => {
  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronPostReq({ auth: "" }), res);

  assert.equal(res._status, 401);
});

test("recovery cron rejects disallowed HTTP methods", async () => {
  const req = { method: "DELETE", headers: {} };
  const res = makeRes();
  await veriffRecoveryCronHandler(req, res);
  assert.equal(res._status, 405);
});

test("recovery cron skips candidate with legacy session ID", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_cron_3",
      name: "Legacy Renter",
      phone: "3105550003",
      email: "legacy@example.com",
      application_status: "submitted",
      identity_status: "processing",
      identity_session_id: "vs_legacy_stripe_id",
    }],
  };

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.scanned, 1);
  assert.equal(res._body.skipped, 1, "legacy session ID is skipped");
  assert.equal(res._body.synced, 0);
  assert.equal(calls.veriffFetches.length, 0, "no Veriff call for legacy session");
});

test("recovery cron counts 404 session as skipped", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_cron_4",
      name: "Missing Renter",
      phone: "3105550004",
      email: "missing@example.com",
      application_status: "submitted",
      identity_status: "processing",
      identity_session_id: "vrf_cron_stale_404",
    }],
  };
  veriffDecisionStatus = 404;

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.scanned, 1);
  assert.equal(res._body.skipped, 1, "404 permanent error is skipped, not failed");
  assert.equal(res._body.failed, 0);
  assert.equal(calls.patched.length, 0);
});

test("recovery cron detects auth failure and stops early", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [
      {
        id: "app_cron_5a",
        name: "Auth Fail A",
        phone: "3105550005",
        email: "a@example.com",
        application_status: "submitted",
        identity_status: "processing",
        identity_session_id: "vrf_cron_auth_fail_a",
      },
      {
        id: "app_cron_5b",
        name: "Auth Fail B",
        phone: "3105550006",
        email: "b@example.com",
        application_status: "submitted",
        identity_status: "processing",
        identity_session_id: "vrf_cron_auth_fail_b",
      },
    ],
  };
  veriffDecisionStatus = 401;

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.authFailureDetected, true);
  assert.equal(res._body.failed, 1, "auth failure counts as failed (only first call before break)");
  // After auth failure the cron breaks early — second candidate is not attempted
  assert.equal(calls.veriffFetches.length, 1, "only one Veriff call before auth break");
});

test("recovery cron skips all when candidate scan fails", async () => {
  recoveryCandidatesResult = { ok: false, error: "DB query failed", status: 503 };

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.skipped, true, "returns skipped:true on scan failure");
  assert.equal(res._body.reason, "candidate_scan_failed");
  assert.equal(calls.veriffFetches.length, 0);
});

test("recovery cron skips already-synced candidates and attempts Checkr for verified", async () => {
  recoveryCandidatesResult = {
    ok: true,
    data: [{
      id: "app_cron_6",
      name: "Verified Renter",
      phone: "3105550007",
      email: "verified@example.com",
      application_status: "under_review",
      identity_status: "verified",
      identity_session_id: "vrf_cron_already_verified",
    }],
  };
  veriffDecisionStatus = 200;
  veriffDecisionPayload = { status: "success", verification: { id: "vrf_cron_already_verified", status: "approved" } };

  const res = makeRes();
  await veriffRecoveryCronHandler(makeCronGetReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.scanned, 1);
  assert.equal(res._body.skipped, 1, "already-synced is counted as skipped");
  assert.equal(res._body.synced, 0);
  assert.equal(calls.patched.length, 0);
  assert.equal(calls.checkrInitiations.length, 1, "Checkr still attempted for already-verified");
});
