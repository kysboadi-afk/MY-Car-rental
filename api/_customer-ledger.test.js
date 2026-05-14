import test from "node:test";
import assert from "node:assert/strict";

import {
  appendCustomerLedgerShadowEntry,
  isCustomerLedgerDualWriteEnabled,
  parseCustomerLedgerMode,
} from "./_customer-ledger.js";

function makeSupabaseMock({
  mode = "parallel",
  bookingCustomerId = "cust-1",
  existingLedgerId = null,
  ledgerInsertError = null,
} = {}) {
  const state = {
    ledgerRows: [],
    idempotencyRows: [],
  };

  const buildQuery = (table) => {
    const filters = {};
    return {
      select() { return this; },
      eq(key, value) {
        filters[key] = value;
        return this;
      },
      async maybeSingle() {
        if (table === "system_settings") {
          return { data: { value: JSON.stringify(mode) }, error: null };
        }
        if (table === "bookings") {
          if (!filters.booking_ref) return { data: null, error: null };
          return {
            data: {
              customer_id: bookingCustomerId,
              stripe_customer_id: null,
              customer_email: "test@example.com",
              customer_phone: "+13105551234",
            },
            error: null,
          };
        }
        if (table === "customer_ledger") {
          if (existingLedgerId) return { data: { id: existingLedgerId }, error: null };
          return { data: null, error: null };
        }
        if (table === "customers") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      async insert(payload) {
        if (table === "customer_ledger") {
          if (ledgerInsertError) return { data: null, error: ledgerInsertError };
          state.ledgerRows.push(payload);
          return { data: [payload], error: null };
        }
        if (table === "ledger_idempotency_log") {
          state.idempotencyRows.push(payload);
          return { data: [payload], error: null };
        }
        return { data: [payload], error: null };
      },
    };
  };

  return {
    from(table) {
      return buildQuery(table);
    },
    _state: state,
  };
}

test("parseCustomerLedgerMode handles JSON and plain strings", () => {
  assert.equal(parseCustomerLedgerMode("\"parallel\""), "parallel");
  assert.equal(parseCustomerLedgerMode("parallel"), "parallel");
  assert.equal(parseCustomerLedgerMode(null), "shadow");
});

test("isCustomerLedgerDualWriteEnabled only enables parallel mode", () => {
  assert.equal(isCustomerLedgerDualWriteEnabled("parallel"), true);
  assert.equal(isCustomerLedgerDualWriteEnabled("shadow"), false);
  assert.equal(isCustomerLedgerDualWriteEnabled("warn"), false);
});

test("appendCustomerLedgerShadowEntry skips writes when mode is shadow", async () => {
  const sb = makeSupabaseMock({ mode: "shadow" });

  const result = await appendCustomerLedgerShadowEntry(sb, {
    caller: "test",
    bookingRef: "bk-1",
    transactionType: "stripe_payment",
    direction: "credit",
    amountCents: 2500,
    sourceType: "stripe_payment",
    sourceId: "pi_shadow",
  });

  assert.equal(result.written, false);
  assert.match(result.reason, /dual_write_disabled:shadow/);
  assert.equal(sb._state.ledgerRows.length, 0);
});

test("appendCustomerLedgerShadowEntry writes in parallel mode", async () => {
  const sb = makeSupabaseMock({ mode: "parallel", bookingCustomerId: "cust-parallel-1" });

  const result = await appendCustomerLedgerShadowEntry(sb, {
    caller: "test",
    bookingRef: "bk-2",
    transactionType: "stripe_payment",
    direction: "credit",
    amountCents: 4200,
    sourceType: "stripe_payment",
    sourceId: "pi_parallel",
    metadata: { payment_type: "balance_payment" },
  });

  assert.equal(result.written, true);
  assert.equal(sb._state.ledgerRows.length, 1);
  assert.equal(sb._state.ledgerRows[0].customer_id, "cust-parallel-1");
  assert.equal(sb._state.idempotencyRows.length, 0);
});

test("appendCustomerLedgerShadowEntry logs duplicate attempts to idempotency table", async () => {
  const sb = makeSupabaseMock({ mode: "parallel", existingLedgerId: "existing-1" });

  const result = await appendCustomerLedgerShadowEntry(sb, {
    caller: "test",
    bookingRef: "bk-3",
    transactionType: "stripe_payment",
    direction: "credit",
    amountCents: 9900,
    sourceType: "stripe_payment",
    sourceId: "pi_duplicate",
  });

  assert.equal(result.written, false);
  assert.equal(result.reason, "duplicate_source");
  assert.equal(sb._state.ledgerRows.length, 0);
  assert.equal(sb._state.idempotencyRows.length, 1);
  assert.equal(sb._state.idempotencyRows[0].source_id, "pi_duplicate");
});
