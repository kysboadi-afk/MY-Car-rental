import { test, mock } from "node:test";
import assert from "node:assert/strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(key, value) { this._headers[key] = value; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeReq(body, origin = "https://www.slytrans.com") {
  return { method: "POST", headers: { origin }, body };
}

const supabaseMockState = {
  tables: {
    payment_plans: [],
    payment_plan_installments: [],
  },
};

function matchesFilters(row, filters) {
  return filters.every(([key, value]) => row[key] === value);
}

function asSingle(result, strict = false) {
  const rows = Array.isArray(result.data)
    ? result.data
    : result.data == null
      ? []
      : [result.data];
  if (!rows.length) {
    return { data: null, error: strict ? { message: "No rows found" } : null };
  }
  if (strict && rows.length > 1) {
    return { data: null, error: { message: "Multiple rows found" } };
  }
  return { data: clone(rows[0]), error: result.error ?? null };
}

function makeBuilder(table) {
  let operation = "select";
  let payload = null;
  let filters = [];
  let sort = null;
  let selected = false;

  function currentRows() {
    let rows = clone(supabaseMockState.tables[table] || []);
    rows = rows.filter((row) => matchesFilters(row, filters));
    if (sort) {
      rows.sort((a, b) => {
        if (a[sort.key] === b[sort.key]) return 0;
        const direction = sort.ascending ? 1 : -1;
        return a[sort.key] > b[sort.key] ? direction : -direction;
      });
    }
    return rows;
  }

  function execute() {
    const tableRows = supabaseMockState.tables[table];
    switch (operation) {
      case "select":
        return { data: currentRows(), error: null };
      case "insert": {
        const inserted = clone(Array.isArray(payload) ? payload : [payload]);
        tableRows.push(...inserted);
        return { data: clone(inserted), error: null };
      }
      case "update": {
        const updated = [];
        supabaseMockState.tables[table] = tableRows.map((row) => {
          if (!matchesFilters(row, filters)) return row;
          const nextRow = { ...row, ...clone(payload) };
          updated.push(clone(nextRow));
          return nextRow;
        });
        return { data: selected ? updated : null, error: null };
      }
      case "delete": {
        const removed = [];
        supabaseMockState.tables[table] = tableRows.filter((row) => {
          if (matchesFilters(row, filters)) {
            removed.push(clone(row));
            return false;
          }
          return true;
        });
        return { data: selected ? removed : null, error: null };
      }
      default:
        return { data: null, error: { message: `Unsupported operation: ${operation}` } };
    }
  }

  const chain = {
    select() { selected = true; return chain; },
    insert(values) { operation = "insert"; payload = values; return chain; },
    update(values) { operation = "update"; payload = values; return chain; },
    delete() { operation = "delete"; return chain; },
    eq(key, value) { filters.push([key, value]); return chain; },
    order(key, options = {}) { sort = { key, ascending: options.ascending !== false }; return chain; },
    limit() { return chain; },
    range() { return chain; },
    maybeSingle() { return Promise.resolve(asSingle(execute(), false)); },
    single() { return Promise.resolve(asSingle(execute(), true)); },
    then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
  };

  return chain;
}

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from: (table) => makeBuilder(table),
    }),
  },
});

const { default: handler } = await import("./payment-plan.js");

const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET;

function setSecret(value) {
  if (value == null) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = value;
}

function resetTables(seed) {
  supabaseMockState.tables = clone({
    payment_plans: seed.payment_plans || [],
    payment_plan_installments: seed.payment_plan_installments || [],
  });
}

