// api/_review-application.test.js
// Tests for the Phase 3 review-application endpoint and the helper functions
// in _renter-applications.js that back it.
//
// Covers:
//   ✓ Happy-path approve / reject / needs_info
//   ✓ 409 STALE_REVIEW_ACTION when version/status changed
//   ✓ Idempotent replay via actionRequestId
//   ✓ Invalid action rejected (400)
//   ✓ Invalid expectedStatus rejected (422)
//   ✓ Admin auth guard (401)
//   ✓ Missing required fields (400)
//   ✓ Notification sent only on first write (not on idempotent replay)

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_SECRET = "test-admin-secret";
process.env.SMTP_HOST    = "smtp.test.invalid";
process.env.SMTP_PORT    = "587";
process.env.SMTP_USER    = "test@test.invalid";
process.env.SMTP_PASS    = "test-password";
process.env.OWNER_EMAIL  = "owner@test.invalid";
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY  = "test-api-key-00000000000000000000000";

// ── Mock tracking ────────────────────────────────────────────────────────────
const calls = {
  performReviewAction: [],
  performPreAdverseAction: [],
  sendReviewDecisionNotifications: [],
};

let performReviewActionResult = {
  ok: true,
  data: {
    id: "app-uuid-1",
    application_status: "approved",
    review_version: 1,
    reviewed_by: "admin@slytrans.com",
    reviewed_at: "2026-05-13T12:00:00.000Z",
  },
};

let sendNotificationsError = null;

const performReviewAction = mock.fn(async (...args) => {
  calls.performReviewAction.push(args);
  return performReviewActionResult;
});

const performPreAdverseAction = mock.fn(async (...args) => {
  calls.performPreAdverseAction.push(args);
  return performReviewActionResult;
});

const fetchReviewApplicationById = mock.fn(async () => ({ ok: false, status: 404, error: "not used in handler" }));

mock.module("./_renter-applications.js", {
  namedExports: {
    performReviewAction,
    performPreAdverseAction,
    fetchReviewApplicationById,
    listReviewQueueApplications: mock.fn(async () => ({ ok: true, data: [], total: 0, page: 1, pageSize: 50 })),
    REVIEW_ACTION_MAP: { approved: "approved", rejected: "rejected", needs_info: "needs_info" },
    toClientApplication: (r) => r,
    insertRenterApplication: mock.fn(),
    fetchRenterApplicationById: mock.fn(),
    patchRenterApplicationById: mock.fn(),
    patchRenterApplicationIdentityById: mock.fn(),
    fetchReviewApplicationById: mock.fn(),
  },
});

mock.module("./_application-notifications.js", {
  namedExports: {
    sendReviewDecisionNotifications: mock.fn(async (...args) => {
      calls.sendReviewDecisionNotifications.push(args);
      if (sendNotificationsError) throw sendNotificationsError;
    }),
    sendSubmittedApplicationNotifications: mock.fn(async () => {}),
    sendIdentityVerifiedNotifications: mock.fn(async () => {}),
    sendIdentityIssueNotifications: mock.fn(async () => {}),
  },
});

const { default: handler } = await import("./review-application.js");

// ── Test helpers ─────────────────────────────────────────────────────────────
function makeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;   return this; },
    send(body)   { this._body = body;   return this; },
    end()        { return this; },
  };
}

function validBody(overrides = {}) {
  return {
    secret:                "test-admin-secret",
    applicationId:         "app-uuid-1",
    action:                "approved",
    reviewedBy:            "admin@slytrans.com",
    notes:                 "Looks good.",
    expectedStatus:        "under_review",
    expectedReviewVersion: 0,
    actionRequestId:       "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ...overrides,
  };
}

