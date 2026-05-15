import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annotateLedgerTransactions,
  computeLedgerSummary,
  normalizeLedgerTransactionInput,
  resolveTransactionDirection,
  addLedgerCharge,
  addLedgerPayment,
  addLedgerRefund,
  addLedgerWaiver,
  getLedgerRemainingBalance,
  CHARGE_TRANSACTION_TYPES,
} from "./_renter-balance-ledger.js";

test("resolveTransactionDirection: applies default direction for charge types", () => {
  assert.equal(resolveTransactionDirection("late_fee"), "debit");
  assert.equal(resolveTransactionDirection("payment"), "credit");
});

test("resolveTransactionDirection: requires explicit direction for adjustment", () => {
  assert.throws(
    () => resolveTransactionDirection("adjustment"),
    /direction must be one of/
  );
  assert.equal(resolveTransactionDirection("adjustment", "debit"), "debit");
  assert.equal(resolveTransactionDirection("adjustment", "credit"), "credit");
});

test("normalizeLedgerTransactionInput: validates source pair and amount", () => {
  assert.throws(
    () => normalizeLedgerTransactionInput({ booking_id: "BK-1", transaction_type: "misc", amount: 10, source_type: "manual" }),
    /source_type and source_id must be provided together/
  );
  assert.throws(
    () => normalizeLedgerTransactionInput({ booking_id: "BK-1", transaction_type: "misc", amount: 0 }),
    /amount must be a positive number/
  );
});

test("normalizeLedgerTransactionInput: normalizes a valid payload", () => {
  const out = normalizeLedgerTransactionInput({
    booking_id: " BK-100 ",
    transaction_type: "payment",
    amount: "42.199",
    notes: "  partial payment  ",
    metadata: { channel: "stripe" },
  });
  assert.equal(out.booking_id, "BK-100");
  assert.equal(out.transaction_type, "payment");
  assert.equal(out.direction, "credit");
  assert.equal(out.amount, 42.2);
  assert.equal(out.notes, "partial payment");
  assert.deepEqual(out.metadata, { channel: "stripe" });
});

test("normalizeLedgerTransactionInput: stores allocation metadata for targeted entries", () => {
  const out = normalizeLedgerTransactionInput({
    booking_id: "BK-100",
    transaction_type: "waiver",
    amount: 25,
    allocation_scope: "targeted",
    target_transaction_type: "late_fee",
  });
  assert.equal(out.metadata.allocation_scope, "targeted");
  assert.equal(out.metadata.target_transaction_type, "late_fee");
});

test("computeLedgerSummary: derives charges, credits, and remaining balance", () => {
  const summary = computeLedgerSummary([
    { transaction_type: "late_fee", direction: "debit", amount: 25 },
    { transaction_type: "damage", direction: "debit", amount: 100 },
    { transaction_type: "payment", direction: "credit", amount: 50 },
    { transaction_type: "waiver", direction: "credit", amount: 10 },
  ]);

  assert.equal(summary.total_charges, 125);
  assert.equal(summary.total_credits, 60);
  assert.equal(summary.total_paid, 50);
  assert.equal(summary.total_waived, 10);
  assert.equal(summary.remaining_balance, 65);
  assert.equal(summary.net_balance, 65);
});

test("computeLedgerSummary: reports credit balance when overpaid", () => {
  const summary = computeLedgerSummary([
    { transaction_type: "misc", direction: "debit", amount: 20 },
    { transaction_type: "payment", direction: "credit", amount: 50 },
  ]);

  assert.equal(summary.remaining_balance, 0);
  assert.equal(summary.credit_balance, 30);
  assert.equal(summary.net_balance, -30);
});

// ── CHARGE_TRANSACTION_TYPES export ──────────────────────────────────────────

test("CHARGE_TRANSACTION_TYPES: includes damage, misc, late_fee, ticket", () => {
  assert.ok(CHARGE_TRANSACTION_TYPES.includes("damage"));
  assert.ok(CHARGE_TRANSACTION_TYPES.includes("misc"));
  assert.ok(CHARGE_TRANSACTION_TYPES.includes("late_fee"));
  assert.ok(CHARGE_TRANSACTION_TYPES.includes("ticket"));
});

