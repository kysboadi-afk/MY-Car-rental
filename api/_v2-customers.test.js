// api/_v2-customers.test.js
// Acceptance tests for the v2-customers sync action.
//
// Covers all six acceptance criteria:
//   A) Totals parity       — gross / net aggregate must match Revenue page formulas
//   B) No skipped rows     — every paid non-excluded row is counted in aggregation
//   C) Missing phone coverage — NULL/blank phone rows included via email/name fallback
//   D) No duplicate splits — un-normalized phones and case-different emails merge
//   E) Refund consistency  — refund_amount reduces net by the correct amount
//   F) Determinism         — two consecutive syncs produce identical totals
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-secret";
process.env.GITHUB_TOKEN = "test-github-token";

// ─── Shared mutable state ─────────────────────────────────────────────────────

// rrRows is the set of rows returned by revenue_records_effective.
// null → Supabase not configured; [] → configured + empty; [...] → has data.
let rrRows = null;

// customers db (what was upserted/inserted)
let customersDb = [];

// log lines emitted by console.log during the last handler call
let logLines = [];

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => {
      if (rrRows === null) return null;

      // Build a minimal fluent Supabase mock.
      // We track every upsert/insert/update so tests can inspect the result.
      function makeQuery(rows) {
        const q = {
          _data:    rows,
          _filters: [],
          select()           { return this; },
          eq(col, val)       { this._filters.push({ type: "eq",    col, val }); return this; },
          is(col, val)       { this._filters.push({ type: "is",    col, val }); return this; },
          ilike(col, val)    { this._filters.push({ type: "ilike", col, val }); return this; },
          not()              { return this; },
          like()             { return this; },
          in()               { return this; },
          order()            { return this; },
          limit()            { return this; },
          maybeSingle() {
            const row = (this._data || []).find((r) => {
              return this._filters.every((f) => {
                if (f.type === "eq")    return String(r[f.col] ?? "") === String(f.val ?? "");
                if (f.type === "is")    return (r[f.col] ?? null) === f.val;
                if (f.type === "ilike") return String(r[f.col] ?? "").toLowerCase() === String(f.val ?? "").toLowerCase();
                return true;
              });
            }) || null;
            this._data = row;
            return this;
          },
          then(resolve) {
            // When used as a Promise (e.g. .limit(1) without .maybeSingle()),
            // apply ilike/eq filters and return a data array.
            const filtered = (rows || []).filter((r) => {
              return this._filters.every((f) => {
                if (f.type === "eq")    return String(r[f.col] ?? "") === String(f.val ?? "");
                if (f.type === "is")    return (r[f.col] ?? null) === f.val;
                if (f.type === "ilike") return String(r[f.col] ?? "").toLowerCase() === String(f.val ?? "").toLowerCase();
                return true;
              });
            });
            return Promise.resolve({ data: filtered, error: null }).then(resolve);
          },
        };
        return q;
      }

      return {
        from: (table) => {
          if (table === "revenue_records_effective") {
            return {
              select: () => ({ eq: () => Promise.resolve({ data: rrRows, error: null }) }),
            };
          }
          if (table === "customers") {
            return {
              select: (..._args) => makeQuery(customersDb),
              upsert: async (rows, _opts) => {
                for (const row of rows) {
                  const idx = customersDb.findIndex((c) => c.phone && c.phone === row.phone);
                  if (idx !== -1) {
                    Object.assign(customersDb[idx], row);
                  } else {
                    customersDb.push({ id: `id-${customersDb.length}`, ...row });
                  }
                }
                return { error: null };
              },
              insert: async (row) => {
                customersDb.push({ id: `id-${customersDb.length}`, ...row });
                return { error: null };
              },
              update: (updates) => ({
                eq: async (_col, _val) => {
                  // Non-fatal patch path — not critical for totals tests
                  return { error: null };
                },
              }),
              delete: () => ({ in: async () => ({ error: null }) }),
            };
          }
          // bookings table — return empty so bookings-count patch is a no-op
          return {
            select: () => ({
              not: () => ({
                not: () => Promise.resolve({ data: [], error: null }),
              }),
              in: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        },
      };
    },
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:  async () => ({ data: {}, sha: null }),
    saveBookings:  async () => {},
    normalizePhone: (phone) => {
      if (!phone) return phone;
      if (/^\+\d{7,15}$/.test(phone)) return phone;
      const digits = phone.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
      return phone;
    },
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (e) => String(e?.message ?? e),
    isSchemaError:     () => false,
  },
});

