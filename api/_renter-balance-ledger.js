// Unified renter balance ledger helpers (Phase 1 + 2).
// Balance is derived from append-only transactions.

// Charge-category types that admin can manually create via Add Charge.
export const CHARGE_TRANSACTION_TYPES = [
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
];

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
  // Refund of a previously captured renter payment increases outstanding debt.
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

function normalizeAllocationScope(value) {
  const out = normalizeOptionalString(value, { max: 20 });
  if (!out) return null;
  if (!["global", "targeted"].includes(out)) {
    throw new Error("allocation_scope must be \"global\" or \"targeted\"");
  }
  return out;
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

  const allocationScope = normalizeAllocationScope(input.allocationScope || input.allocation_scope);
  const targetTransactionType = normalizeOptionalString(
    input.targetTransactionType || input.target_transaction_type,
    { max: 50 }
  );
  const targetLedgerTransactionId = normalizeOptionalString(
    input.targetLedgerTransactionId || input.target_ledger_transaction_id,
    { max: 80 }
  );
  if (targetTransactionType && !LEDGER_TRANSACTION_TYPES.includes(targetTransactionType)) {
    throw new Error(`target_transaction_type must be one of: ${LEDGER_TRANSACTION_TYPES.join(", ")}`);
  }
  if (allocationScope === "targeted" && !targetTransactionType && !targetLedgerTransactionId) {
    throw new Error("targeted allocation requires either targetTransactionType or targetLedgerTransactionId");
  }
  if ((targetTransactionType || targetLedgerTransactionId) && !allocationScope) {
    metadata = { ...metadata, allocation_scope: "targeted" };
  }
  if (allocationScope) {
    metadata = { ...metadata, allocation_scope: allocationScope };
  }
  if (targetTransactionType) {
    metadata = { ...metadata, target_transaction_type: targetTransactionType };
  }
  if (targetLedgerTransactionId) {
    metadata = { ...metadata, target_ledger_transaction_id: targetLedgerTransactionId };
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

function sortLedgerTransactionsAsc(transactions = []) {
  return [...transactions].sort((a, b) => {
    const timeA = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const timeB = b?.created_at ? new Date(b.created_at).getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

function buildDebitAllocationAliases(row = {}) {
  const aliases = [];
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata
    : {};

  const relatedChargeId = normalizeOptionalString(row.related_charge_id, { max: 80 });
  const relatedTicketId = normalizeOptionalString(row.related_ticket_id, { max: 80 });
  const transactionType = normalizeOptionalString(row.transaction_type, { max: 50 });
  const targetLedgerTransactionId = normalizeOptionalString(metadata.target_ledger_transaction_id, { max: 80 });

  if (targetLedgerTransactionId) aliases.push(`ledger:${targetLedgerTransactionId}`);
  if (relatedChargeId) aliases.push(`charge:${relatedChargeId}`);
  if (relatedTicketId) aliases.push(`ticket:${relatedTicketId}`);
  if (transactionType) aliases.push(`type:${transactionType}`);

  return [...new Set(aliases)];
}

function buildCreditAllocationTargets(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata
    : {};

  const allocationScope = normalizeOptionalString(metadata.allocation_scope, { max: 20 }) || null;
  const targetLedgerTransactionId = normalizeOptionalString(metadata.target_ledger_transaction_id, { max: 80 });
  const relatedChargeId = normalizeOptionalString(row.related_charge_id, { max: 80 });
  const relatedTicketId = normalizeOptionalString(row.related_ticket_id, { max: 80 });
  const targetTransactionType = normalizeOptionalString(metadata.target_transaction_type, { max: 50 });

  const targets = [];
  if (targetLedgerTransactionId) targets.push(`ledger:${targetLedgerTransactionId}`);
  if (relatedChargeId) targets.push(`charge:${relatedChargeId}`);
  if (relatedTicketId) targets.push(`ticket:${relatedTicketId}`);
  if (targetTransactionType) targets.push(`type:${targetTransactionType}`);

  if (targets.length > 0) {
    return {
      scope: "targeted",
      targets: [...new Set(targets)],
      label: targets.join(","),
    };
  }

  return {
    scope: allocationScope === "targeted" ? "targeted" : "global",
    targets: [],
    label: allocationScope === "targeted" ? "targeted" : "global",
  };
}

function allocationTargetsMatch(targets = [], aliases = []) {
  if (!targets.length || !aliases.length) return false;
  const aliasSet = new Set(aliases);
  return targets.some((target) => aliasSet.has(target));
}

export function annotateLedgerTransactions(transactions = []) {
  const ordered = sortLedgerTransactionsAsc(transactions);
  const openDebits = [];
  const targetedCredits = [];
  let globalCreditCarryCents = 0;
  let outstandingCents = 0;
  const getCreditBalanceCents = () => (
    globalCreditCarryCents
    + targetedCredits.reduce((sum, credit) => sum + Math.max(0, credit.remainingCents), 0)
  );

  const applyToOpenDebits = (amountCents, targets = null) => {
    let remaining = amountCents;
    for (const debit of openDebits) {
      if (remaining <= 0) break;
      if (debit.remainingCents <= 0) continue;
      if (targets && !allocationTargetsMatch(targets, debit.aliases)) continue;
      const applied = Math.min(debit.remainingCents, remaining);
      debit.remainingCents -= applied;
      remaining -= applied;
      outstandingCents -= applied;
    }
    return remaining;
  };

  const consumeMatchingTargetedCredits = (amountCents, aliases = []) => {
    let remaining = amountCents;
    for (const credit of targetedCredits) {
      if (remaining <= 0) break;
      if (credit.remainingCents <= 0) continue;
      if (!allocationTargetsMatch(credit.targets, aliases)) continue;
      const applied = Math.min(credit.remainingCents, remaining);
      credit.remainingCents -= applied;
      remaining -= applied;
    }
    return remaining;
  };

  const annotated = ordered.map((row) => {
    const amountCents = toCents(Number(row.amount) || 0);
    const direction = row.direction === "credit" ? "credit" : "debit";
    const aliases = buildDebitAllocationAliases(row);
    const allocation = buildCreditAllocationTargets(row);

    if (amountCents > 0) {
      if (direction === "debit") {
        let remainingDebit = consumeMatchingTargetedCredits(amountCents, aliases);
        if (remainingDebit > 0 && globalCreditCarryCents > 0) {
          const applied = Math.min(globalCreditCarryCents, remainingDebit);
          globalCreditCarryCents -= applied;
          remainingDebit -= applied;
        }
        if (remainingDebit > 0) {
          openDebits.push({
            id: row.id || null,
            aliases,
            remainingCents: remainingDebit,
          });
          outstandingCents += remainingDebit;
        }
      } else if (allocation.scope === "targeted" && allocation.targets.length > 0) {
        const remainder = applyToOpenDebits(amountCents, allocation.targets);
        if (remainder > 0) {
          targetedCredits.push({
            targets: allocation.targets,
            label: allocation.label,
            remainingCents: remainder,
          });
        }
      } else {
        const remainder = applyToOpenDebits(amountCents);
        if (remainder > 0) {
          globalCreditCarryCents += remainder;
        }
      }
    }

    const creditBalanceCents = getCreditBalanceCents();
    const remainingBalance = roundMoney(outstandingCents / 100);
    const creditBalance = roundMoney(creditBalanceCents / 100);

    return {
      ...row,
      allocation_scope: direction === "credit" ? allocation.scope : "debit",
      allocation_targets: direction === "credit" ? allocation.targets : aliases,
      running_balance: remainingBalance,
      remaining_balance: remainingBalance,
      credit_balance: creditBalance,
      net_balance: roundMoney(remainingBalance - creditBalance),
    };
  });

  const finalOutstanding = roundMoney(outstandingCents / 100);
  const finalCreditBalance = roundMoney(getCreditBalanceCents() / 100);

  return {
    transactions: annotated,
    summary: {
      remaining_balance: finalOutstanding,
      credit_balance: finalCreditBalance,
      net_balance: roundMoney(finalOutstanding - finalCreditBalance),
    },
  };
}

export async function insertLedgerTransaction(sb, input) {
  const payload = normalizeLedgerTransactionInput(input);
  if (input.due_date) {
    payload.due_date = normalizeOptionalString(input.due_date, { max: 10 });
  }
  // Optional created_at override for backfill operations — preserves original
  // source timestamps so historical integrity is maintained.  Callers must
  // supply a valid ISO-8601 timestamp string; otherwise now() is used by DB.
  if (input.created_at) {
    const ts = normalizeOptionalString(input.created_at, { max: 40 });
    if (ts) payload.created_at = ts;
  }
  const { data, error } = await sb
    .from("renter_balance_ledger")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(`Could not insert ledger transaction: ${error.message}`);
  return data;
}

// addLedgerCharge: idempotent admin charge insertion.
// Uses source_type='manual_charge' + charge_request_id as the deduplication key.
// Returns the existing row on duplicate without error (idempotent).
export async function addLedgerCharge(sb, input = {}) {
  const chargeRequestId = normalizeOptionalString(input.chargeRequestId || input.charge_request_id, { max: 200 });
  if (!chargeRequestId) throw new Error("charge_request_id is required for idempotent Add Charge");

  const bookingRef = normalizeOptionalString(input.bookingId || input.booking_id || input.booking_ref, { max: 200 });
  if (!bookingRef) throw new Error("booking_id is required");

  const transactionType = normalizeOptionalString(input.transactionType || input.transaction_type, { max: 50 });
  if (!transactionType) throw new Error("transaction_type is required");
  if (!CHARGE_TRANSACTION_TYPES.includes(transactionType)) {
    throw new Error(`transaction_type must be a charge category. Allowed: ${CHARGE_TRANSACTION_TYPES.join(", ")}`);
  }

  // Check for existing entry with same idempotency key (idempotent)
  const { data: existing, error: lookupErr } = await sb
    .from("renter_balance_ledger")
    .select("*")
    .eq("source_type", "manual_charge")
    .eq("source_id", chargeRequestId)
    .maybeSingle();
  if (lookupErr) throw new Error(`Idempotency check failed: ${lookupErr.message}`);
  if (existing) return { transaction: existing, duplicate: true };

  const payload = normalizeLedgerTransactionInput({
    booking_id: bookingRef,
    customer_id: input.customerId || input.customer_id,
    transaction_type: transactionType,
    amount: input.amount,
    notes: input.notes,
    source_type: "manual_charge",
    source_id: chargeRequestId,
    related_charge_id: input.relatedChargeId || input.related_charge_id,
    related_ticket_id: input.relatedTicketId || input.related_ticket_id,
    allocation_scope: input.allocationScope || input.allocation_scope,
    target_transaction_type: input.targetTransactionType || input.target_transaction_type,
    target_ledger_transaction_id: input.targetLedgerTransactionId || input.target_ledger_transaction_id,
    metadata: input.metadata || {},
    created_by: normalizeOptionalString(input.createdBy || input.created_by, { max: 120 }) || "admin",
  });

  const dueDate = normalizeOptionalString(input.dueDate || input.due_date, { max: 10 });
  if (dueDate) payload.due_date = dueDate;

  const { data, error } = await sb
    .from("renter_balance_ledger")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    // Handle uniqueness constraint violation from concurrent requests (race-safe)
    if (error.code === "23505") {
      const { data: raced } = await sb
        .from("renter_balance_ledger")
        .select("*")
        .eq("source_type", "manual_charge")
        .eq("source_id", chargeRequestId)
        .maybeSingle();
      if (raced) return { transaction: raced, duplicate: true };
    }
    throw new Error(`Could not add charge: ${error.message}`);
  }
  return { transaction: data, duplicate: false };
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

// addLedgerPayment: idempotent Stripe payment credit.
// Keyed on source_type='stripe_payment' + source_id=paymentIntentId.
// Returns the existing row with duplicate=true on replay — safe for webhook retries.
export async function addLedgerPayment(sb, input = {}) {
  const piId = normalizeOptionalString(
    input.stripePaymentIntentId || input.stripe_payment_intent_id || input.paymentIntentId,
    { max: 255 }
  );
  if (!piId) throw new Error("stripe_payment_intent_id is required for addLedgerPayment");

  const { data: existing, error: lookupErr } = await sb
    .from("renter_balance_ledger")
    .select("*")
    .eq("source_type", "stripe_payment")
    .eq("source_id", piId)
    .maybeSingle();
  if (lookupErr) throw new Error(`Idempotency check failed: ${lookupErr.message}`);
  if (existing) return { transaction: existing, duplicate: true };

  const payload = normalizeLedgerTransactionInput({
    booking_id:               input.bookingId || input.booking_id || input.booking_ref,
    customer_id:              input.customerId || input.customer_id,
    transaction_type:         normalizeOptionalString(input.transactionType || input.transaction_type, { max: 50 }) || "payment",
    amount:                   input.amount,
    notes:                    input.notes,
    source_type:              "stripe_payment",
    source_id:                piId,
    stripe_payment_intent_id: piId,
    related_charge_id:        input.relatedChargeId || input.related_charge_id,
    related_ticket_id:        input.relatedTicketId || input.related_ticket_id,
    allocation_scope:         input.allocationScope || input.allocation_scope,
    target_transaction_type:  input.targetTransactionType || input.target_transaction_type,
    target_ledger_transaction_id: input.targetLedgerTransactionId || input.target_ledger_transaction_id,
    metadata:                 input.metadata || {},
    created_by:               normalizeOptionalString(input.createdBy || input.created_by, { max: 120 }) || "system",
  });

  const { data, error } = await sb
    .from("renter_balance_ledger")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await sb
        .from("renter_balance_ledger")
        .select("*")
        .eq("source_type", "stripe_payment")
        .eq("source_id", piId)
        .maybeSingle();
      if (raced) return { transaction: raced, duplicate: true };
    }
    throw new Error(`Could not add payment ledger entry: ${error.message}`);
  }
  return { transaction: data, duplicate: false };
}

// addLedgerRefund: idempotent Stripe refund debit.
// Keyed on source_type='stripe_refund' + source_id=chargeId (or refundId).
// A Stripe refund increases the renter's net balance because a previously
// collected payment was returned to the renter's card.
export async function addLedgerRefund(sb, input = {}) {
  const refundKey = normalizeOptionalString(
    input.chargeId || input.charge_id || input.refundId || input.refund_id,
    { max: 255 }
  );
  if (!refundKey) throw new Error("chargeId or refundId is required for addLedgerRefund");

  const { data: existing, error: lookupErr } = await sb
    .from("renter_balance_ledger")
    .select("*")
    .eq("source_type", "stripe_refund")
    .eq("source_id", refundKey)
    .maybeSingle();
  if (lookupErr) throw new Error(`Idempotency check failed: ${lookupErr.message}`);
  if (existing) return { transaction: existing, duplicate: true };

  const payload = normalizeLedgerTransactionInput({
    booking_id:               input.bookingId || input.booking_id || input.booking_ref,
    customer_id:              input.customerId || input.customer_id,
    transaction_type:         "refund",
    amount:                   input.amount,
    notes:                    input.notes,
    source_type:              "stripe_refund",
    source_id:                refundKey,
    stripe_payment_intent_id: normalizeOptionalString(
      input.stripePaymentIntentId || input.stripe_payment_intent_id, { max: 255 }
    ),
    related_charge_id:        input.relatedChargeId || input.related_charge_id,
    related_ticket_id:        input.relatedTicketId || input.related_ticket_id,
    allocation_scope:         input.allocationScope || input.allocation_scope,
    target_transaction_type:  input.targetTransactionType || input.target_transaction_type,
    target_ledger_transaction_id: input.targetLedgerTransactionId || input.target_ledger_transaction_id,
    metadata:                 input.metadata || {},
    created_by:               normalizeOptionalString(input.createdBy || input.created_by, { max: 120 }) || "system",
  });

  const { data, error } = await sb
    .from("renter_balance_ledger")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await sb
        .from("renter_balance_ledger")
        .select("*")
        .eq("source_type", "stripe_refund")
        .eq("source_id", refundKey)
        .maybeSingle();
      if (raced) return { transaction: raced, duplicate: true };
    }
    throw new Error(`Could not add refund ledger entry: ${error.message}`);
  }
  return { transaction: data, duplicate: false };
}

// addLedgerWaiver: idempotent admin waiver credit.
// Keyed on source_type='admin_waiver' + source_id=waiverKey.
// The waiverKey is caller-supplied; callers should build it from
// bookingRef + feeType + second-truncated ISO timestamp for dedup.
export async function addLedgerWaiver(sb, input = {}) {
  const waiverKey = normalizeOptionalString(input.waiverKey || input.waiver_key, { max: 255 });
  if (!waiverKey) throw new Error("waiverKey is required for addLedgerWaiver");

  const { data: existing, error: lookupErr } = await sb
    .from("renter_balance_ledger")
    .select("*")
    .eq("source_type", "admin_waiver")
    .eq("source_id", waiverKey)
    .maybeSingle();
  if (lookupErr) throw new Error(`Idempotency check failed: ${lookupErr.message}`);
  if (existing) return { transaction: existing, duplicate: true };

  const payload = normalizeLedgerTransactionInput({
    booking_id:  input.bookingId || input.booking_id || input.booking_ref,
    customer_id: input.customerId || input.customer_id,
    transaction_type: "waiver",
    amount:      input.amount,
    notes:       input.notes,
    source_type: "admin_waiver",
    source_id:   waiverKey,
    related_charge_id: input.relatedChargeId || input.related_charge_id,
    related_ticket_id: input.relatedTicketId || input.related_ticket_id,
    allocation_scope: input.allocationScope || input.allocation_scope,
    target_transaction_type: input.targetTransactionType || input.target_transaction_type,
    target_ledger_transaction_id: input.targetLedgerTransactionId || input.target_ledger_transaction_id,
    metadata:    input.metadata || {},
    created_by:  normalizeOptionalString(input.createdBy || input.created_by, { max: 120 }) || "admin",
  });

  const { data, error } = await sb
    .from("renter_balance_ledger")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await sb
        .from("renter_balance_ledger")
        .select("*")
        .eq("source_type", "admin_waiver")
        .eq("source_id", waiverKey)
        .maybeSingle();
      if (raced) return { transaction: raced, duplicate: true };
    }
    throw new Error(`Could not add waiver ledger entry: ${error.message}`);
  }
  return { transaction: data, duplicate: false };
}

