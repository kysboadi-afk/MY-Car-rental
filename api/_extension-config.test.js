// Tests for api/extension-config.js
// Validates renter-visible balance/overdue/payment-plan fields used by extension UI.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";

let mockPaymentIntent = null;
let ledgerSummaryMock = { remaining_balance: 0 };
let paymentPlanProgressMock = {
  has_active_plan: false,
  remaining_balance: 0,
  overdue_amount: 0,
  next_due_date: null,
};
let ledgerShouldThrow = false;
let progressShouldThrow = false;
let supabaseEnabled = true;

mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    get paymentIntents() {
      return {
        retrieve: async () => {
          if (!mockPaymentIntent) throw new Error("PI not found");
          return mockPaymentIntent;
        },
      };
    }
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => (supabaseEnabled ? { from: () => ({}) } : null),
  },
});

mock.module("./_renter-balance-ledger.js", {
  namedExports: {
    getLedgerSummary: async () => {
      if (ledgerShouldThrow) throw new Error("ledger unavailable");
      return { ...ledgerSummaryMock };
    },
  },
});

mock.module("./_payment-plan-reconcile.js", {
  namedExports: {
    computePaymentPlanProgress: async () => {
      if (progressShouldThrow) throw new Error("payment-plan unavailable");
      return { ...paymentPlanProgressMock };
    },
  },
});

const { default: handler } = await import("./extension-config.js");

function makeReq(overrides = {}) {
  return {
    method: "GET",
    headers: { origin: "https://www.slytrans.com" },
    query: { piId: "pi_test_123", ...(overrides.query || {}) },
    ...overrides,
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function reset() {
  mockPaymentIntent = {
    id: "pi_test_123",
    status: "requires_payment_method",
    amount: 7500,
    metadata: {
      payment_type: "rental_extension",
      extension_total_amount: "100",
      extension_amount_paid: "75",
      extension_remaining_balance: "25",
      extension_payment_status: "partially_paid",
      extension_label: "2 extra days",
      vehicle_name: "Camry 2012",
      vehicle_id: "camry",
      renter_name: "Alice Smith",
      booking_id: "bk-ext-001",
    },
  };
  ledgerSummaryMock = { remaining_balance: 0 };
  paymentPlanProgressMock = {
    has_active_plan: false,
    remaining_balance: 0,
    overdue_amount: 0,
    next_due_date: null,
  };
  ledgerShouldThrow = false;
  progressShouldThrow = false;
  supabaseEnabled = true;
}

test("extension-config: returns outstanding, overdue, and payment-plan visibility fields", async () => {
  reset();
  ledgerSummaryMock = { remaining_balance: 210.75 };
  paymentPlanProgressMock = {
    has_active_plan: true,
    remaining_balance: 120.5,
    overdue_amount: 30,
    next_due_date: "2026-07-10",
  };

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.currentOutstandingBalance, "210.75");
  assert.equal(res._body.overdueAmount, "30.00");
  assert.equal(res._body.paymentPlanRemainingBalance, "120.50");
  assert.equal(res._body.paymentPlanOverdueAmount, "30.00");
  assert.equal(res._body.paymentPlanNextDueDate, "2026-07-10");
  assert.equal(res._body.hasActivePaymentPlan, true);
  assert.equal(res._body.totalOwedBeforeExtension, "210.75");
});

test("extension-config: uses safe defaults when ledger and payment-plan lookups fail", async () => {
  reset();
  ledgerShouldThrow = true;
  progressShouldThrow = true;

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.currentOutstandingBalance, "0.00");
  assert.equal(res._body.overdueAmount, "0.00");
  assert.equal(res._body.paymentPlanRemainingBalance, "0.00");
  assert.equal(res._body.paymentPlanOverdueAmount, "0.00");
  assert.equal(res._body.hasActivePaymentPlan, false);
  assert.equal(res._body.totalOwedBeforeExtension, "0.00");
});

test("extension-config: ignores non-extension payment intents", async () => {
  reset();
  mockPaymentIntent.metadata.payment_type = "balance_payment";

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 400);
  assert.match(String(res._body?.error || ""), /not valid for a rental extension/i);
});

test("extension-config: does not query balances when booking reference is missing", async () => {
  reset();
  mockPaymentIntent.metadata.booking_id = "";
  mockPaymentIntent.metadata.original_booking_id = "";
  ledgerSummaryMock = { remaining_balance: 999 };
  paymentPlanProgressMock = {
    has_active_plan: true,
    remaining_balance: 444,
    overdue_amount: 111,
    next_due_date: "2026-08-01",
  };

  const res = makeRes();
  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.currentOutstandingBalance, "0.00");
  assert.equal(res._body.overdueAmount, "0.00");
  assert.equal(res._body.paymentPlanRemainingBalance, "0.00");
  assert.equal(res._body.hasActivePaymentPlan, false);
});
