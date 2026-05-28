import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContractTransitionKpiMismatches } from "./v2-dashboard.js";

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