// getLedgerRemainingBalance: convenience helper for pre-payment cap checks.
// Returns 0 when no ledger entries exist (booking has no outstanding balance on record).
export async function getLedgerRemainingBalance(sb, { bookingId } = {}) {
  const bookingRef = normalizeOptionalString(bookingId, { max: 200 });
  if (!bookingRef) throw new Error("bookingId is required");
  try {
    const summary = await getLedgerSummary(sb, { bookingId: bookingRef });
    return summary.remaining_balance;
  } catch (_) {
    return 0;
  }
}

// getLedgerOverdueBookings: returns bookings where net balance > 0 and at
// least one ledger entry has a due_date in the past (past cutoffDays offset).
// agingBuckets=true annotates each row with its aging bucket:
//   current (0–29 d), 30-59, 60-89, 90+
export async function getLedgerOverdueBookings(sb, { cutoffDays = 0, agingBuckets = true, limit = 200 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const dueScanLimit = Math.max(safeLimit * 50, 5000);

  // Step 1: find all booking_ids with any past-due ledger entry.
  const cutoffDate = new Date();
  cutoffDate.setUTCHours(0, 0, 0, 0);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - Math.max(0, Number(cutoffDays) || 0));
  const cutoffDateStr = cutoffDate.toISOString().slice(0, 10);

  const { data: dueRows, error: dueErr } = await sb
    .from("renter_balance_ledger")
    .select("booking_id, due_date")
    .not("due_date", "is", null)
    .lt("due_date", cutoffDateStr)
    .order("due_date", { ascending: true })
    .limit(dueScanLimit);
  if (dueErr) throw new Error(`getLedgerOverdueBookings due-date query failed: ${dueErr.message}`);

  if (!dueRows || dueRows.length === 0) return [];

  // Unique booking IDs with any overdue entry.
  const overdueBookingIds = [...new Set((dueRows || []).map((r) => r.booking_id))];

  const { data: ledgerRows, error: ledgerErr } = await sb
    .from("renter_balance_ledger")
    .select("id, booking_id, customer_id, transaction_type, direction, amount, created_at, related_charge_id, related_ticket_id, metadata")
    .in("booking_id", overdueBookingIds)
    .order("created_at", { ascending: true });
  if (ledgerErr) throw new Error(`getLedgerOverdueBookings ledger query failed: ${ledgerErr.message}`);

  const bookingSummaries = {};
  for (const row of ledgerRows || []) {
    const bookingId = row.booking_id;
    if (!bookingSummaries[bookingId]) {
      bookingSummaries[bookingId] = { rows: [], customer_id: row.customer_id || null };
    }
    bookingSummaries[bookingId].rows.push(row);
    if (!bookingSummaries[bookingId].customer_id && row.customer_id) {
      bookingSummaries[bookingId].customer_id = row.customer_id;
    }
  }

  const overdueWithBalance = overdueBookingIds
    .map((bookingId) => {
      const rows = bookingSummaries[bookingId]?.rows || [];
      const raw = computeLedgerSummary(rows);
      const allocation = annotateLedgerTransactions(rows).summary;
      return {
        booking_id: bookingId,
        customer_id: bookingSummaries[bookingId]?.customer_id || null,
        total_charges: raw.total_charges,
        total_credits: raw.total_credits,
        net_balance: allocation.net_balance,
        remaining_balance: allocation.remaining_balance,
      };
    })
    .filter((row) => Number(row.remaining_balance || 0) > 0);
  if (overdueWithBalance.length === 0) return [];

  const finalBookingIds = overdueWithBalance.map((r) => r.booking_id);

  // Step 3: fetch booking metadata.
  const { data: bookingRows, error: bErr } = await sb
    .from("bookings")
    .select("booking_ref, customer_email, customer_phone, customer_name, vehicle_id, return_date")
    .in("booking_ref", finalBookingIds)
    .limit(safeLimit);
  if (bErr) throw new Error(`getLedgerOverdueBookings bookings query failed: ${bErr.message}`);

  const bookingMap = {};
  for (const bk of bookingRows || []) {
    bookingMap[bk.booking_ref] = bk;
  }

  const now = Date.now();

  return overdueWithBalance
    .slice(0, safeLimit)
    .map((row) => {
      const bk = bookingMap[row.booking_id] || {};
      // Earliest overdue due_date for this booking.
      const earliestDue = (dueRows || [])
        .filter((d) => d.booking_id === row.booking_id)
        .map((d) => d.due_date)
        .sort()[0];
      const daysOverdue = earliestDue
        ? Math.floor((now - new Date(earliestDue).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      let aging_bucket = "current";
      if (daysOverdue !== null) {
        if (daysOverdue >= 90) aging_bucket = "90+";
        else if (daysOverdue >= 60) aging_bucket = "60-89";
        else if (daysOverdue >= 30) aging_bucket = "30-59";
        else aging_bucket = "current";
      }

      return {
        booking_id: row.booking_id,
        customer_id: row.customer_id || null,
        customer_email: bk.customer_email || null,
        customer_phone: bk.customer_phone || null,
        customer_name: bk.customer_name || null,
        vehicle_id: bk.vehicle_id || null,
        net_balance: roundMoney(Number(row.net_balance || 0)),
        remaining_balance: roundMoney(Number(row.remaining_balance || 0)),
        total_charges: roundMoney(Number(row.total_charges || 0)),
        total_credits: roundMoney(Number(row.total_credits || 0)),
        earliest_due_date: earliestDue || null,
        days_overdue: daysOverdue,
        ...(agingBuckets ? { aging_bucket } : {}),
      };
    })
    .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0));
}

