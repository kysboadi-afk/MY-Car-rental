import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcilePaymentPlanPayment, computePaymentPlanProgress } from "./_payment-plan-reconcile.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMockSupabase(seed = {}) {
  const state = {
    payment_plans: clone(seed.payment_plans || []),
    payment_plan_installments: clone(seed.payment_plan_installments || []),
    payment_plan_allocations: clone(seed.payment_plan_allocations || []),
  };

  function tableRows(table) {
    if (!state[table]) state[table] = [];
    return state[table];
  }

  function build(table) {
    let mode = "select";
    let payload = null;
    const filters = [];
    let sorters = [];
    let rowLimit = null;

    const api = {
      select() { mode = "select"; return api; },
      insert(values) { mode = "insert"; payload = values; return api; },
      update(values) { mode = "update"; payload = values; return api; },
      eq(key, value) { filters.push((row) => row[key] === value); return api; },
      in(key, values) {
        const set = new Set(values || []);
        filters.push((row) => set.has(row[key]));
        return api;
      },
      order(key, options = {}) {
        sorters.push({ key, ascending: options.ascending !== false });
        return api;
      },
      limit(n) { rowLimit = Number(n); return api; },
      maybeSingle() { return Promise.resolve(asSingle(run(), false)); },
      single() { return Promise.resolve(asSingle(run(), true)); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };

    function applyFilters(rows) {
      let out = rows.filter((row) => filters.every((f) => f(row)));
      for (const sorter of sorters) {
        out = out.sort((a, b) => {
          if (a[sorter.key] === b[sorter.key]) return 0;
          if (a[sorter.key] == null) return sorter.ascending ? 1 : -1;
          if (b[sorter.key] == null) return sorter.ascending ? -1 : 1;
          return a[sorter.key] > b[sorter.key]
            ? (sorter.ascending ? 1 : -1)
            : (sorter.ascending ? -1 : 1);
        });
      }
      if (Number.isFinite(rowLimit) && rowLimit >= 0) out = out.slice(0, rowLimit);
      return out;
    }

    function run() {
      const rows = tableRows(table);
      if (mode === "select") {
        return { data: clone(applyFilters(rows)), error: null };
      }
      if (mode === "insert") {
        const inserted = clone(Array.isArray(payload) ? payload : [payload]);
        for (const row of inserted) {
          if (!row.id) row.id = `${table}-${rows.length + 1}`;
          if (row.created_at == null) row.created_at = new Date().toISOString();
          rows.push(row);
        }
        return { data: clone(inserted), error: null };
      }
      if (mode === "update") {
        const matched = applyFilters(rows);
        for (const row of matched) Object.assign(row, clone(payload));
        return { data: clone(matched), error: null };
      }
      return { data: null, error: { message: "Unsupported operation" } };
    }

    function asSingle(result, strict) {
      const rows = Array.isArray(result.data) ? result.data : result.data == null ? [] : [result.data];
      if (!rows.length) return { data: null, error: strict ? { message: "No rows found" } : null };
      if (strict && rows.length > 1) return { data: null, error: { message: "Multiple rows found" } };
      return { data: clone(rows[0]), error: null };
    }

    return api;
  }

  return {
    state,
    from(table) {
      return build(table);
    },
  };
}

test("reconcilePaymentPlanPayment allocates across installments for catch-up payments", async () => {
  const sb = createMockSupabase({
    payment_plans: [
      { id: "plan-1", booking_id: "BK-1", status: "active", next_due_date: "2026-05-20T00:00:00.000Z", created_at: "2026-05-01T00:00:00.000Z" },
    ],
    payment_plan_installments: [
      { id: "inst-1", plan_id: "plan-1", installment_number: 1, amount: 50, amount_paid: 0, due_date: "2099-05-20T00:00:00.000Z", status: "pending" },
      { id: "inst-2", plan_id: "plan-1", installment_number: 2, amount: 50, amount_paid: 0, due_date: "2099-05-27T00:00:00.000Z", status: "pending" },
    ],
  });

  const result = await reconcilePaymentPlanPayment(sb, {
    booking_id: "BK-1",
    payment_intent_id: "pi_123",
    amount: 70,
    ledger_transaction_id: "ledger-1",
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.amount_allocated, 70);
  assert.equal(result.amount_unapplied, 0);
  assert.equal(result.allocations.length, 2);
  assert.equal(result.allocations[0].amount_allocated, 50);
  assert.equal(result.allocations[1].amount_allocated, 20);

  const inst1 = sb.state.payment_plan_installments.find((x) => x.id === "inst-1");
  const inst2 = sb.state.payment_plan_installments.find((x) => x.id === "inst-2");
  assert.equal(inst1.status, "paid");
  assert.equal(Number(inst1.amount_paid), 50);
  assert.equal(inst2.status, "partial");
  assert.equal(Number(inst2.amount_paid), 20);
});

test("reconcilePaymentPlanPayment is idempotent on duplicate Stripe PI delivery", async () => {
  const sb = createMockSupabase({
    payment_plans: [
      { id: "plan-2", booking_id: "BK-2", status: "active", next_due_date: "2026-06-01T00:00:00.000Z", created_at: "2026-05-01T00:00:00.000Z" },
    ],
    payment_plan_installments: [
      { id: "inst-3", plan_id: "plan-2", installment_number: 1, amount: 50, amount_paid: 0, due_date: "2099-06-01T00:00:00.000Z", status: "pending" },
    ],
  });

  const first = await reconcilePaymentPlanPayment(sb, {
    booking_id: "BK-2",
    payment_intent_id: "pi_dup",
    amount: 50,
  });
  const second = await reconcilePaymentPlanPayment(sb, {
    booking_id: "BK-2",
    payment_intent_id: "pi_dup",
    amount: 50,
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(sb.state.payment_plan_allocations.length, 1);
});

test("computePaymentPlanProgress reports remaining and overdue balances", async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sb = createMockSupabase({
    payment_plans: [
      { id: "plan-3", booking_id: "BK-3", status: "active", created_at: "2026-05-01T00:00:00.000Z" },
    ],
    payment_plan_installments: [
      { id: "inst-4", plan_id: "plan-3", installment_number: 1, amount: 40, amount_paid: 10, due_date: yesterday, status: "partial" },
      { id: "inst-5", plan_id: "plan-3", installment_number: 2, amount: 30, amount_paid: 0, due_date: tomorrow, status: "pending" },
    ],
  });

  const progress = await computePaymentPlanProgress(sb, { bookingId: "BK-3" });
  assert.equal(progress.has_active_plan, true);
  assert.equal(progress.remaining_balance, 60);
  assert.equal(progress.overdue_amount, 30);
  assert.equal(progress.remaining_installments, 2);
});