test("update: recalculates unpaid payment plan installments", async () => {
  setSecret("test-secret");
  resetTables({
    payment_plans: [
      {
        id: "plan-1",
        booking_id: "bk-1",
        customer_email: "old@example.com",
        total_amount: 120,
        installments: 2,
        interval_days: 14,
        next_due_date: "2026-05-01T12:00:00.000Z",
        status: "active",
        notes: null,
      },
    ],
    payment_plan_installments: [
      { id: "inst-1", plan_id: "plan-1", installment_number: 1, amount: 60, due_date: "2026-05-01T12:00:00.000Z", status: "pending", payment_intent_id: null, ledger_transaction_id: null },
      { id: "inst-2", plan_id: "plan-1", installment_number: 2, amount: 60, due_date: "2026-05-15T12:00:00.000Z", status: "pending", payment_intent_id: null, ledger_transaction_id: null },
    ],
  });

  const req = makeReq({
    secret: "test-secret",
    action: "update",
    plan_id: "plan-1",
    customer_email: "new@example.com",
    total_amount: 150,
    installments: 3,
    interval_days: 7,
    next_due_date: "2026-05-20",
    notes: "Updated terms",
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.plan.customer_email, "new@example.com");
  assert.equal(res._body.plan.total_amount, 150);
  assert.equal(res._body.installments.length, 3);
  assert.deepEqual(
    res._body.installments.map((row) => row.amount),
    [50, 50, 50],
  );
  assert.deepEqual(
    res._body.installments.map((row) => row.due_date.slice(0, 10)),
    ["2026-05-20", "2026-05-27", "2026-06-03"],
  );
});

test("update: rejects schedule changes once installment payments exist", async () => {
  setSecret("test-secret");
  resetTables({
    payment_plans: [
      {
        id: "plan-2",
        booking_id: "bk-2",
        customer_email: "customer@example.com",
        total_amount: 120,
        installments: 2,
        interval_days: 14,
        next_due_date: "2026-05-01T12:00:00.000Z",
        status: "active",
      },
    ],
    payment_plan_installments: [
      { id: "inst-3", plan_id: "plan-2", installment_number: 1, amount: 60, due_date: "2026-05-01T12:00:00.000Z", status: "paid", payment_intent_id: "pi_123", ledger_transaction_id: "ledger_123" },
      { id: "inst-4", plan_id: "plan-2", installment_number: 2, amount: 60, due_date: "2026-05-15T12:00:00.000Z", status: "pending", payment_intent_id: null, ledger_transaction_id: null },
    ],
  });

  const req = makeReq({
    secret: "test-secret",
    action: "update",
    plan_id: "plan-2",
    total_amount: 140,
  });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 400);
  assert.match(res._body.error, /Cannot change the payment schedule/);
  assert.equal(supabaseMockState.tables.payment_plan_installments.length, 2);
});

test("delete: removes unpaid payment plans", async () => {
  setSecret("test-secret");
  resetTables({
    payment_plans: [
      {
        id: "plan-3",
        booking_id: "bk-3",
        customer_email: "customer@example.com",
        total_amount: 200,
        installments: 4,
        interval_days: 7,
        next_due_date: "2026-05-10T12:00:00.000Z",
        status: "active",
      },
    ],
    payment_plan_installments: [
      { id: "inst-5", plan_id: "plan-3", installment_number: 1, amount: 50, due_date: "2026-05-10T12:00:00.000Z", status: "pending", payment_intent_id: null, ledger_transaction_id: null },
    ],
  });

  const req = makeReq({ secret: "test-secret", action: "delete", plan_id: "plan-3" });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(supabaseMockState.tables.payment_plans.length, 0);
});

test("delete: rejects plans that already have recorded payments", async () => {
  setSecret("test-secret");
  resetTables({
    payment_plans: [
      {
        id: "plan-4",
        booking_id: "bk-4",
        customer_email: "customer@example.com",
        total_amount: 200,
        installments: 4,
        interval_days: 7,
        next_due_date: "2026-05-10T12:00:00.000Z",
        status: "active",
      },
    ],
    payment_plan_installments: [
      { id: "inst-6", plan_id: "plan-4", installment_number: 1, amount: 50, due_date: "2026-05-10T12:00:00.000Z", status: "partial", payment_intent_id: "pi_456", ledger_transaction_id: null },
    ],
  });

  const req = makeReq({ secret: "test-secret", action: "delete", plan_id: "plan-4" });
  const res = makeRes();

  await handler(req, res);

  assert.equal(res._status, 400);
  assert.match(res._body.error, /Cannot delete a payment plan/);
  assert.equal(supabaseMockState.tables.payment_plans.length, 1);
});

process.on("exit", () => {
  setSecret(REAL_ADMIN_SECRET);
});
