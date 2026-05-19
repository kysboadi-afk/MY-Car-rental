// api/_v2-revenue-reconciliation.test.js
// Tests for POST /api/v2-revenue-reconciliation.
//
// Validates:
//   1. auth: rejects wrong secret with 401
//   2. auth: rejects missing secret with 401
//   3. audit: returns empty rows when Supabase is not configured
//   4. audit: returns rows from revenue_reconciliation_audit view
//   5. audit: filters by source_table
//   6. audit: filters by included_only=true (included_in_dashboard=true only)
//   7. audit: filters by vehicle_id
//   8. audit: filters by booking_id
//   9. audit: summary block totals gross/net/fees/refunds correctly
//  10. audit: summary separates included vs excluded rows
//  11. audit: by_source breaks down revenue_records vs charges
//  12. summary action: returns aggregated summary only (no rows key)
//  13. audit: Supabase schema error → empty/zero graceful fallback
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-admin-secret";

// ─── Shared mutable state ─────────────────────────────────────────────────────
let supabaseRows  = null; // null = not configured
let supabaseError = null; // non-null = view query error

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => {
      if (supabaseRows === null) return null;

      // Fluent builder simulating .from().select().eq().order().range()
      function makeQuery(baseRows) {
        const q = {
          _rows:  baseRows,
          _error: supabaseError,
          select()  { return this; },
          order()   { return this; },
          eq(col, val) {
            if (this._rows) {
              this._rows = this._rows.filter((r) => String(r[col]) === String(val));
            }
            return this;
          },
          range(from, to) {
            if (this._rows) this._rows = this._rows.slice(from, to + 1);
            return this;
          },
          then(onFulfilled) {
            return Promise.resolve({ data: this._rows, error: this._error }).then(onFulfilled);
          },
          catch(onRejected) {
            return Promise.resolve({ data: this._rows, error: this._error }).catch(onRejected);
          },
        };
        return q;
      }

      return {
        from: (_table) => ({
          select: () => makeQuery([...(supabaseRows || [])]),
        }),
      };
    },
  },
});

// ─── Import handler (after mocks) ─────────────────────────────────────────────
const { default: handler } = await import("./v2-revenue-reconciliation.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeRes() {
  return {
    _status: 200,
    _body:   null,
    setHeader() {},
    status(c)  { this._status = c; return this; },
    json(b)    { this._body = b;   return this; },
    send(b)    { this._body = b;   return this; },
    end()      { return this; },
  };
}

function makeReq(body) {
  return { method: "POST", headers: { origin: "https://slycarrentals.com" }, body };
}

/** A canonical audit row (included in all surfaces). */
function canonicalRow(overrides = {}) {
  return {
    booking_id: "bk-1",
    vehicle_id: "camry",
    payment_intent_id: "pi_1",
    gross: 300,
    fees: 9,
    refunds: 0,
    net: 291,
    source_table: "revenue_records",
    included_in_dashboard: true,
    included_in_revenue_page: true,
    included_in_fleet_analytics: true,
    ...overrides,
  };
}

