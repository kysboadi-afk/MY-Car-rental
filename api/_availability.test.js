// Tests for api/_availability.js — parseDateTimeMs and hasDateTimeOverlap
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDateTimeMs, hasDateTimeOverlap, hasOverlap } from "./_availability.js";

// ─── parseDateTimeMs ─────────────────────────────────────────────────────────

test("parseDateTimeMs: date only returns midnight", () => {
  const ts = parseDateTimeMs("2026-03-27");
  const d = new Date(ts);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("parseDateTimeMs: 12-hour AM format", () => {
  const ts = parseDateTimeMs("2026-03-27", "9:00 AM");
  const d = new Date(ts);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
});

test("parseDateTimeMs: 12-hour PM format", () => {
  const ts = parseDateTimeMs("2026-03-27", "3:30 PM");
  const d = new Date(ts);
  assert.equal(d.getHours(), 15);
  assert.equal(d.getMinutes(), 30);
});

test("parseDateTimeMs: 12:00 PM is noon, not midnight", () => {
  const ts = parseDateTimeMs("2026-03-27", "12:00 PM");
  const d = new Date(ts);
  assert.equal(d.getHours(), 12);
});

test("parseDateTimeMs: 12:00 AM is midnight", () => {
  const ts = parseDateTimeMs("2026-03-27", "12:00 AM");
  const d = new Date(ts);
  assert.equal(d.getHours(), 0);
});

test("parseDateTimeMs: 24-hour format", () => {
  const ts = parseDateTimeMs("2026-03-27", "22:45");
  const d = new Date(ts);
  assert.equal(d.getHours(), 22);
  assert.equal(d.getMinutes(), 45);
});

test("parseDateTimeMs: returns NaN for missing date", () => {
  assert.ok(Number.isNaN(parseDateTimeMs(null)));
  assert.ok(Number.isNaN(parseDateTimeMs("")));
});

// ─── hasDateTimeOverlap ───────────────────────────────────────────────────────

// ── Back-to-back bookings (no overlap) ──────────────────────────────────────

test("hasDateTimeOverlap: back-to-back same day — no overlap", () => {
  // Existing: 9 AM – 5 PM; New: 6 PM – 11 PM
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "5:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "6:00 PM", "11:00 PM"), false);
});

test("hasDateTimeOverlap: new booking ends exactly when existing starts — no overlap", () => {
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "3:00 PM", toTime: "9:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "9:00 AM", "3:00 PM"), false);
});

test("hasDateTimeOverlap: new booking starts exactly when existing ends — no overlap", () => {
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "3:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "3:00 PM", "9:00 PM"), false);
});

// ── Actual overlaps ──────────────────────────────────────────────────────────

test("hasDateTimeOverlap: same time window — overlap", () => {
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "5:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "9:00 AM", "5:00 PM"), true);
});

test("hasDateTimeOverlap: new booking starts before existing ends — overlap", () => {
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "5:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "2:00 PM", "9:00 PM"), true);
});

test("hasDateTimeOverlap: new booking fully inside existing — overlap", () => {
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "8:00 AM", toTime: "8:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "10:00 AM", "2:00 PM"), true);
});

// ── Multi-day bookings ────────────────────────────────────────────────────────

test("hasDateTimeOverlap: multi-day with no time — separate weeks — no overlap", () => {
  const ranges = [{ from: "2026-03-01", to: "2026-03-07" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-08", "2026-03-14"), false);
});

test("hasDateTimeOverlap: multi-day with no time — adjacent days — no overlap", () => {
  // Existing ends March 7 (treated as midnight of March 8 = next day); New starts March 8 at midnight.
  // Boundary condition: rEnd == newStart → strict overlap (rEnd > newStart) is false → no conflict.
  const ranges = [{ from: "2026-03-01", to: "2026-03-07" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-08", "2026-03-14"), false);
});

test("hasDateTimeOverlap: multi-day — new overlaps start of existing — overlap", () => {
  const ranges = [{ from: "2026-03-05", to: "2026-03-10" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-03", "2026-03-06"), true);
});

test("hasDateTimeOverlap: multi-day with times — same day return/pickup no overlap", () => {
  // Existing: March 7 returned at 11 AM; New: March 7 pickup at 2 PM
  const ranges = [{ from: "2026-03-01", to: "2026-03-07", fromTime: "10:00 AM", toTime: "11:00 AM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-07", "2026-03-14", "2:00 PM", "10:00 AM"), false);
});

test("hasDateTimeOverlap: multi-day with times — return and pickup overlap — conflict", () => {
  // Existing: March 1-7, returns at 3 PM. New: starts March 7 at 10 AM (before 3 PM return)
  const ranges = [{ from: "2026-03-01", to: "2026-03-07", fromTime: "10:00 AM", toTime: "3:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-07", "2026-03-14", "10:00 AM", "10:00 AM"), true);
});

// ── Empty / edge cases ────────────────────────────────────────────────────────

test("hasDateTimeOverlap: empty ranges — no overlap", () => {
  assert.equal(hasDateTimeOverlap([], "2026-03-27", "2026-03-28"), false);
});

// ─── Legacy hasOverlap (date-only) still works ───────────────────────────────

test("hasOverlap: completely non-overlapping ranges — false", () => {
  const ranges = [{ from: "2026-03-01", to: "2026-03-07" }];
  assert.equal(hasOverlap(ranges, "2026-03-10", "2026-03-14"), false);
});

test("hasOverlap: ranges touch at endpoint — overlap", () => {
  const ranges = [{ from: "2026-03-01", to: "2026-03-07" }];
  assert.equal(hasOverlap(ranges, "2026-03-07", "2026-03-14"), true);
});
