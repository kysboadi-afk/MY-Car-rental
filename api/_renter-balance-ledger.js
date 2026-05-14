// Unified renter balance ledger helpers (Phase 1).
// Balance is derived from append-only transactions.

export const LEDGER_TRANSACTION_TYPES = [
  "extension",
  "late_fee",
  "ticket",
  "damage",
  "repair",
  "deductible",
  "smoking",
  "cleaning",
  "towing",
  "misc",
  "payment",
  "refund",
  "waiver",
  "adjustment",
];

export const LEDGER_DIRECTIONS = ["debit", "credit"];

const DEFAULT_DIRECTION_BY_TYPE = {
  extension:  "debit",
  late_fee:   "debit",
  ticket:     "debit",
  damage:     "debit",
  repair:     "debit",
  deductible: "debit",
  smoking:    "debit",
  cleaning:   "debit",
  towing:     "debit",
  misc:       "debit",
  payment:    "credit",
  refund:     "debit",
  waiver:     "credit",
  adjustment: null,
};

function roundMoney(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  return Number(rounded.toFixed(2));
}

function toCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100);
}

function parsePositiveAmount(value, field = "amount") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return toCents(parsed) / 100;
}

function normalizeOptionalString(value, { max = 2000 } = {}) {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  if (!out) return null;
  return out.slice(0, max);
}

export function resolveTransactionDirection(transactionType, direction) {
  if (!LEDGER_TRANSACTION_TYPES.includes(transactionType)) {
    throw new Error(`transaction_type must be one of: ${LEDGER_TRANSACTION_TYPES.join(", ")}`);
  }
  const expected = DEFAULT_DIRECTION_BY_TYPE[transactionType];

  if (!expected) {
    if (!direction || !LEDGER_DIRECTIONS.includes(direction)) {
      throw new Error(`direction must be one of: ${LEDGER_DIRECTIONS.join(", ")} for transaction_type "${transactionType}"`);
    }
    return direction;
  }

  if (direction && direction !== expected) {
    throw new Error(`direction "${direction}" does not match transaction_type "${transactionType}" (expected "${expected}")`);
  }
  return expected;
}

export function normalizeLedgerTransactionInput(input = {}) {
  const bookingId = normalizeOptionalString(input.bookingId || input.booking_id || input.booking_ref, { max: 200 });
  if (!bookingId) throw new Error("booking_id is required");

  const transactionType = normalizeOptionalString(input.transactionType || input.transaction_type, { max: 50 });
  if (!transactionType) throw new Error("transaction_type is required");

  const direction = resolveTransactionDirection(transactionType, normalizeOptionalString(input.direction, { max: 20 }));
  const amount = parsePositiveAmount(input.amount);

  let metadata = {};
  if (input.metadata !== undefined && input.metadata !== null) {
    if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new Error("metadata must be an object");
    }
    metadata = input.metadata;
  }

  const sourceType = normalizeOptionalString(input.sourceType || input.source_type, { max: 100 });
  const sourceId = normalizeOptionalString(input.sourceId || input.source_id, { max: 200 });
  if ((sourceType && !sourceId) || (!sourceType && sourceId)) {
    throw new Error("source_type and source_id must be provided together");
  }

  return {
    booking_id: bookingId,
    customer_id: normalizeOptionalString(input.customerId || input.customer_id, { max: 80 }),
    transaction_type: transactionType,
    direction,
    amount,
    notes: normalizeOptionalString(input.notes, { max: 4000 }),
    source_type: sourceType,
    source_id: sourceId,
    stripe_payment_intent_id: normalizeOptionalString(input.stripePaymentIntentId || input.stripe_payment_intent_id, { max: 255 }),
    related_charge_id: normalizeOptionalString(input.relatedChargeId || input.related_charge_id, { max: 80 }),
    related_ticket_id: normalizeOptionalString(input.relatedTicketId || input.related_ticket_id, { max: 80 }),
    metadata,
    created_by: normalizeOptionalString(input.createdBy || input.created_by, { max: 120 }) || "admin",
  };
}