mock.module("./_expenses.js", {
  namedExports: {
    loadExpenses: async () => ({ data: [], error: null }),
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha, message);
    },
  },
});

mock.module("node:crypto", {
  namedExports: { randomUUID: () => "00000000-0000-0000-0000-000000000001" },
});

global.fetch = async () => ({ ok: false, status: 404, text: async () => "Not Found" });

// ─── Import handler (must come after mocks) ───────────────────────────────────
const { default: handler } = await import("./v2-customers.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(body) {
  return { method: "POST", headers: { origin: "https://www.slytrans.com" }, body };
}

function makeRes() {
  return {
    _status: 200,
    _body:   null,
    setHeader() {},
    status(c)  { this._status = c; return this; },
    json(b)    { this._body = b;  return this; },
    send(b)    { this._body = b;  return this; },
    end()      { return this; },
  };
}

function resetState() {
  rrRows      = null;
  customersDb = [];
  logLines    = [];
}

/** Call sync and capture console.log output. */
async function runSync() {
  logLines = [];
  const orig = console.log;
  console.log = (...args) => { logLines.push(args.join(" ")); };
  const res = makeRes();
  await handler(makeReq({ secret: "test-secret", action: "sync" }), res);
  console.log = orig;
  return res;
}

/** Parse the aggregation log line emitted by the sync handler. */
function parseAggLog() {
  const line = logLines.find((l) => l.includes("v2-customers sync aggregation"));
  if (!line) return null;
  // Prefix each key with a space so "net_total" doesn't match inside "stripe_net_total".
  // Use [-\d.]+ to handle negative values (e.g. net after a large refund).
  const extract = (key) => {
    const m = line.match(new RegExp(` ${key}=([-\\d.]+)`));
    return m ? Number(m[1]) : null;
  };
  return {
    row_count:        Number((line.match(/row_count=(\d+)/) || [])[1] ?? "0"),
    gross_total:      extract("gross_total"),
    stripe_fee_total: extract("stripe_fee_total"),
    stripe_net_total: extract("stripe_net_total"),
    net_total:        extract("net_total"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A) TOTALS PARITY
// ═══════════════════════════════════════════════════════════════════════════════
test("A) totals parity: net formula matches (stripe_net ?? gross-fee) - refund_amount", async () => {
  resetState();
  rrRows = [
    // Record with explicit stripe_net
    { customer_phone: "+13105550001", customer_name: "Alice", customer_email: "alice@x.com",
      gross_amount: 300, stripe_fee: 9.57, stripe_net: 290.43, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-01", return_date: "2026-01-03", vehicle_id: "camry" },
    // Record without stripe_net — should fall back to gross - fee
    { customer_phone: "+14075550002", customer_name: "Bob", customer_email: "bob@x.com",
      gross_amount: 150, stripe_fee: 4.65, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-02-01", return_date: "2026-02-02", vehicle_id: "camry" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);

  const agg = parseAggLog();
  assert.ok(agg, "aggregation log must be present");

  // Canonical net: (stripe_net ?? gross-fee) - refund
  const expectedNet = (290.43 - 0) + (150 - 4.65 - 0);  // 290.43 + 145.35 = 435.78
  assert.equal(agg.gross_total, 450,   "gross should be sum of gross_amount");
  assert.equal(agg.net_total,   Math.round(expectedNet * 100) / 100, "net must use canonical formula");
  assert.equal(agg.row_count,   2, "both rows counted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// B) NO SKIPPED ROWS
// ═══════════════════════════════════════════════════════════════════════════════
test("B) no skipped rows: all paid non-excluded rows are counted (row_count matches input)", async () => {
  resetState();
  rrRows = [
    { customer_phone: "+13105550001", customer_name: "Alice", customer_email: null,
      gross_amount: 100, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-01", return_date: "2026-01-02", vehicle_id: "camry" },
    { customer_phone: null, customer_name: "Bob", customer_email: "bob@x.com",
      gross_amount: 200, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-02-01", return_date: "2026-02-02", vehicle_id: "camry" },
    { customer_phone: null, customer_name: "Carol With No Email", customer_email: null,
      gross_amount: 50, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-03-01", return_date: "2026-03-02", vehicle_id: "camry" },
    // cancelled — should NOT count in valid/aggregation
    { customer_phone: "+13105550001", customer_name: "Alice", customer_email: null,
      gross_amount: 300, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: true, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-04-01", return_date: "2026-04-02", vehicle_id: "camry" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);

  const agg = parseAggLog();
  assert.ok(agg, "aggregation log must be present");
  // 3 valid (non-cancelled) rows across the 4 rrRows
  assert.equal(agg.row_count, 3, "row_count must equal non-cancelled valid rows");
  assert.equal(agg.gross_total, 350, "gross should sum only non-cancelled rows");
});

// ═══════════════════════════════════════════════════════════════════════════════
// C) MISSING PHONE COVERAGE
// ═══════════════════════════════════════════════════════════════════════════════
test("C) missing phone: phone-null rows are included via email fallback", async () => {
  resetState();
  rrRows = [
    { customer_phone: null, customer_name: "No Phone Guy", customer_email: "nophone@x.com",
      gross_amount: 400, stripe_fee: 12, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-10", return_date: "2026-01-12", vehicle_id: "camry" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 1, "email-only customer should be synced");

  const agg = parseAggLog();
  assert.ok(agg);
  assert.equal(agg.gross_total, 400, "revenue from phone-null row must not be lost");
  assert.equal(agg.row_count,   1);
});

test("C) missing phone: phone-null AND email-null rows included via name fallback", async () => {
  resetState();
  rrRows = [
    { customer_phone: null, customer_name: "Ghost Customer", customer_email: null,
      gross_amount: 75, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-03-01", return_date: "2026-03-02", vehicle_id: "slingshot" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 1, "name-only customer should be synced");

  const agg = parseAggLog();
  assert.ok(agg);
  assert.equal(agg.gross_total, 75);
  assert.equal(agg.row_count,   1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// D) NO DUPLICATE SPLITS
// ═══════════════════════════════════════════════════════════════════════════════
test("D) no duplicate splits: un-normalized phones merge into one customer", async () => {
  resetState();
  rrRows = [
    // Phone "3463814616" (no country code) — should normalize to +13463814616
    { customer_phone: "3463814616", customer_name: "Same Person",
      customer_email: "same@x.com",
      gross_amount: 100, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-01", return_date: "2026-01-02", vehicle_id: "camry" },
    // Same person, already normalized
    { customer_phone: "+13463814616", customer_name: "Same Person",
      customer_email: "same@x.com",
      gross_amount: 200, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-02-01", return_date: "2026-02-02", vehicle_id: "camry" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 1, "two phone variants must collapse into ONE customer");
  assert.equal(customersDb.length, 1, "only one customer row in DB");
  assert.equal(customersDb[0].total_gross_revenue, 300, "combined gross must be 300");
});

test("D) no duplicate splits: emails with different case merge into one customer", async () => {
  resetState();
  rrRows = [
    { customer_phone: null, customer_name: "Email Case Person",
      customer_email: "User@Example.COM",
      gross_amount: 150, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-01", return_date: "2026-01-02", vehicle_id: "camry" },
    { customer_phone: null, customer_name: "Email Case Person",
      customer_email: "user@example.com",
      gross_amount: 50, stripe_fee: 0, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-02-01", return_date: "2026-02-02", vehicle_id: "camry" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 1, "case-differing emails must collapse into ONE customer");

  const agg = parseAggLog();
  assert.ok(agg);
  assert.equal(agg.gross_total, 200, "combined gross from both email-variant rows");
  assert.equal(agg.row_count,   2);
});

// ═══════════════════════════════════════════════════════════════════════════════
// E) REFUND CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════════
test("E) refund consistency: refund_amount=300 reduces net_total by 300", async () => {
  resetState();
  rrRows = [
    { customer_phone: "+13105550001", customer_name: "Refund Alice",
      customer_email: "alice@x.com",
      gross_amount: 500, stripe_fee: 15.45, stripe_net: 484.55, refund_amount: 300,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-01", return_date: "2026-01-03", vehicle_id: "camry" },
  ];

  const res = await runSync();
  assert.equal(res._status, 200);

  const agg = parseAggLog();
  assert.ok(agg);

  // net = stripe_net(484.55) - refund(300) = 184.55
  const expectedNet = 484.55 - 300;
  assert.equal(agg.net_total,   Math.round(expectedNet * 100) / 100, "net must subtract refund");
  assert.equal(agg.gross_total, 500, "gross is unaffected by refund_amount");
  assert.equal(agg.row_count,   1);

  // The saved customer row must also reflect the deducted net
  assert.equal(customersDb.length, 1);
  assert.equal(customersDb[0].total_net_revenue, Math.round(expectedNet * 100) / 100);
});

// ═══════════════════════════════════════════════════════════════════════════════
// F) DETERMINISM
// ═══════════════════════════════════════════════════════════════════════════════
test("F) determinism: running sync twice produces identical totals", async () => {
  resetState();
  rrRows = [
    { customer_phone: "+13105550001", customer_name: "Alice", customer_email: "alice@x.com",
      gross_amount: 300, stripe_fee: 9.57, stripe_net: 290.43, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-01-01", return_date: "2026-01-03", vehicle_id: "camry" },
    { customer_phone: "+14075550002", customer_name: "Bob", customer_email: "bob@x.com",
      gross_amount: 150, stripe_fee: 4.65, stripe_net: null, refund_amount: 0,
      is_cancelled: false, is_no_show: false, payment_status: "paid",
      pickup_date: "2026-02-01", return_date: "2026-02-02", vehicle_id: "camry" },
  ];

  const res1 = await runSync();
  const agg1 = parseAggLog();

  // Second run (state of customersDb carries over but rrRows stays the same)
  const res2 = await runSync();
  const agg2 = parseAggLog();

  assert.equal(res1._status, 200);
  assert.equal(res2._status, 200);
  assert.ok(agg1 && agg2, "both runs must emit aggregation log");

  assert.equal(agg1.gross_total,      agg2.gross_total,      "gross_total idempotent");
  assert.equal(agg1.stripe_fee_total, agg2.stripe_fee_total, "stripe_fee_total idempotent");
  assert.equal(agg1.stripe_net_total, agg2.stripe_net_total, "stripe_net_total idempotent");
  assert.equal(agg1.net_total,        agg2.net_total,        "net_total idempotent");
  assert.equal(agg1.row_count,        agg2.row_count,        "row_count idempotent");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auth guard
// ═══════════════════════════════════════════════════════════════════════════════
test("auth: wrong secret is rejected with 401", async () => {
  resetState();
  const res = makeRes();
  await handler(makeReq({ secret: "bad-secret", action: "sync" }), res);
  assert.equal(res._status, 401);
});
