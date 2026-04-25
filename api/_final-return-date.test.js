// api/_final-return-date.test.js
// Unit tests for computeFinalReturnDate and buildDateTimeLA.
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDateTimeLA, computeFinalReturnDate, BUSINESS_TZ } from "./_final-return-date.js";

// ── buildDateTimeLA ───────────────────────────────────────────────────────────

test("buildDateTimeLA: returns NaN for missing date", () => {
  assert.ok(isNaN(buildDateTimeLA("", "10:00").getTime()));
  assert.ok(isNaN(buildDateTimeLA(null, "10:00").getTime()));
});

test("buildDateTimeLA: midnight when no time provided", () => {
  const d = buildDateTimeLA("2026-06-01", "");
  // 2026-06-01 00:00 PDT = 2026-06-01 07:00 UTC
  assert.equal(d.toISOString(), "2026-06-01T07:00:00.000Z");
});

test("buildDateTimeLA: 12-hour AM format (PST)", () => {
  // 2026-01-15 is in PST (UTC-8): 10:00 AM PST = 18:00 UTC
  const d = buildDateTimeLA("2026-01-15", "10:00 AM");
  assert.equal(d.toISOString(), "2026-01-15T18:00:00.000Z");
});

test("buildDateTimeLA: 12-hour PM format (PDT)", () => {
  // 2026-06-01 is in PDT (UTC-7): 5:00 PM PDT = 00:00 UTC next day
  const d = buildDateTimeLA("2026-06-01", "5:00 PM");
  assert.equal(d.toISOString(), "2026-06-02T00:00:00.000Z");
});

test("buildDateTimeLA: 24-hour HH:MM format (PDT)", () => {
  // 2026-04-01 is PDT (UTC-7): 17:00 PDT = 00:00 UTC next day
  const d = buildDateTimeLA("2026-04-01", "17:00");
  assert.equal(d.toISOString(), "2026-04-02T00:00:00.000Z");
});

test("buildDateTimeLA: 24-hour HH:MM:SS from Supabase (PDT)", () => {
  // 2026-05-10 is PDT: 10:00:00 PDT = 17:00 UTC
  const d = buildDateTimeLA("2026-05-10", "10:00:00");
  assert.equal(d.toISOString(), "2026-05-10T17:00:00.000Z");
});

test("buildDateTimeLA: PDT vs PST offset (DST boundary)", () => {
  // Before DST (PST, UTC-8): 2026-03-05 10:00 PST = 18:00 UTC
  const pst = buildDateTimeLA("2026-03-05", "10:00");
  assert.equal(pst.toISOString(), "2026-03-05T18:00:00.000Z");

  // After DST (PDT, UTC-7): 2026-04-01 10:00 PDT = 17:00 UTC
  const pdt = buildDateTimeLA("2026-04-01", "10:00");
  assert.equal(pdt.toISOString(), "2026-04-01T17:00:00.000Z");
});

test("BUSINESS_TZ export is America/Los_Angeles", () => {
  assert.equal(BUSINESS_TZ, "America/Los_Angeles");
});

// ── computeFinalReturnDate ────────────────────────────────────────────────────

function makeSb(extRecords = [], error = null) {
  return {
    from() {
      const chain = {
        select() { return this; },
        or()     { return this; },
        eq()     { return this; },
        async then(resolve) { return resolve({ data: extRecords, error }); },
      };
      return chain;
    },
  };
}

test("computeFinalReturnDate: returns base when sb is null", async () => {
  const result = await computeFinalReturnDate(null, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-10", time: "10:00" });
});

test("computeFinalReturnDate: returns base when bookingRef is missing", async () => {
  const sb = makeSb([{ return_date: "2026-05-20", return_time: "10:00:00" }]);
  const result = await computeFinalReturnDate(sb, null, "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-10", time: "10:00" });
});

test("computeFinalReturnDate: returns base when no extensions exist", async () => {
  const sb = makeSb([]); // no extension records
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-10", time: "10:00" });
});

test("computeFinalReturnDate: returns extension date when it is later", async () => {
  const sb = makeSb([{ return_date: "2026-05-17", return_time: "10:00:00" }]);
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-17", time: "10:00" });
});

test("computeFinalReturnDate: keeps base when extension date is earlier", async () => {
  const sb = makeSb([{ return_date: "2026-05-05", return_time: "10:00:00" }]);
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-10", time: "10:00" });
});

test("computeFinalReturnDate: returns the latest among multiple extensions", async () => {
  const sb = makeSb([
    { return_date: "2026-05-14", return_time: "10:00:00" },
    { return_date: "2026-05-21", return_time: "10:00:00" },
    { return_date: "2026-05-17", return_time: "10:00:00" },
  ]);
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-21", time: "10:00" });
});

test("computeFinalReturnDate: picks later time when extension date equals base date", async () => {
  const sb = makeSb([{ return_date: "2026-05-10", return_time: "17:00:00" }]);
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  // Same date but later time — extension time wins
  assert.deepEqual(result, { date: "2026-05-10", time: "17:00" });
});

test("computeFinalReturnDate: returns base when Supabase returns an error", async () => {
  const sb = makeSb(null, { message: "connection refused" });
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-10", time: "10:00" });
});

test("computeFinalReturnDate: returns base when Supabase throws", async () => {
  const sb = {
    from() {
      return {
        select() { return this; },
        or() { throw new Error("mock network error"); },
        eq() { return this; },
        async then() { throw new Error("mock network error"); },
      };
    },
  };
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-10", time: "10:00" });
});

test("computeFinalReturnDate: skips extension records with missing return_date", async () => {
  const sb = makeSb([
    { return_date: null,         return_time: "10:00:00" },
    { return_date: "2026-05-17", return_time: "10:00:00" },
  ]);
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-17", time: "10:00" });
});

test("computeFinalReturnDate: handles ISO timestamp return_date (trims to YYYY-MM-DD)", async () => {
  const sb = makeSb([{ return_date: "2026-05-17T00:00:00.000Z", return_time: "10:00:00" }]);
  const result = await computeFinalReturnDate(sb, "bk-001", "2026-05-10", "10:00");
  assert.deepEqual(result, { date: "2026-05-17", time: "10:00" });
});
