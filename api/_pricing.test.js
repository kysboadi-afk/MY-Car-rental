// Tests for api/_pricing.js — computeAmount
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAmount } from "./_pricing.js";

// ─── Camry daily ────────────────────────────────────────────────────────────

test("camry: 1 day = $50", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-02"), 50);
});

test("camry: 6 days = 6 × $50 = $300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-07"), 300);
});

// ─── Camry weekly ($320/week) ────────────────────────────────────────────────

test("camry: 7 days = 1 × $320 weekly = $320", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-08"), 320);
});

test("camry: 10 days = 1 × $320 + 3 × $50 = $470", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-11"), 470);
});

test("camry: 13 days = 1 × $320 + 6 × $50 = $620", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-14"), 620);
});

// ─── Camry biweekly ($600/2 weeks) ───────────────────────────────────────────

test("camry: 14 days = 1 × $600 biweekly = $600", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-15"), 600);
});

test("camry: 16 days = 1 × $600 + 2 × $50 = $700", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-17"), 700);
});

test("camry: 28 days = 2 × $600 biweekly = $1200", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-29"), 1200);
});

test("camry: 29 days = 2 × $600 + 1 × $50 = $1250", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-30"), 1250);
});

// ─── Camry monthly ($1250/month) ─────────────────────────────────────────────

test("camry: 30 days = 1 × $1250 monthly = $1250", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-07-31"), 1250);
});

test("camry: 31 days = 1 × $1250 + 1 × $50 = $1300", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-01"), 1300);
});

test("camry: 37 days = 1 × $1250 + 1 × $320 weekly = $1570", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-07"), 1570);
});

test("camry: 60 days = 2 × $1250 monthly = $2500", () => {
  assert.equal(computeAmount("camry", "2025-07-01", "2025-08-30"), 2500);
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