test("CHARGE_TRANSACTION_TYPES: does not include payment/waiver/adjustment/refund", () => {
  assert.ok(!CHARGE_TRANSACTION_TYPES.includes("payment"));
  assert.ok(!CHARGE_TRANSACTION_TYPES.includes("waiver"));
  assert.ok(!CHARGE_TRANSACTION_TYPES.includes("adjustment"));
  assert.ok(!CHARGE_TRANSACTION_TYPES.includes("refund"));
});

// ── addLedgerCharge idempotency ───────────────────────────────────────────────

function makeMockSb({ existing = null, insertedRow = null } = {}) {
  const insertedRows = [];
  return {
    _insertedRows: insertedRows,
    from(table) {
      return {
        select() { return this; },
        eq()     { return this; },
        maybeSingle() { return Promise.resolve({ data: existing, error: null }); },
        insert(row) {
          insertedRows.push(row);
          return {
            select() { return this; },
            single() {
              return Promise.resolve({ data: insertedRow || { id: "row-1", ...row }, error: null });
            },
          };
        },
      };
    },
  };
}

test("addLedgerCharge: requires charge_request_id", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => addLedgerCharge(sb, { booking_id: "BK-1", transaction_type: "damage", amount: 100 }),
    /charge_request_id is required/
  );
});

test("addLedgerCharge: requires booking_id", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => addLedgerCharge(sb, { charge_request_id: "cr-abc", transaction_type: "damage", amount: 100 }),
    /booking_id is required/
  );
});

test("addLedgerCharge: rejects non-charge transaction_type", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => addLedgerCharge(sb, { charge_request_id: "cr-abc", booking_id: "BK-1", transaction_type: "payment", amount: 100 }),
    /transaction_type must be a charge category/
  );
});

test("addLedgerCharge: inserts new charge and returns duplicate=false", async () => {
  const sb = makeMockSb({ existing: null, insertedRow: { id: "row-new", booking_id: "BK-1", transaction_type: "damage", amount: 150, direction: "debit" } });
  const result = await addLedgerCharge(sb, {
    charge_request_id: "cr-unique-1",
    booking_id: "BK-1",
    transaction_type: "damage",
    amount: 150,
    notes: "Bumper repair",
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.transaction.id, "row-new");
});

test("addLedgerCharge: returns existing row with duplicate=true when idempotency key matches", async () => {
  const existingRow = { id: "row-existing", booking_id: "BK-1", transaction_type: "damage", amount: 150 };
  const sb = makeMockSb({ existing: existingRow });
  const result = await addLedgerCharge(sb, {
    charge_request_id: "cr-dup-1",
    booking_id: "BK-1",
    transaction_type: "damage",
    amount: 150,
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.transaction.id, "row-existing");
  assert.equal(sb._insertedRows.length, 0);
});


// ── Phase 3: addLedgerPayment ─────────────────────────────────────────────────

test("addLedgerPayment: requires stripe_payment_intent_id", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => addLedgerPayment(sb, { booking_id: "BK-1", amount: 50 }),
    /stripe_payment_intent_id is required/
  );
});

test("addLedgerPayment: inserts new payment and returns duplicate=false", async () => {
  const insertedRow = { id: "pay-1", booking_id: "BK-1", transaction_type: "payment", direction: "credit", amount: 50 };
  const sb = makeMockSb({ existing: null, insertedRow });
  const result = await addLedgerPayment(sb, {
    booking_id: "BK-1",
    paymentIntentId: "pi_test_abc",
    amount: 50,
    notes: "Rental balance payment",
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.transaction.id, "pay-1");
  assert.equal(sb._insertedRows.length, 1);
});

test("addLedgerPayment: returns existing row with duplicate=true on replay", async () => {
  const existingRow = { id: "pay-existing", booking_id: "BK-1", transaction_type: "payment", amount: 50 };
  const sb = makeMockSb({ existing: existingRow });
  const result = await addLedgerPayment(sb, {
    booking_id: "BK-1",
    paymentIntentId: "pi_test_abc",
    amount: 50,
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.transaction.id, "pay-existing");
  assert.equal(sb._insertedRows.length, 0);
});

test("addLedgerPayment: uses 'payment' as default transaction_type", async () => {
  const insertedRow = { id: "pay-2", booking_id: "BK-2", transaction_type: "payment", direction: "credit", amount: 75 };
  const sb = makeMockSb({ existing: null, insertedRow });
  const result = await addLedgerPayment(sb, {
    booking_id: "BK-2",
    paymentIntentId: "pi_test_xyz",
    amount: 75,
  });
  assert.equal(result.duplicate, false);
  assert.equal(sb._insertedRows[0].transaction_type, "payment");
});

// ── Phase 3: addLedgerRefund ──────────────────────────────────────────────────

test("addLedgerRefund: requires chargeId or refundId", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => addLedgerRefund(sb, { booking_id: "BK-1", amount: 25 }),
    /chargeId or refundId is required/
  );
});

