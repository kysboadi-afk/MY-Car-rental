import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeLedgerSummary,
  normalizeLedgerTransactionInput,
  resolveTransactionDirection,
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
