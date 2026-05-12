import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
process.env.STRIPE_IDENTITY_WEBHOOK_SECRET = "whsec_identity_test";
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-password";
process.env.OWNER_EMAIL = "owner@test.invalid";
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY = "test-api-key-00000000000000000000000";

const calls = {
  createdSessions: [],
  retrievedSessions: [],
  patched: [],
  fetched: [],
  eventInserts: [],
  sentMails: [],
  sentMessages: [],
};

let fetchResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "submitted" } };
let patchResult = { ok: true, data: { id: "app_1" } };
let stripeSessionResult = { id: "vs_123", client_secret: "vcs_123" };
let stripeRetrieveResult = null; // null = throw (session not found / deleted)
let webhookEvent = null;
let duplicateEvent = false;
let insertEventError = null;
let throwConstructEvent = false;

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

mock.module("nodemailer", {
  defaultExport: {
    createTransport: () => ({
      sendMail: async (opts) => { calls.sentMails.push(opts); },
    }),
  },
});

mock.module("./_textmagic.js", {
  namedExports: {
    sendSms: async (to, text) => { calls.sentMessages.push({ to, text }); return {}; },
  },
});

class StripeMock {
  constructor() {
    this.identity = {
      verificationSessions: {
        create: async (args) => {
          calls.createdSessions.push(args);
          return stripeSessionResult;
        },
        retrieve: async (id) => {
          calls.retrievedSessions.push(id);
          if (!stripeRetrieveResult) throw new Error(`No session found: ${id}`);
          return stripeRetrieveResult;
        },
      },
    };
    this.webhooks = {
      constructEvent: () => {
        if (throwConstructEvent) throw new Error("bad signature");
        return webhookEvent;
      },
    };
  }
}

mock.module("stripe", {
  defaultExport: StripeMock,
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

const { default: createIdentitySessionHandler } = await import("./create-identity-verification-session.js");
const { default: stripeIdentityWebhookHandler } = await import("./stripe-identity-webhook.js");

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

function makeWebhookReq() {
  const req = Readable.from([Buffer.from("{}")]);
  req.method = "POST";
  req.headers = { "stripe-signature": "sig_test" };
  return req;
}

beforeEach(() => {
  calls.createdSessions.length = 0;
  calls.retrievedSessions.length = 0;
  calls.patched.length = 0;
  calls.fetched.length = 0;
  calls.eventInserts.length = 0;
  calls.sentMails.length = 0;
  calls.sentMessages.length = 0;
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
  stripeSessionResult = { id: "vs_123", client_secret: "vcs_123" };
  stripeRetrieveResult = null;
  webhookEvent = null;
  duplicateEvent = false;
  insertEventError = null;
  throwConstructEvent = false;
});

test("create-identity-verification-session creates a Stripe Identity session with application metadata", async () => {
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.verificationSessionId, "vs_123");
  assert.equal(calls.createdSessions.length, 1);
  assert.equal(calls.createdSessions[0].metadata.application_id, "app_1");
  assert.equal(calls.patched[0].patch.identitySessionId, "vs_123");
  assert.equal(calls.patched[0].patch.identityStatus, "requires_input");
});

test("create-identity-verification-session returns alreadyVerified when identity is already complete", async () => {
  fetchResult = { ok: true, data: { id: "app_1", identity_status: "verified", application_status: "under_review" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.createdSessions.length, 0);
});

test("stripe-identity-webhook verifies signature, records event, and moves verified apps to under_review", async () => {
  webhookEvent = {
    id: "evt_identity_verified_1",
    type: "identity.verification_session.verified",
    data: {
      object: {
        id: "vs_123",
        status: "verified",
        metadata: { application_id: "app_1" },
      },
    },
  };

  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.received, true);
  assert.equal(calls.eventInserts.length, 1);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.patched[0].patch.identityStatus, "verified");
  assert.equal(calls.patched[0].patch.applicationStatus, "under_review");
  assert.equal(calls.sentMails.length, 2);
  assert.equal(calls.sentMessages.length, 1);
  assert.ok(calls.sentMails[0].subject.includes("Identity Verified"));
  assert.ok(calls.sentMails[1].subject.includes("Under Review"));
});

test("stripe-identity-webhook returns duplicate without patching when event was already processed", async () => {
  duplicateEvent = true;
  webhookEvent = {
    id: "evt_identity_duplicate_1",
    type: "identity.verification_session.processing",
    data: {
      object: {
        id: "vs_555",
        status: "processing",
        metadata: { application_id: "app_1" },
      },
    },
  };

  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.duplicate, true);
  assert.equal(calls.eventInserts.length, 0);
  assert.equal(calls.patched.length, 0);
  assert.equal(calls.sentMails.length, 0);
  assert.equal(calls.sentMessages.length, 0);
});

test("stripe-identity-webhook does not resend verified notifications when app is already verified", async () => {
  fetchResult = {
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
  webhookEvent = {
    id: "evt_identity_verified_repeat",
    type: "identity.verification_session.verified",
    data: {
      object: {
        id: "vs_123",
        status: "verified",
        metadata: { application_id: "app_1" },
      },
    },
  };

  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 200);
  assert.equal(calls.patched.length, 1);
  assert.equal(calls.sentMails.length, 0);
  assert.equal(calls.sentMessages.length, 0);
});

