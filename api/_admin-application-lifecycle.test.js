import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import {
  buildApplicationLifecycleSummary,
  compareApplicationQueueRecords,
  getApplicationAttentionFlags,
  getApplicationQueuePriority,
  getDefaultApplicationQueueSort,
  matchesApplicationLifecycleFilter,
} from "./_renter-applications.js";

test("buildApplicationLifecycleSummary counts lifecycle filters and new applications consistently", () => {
  const now = Date.parse("2026-05-18T12:00:00.000Z");
  const records = [
    {
      id: "app-submitted-new",
      application_status: "submitted",
      identity_status: "not_started",
      checkr_report_status: null,
      submitted_at: "2026-05-18T11:30:00.000Z",
      reviewed_at: null,
    },
    {
      id: "app-under-review-verified",
      application_status: "under_review",
      identity_status: "verified",
      checkr_report_status: "pending",
      submitted_at: "2026-05-17T11:00:00.000Z",
      reviewed_at: "2026-05-17T11:30:00.000Z",
    },
    {
      id: "app-needs-info",
      application_status: "needs_info",
      identity_status: "processing",
      checkr_report_status: "consider",
      submitted_at: "2026-05-16T11:00:00.000Z",
      reviewed_at: "2026-05-16T12:00:00.000Z",
    },
    {
      id: "app-approved",
      application_status: "approved",
      identity_status: "verified",
      checkr_report_status: "clear",
      submitted_at: "2026-05-15T11:00:00.000Z",
      reviewed_at: "2026-05-15T16:00:00.000Z",
    },
    {
      id: "app-rejected",
      application_status: "rejected",
      identity_status: "verified",
      checkr_report_status: "consider",
      submitted_at: "2026-05-14T11:00:00.000Z",
      reviewed_at: "2026-05-14T15:00:00.000Z",
    },
    {
      id: "app-archived",
      application_status: "withdrawn",
      identity_status: "canceled",
      checkr_report_status: null,
      submitted_at: "2026-05-13T11:00:00.000Z",
      reviewed_at: "2026-05-13T12:00:00.000Z",
    },
  ];

  const summary = buildApplicationLifecycleSummary(records, now);

  assert.equal(summary.total, 6);
  assert.equal(summary.reviewQueueTotal, 3);
  assert.equal(summary.submitted, 1);
  assert.equal(summary.underReview, 1);
  assert.equal(summary.needsInfo, 1);
  assert.equal(summary.identityVerified, 1);
  assert.equal(summary.checkrPending, 1);
  assert.equal(summary.checkrConsider, 1);
  assert.equal(summary.checkrIssue, 1);
  assert.equal(summary.approved, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.archived, 1);
  assert.equal(summary.newApplications, 1);
  assert.equal(summary.analytics.approvalRate, 0.5);
  assert.equal(summary.analytics.rejectionRate, 0.5);
  assert.equal(summary.analytics.funnel.identityVerified, 1);
});

test("getApplicationAttentionFlags marks last hour and unreviewed submissions", () => {
  const flags = getApplicationAttentionFlags({
    application_status: "submitted",
    submitted_at: "2026-05-18T11:30:00.000Z",
    reviewed_at: null,
  }, Date.parse("2026-05-18T12:00:00.000Z"));

  assert.equal(flags.isRecentHour, true);
  assert.equal(flags.isRecentDay, true);
  assert.equal(flags.isUnreviewed, true);
  assert.equal(flags.isNewAttention, true);
});

test("matchesApplicationLifecycleFilter treats declined alias and archived states correctly", () => {
  const rejectedRecord = { application_status: "rejected", identity_status: "verified", checkr_report_status: "consider" };
  const archivedRecord = { application_status: "expired", identity_status: "failed", checkr_report_status: null };
  const verifiedRecord = { application_status: "under_review", identity_status: "verified", checkr_report_status: null };
  const queuedRecord = { application_status: "submitted", identity_status: "not_started", checkr_report_status: null };
  const checkrFailedRecord = { application_status: "under_review", identity_status: "verified", checkr_report_status: "failed" };

  assert.equal(matchesApplicationLifecycleFilter(rejectedRecord, "declined"), true);
  assert.equal(matchesApplicationLifecycleFilter(archivedRecord, "archived"), true);
  assert.equal(matchesApplicationLifecycleFilter(verifiedRecord, "identity_verified"), true);
  assert.equal(matchesApplicationLifecycleFilter(queuedRecord, "in_queue"), true);
  assert.equal(matchesApplicationLifecycleFilter(rejectedRecord, "checkr_consider"), false);
  assert.equal(matchesApplicationLifecycleFilter({ application_status: "under_review", identity_status: "verified", checkr_report_status: "consider" }, "checkr_consider"), true);
  assert.equal(matchesApplicationLifecycleFilter(checkrFailedRecord, "checkr_issue"), true);
});

