import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildOperatorLeadPipeline,
  buildContractTransitionKpiMismatches,
  buildManageBookingTransitionSummary,
  buildContractTransitionObservabilitySummary,
} from "./v2-dashboard.js";

test("buildOperatorLeadPipeline maps lead statuses and computes conversion rate", () => {
  const summary = buildOperatorLeadPipeline([
    { status: "new_lead" },
    { status: "contacted" },
    { status: "demo_scheduled" },
    { status: "onboarding" },
    { status: "active_operator" },
    { status: "active_operator" },
    { status: "rejected" },
    { status: "unknown" },
  ]);

  assert.deepEqual(summary, {
    newLeads: 1,
    contacted: 1,
    demoScheduled: 1,
    qualified: 1,
    converted: 2,
    closed: 1,
    totalLeads: 7,
    conversionRate: 28.6,
  });
});

test("buildOperatorLeadPipeline returns zeroed metrics for empty input", () => {
  assert.deepEqual(buildOperatorLeadPipeline(), {
    newLeads: 0,
    contacted: 0,
    demoScheduled: 0,
    qualified: 0,
    converted: 0,
    closed: 0,
    totalLeads: 0,
    conversionRate: 0,
  });
});

test("buildContractTransitionKpiMismatches reports available-vehicle and revenue drifts", () => {
  const mismatches = buildContractTransitionKpiMismatches({
    viewAvailableVehicles: 5,
    jsAvailableVehicles: 3,
    canonicalTotalRevenue: 1000,
    aggregatedTotalRevenue: 975.5,
  });

  assert.deepEqual(mismatches, [
    {
      metric: "available_vehicles",
      canonical: 5,
      legacy: 3,
      diff: 2,
      canonicalSource: "admin_metrics_v2",
      legacySource: "js_booking_loop",
    },
    {
      metric: "total_revenue",
      canonical: 1000,
      legacy: 975.5,
      diff: 24.5,
      canonicalSource: "total_revenue_kpi_canonical",
      legacySource: "revenue_aggregation_loop",
    },
  ]);
});

test("buildContractTransitionKpiMismatches ignores missing or within-tolerance values", () => {
  const mismatches = buildContractTransitionKpiMismatches({
    viewAvailableVehicles: 5,
    jsAvailableVehicles: 5,
    canonicalTotalRevenue: 1000,
    aggregatedTotalRevenue: 1000.009,
  });

  assert.deepEqual(mismatches, []);
});

test("buildManageBookingTransitionSummary reports stale-balance mismatches and fallback usage", () => {
  const summary = buildManageBookingTransitionSummary([
    {
      bookingId: "bk-1",
      status: "reserved",
      paymentStatus: "deposit_paid",
      totalPrice: 275,
      depositPaid: 100,
      remainingBalance: 0,
    },
    {
      bookingId: "bk-2",
      status: "reserved",
      paymentStatus: "deposit_paid",
      totalPrice: 275,
      depositPaid: 100,
      remainingBalance: 175,
    },
  ]);

  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.lifecycleMismatchCount, 1);
  assert.equal(summary.financialSnapshotDiffCount, 1);
  assert.deepEqual(summary.fallbackPathUsage, [
    {
      key: "remaining_balance_total_minus_paid",
      label: "remaining_balance_total_minus_paid",
      count: 1,
      module: "manage-booking",
      page: "Manage Booking",
      fallback: null,
      source: "effectiveBalanceDue",
    },
  ]);
  assert.equal(summary.eventUsage.synthetic, 1);
  assert.equal(summary.eventUsage.canonical, 1);
  assert.equal(summary.adoptionPercent, 50);
});

test("buildContractTransitionObservabilitySummary merges module progress and legacy surfaces", () => {
  const summary = buildContractTransitionObservabilitySummary({
    dashboardFallbackPaths: [
      { path: "financial_kpis", fallback: "bookings_derived_financials", reason: "canonical_reporting_unavailable" },
    ],
    dashboardUsesLegacyBookingLoop: true,
    dashboardFinancialSource: "bookings_derived_financials",
    kpiMismatches: [
      {
        metric: "total_revenue",
        canonical: 1000,
        legacy: 975.5,
        diff: 24.5,
        canonicalSource: "total_revenue_kpi_canonical",
        legacySource: "revenue_aggregation_loop",
      },
    ],
    manageBookingBookings: [
      {
        bookingId: "bk-1",
        status: "reserved",
        paymentStatus: "deposit_paid",
        totalPrice: 275,
        depositPaid: 100,
        remainingBalance: 0,
      },
      {
        bookingId: "bk-2",
        status: "reserved",
        paymentStatus: "deposit_paid",
        totalPrice: 275,
        depositPaid: 100,
        remainingBalance: 175,
      },
    ],
  });

  assert.equal(summary.summary.adoptionPercent, 20);
  assert.equal(summary.summary.openIssues, 3);
  assert.equal(summary.summary.fallbackEvents, 2);
  assert.deepEqual(summary.counts, {
    lifecycleMismatches: 1,
    financialSnapshotDiffs: 1,
    kpiAggregationMismatches: 1,
  });
  assert.deepEqual(summary.eventUsage, {
    synthetic: 3,
    canonical: 1,
  });
  assert.deepEqual(summary.moduleProgress, [
    {
      module: "dashboard",
      page: "Dashboard",
      adopted: 0,
      total: 3,
      adoptionPercent: 0,
      legacyDependencyCount: 2,
    },
    {
      module: "manage-booking",
      page: "Manage Booking",
      adopted: 1,
      total: 2,
      adoptionPercent: 50,
      legacyDependencyCount: 1,
    },
  ]);
  assert.deepEqual(summary.legacyDerivedSurfaces, [
    {
      key: "manage_booking_dashboard",
      label: "Manage Booking dashboard",
      count: 2,
      module: "manage-booking",
      page: "Manage Booking",
      fallback: null,
      source: null,
    },
    {
      key: "v2_dashboard_booking_count_loop",
      label: "Dashboard booking count loop",
      count: 1,
      module: "dashboard",
      page: "Dashboard",
      fallback: null,
      source: null,
    },
    {
      key: "v2_dashboard_financial_kpis",
      label: "Dashboard financial KPIs",
      count: 1,
      module: "dashboard",
      page: "Dashboard",
      fallback: null,
      source: null,
    },
  ]);
});
