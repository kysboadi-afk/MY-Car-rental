import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_IDENTITY_WEBHOOK_SECRET = "whsec_test_123";

const calls = {
  patched: [],
  launches: [],
  verifiedNotifications: 0,
  issueNotifications: 0,
};

let currentApplication = {
  id: "app_1",
  identity_status: "verified",
  application_status: "under_review",
  identity_session_id: "vs_123",
};

mock.module("stripe", {
  defaultExport: class Stripe {
    constructor() {
      this.webhooks = {
        constructEvent() {
          return {
            id: "evt_1",
            type: "identity.verification_session.verified",
            data: {
              object: {
                id: "vs_123",
                status: "verified",
                metadata: { application_id: "app_1" },
              },
            },
          };
        },
      };
    }
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from(table) {
        if (table !== "stripe_identity_webhook_events") throw new Error(`Unexpected table ${table}`);
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: null, error: null }),
                };
              },
            };
          },
          insert: async () => ({ error: null }),
          update() {
            return {
              eq() {
                return {
                  is: async () => ({ error: null }),
                };
              },
            };
          },
        };
      },
    }),
  },
});

mock.module("./_renter-applications.js", {
  namedExports: {
    fetchRenterApplicationById: mock.fn(async () => ({ ok: true, data: currentApplication })),
    fetchRenterApplicationByIdentitySessionId: mock.fn(async () => ({ ok: true, data: currentApplication })),
    patchRenterApplicationIdentityById: mock.fn(async (applicationId, patch) => {
      calls.patched.push({ applicationId, patch });
      return {
        ok: true,
        data: {
          ...currentApplication,
          ...patch,
          identity_status: patch.identityStatus || currentApplication.identity_status,
          application_status: patch.applicationStatus || currentApplication.application_status,
        },
      };
    }),
  },
});

mock.module("./_application-notifications.js", {
  namedExports: {
    sendIdentityVerifiedNotifications: mock.fn(async () => {
      calls.verifiedNotifications += 1;
    }),
    sendIdentityIssueNotifications: mock.fn(async () => {
      calls.issueNotifications += 1;
    }),
  },
});

mock.module("./_identity-verified-orchestration.js", {
  namedExports: {
    launchCheckrForVerifiedFinalization: mock.fn(async (input) => {
      calls.launches.push(input);
      return { ok: true, executed: true };
    }),
  },
});

const { default: handler } = await import("./stripe-identity-webhook.js");

function makeRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeReq() {
  const req = Readable.from([Buffer.from("{}")]);
  req.method = "POST";
  req.headers = { "stripe-signature": "test_signature" };
  return req;
}

beforeEach(() => {
  calls.patched.length = 0;
  calls.launches.length = 0;
  calls.verifiedNotifications = 0;
  calls.issueNotifications = 0;
  currentApplication = {
    id: "app_1",
    identity_status: "verified",
    application_status: "under_review",
    identity_session_id: "vs_123",
  };
});

test("stripe-identity-webhook launches Checkr reconciliation when already verified", async () => {
  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.launches[0].source, "stripe_identity_webhook");
  assert.equal(calls.launches[0].trigger, "verified_reconciliation");
  assert.equal(calls.verifiedNotifications, 0);
});

test("stripe-identity-webhook launches Checkr on first verified transition", async () => {
  currentApplication = {
    id: "app_1",
    identity_status: "requires_input",
    application_status: "submitted",
    identity_session_id: "vs_123",
  };

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.launches[0].source, "stripe_identity_webhook");
  assert.equal(calls.launches[0].trigger, "verified_transition");
  assert.equal(calls.verifiedNotifications, 1);
});