test("stripe-identity-webhook sends requires-input notifications only on transition", async () => {
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
  webhookEvent = {
    id: "evt_identity_requires_input_1",
    type: "identity.verification_session.requires_input",
    data: {
      object: {
        id: "vs_123",
        status: "requires_input",
        metadata: { application_id: "app_1" },
        last_error: { code: "document_unverified_other" },
      },
    },
  };

  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 200);
  assert.equal(calls.sentMails.length, 2);
  assert.equal(calls.sentMessages.length, 1);
  assert.ok(calls.sentMails[0].subject.includes("Requires Input"));
});

test("stripe-identity-webhook returns 400 when signature verification fails", async () => {
  throwConstructEvent = true;
  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 400);
  assert.match(String(res._body || ""), /Webhook Error/i);
});

// ─── Terminal state blocking ───────────────────────────────────────────────────

test("create-identity-verification-session blocks when application_status is approved", async () => {
  fetchResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "approved" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(res._body.applicationStatus, "approved");
  assert.equal(calls.createdSessions.length, 0);
});

test("create-identity-verification-session blocks when application_status is rejected", async () => {
  fetchResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "rejected" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(res._body.applicationStatus, "rejected");
  assert.equal(calls.createdSessions.length, 0);
});

test("create-identity-verification-session blocks when application_status is expired", async () => {
  fetchResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "expired" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(res._body.applicationStatus, "expired");
  assert.equal(calls.createdSessions.length, 0);
});

test("create-identity-verification-session blocks when application_status is withdrawn", async () => {
  fetchResult = { ok: true, data: { id: "app_1", identity_status: "not_started", application_status: "withdrawn" } };
  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.blocked, true);
  assert.equal(res._body.applicationStatus, "withdrawn");
  assert.equal(calls.createdSessions.length, 0);
});

// ─── Session reuse ─────────────────────────────────────────────────────────────

test("create-identity-verification-session reuses existing Stripe session when status is requires_input", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_existing",
    },
  };
  stripeRetrieveResult = { id: "vs_existing", status: "requires_input", client_secret: "vcs_existing" };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.verificationSessionId, "vs_existing");
  assert.equal(res._body.clientSecret, "vcs_existing");
  assert.equal(res._body.sessionReused, true);
  // Must NOT create a new session when an existing one is resumable
  assert.equal(calls.createdSessions.length, 0);
  assert.equal(calls.retrievedSessions[0], "vs_existing");
});

test("create-identity-verification-session returns processing when existing Stripe session is processing", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "processing",
      application_status: "submitted",
      identity_session_id: "vs_processing",
    },
  };
  stripeRetrieveResult = { id: "vs_processing", status: "processing", client_secret: null };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.processing, true);
  assert.equal(res._body.identityStatus, "processing");
  assert.equal(calls.createdSessions.length, 0);
});

test("create-identity-verification-session returns alreadyVerified when existing Stripe session is verified", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_done",
    },
  };
  stripeRetrieveResult = { id: "vs_done", status: "verified", client_secret: null };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.alreadyVerified, true);
  assert.equal(calls.createdSessions.length, 0);
});

test("create-identity-verification-session creates new session when existing Stripe session is canceled", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "canceled",
      application_status: "submitted",
      identity_session_id: "vs_canceled",
    },
  };
  stripeRetrieveResult = { id: "vs_canceled", status: "canceled", client_secret: null };

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.verificationSessionId, "vs_123"); // new session
  assert.equal(calls.createdSessions.length, 1);
});

test("create-identity-verification-session creates new session when Stripe retrieve throws", async () => {
  fetchResult = {
    ok: true,
    data: {
      id: "app_1",
      identity_status: "requires_input",
      application_status: "submitted",
      identity_session_id: "vs_deleted",
    },
  };
  // stripeRetrieveResult remains null → retrieve throws

  const res = makeRes();
  await createIdentitySessionHandler(makeIdentityCreateReq({ applicationId: "app_1" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  // A new session must be created when retrieve fails
  assert.equal(calls.createdSessions.length, 1);
  assert.equal(res._body.sessionReused, undefined);
});

// ─── Notification link assertions ─────────────────────────────────────────────

test("stripe-identity-webhook requires-input notification applicant SMS contains verification link", async () => {
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
  webhookEvent = {
    id: "evt_identity_requires_input_link",
    type: "identity.verification_session.requires_input",
    data: {
      object: {
        id: "vs_123",
        status: "requires_input",
        metadata: { application_id: "app_1" },
        last_error: { code: "document_unverified_other" },
      },
    },
  };

  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 200);
  assert.ok(
    calls.sentMessages[0].text.includes("thank-you.html"),
    `Expected verification URL in SMS, got: ${calls.sentMessages[0].text}`
  );
  assert.ok(
    calls.sentMails[1].html.includes("thank-you.html"),
    `Expected verification URL in applicant email HTML`
  );
});

test("stripe-identity-webhook verified notification does not include a verification link CTA", async () => {
  webhookEvent = {
    id: "evt_identity_verified_link_check",
    type: "identity.verification_session.verified",
    data: {
      object: {
        id: "vs_123",
        status: "verified",
        metadata: { application_id: "app_1" },
      },
    },
  };

  const res = makeRes();
  await stripeIdentityWebhookHandler(makeWebhookReq(), res);

  assert.equal(res._status, 200);
  // The verified applicant email should not have a "Verify Identity" CTA
  assert.ok(!calls.sentMails[1].html.includes("Complete Identity Verification"), "Verified email must not show verify CTA");
});