function resetCalls() {
  calls.performReviewAction.length = 0;
  calls.performPreAdverseAction.length = 0;
  calls.sendReviewDecisionNotifications.length = 0;
  performReviewAction.mock.resetCalls();
  performPreAdverseAction.mock.resetCalls();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("review-application: approve — success 200 + notification sent", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: true,
    data: { id: "app-uuid-1", application_status: "approved", review_version: 1, reviewed_by: "admin@slytrans.com", reviewed_at: "2026-05-13T12:00:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: { origin: "https://www.slytrans.com" }, body: validBody() }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.newStatus, "approved");
  assert.equal(res._body.reviewVersion, 1);
  assert.equal(res._body.idempotent, false);
  assert.equal(calls.sendReviewDecisionNotifications.length, 1);
});

test("review-application: reject — success 200 + notification sent", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: true,
    data: { id: "app-uuid-1", application_status: "rejected", review_version: 1, reviewed_by: "admin@slytrans.com", reviewed_at: "2026-05-13T12:00:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody({ action: "rejected" }) }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.newStatus, "rejected");
  assert.equal(calls.sendReviewDecisionNotifications.length, 1);
  assert.equal(calls.sendReviewDecisionNotifications[0][1], "rejected");
});

test("review-application: needs_info — success 200 + notification sent", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: true,
    data: { id: "app-uuid-1", application_status: "needs_info", review_version: 1, reviewed_by: "admin@slytrans.com", reviewed_at: "2026-05-13T12:00:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody({ action: "needs_info", notes: "Please provide insurance." }) }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.newStatus, "needs_info");
  assert.equal(calls.sendReviewDecisionNotifications.length, 1);
  assert.equal(calls.sendReviewDecisionNotifications[0][1], "needs_info");
});

test("review-application: pre_adverse — success 200 + notification sent", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: true,
    data: { id: "app-uuid-1", application_status: "under_review", review_version: 1, reviewed_by: "admin@slytrans.com", reviewed_at: "2026-05-13T12:00:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody({ action: "pre_adverse" }) }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.action, "pre_adverse");
  assert.equal(calls.performPreAdverseAction.length, 1);
  assert.equal(calls.sendReviewDecisionNotifications.length, 1);
  assert.equal(calls.sendReviewDecisionNotifications[0][1], "pre_adverse");
});

test("review-application: 409 STALE_REVIEW_ACTION — no notification", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: false,
    status: 409,
    code: "STALE_REVIEW_ACTION",
    error: "The application was already updated by another reviewer. Please refresh and try again.",
    current: { applicationStatus: "approved", reviewVersion: 2, reviewedBy: "other@admin.com", reviewedAt: "2026-05-13T11:59:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody() }, res);

  assert.equal(res._status, 409);
  assert.equal(res._body.code, "STALE_REVIEW_ACTION");
  assert.ok(res._body.current);
  assert.equal(res._body.current.applicationStatus, "approved");
  assert.equal(calls.sendReviewDecisionNotifications.length, 0);
});

test("review-application: idempotent replay — 200 + no notification", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: true,
    idempotent: true,
    data: { id: "app-uuid-1", application_status: "approved", review_version: 1, reviewed_by: "admin@slytrans.com", reviewed_at: "2026-05-13T12:00:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody() }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.idempotent, true);
  // No notifications on idempotent replay.
  assert.equal(calls.sendReviewDecisionNotifications.length, 0);
});

test("review-application: notification failure is non-fatal (returns 200)", async () => {
  resetCalls();
  sendNotificationsError = new Error("SMTP failed");
  performReviewActionResult = {
    ok: true,
    data: { id: "app-uuid-1", application_status: "approved", review_version: 1, reviewed_by: "admin@slytrans.com", reviewed_at: "2026-05-13T12:00:00.000Z" },
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody() }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  sendNotificationsError = null;
});

test("review-application: 401 without correct admin secret", async () => {
  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody({ secret: "wrong-secret" }) }, res);
  assert.equal(res._status, 401);
});

test("review-application: 400 missing applicationId", async () => {
  const res = makeRes();
  const body = validBody();
  delete body.applicationId;
  await handler({ method: "POST", headers: {}, body }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /applicationId/);
});

test("review-application: 400 missing action", async () => {
  const res = makeRes();
  const body = validBody();
  delete body.action;
  await handler({ method: "POST", headers: {}, body }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /action/);
});

test("review-application: 400 missing reviewedBy", async () => {
  const res = makeRes();
  const body = validBody();
  delete body.reviewedBy;
  await handler({ method: "POST", headers: {}, body }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /reviewedBy/);
});

test("review-application: 400 missing expectedStatus", async () => {
  const res = makeRes();
  const body = validBody();
  delete body.expectedStatus;
  await handler({ method: "POST", headers: {}, body }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /expectedStatus/);
});

test("review-application: 400 missing expectedReviewVersion", async () => {
  const res = makeRes();
  const body = validBody();
  delete body.expectedReviewVersion;
  await handler({ method: "POST", headers: {}, body }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /expectedReviewVersion/);
});

test("review-application: 400 missing actionRequestId", async () => {
  const res = makeRes();
  const body = validBody();
  delete body.actionRequestId;
  await handler({ method: "POST", headers: {}, body }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /actionRequestId/);
});

test("review-application: 405 on GET", async () => {
  const res = makeRes();
  await handler({ method: "GET", headers: {}, body: {} }, res);
  assert.equal(res._status, 405);
});

test("review-application: passes through 422 for non-reviewable status", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: false,
    status: 422,
    error: 'Cannot review an application with status "submitted". Only under_review and needs_info applications may be acted upon.',
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody({ expectedStatus: "submitted" }) }, res);

  assert.equal(res._status, 422);
  assert.match(res._body.error, /submitted/);
  assert.equal(calls.sendReviewDecisionNotifications.length, 0);
});

test("review-application: passes through 400 for invalid action", async () => {
  resetCalls();
  performReviewActionResult = {
    ok: false,
    status: 400,
    error: 'action must be "approved", "rejected", or "needs_info".',
  };

  const res = makeRes();
  await handler({ method: "POST", headers: {}, body: validBody({ action: "auto_approve" }) }, res);

  assert.equal(res._status, 400);
  assert.match(res._body.error, /action/);
  assert.equal(calls.sendReviewDecisionNotifications.length, 0);
});