function reset() {
  supabaseRows  = null;
  supabaseError = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. AUTH — wrong secret
// ═══════════════════════════════════════════════════════════════════════════════
test("auth: rejects wrong secret with 401", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({ secret: "wrong" }), res);
  assert.equal(res._status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AUTH — missing secret
// ═══════════════════════════════════════════════════════════════════════════════
test("auth: rejects missing secret with 401", async () => {
  reset();
  const res = makeRes();
  await handler(makeReq({}), res);
  assert.equal(res._status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. AUDIT — Supabase not configured → graceful empty response
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: returns empty rows and zero summary when Supabase not configured", async () => {
  reset();
  // supabaseRows = null → getSupabaseAdmin returns null
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.rows, []);
  assert.equal(res._body.total_rows, 0);
  assert.equal(res._body.summary.total_gross, 0);
  assert.equal(res._body.supabase, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AUDIT — returns rows from Supabase view
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: returns rows from revenue_reconciliation_audit view", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", gross: 300 }),
    canonicalRow({ booking_id: "bk-2", gross: 150 }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.rows.length, 2);
  assert.equal(res._body.supabase, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. AUDIT — filter by source_table
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: filters by source_table=charges", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", source_table: "revenue_records" }),
    canonicalRow({ booking_id: "bk-2", source_table: "charges", included_in_dashboard: false }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", source_table: "charges" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.rows.length, 1);
  assert.equal(res._body.rows[0].source_table, "charges");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. AUDIT — filter by included_only
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: included_only=true returns only canonical-included rows", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", included_in_dashboard: true  }),
    canonicalRow({ booking_id: "bk-2", included_in_dashboard: false }),
    canonicalRow({ booking_id: "bk-3", included_in_dashboard: true  }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", included_only: true }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.rows.length, 2, "only 2 canonical-included rows");
  assert.ok(res._body.rows.every((r) => r.included_in_dashboard === true));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. AUDIT — filter by vehicle_id
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: filters by vehicle_id", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", vehicle_id: "camry"     }),
    canonicalRow({ booking_id: "bk-2", vehicle_id: "camry2013" }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", vehicle_id: "camry" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.rows.length, 1);
  assert.equal(res._body.rows[0].vehicle_id, "camry");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. AUDIT — filter by booking_id
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: filters by booking_id", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1" }),
    canonicalRow({ booking_id: "bk-2" }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", booking_id: "bk-1" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.rows.length, 1);
  assert.equal(res._body.rows[0].booking_id, "bk-1");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. AUDIT — summary totals are correct
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: summary block totals gross/net/fees/refunds correctly", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", gross: 300, fees: 9,  refunds: 0,  net: 291 }),
    canonicalRow({ booking_id: "bk-2", gross: 150, fees: 4.5,refunds: 10, net: 135.5 }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);
  const s = res._body.summary;
  assert.equal(s.total_gross,   450);
  assert.equal(s.total_fees,    13.5);
  assert.equal(s.total_refunds, 10);
  assert.equal(s.total_net,     426.5);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. AUDIT — summary splits included vs excluded
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: summary separates included and excluded rows", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", gross: 300, net: 291, included_in_dashboard: true  }),
    canonicalRow({ booking_id: "bk-2", gross: 100, net: 100, included_in_dashboard: false }),
    canonicalRow({ booking_id: "bk-3", gross: 50,  net: 50,  included_in_dashboard: true  }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);
  const s = res._body.summary;
  assert.equal(s.included_count,  2,   "two canonical-included rows");
  assert.equal(s.excluded_count,  1,   "one excluded row");
  assert.equal(s.included_gross,  350, "300 + 50");
  assert.equal(s.excluded_gross,  100);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. AUDIT — by_source breakdown
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: summary by_source separates revenue_records from charges", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", source_table: "revenue_records", gross: 200, fees: 6, refunds: 0, net: 194 }),
    canonicalRow({ booking_id: "bk-2", source_table: "charges",         gross: 50,  fees: 0, refunds: 0, net: 50, included_in_dashboard: false }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);
  const { by_source } = res._body.summary;
  assert.equal(by_source.revenue_records.count, 1);
  assert.equal(by_source.revenue_records.gross, 200);
  assert.equal(by_source.revenue_records.fees,  6);
  assert.equal(by_source.charges.count, 1);
  assert.equal(by_source.charges.gross, 50);
  assert.equal(by_source.charges.fees,  0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. SUMMARY action — no rows key, only summary
// ═══════════════════════════════════════════════════════════════════════════════
test("summary action: returns summary only with no rows key", async () => {
  reset();
  supabaseRows = [
    canonicalRow({ booking_id: "bk-1", gross: 400, fees: 12, refunds: 0, net: 388 }),
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "summary" }), res);
  assert.equal(res._status, 200);
  assert.ok(!("rows" in res._body), "rows key must not be present for summary action");
  assert.ok("summary" in res._body, "summary key must be present");
  assert.equal(res._body.summary.total_gross, 400);
  assert.equal(res._body.supabase, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. AUDIT — Supabase schema error → graceful fallback
// ═══════════════════════════════════════════════════════════════════════════════
test("audit: Supabase schema error returns graceful empty fallback", async () => {
  reset();
  supabaseRows  = [];                             // Supabase is configured...
  supabaseError = { code: "42P01", message: "relation revenue_reconciliation_audit does not exist" };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.rows, []);
  assert.equal(res._body.supabase, false, "should fall back to supabase:false on schema error");
});