test("addLedgerRefund: inserts new refund and returns duplicate=false", async () => {
  const insertedRow = { id: "ref-1", booking_id: "BK-1", transaction_type: "refund", direction: "debit", amount: 25 };
  const sb = makeMockSb({ existing: null, insertedRow });
  const result = await addLedgerRefund(sb, {
    booking_id: "BK-1",
    chargeId: "ch_test_123",
    amount: 25,
    notes: "Full refund — $25.00 returned to renter",
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.transaction.id, "ref-1");
  assert.equal(sb._insertedRows[0].transaction_type, "refund");
  assert.equal(sb._insertedRows[0].direction, "debit");
});

test("addLedgerRefund: returns existing row with duplicate=true on replay", async () => {
  const existingRow = { id: "ref-existing", booking_id: "BK-1", transaction_type: "refund", amount: 25 };
  const sb = makeMockSb({ existing: existingRow });
  const result = await addLedgerRefund(sb, {
    booking_id: "BK-1",
    chargeId: "ch_test_123",
    amount: 25,
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.transaction.id, "ref-existing");
  assert.equal(sb._insertedRows.length, 0);
});

// ── Phase 3: addLedgerWaiver ──────────────────────────────────────────────────

test("addLedgerWaiver: requires waiverKey", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => addLedgerWaiver(sb, { booking_id: "BK-1", amount: 25 }),
    /waiverKey is required/
  );
});

