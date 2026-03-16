// Tests for api/_pricing.js — computeAmount and computeProtectionPlanCost
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAmount, computeProtectionPlanCost } from "./_pricing.js";

// ─── Camry daily ────────────────────────────────────────────────────────────

test("camry: 1 day = $50", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-02"), 50);
});

test("camry: 6 days = 6 × $50 = $300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-07"), 300);
});

// ─── Camry weekly ($350/week) ────────────────────────────────────────────────

test("camry: 7 days = 1 × $350 weekly = $350", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-08"), 350);
});

test("camry: 10 days = 1 × $350 + 3 × $50 = $500", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-11"), 500);
});

test("camry: 13 days = 1 × $350 + 6 × $50 = $650", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-14"), 650);
});

// ─── Camry biweekly ($650/2 weeks) ───────────────────────────────────────────

test("camry: 14 days = 1 × $650 biweekly = $650", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-15"), 650);
});

test("camry: 16 days = 1 × $650 + 2 × $50 = $750", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-17"), 750);
});

test("camry: 28 days = 2 × $650 biweekly = $1300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-29"), 1300);
});

test("camry: 29 days = 2 × $650 + 1 × $50 = $1350", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-30"), 1350);
});

// ─── Camry monthly ($1300/month) ─────────────────────────────────────────────

test("camry: 30 days = 1 × $1300 monthly = $1300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-31"), 1300);
});

test("camry: 31 days = 1 × $1300 + 1 × $50 = $1350", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-01"), 1350);
});

test("camry: 37 days = 1 × $1300 + 1 × $350 weekly = $1650", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-07"), 1650);
});

test("camry: 60 days = 2 × $1300 monthly = $2600", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-30"), 2600);
});

// ─── Slingshot (no tiered rates, has deposit) ────────────────────────────────

test("slingshot: 1 day = $300 + $150 deposit = $450", () => {
  assert.equal(computeAmount("slingshot", "2025-07-01", "2025-07-02"), 450);
});

test("slingshot: 30 days = 30 × $300 + $150 deposit = $9150", () => {
  assert.equal(computeAmount("slingshot", "2025-07-01", "2025-07-31"), 9150);
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test("same-day (0-day gap) treated as 1 day minimum", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-01"), 50);
});

test("unknown vehicleId returns null", () => {
  assert.equal(computeAmount("unknown", "2025-07-01", "2025-07-05"), null);
});

// ─── Camry 2013 SE daily ─────────────────────────────────────────────────────

test("camry2013: 1 day = $55", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-02"), 55);
});

test("camry2013: 6 days = 6 × $55 = $330", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-07"), 330);
});

// ─── Camry 2013 SE weekly ($350/week) ────────────────────────────────────────

test("camry2013: 7 days = 1 × $350 weekly = $350", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-08"), 350);
});

test("camry2013: 10 days = 1 × $350 + 3 × $55 = $515", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-11"), 515);
});

// ─── Camry 2013 SE biweekly ($650/2 weeks) ───────────────────────────────────

test("camry2013: 14 days = 1 × $650 biweekly = $650", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-15"), 650);
});

test("camry2013: 16 days = 1 × $650 + 2 × $55 = $760", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-17"), 760);
});

// ─── Camry 2013 SE monthly ($1300/month) ─────────────────────────────────────

test("camry2013: 30 days = 1 × $1300 monthly = $1300", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-07-31"), 1300);
});

test("camry2013: 31 days = 1 × $1300 + 1 × $55 = $1355", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-08-01"), 1355);
});

test("camry2013: 37 days = 1 × $1300 + 1 × $350 weekly = $1650", () => {
  assert.equal(computeAmount("camry2013", "2025-07-01", "2025-08-07"), 1650);
});

// ─── Damage Protection Plan cost ─────────────────────────────────────────────

test("protection plan: 1 day = $15", () => {
  assert.equal(computeProtectionPlanCost(1), 15);
});

test("protection plan: 6 days = 6 × $15 = $90", () => {
  assert.equal(computeProtectionPlanCost(6), 90);
});

test("protection plan: 7 days = 1 × $75 weekly = $75", () => {
  assert.equal(computeProtectionPlanCost(7), 75);
});

test("protection plan: 8 days = 1 × $75 + 1 × $15 = $90", () => {
  assert.equal(computeProtectionPlanCost(8), 90);
});

test("protection plan: 30 days = 1 × $250 monthly = $250", () => {
  assert.equal(computeProtectionPlanCost(30), 250);
});

test("protection plan: 31 days = 1 × $250 + 1 × $15 = $265", () => {
  assert.equal(computeProtectionPlanCost(31), 265);
});

test("protection plan: 37 days = 1 × $250 + 1 × $75 = $325", () => {
  assert.equal(computeProtectionPlanCost(37), 325);
});
