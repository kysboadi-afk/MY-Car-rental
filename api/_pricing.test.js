// Tests for api/_pricing.js — computeAmount, computeSlingshotAmount, and computeProtectionPlanCost
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAmount, computeProtectionPlanCost, computeSlingshotAmount } from "./_pricing.js";

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

// ─── Slingshot hourly tiers (deposit always $150) ────────────────────────────

test("slingshot: 3 hours = $200 + $150 deposit = $350", () => {
  assert.equal(computeSlingshotAmount(3), 350);
});

test("slingshot: 6 hours = $250 + $150 deposit = $400", () => {
  assert.equal(computeSlingshotAmount(6), 400);
});

test("slingshot: 24 hours = $350 + $150 deposit = $500", () => {
  assert.equal(computeSlingshotAmount(24), 500);
});

test("slingshot: invalid duration returns null", () => {
  assert.equal(computeSlingshotAmount(12), null);
  assert.equal(computeSlingshotAmount(0), null);
  assert.equal(computeSlingshotAmount(300), null);
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
// Rates: $13/day (derived) · $85/week · $150/2-week · $295/month

test("protection plan: 1 day = $13", () => {
  assert.equal(computeProtectionPlanCost(1), 13);
});

test("protection plan: 6 days = 6 × $13 = $78", () => {
  assert.equal(computeProtectionPlanCost(6), 78);
});

test("protection plan: 7 days = 1 × $85 weekly = $85", () => {
  assert.equal(computeProtectionPlanCost(7), 85);
});

test("protection plan: 8 days = 1 × $85 + 1 × $13 = $98", () => {
  assert.equal(computeProtectionPlanCost(8), 98);
});

test("protection plan: 14 days = 1 × $150 biweekly = $150", () => {
  assert.equal(computeProtectionPlanCost(14), 150);
});

test("protection plan: 15 days = 1 × $150 + 1 × $13 = $163", () => {
  assert.equal(computeProtectionPlanCost(15), 163);
});

test("protection plan: 30 days = 1 × $295 monthly = $295", () => {
  assert.equal(computeProtectionPlanCost(30), 295);
});

test("protection plan: 31 days = 1 × $295 + 1 × $13 = $308", () => {
  assert.equal(computeProtectionPlanCost(31), 308);
});

test("protection plan: 37 days = 1 × $295 + 1 × $85 weekly = $380", () => {
  assert.equal(computeProtectionPlanCost(37), 380);
});