test("queue sorting keeps operational priority deterministic", () => {
  const underReview = {
    id: "a-app",
    application_status: "under_review",
    submitted_at: "2026-05-18T09:00:00.000Z",
    updated_at: "2026-05-18T09:30:00.000Z",
  };
  const submitted = {
    id: "b-app",
    application_status: "submitted",
    submitted_at: "2026-05-18T10:00:00.000Z",
    updated_at: "2026-05-18T10:10:00.000Z",
  };
  const approved = {
    id: "c-app",
    application_status: "approved",
    submitted_at: "2026-05-18T11:00:00.000Z",
    reviewed_at: "2026-05-18T11:30:00.000Z",
    updated_at: "2026-05-18T11:30:00.000Z",
  };

  const ordered = [approved, submitted, underReview].sort((left, right) => compareApplicationQueueRecords(left, right, {
    sortField: "priority",
    sortDir: "asc",
  }));

  assert.deepEqual(ordered.map((record) => record.id), ["a-app", "b-app", "c-app"]);
  assert.equal(getApplicationQueuePriority(underReview) < getApplicationQueuePriority(approved), true);
});

test("approved and rejected filters default to newest reviewed first", () => {
  assert.deepEqual(getDefaultApplicationQueueSort("approved"), { sortField: "reviewed_at", sortDir: "desc" });
  assert.deepEqual(getDefaultApplicationQueueSort("rejected"), { sortField: "reviewed_at", sortDir: "desc" });
  assert.deepEqual(getDefaultApplicationQueueSort("", "new"), { sortField: "submitted_at", sortDir: "desc" });
});

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `Expected function ${functionName} to exist in admin-v2/index.html`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `Expected body for function ${functionName}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract function ${functionName}`);
}

async function loadDemoQueueFunctionContext() {
  const htmlPath = path.join(process.cwd(), "admin-v2", "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  const snippet = [
    extractFunctionSource(html, "demoNormalizeQueueItem"),
    extractFunctionSource(html, "demoBuildQueueSummary"),
    extractFunctionSource(html, "normalizeDemoQueuePayload"),
  ].join("\n");

  const context = {
    APP_QUEUE_SIZE: 50,
    appQueueState: { page: 1 },
    Date,
    Number,
    Math,
    String,
    Array,
    console,
    buildDemoReviewQueueResponse: () => ({
      applications: [
        {
          id: "demo-app-seeded",
          name: "Seeded Demo Applicant",
          phone: "(555) 010-2999",
          applicationStatus: "submitted",
          identityStatus: "processing",
          submittedAt: "2026-05-18T11:30:00.000Z",
          updatedAt: "2026-05-18T11:45:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
      summary: {},
      filters: {},
    }),
  };
  vm.createContext(context);
  vm.runInContext(snippet, context);
  return context;
}

test("demo queue payload normalization guarantees array response and seeded fallback", async () => {
  const context = await loadDemoQueueFunctionContext();
  const payload = context.normalizeDemoQueuePayload({ applications: null, total: null }, 1);
  assert.equal(Array.isArray(payload.applications), true);
  assert.equal(payload.applications.length > 0, true);
  assert.equal(typeof payload.applications[0].id, "string");
  assert.equal(payload.success, true);
});

test("demo queue payload normalization tolerates malformed records without throwing", async () => {
  const context = await loadDemoQueueFunctionContext();
  const payload = context.normalizeDemoQueuePayload({
    applications: [null, {}, { id: 42, name: "", phone: null, submittedAt: "bad-date", applicationStatus: "under_review" }],
    total: "abc",
  }, 3);
  assert.equal(Array.isArray(payload.applications), true);
  assert.equal(payload.applications.length, 3);
  assert.equal(payload.page, 3);
  payload.applications.forEach((row) => {
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.name, "string");
    assert.equal(typeof row.phone, "string");
  });
});

test("demo queue summary keeps review queue counters usable for rendering", async () => {
  const context = await loadDemoQueueFunctionContext();
  const summary = context.demoBuildQueueSummary([
    { applicationStatus: "submitted", identityStatus: "processing", checkrReportStatus: "pending" },
    { applicationStatus: "under_review", identityStatus: "verified", checkrReportStatus: "consider" },
    { applicationStatus: "needs_info", identityStatus: "requires_input", checkrReportStatus: "not_started" },
    { applicationStatus: "approved", identityStatus: "verified", checkrReportStatus: "clear" },
    { applicationStatus: "rejected", identityStatus: "verified", checkrReportStatus: "consider" },
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.reviewQueueTotal, 3);
  assert.equal(summary.underReview, 1);
  assert.equal(summary.needsInfo, 1);
  assert.equal(summary.approved, 1);
  assert.equal(summary.rejected, 1);
});
