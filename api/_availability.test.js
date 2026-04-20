// Tests for api/_availability.js — parseDateTimeMs and hasDateTimeOverlap
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDateTimeMs,
  hasDateTimeOverlap,
  hasOverlap,
  isDatesAndTimesAvailable,
  isDatesAvailable,
} from "./_availability.js";

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

test("hasDateTimeOverlap: back-to-back same day — 1-hour gap blocked by 2-hour buffer", () => {
  // Car returns at 5 PM; buffer end = 7 PM. New booking at 6 PM starts before 7 PM → blocked.
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "5:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "6:00 PM", "11:00 PM"), true);
});

test("hasDateTimeOverlap: new booking ends exactly when existing starts — no overlap", () => {
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "3:00 PM", toTime: "9:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "9:00 AM", "3:00 PM"), false);
});

test("hasDateTimeOverlap: new booking starts exactly when existing ends — blocked by 2-hour buffer", () => {
  // Car returns at 3 PM; buffer end = 5 PM. New booking at 3 PM starts before 5 PM → blocked.
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "3:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "3:00 PM", "9:00 PM"), true);
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

// ── 2-hour buffer behaviour ───────────────────────────────────────────────────

test("hasDateTimeOverlap: new booking starts exactly 2 hours after return — not blocked", () => {
  // Car returns 3 PM; buffer end = 5 PM. New pickup at 5 PM is allowed.
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "3:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "5:00 PM", "9:00 PM"), false);
});

test("hasDateTimeOverlap: new booking starts 2+ hours after return (same day) — no overlap", () => {
  // Car returns 5 PM; buffer end = 7 PM. New pickup at 7 PM is exactly the boundary — allowed.
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "9:00 AM", toTime: "5:00 PM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "7:00 PM", "11:00 PM"), false);
});

test("hasDateTimeOverlap: new booking starts within 2-hour buffer — blocked", () => {
  // Car returns 10 AM; buffer end = 12 PM. New pickup at 11 AM is within buffer → blocked.
  const ranges = [{ from: "2026-03-27", to: "2026-03-27", fromTime: "8:00 AM", toTime: "10:00 AM" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-27", "2026-03-27", "11:00 AM", "5:00 PM"), true);
});

test("hasDateTimeOverlap: buffer does NOT apply to date-only ranges — adjacent days allowed", () => {
  // Legacy date-only range ends March 7; new starts March 8 → no overlap (no buffer added).
  const ranges = [{ from: "2026-03-01", to: "2026-03-07" }];
  assert.equal(hasDateTimeOverlap(ranges, "2026-03-08", "2026-03-14"), false);
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

test("isDatesAvailable: camry2013 ignores blocked ranges (override enabled)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: Buffer.from(JSON.stringify({
        camry2013: [{ from: "2026-04-20", to: "2026-04-30" }],
      })).toString("base64"),
    }),
  });
  try {
    const available = await isDatesAvailable("camry2013", "2026-04-20", "2026-04-22");
    assert.equal(available, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isDatesAndTimesAvailable: non-override vehicles still honor blocked ranges", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: Buffer.from(JSON.stringify({
        camry: [{ from: "2026-04-20", to: "2026-04-30", fromTime: "9:00 AM", toTime: "10:00 AM" }],
      })).toString("base64"),
    }),
  });
  try {
    const available = await isDatesAndTimesAvailable("camry", "2026-04-20", "2026-04-22", "9:00 AM", "9:00 AM");
    assert.equal(available, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isDatesAndTimesAvailable: camry2013 ignores blocked ranges with times (override enabled)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: Buffer.from(JSON.stringify({
        camry2013: [{ from: "2026-04-20", to: "2026-04-30", fromTime: "9:00 AM", toTime: "10:00 AM" }],
      })).toString("base64"),
    }),
  });
  try {
    const available = await isDatesAndTimesAvailable("camry2013", "2026-04-20", "2026-04-22", "9:00 AM", "9:00 AM");
    assert.equal(available, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