export function computeLedgerSummary(transactions = []) {
  let totalChargesCents = 0;
  let totalCreditsCents = 0;
  let totalPaymentsCents = 0;
  let totalWaivedCents = 0;
  let totalRefundsCents = 0;

  for (const row of transactions) {
    const amount = Number(row.amount) || 0;
    if (amount <= 0) continue;
    const amountCents = toCents(amount);
    const direction = row.direction === "credit" ? "credit" : "debit";
    const type = String(row.transaction_type || "");

    if (direction === "debit") totalChargesCents += amountCents;
    else totalCreditsCents += amountCents;

    if (type === "payment" && direction === "credit") totalPaymentsCents += amountCents;
    if (type === "waiver"  && direction === "credit") totalWaivedCents   += amountCents;
    if (type === "refund"  && direction === "debit")  totalRefundsCents  += amountCents;
  }

  const totalCharges = totalChargesCents / 100;
  const totalCredits = totalCreditsCents / 100;
  const totalPayments = totalPaymentsCents / 100;
  const totalWaived = totalWaivedCents / 100;
  const totalRefunds = totalRefundsCents / 100;
  const netBalance = (totalChargesCents - totalCreditsCents) / 100;
  const remainingBalance = Math.max(0, netBalance);
  const creditBalance = netBalance < 0 ? Math.abs(netBalance) : 0;

  return {
    total_charges: totalCharges,
    total_credits: totalCredits,
    total_paid: totalPayments,
    total_waived: totalWaived,
    total_refunds: totalRefunds,
    net_balance: netBalance,
    remaining_balance: roundMoney(remainingBalance),
    credit_balance: roundMoney(creditBalance),
    transaction_count: transactions.length,
  };
}

export async function insertLedgerTransaction(sb, input) {
  const payload = normalizeLedgerTransactionInput(input);
  const { data, error } = await sb
    .from("renter_balance_ledger")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(`Could not insert ledger transaction: ${error.message}`);
  return data;
}

export async function listLedgerTransactions(sb, { bookingId, customerId, limit = 100, offset = 0 } = {}) {
  const bookingRef = normalizeOptionalString(bookingId, { max: 200 });
  const customerRef = normalizeOptionalString(customerId, { max: 80 });
  if (!bookingRef && !customerRef) {
    throw new Error("booking_id or customer_id is required");
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  let query = sb
    .from("renter_balance_ledger")
    .select("*")
    .order("created_at", { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (bookingRef) query = query.eq("booking_id", bookingRef);
  if (customerRef) query = query.eq("customer_id", customerRef);

  const { data, error } = await query;
  if (error) throw new Error(`Could not load ledger transactions: ${error.message}`);
  return data || [];
}

export async function getLedgerSummary(sb, { bookingId, customerId } = {}) {
  const bookingRef = normalizeOptionalString(bookingId, { max: 200 });
  const customerRef = normalizeOptionalString(customerId, { max: 80 });
  if (!bookingRef && !customerRef) {
    throw new Error("booking_id or customer_id is required");
  }

  let summaryQuery = sb
    .from("renter_balance_ledger_summary")
    .select("total_charges,total_credits,net_balance,transaction_count");
  let typedTotalsQuery = sb
    .from("renter_balance_ledger")
    .select("transaction_type,direction,amount")
    .in("transaction_type", ["payment", "waiver", "refund"]);

  if (bookingRef) {
    summaryQuery = summaryQuery.eq("booking_id", bookingRef);
    typedTotalsQuery = typedTotalsQuery.eq("booking_id", bookingRef);
  }
  if (customerRef) {
    summaryQuery = summaryQuery.eq("customer_id", customerRef);
    typedTotalsQuery = typedTotalsQuery.eq("customer_id", customerRef);
  }

  const [{ data: summaryRows, error: summaryErr }, { data: typedRows, error: typedErr }] = await Promise.all([
    summaryQuery,
    typedTotalsQuery,
  ]);
  if (summaryErr) throw new Error(`Could not load ledger summary: ${summaryErr.message}`);
  if (typedErr) throw new Error(`Could not load ledger typed totals: ${typedErr.message}`);

  const base = (summaryRows || []).reduce((acc, row) => {
    acc.total_charges += Number(row.total_charges || 0);
    acc.total_credits += Number(row.total_credits || 0);
    acc.net_balance += Number(row.net_balance || 0);
    acc.transaction_count += Number(row.transaction_count || 0);
    return acc;
  }, { total_charges: 0, total_credits: 0, net_balance: 0, transaction_count: 0 });

  const typed = computeLedgerSummary(typedRows || []);
  const remainingBalance = Math.max(0, roundMoney(base.net_balance));
  const creditBalance = base.net_balance < 0 ? Math.abs(roundMoney(base.net_balance)) : 0;

  return {
    total_charges: roundMoney(base.total_charges),
    total_credits: roundMoney(base.total_credits),
    total_paid: typed.total_paid,
    total_waived: typed.total_waived,
    total_refunds: typed.total_refunds,
    net_balance: roundMoney(base.net_balance),
    remaining_balance: remainingBalance,
    credit_balance: creditBalance,
    transaction_count: base.transaction_count,
  };
}
