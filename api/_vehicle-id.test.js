// api/_vehicle-id.test.js
// Regression tests for _vehicle-id.js.
//
// Covers the critical bug where legacy DB records with vehicle_id="camry2012"
// were not being mapped to the canonical "camry" key, causing the dashboard
// to report 0 bookings / 0 revenue for the Camry 2012 vehicle.
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeVehicleId, uiVehicleId } from "./_vehicle-id.js";

// ── normalizeVehicleId ────────────────────────────────────────────────────────

test("normalizeVehicleId: canonical ID passes through unchanged", () => {
  assert.equal(normalizeVehicleId("camry"),     "camry");
  assert.equal(normalizeVehicleId("camry2013"), "camry2013");
  assert.equal(normalizeVehicleId("slingshot"), "slingshot");
});

test("normalizeVehicleId: display name resolves to canonical ID", () => {
  assert.equal(normalizeVehicleId("Camry 2012"),    "camry");
  assert.equal(normalizeVehicleId("Camry 2013 SE"), "camry2013");
});

test("normalizeVehicleId: legacy raw ID normalises to canonical", () => {
  // This was the source of the bug — Stripe webhook was deriving "camry2012"
  // from the vehicle name and storing it in the DB before normalisation was
  // added.  normalizeVehicleId must map it to "camry" before persistence.
  assert.equal(normalizeVehicleId("camry2012"), "camry");
});

test("normalizeVehicleId: empty / null input returns empty string", () => {
  assert.equal(normalizeVehicleId(""),    "");
  assert.equal(normalizeVehicleId(null),  "");
  assert.equal(normalizeVehicleId(undefined), "");
});

// ── uiVehicleId ───────────────────────────────────────────────────────────────

test("uiVehicleId: canonical DB ID passes through unchanged", () => {
  assert.equal(uiVehicleId("camry"),     "camry");
  assert.equal(uiVehicleId("camry2013"), "camry2013");
  assert.equal(uiVehicleId("slingshot"), "slingshot");
});

test("uiVehicleId: legacy DB ID 'camry2012' maps to canonical 'camry'", () => {
  // Critical regression test.
  // Legacy booking rows stored vehicle_id="camry2012".  uiVehicleId must
  // return "camry" so those bookings are grouped under the correct vehicle
  // in dashboard KPIs, vehicleStats, and alert generation.
  assert.equal(uiVehicleId("camry2012"), "camry");
});

test("uiVehicleId: empty / null input returns empty string", () => {
  assert.equal(uiVehicleId(""),        "");
  assert.equal(uiVehicleId(null),      "");
  assert.equal(uiVehicleId(undefined), "");
});

// ── round-trip: normalizeVehicleId ∘ uiVehicleId ─────────────────────────────

test("round-trip: uiVehicleId(normalizeVehicleId(x)) is idempotent for known IDs", () => {
  const inputs = ["camry", "camry2012", "Camry 2012", "camry2013", "Camry 2013 SE", "slingshot"];
  for (const input of inputs) {
    const canonical = normalizeVehicleId(input);
    const ui        = uiVehicleId(canonical);
    // After normalisation the ui ID must equal the canonical ID (no further
    // transformation expected for the IDs in use today).
    assert.equal(ui, canonical, `round-trip failed for input "${input}"`);
  }
});

// ── dashboard grouping regression ─────────────────────────────────────────────

test("dashboard grouping: legacy camry2012 bookings count towards 'camry' vehicle", () => {
  // Simulate what v2-dashboard.js does when it processes rows returned by
  // Supabase: it calls uiVehicleId() on vehicle_id to get the grouping key,
  // then checks whether that key is present in filteredVehicleIds (which
  // contains the vehicles.json keys — always "camry", never "camry2012").
  //
  // Before the fix: uiVehicleId("camry2012") returned "camry2012"
  //   → filteredVehicleIds.has("camry2012") === false
  //   → booking dropped → 0 bookings shown for Camry 2012
  //
  // After the fix: uiVehicleId("camry2012") returns "camry"
  //   → filteredVehicleIds.has("camry") === true
  //   → booking included ✓

  const filteredVehicleIds = new Set(["camry", "camry2013", "slingshot"]);

  // Legacy row from Supabase
  const row = { vehicle_id: "camry2012", deposit_paid: 150 };
  const resolvedId = uiVehicleId(row.vehicle_id);

  assert.equal(resolvedId, "camry", "resolved vehicle_id should be 'camry'");
  assert.ok(
    filteredVehicleIds.has(resolvedId),
    `resolved ID '${resolvedId}' must be present in filteredVehicleIds so the booking is not dropped`
  );
});

test("dashboard grouping: revenue records with legacy camry2012 aggregate under 'camry'", () => {
  // Simulates the rrByVehicle accumulation loop in v2-dashboard.js.
  const rrRows = [
    { vehicle_id: "camry",     gross_amount: 300, stripe_fee: 10, stripe_net: 290, is_cancelled: false, is_no_show: false },
    { vehicle_id: "camry2012", gross_amount: 200, stripe_fee:  8, stripe_net: 192, is_cancelled: false, is_no_show: false },
    { vehicle_id: "camry",     gross_amount: 250, stripe_fee:  9, stripe_net: 241, is_cancelled: false, is_no_show: false },
  ];

  const rrByVehicle = {};
  for (const r of rrRows) {
    if (r.is_cancelled || r.is_no_show) continue;
    const vid = uiVehicleId(r.vehicle_id);
    if (!rrByVehicle[vid]) rrByVehicle[vid] = { gross: 0, net: 0, count: 0 };
    rrByVehicle[vid].gross += r.gross_amount;
    rrByVehicle[vid].net   += r.stripe_net;
    rrByVehicle[vid].count += 1;
  }

  // All three rows must be aggregated under "camry" — none under "camry2012".
  assert.ok(!rrByVehicle["camry2012"], "no entry should remain under legacy key 'camry2012'");
  assert.equal(rrByVehicle["camry"].count, 3, "all 3 rows should be counted under 'camry'");
  assert.equal(rrByVehicle["camry"].gross, 750);
  assert.equal(rrByVehicle["camry"].net,   723);
});