test("addLedgerWaiver: inserts new waiver and returns duplicate=false", async () => {
  const insertedRow = { id: "waiv-1", booking_id: "BK-1", transaction_type: "waiver", direction: "credit", amount: 25 };
  const sb = makeMockSb({ existing: null, insertedRow });
  const result = await addLedgerWaiver(sb, {
    booking_id: "BK-1",
    waiverKey: "BK-1:late_fee_waiver:2026-01-01T10:00:00",
    amount: 25,
    notes: "Late fee waiver (full): admin override",
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.transaction.id, "waiv-1");
  assert.equal(sb._insertedRows[0].transaction_type, "waiver");
  assert.equal(sb._insertedRows[0].direction, "credit");
});

test("addLedgerWaiver: returns existing row with duplicate=true on replay", async () => {
  const existingRow = { id: "waiv-existing", booking_id: "BK-1", transaction_type: "waiver", amount: 25 };
  const sb = makeMockSb({ existing: existingRow });
  const result = await addLedgerWaiver(sb, {
    booking_id: "BK-1",
    waiverKey: "BK-1:late_fee_waiver:2026-01-01T10:00:00",
    amount: 25,
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.transaction.id, "waiv-existing");
  assert.equal(sb._insertedRows.length, 0);
});

// ── Phase 3: getLedgerRemainingBalance ────────────────────────────────────────

test("getLedgerRemainingBalance: requires bookingId", async () => {
  const sb = makeMockSb();
  await assert.rejects(
    () => getLedgerRemainingBalance(sb, {}),
    /bookingId is required/
  );
});

test("getLedgerRemainingBalance: returns 0 on DB error (non-fatal)", async () => {
  // Build a mock that returns errors from its queries
  const errorSb = {
    from() {
      return {
        select() { return this; },
        eq()     { return this; },
        in()     { return this; },
        order()  { return this; },
        range()  { return this; },
        then: null,
        [Symbol.asyncIterator]: undefined,
        // Return error from both summary and typed-totals queries
        get [Symbol.hasInstance]() { return false; },
      };
    },
  };
  // Override to return errors
  const errResult = { data: null, error: { message: "table not found" } };
  const safeSb = {
    from() {
      return {
        select() { return this; },
        eq()     { return this; },
        in()     { return this; },
        order()  { return this; },
        range()  { return Promise.resolve(errResult); },
        maybeSingle() { return Promise.resolve(errResult); },
      };
    },
  };
  const balance = await getLedgerRemainingBalance(safeSb, { bookingId: "BK-1" });
  assert.equal(balance, 0);
});

// ── Phase 3: computeLedgerSummary with refund ────────────────────────────────

test("computeLedgerSummary: refund (debit) correctly increases net balance", () => {
  const summary = computeLedgerSummary([
    { transaction_type: "misc", direction: "debit", amount: 100 },
    { transaction_type: "payment", direction: "credit", amount: 100 },
    { transaction_type: "refund", direction: "debit", amount: 100 },
  ]);
  // charge=100, payment=100 (refunded), refund=100 → net=100 (renter owes again)
  assert.equal(summary.total_charges, 200);
  assert.equal(summary.total_credits, 100);
  assert.equal(summary.total_paid, 100);
  assert.equal(summary.total_refunds, 100);
  assert.equal(summary.remaining_balance, 100);
  assert.equal(summary.net_balance, 100);
});

test("computeLedgerSummary: waiver reduces remaining balance", () => {
  const summary = computeLedgerSummary([
    { transaction_type: "late_fee", direction: "debit", amount: 25 },
    { transaction_type: "waiver",   direction: "credit", amount: 25 },
  ]);
  assert.equal(summary.total_charges, 25);
  assert.equal(summary.total_waived, 25);
  assert.equal(summary.remaining_balance, 0);
  assert.equal(summary.credit_balance, 0);
});

test("computeLedgerSummary: partial payment leaves correct remaining balance", () => {
  const summary = computeLedgerSummary([
    { transaction_type: "misc",    direction: "debit",  amount: 300 },
    { transaction_type: "payment", direction: "credit", amount: 100 },
  ]);
  assert.equal(summary.total_charges, 300);
  assert.equal(summary.total_paid, 100);
  assert.equal(summary.remaining_balance, 200);
  assert.equal(summary.net_balance, 200);
});

test("annotateLedgerTransactions: targeted waiver does not reduce unrelated repair balance", () => {
  const result = annotateLedgerTransactions([
    { id: "repair-1", created_at: "2026-01-01T10:00:00Z", transaction_type: "repair", direction: "debit", amount: 800, metadata: {} },
    {
      id: "waiver-1",
      created_at: "2026-01-01T11:00:00Z",
      transaction_type: "waiver",
      direction: "credit",
      amount: 25,
      metadata: { allocation_scope: "targeted", target_transaction_type: "late_fee" },
    },
  ]);

  assert.equal(result.summary.remaining_balance, 800);
  assert.equal(result.summary.credit_balance, 25);
  assert.equal(result.summary.net_balance, 775);
  assert.equal(result.transactions.at(-1).running_balance, 800);
});

test("annotateLedgerTransactions: targeted payment applies only to matching ticket balance", () => {
  const result = annotateLedgerTransactions([
    { id: "repair-1", created_at: "2026-01-01T10:00:00Z", transaction_type: "repair", direction: "debit", amount: 800, metadata: {} },
    { id: "ticket-1", created_at: "2026-01-01T10:30:00Z", transaction_type: "ticket", direction: "debit", amount: 120, metadata: {} },
    {
      id: "payment-1",
      created_at: "2026-01-01T11:00:00Z",
      transaction_type: "payment",
      direction: "credit",
      amount: 120,
      related_ticket_id: "ticket-abc",
      metadata: { allocation_scope: "targeted", target_transaction_type: "ticket" },
    },
  ]);

  assert.equal(result.summary.remaining_balance, 800);
  assert.equal(result.summary.credit_balance, 0);
  assert.equal(result.summary.net_balance, 800);
  assert.equal(result.transactions.at(-1).running_balance, 800);
});

test("annotateLedgerTransactions: global payment still pools across open balances", () => {
  const result = annotateLedgerTransactions([
    { id: "repair-1", created_at: "2026-01-01T10:00:00Z", transaction_type: "repair", direction: "debit", amount: 800, metadata: {} },
    { id: "ticket-1", created_at: "2026-01-01T10:30:00Z", transaction_type: "ticket", direction: "debit", amount: 120, metadata: {} },
    { id: "payment-1", created_at: "2026-01-01T11:00:00Z", transaction_type: "payment", direction: "credit", amount: 100, metadata: { allocation_scope: "global" } },
  ]);

  assert.equal(result.summary.remaining_balance, 820);
  assert.equal(result.summary.credit_balance, 0);
  assert.equal(result.summary.net_balance, 820);
});