// deleteLedgerTransaction: hard-delete a single ledger row by its UUID id.
// Admin-only — caller must already be authorized.
export async function deleteLedgerTransaction(sb, { id } = {}) {
  const rowId = normalizeOptionalString(id, { max: 80 });
  if (!rowId) throw new Error("id is required for deleteLedgerTransaction");

  // Fetch first so we can return the deleted row for confirmation.
  const { data: existing, error: fetchErr } = await sb
    .from("renter_balance_ledger")
    .select("*")
    .eq("id", rowId)
    .maybeSingle();
  if (fetchErr) throw new Error(`Could not find ledger entry: ${fetchErr.message}`);
  if (!existing) throw new Error("Ledger entry not found");

  const { error } = await sb
    .from("renter_balance_ledger")
    .delete()
    .eq("id", rowId);
  if (error) throw new Error(`Could not delete ledger entry: ${error.message}`);

  return { deleted: true, transaction: existing };
}

// updateLedgerTransaction: patch mutable fields (amount, notes, due_date,
// transaction_type) on a manual_charge ledger row.
// System-generated rows (stripe_payment, stripe_refund, admin_waiver) are
// protected and cannot be edited via this path.
export async function updateLedgerTransaction(sb, { id, transactionType, amount, notes, dueDate } = {}) {
  const rowId = normalizeOptionalString(id, { max: 80 });
  if (!rowId) throw new Error("id is required for updateLedgerTransaction");

  // Fetch first.
  const { data: existing, error: fetchErr } = await sb
    .from("renter_balance_ledger")
    .select("*")
    .eq("id", rowId)
    .maybeSingle();
  if (fetchErr) throw new Error(`Could not find ledger entry: ${fetchErr.message}`);
  if (!existing) throw new Error("Ledger entry not found");

  const patch = {};

  if (transactionType !== undefined && transactionType !== null) {
    const t = normalizeOptionalString(transactionType, { max: 50 });
    if (!LEDGER_TRANSACTION_TYPES.includes(t)) {
      throw new Error(`Invalid transaction_type: ${t}`);
    }
    patch.transaction_type = t;
    // Keep direction consistent with the new type.
    const dir = DEFAULT_DIRECTION_BY_TYPE[t];
    if (dir) patch.direction = dir;
  }

  if (amount !== undefined && amount !== null) {
    patch.amount = parsePositiveAmount(amount);
  }

  if (notes !== undefined) {
    patch.notes = normalizeOptionalString(notes, { max: 2000 }) || null;
  }

  if (dueDate !== undefined) {
    patch.due_date = normalizeOptionalString(dueDate, { max: 10 }) || null;
  }

  if (Object.keys(patch).length === 0) {
    return { transaction: existing, changed: false };
  }

  const { data, error } = await sb
    .from("renter_balance_ledger")
    .update(patch)
    .eq("id", rowId)
    .select("*")
    .single();
  if (error) throw new Error(`Could not update ledger entry: ${error.message}`);

  return { transaction: data, changed: true };
}

export async function getLedgerSummary(sb, { bookingId, customerId } = {}) {
  const bookingRef = normalizeOptionalString(bookingId, { max: 200 });
  const customerRef = normalizeOptionalString(customerId, { max: 80 });
  if (!bookingRef && !customerRef) {
    throw new Error("booking_id or customer_id is required");
  }

  let ledgerQuery = sb
    .from("renter_balance_ledger")
    .select("id,booking_id,customer_id,transaction_type,direction,amount,created_at,related_charge_id,related_ticket_id,metadata");

  if (bookingRef) {
    ledgerQuery = ledgerQuery.eq("booking_id", bookingRef);
  }
  if (customerRef) {
    ledgerQuery = ledgerQuery.eq("customer_id", customerRef);
  }

  const { data: rows, error } = await ledgerQuery.order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load ledger summary: ${error.message}`);

  const raw = computeLedgerSummary(rows || []);
  const allocation = annotateLedgerTransactions(rows || []).summary;

  return {
    total_charges: raw.total_charges,
    total_credits: raw.total_credits,
    total_paid: raw.total_paid,
    total_waived: raw.total_waived,
    total_refunds: raw.total_refunds,
    net_balance: allocation.net_balance,
    remaining_balance: allocation.remaining_balance,
    credit_balance: allocation.credit_balance,
    transaction_count: raw.transaction_count,
  };
}
