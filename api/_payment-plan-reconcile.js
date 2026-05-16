function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function nowIso() {
  return new Date().toISOString();
}

function isCancelledStatus(status) {
  return String(status || "").toLowerCase() === "cancelled";
}

function isCompletedStatus(status) {
  return String(status || "").toLowerCase() === "completed";
}

function isFullyPaidInstallment(installment = {}) {
  const amount = roundMoney(installment.amount || 0);
  const amountPaid = roundMoney(installment.amount_paid || 0);
  return amount > 0 && amountPaid >= amount - 0.009;
}

function installmentOutstanding(installment = {}) {
  const amount = roundMoney(installment.amount || 0);
  const amountPaid = roundMoney(installment.amount_paid || 0);
  return Math.max(0, roundMoney(amount - amountPaid));
}

function normalizeInstallment(installment = {}) {
  const amount = roundMoney(installment.amount || 0);
  const paidFromField = installment.amount_paid != null ? Number(installment.amount_paid) : null;
  const legacyPaid = String(installment.status || "").toLowerCase() === "paid" ? amount : 0;
  const amountPaid = roundMoney(
    Number.isFinite(paidFromField) && paidFromField >= 0 ? paidFromField : legacyPaid
  );
  return {
    ...installment,
    amount,
    amount_paid: Math.max(0, amountPaid),
  };
}

async function ensureAllocationTableExists(sb) {
  try {
    const { error } = await sb
      .from("payment_plan_allocations")
      .select("id")
      .limit(1);
    if (error) throw error;
    return true;
  } catch (_) {
    return false;
  }
}

export async function computePaymentPlanProgress(sb, { bookingId, includeInstallments = false } = {}) {
  const bookingRef = String(bookingId || "").trim();
  if (!bookingRef) {
    return {
      booking_id: null,
      active_plan_count: 0,
      has_active_plan: false,
      plan_status: "none",
      installment_count: 0,
      remaining_installments: 0,
      remaining_balance: 0,
      overdue_amount: 0,
      next_due_date: null,
      last_payment_at: null,
      installments: [],
    };
  }

  const { data: plans, error: plansErr } = await sb
    .from("payment_plans")
    .select("*")
    .eq("booking_id", bookingRef)
    .order("created_at", { ascending: false });
  if (plansErr) throw new Error(`payment plan progress lookup failed: ${plansErr.message}`);

  if (!plans || plans.length === 0) {
    return {
      booking_id: bookingRef,
      active_plan_count: 0,
      has_active_plan: false,
      plan_status: "none",
      installment_count: 0,
      remaining_installments: 0,
      remaining_balance: 0,
      overdue_amount: 0,
      next_due_date: null,
      last_payment_at: null,
      installments: [],
    };
  }

  const activePlans = plans.filter((plan) => !isCancelledStatus(plan.status) && !isCompletedStatus(plan.status));
  const planIds = (activePlans.length ? activePlans : plans).map((p) => p.id);

  const { data: rawInstallments, error: installmentsErr } = await sb
    .from("payment_plan_installments")
    .select("*")
    .in("plan_id", planIds)
    .order("due_date", { ascending: true })
    .order("installment_number", { ascending: true });
  if (installmentsErr) throw new Error(`payment plan installments lookup failed: ${installmentsErr.message}`);

  const installments = (rawInstallments || []).map(normalizeInstallment);
  const openInstallments = installments.filter((row) => !isFullyPaidInstallment(row));
  const remainingInstallments = openInstallments.length;

  const remainingBalance = roundMoney(
    openInstallments.reduce((sum, row) => sum + installmentOutstanding(row), 0)
  );

  const today = new Date();
  const overdueInstallments = openInstallments.filter((row) => {
    if (!row.due_date) return false;
    return new Date(row.due_date).getTime() < today.getTime();
  });
  const overdueAmount = roundMoney(
    overdueInstallments.reduce((sum, row) => sum + installmentOutstanding(row), 0)
  );

  const nextDueInstallment = openInstallments
    .filter((row) => row.due_date)
    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null;

  const lastPaymentAt = installments
    .map((row) => row.last_paid_at || row.paid_at || null)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    booking_id: bookingRef,
    active_plan_count: activePlans.length,
    has_active_plan: activePlans.length > 0,
    plan_status: activePlans.length > 0 ? (overdueAmount > 0 ? "defaulted" : "active") : "completed_or_cancelled",
    installment_count: installments.length,
    remaining_installments: remainingInstallments,
    remaining_balance: remainingBalance,
    overdue_amount: overdueAmount,
    next_due_date: nextDueInstallment?.due_date || null,
    last_payment_at: lastPaymentAt,
    installments: includeInstallments ? installments : [],
  };
}

async function updatePlanRollup(sb, plan, installments) {
  if (!plan || !plan.id) return;
  if (isCancelledStatus(plan.status)) return;

  const normalizedInstallments = (installments || []).map(normalizeInstallment);
  const unpaid = normalizedInstallments.filter((row) => !isFullyPaidInstallment(row));
  const nextDue = unpaid
    .filter((row) => row.due_date)
    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null;
  const overdueExists = unpaid.some((row) => row.due_date && new Date(row.due_date).getTime() < Date.now());
  const allPaid = normalizedInstallments.length > 0 && unpaid.length === 0;

  const nextStatus = allPaid ? "completed" : (overdueExists ? "defaulted" : "active");
  const updates = {
    status: nextStatus,
    next_due_date: allPaid ? null : (nextDue?.due_date || plan.next_due_date || null),
  };
  await sb.from("payment_plans").update(updates).eq("id", plan.id);
}

export async function reconcilePaymentPlanPayment(sb, input = {}) {
  const bookingId = String(input.bookingId || input.booking_id || input.booking_ref || "").trim();
  const paymentIntentId = String(
    input.paymentIntentId || input.payment_intent_id || input.stripe_payment_intent_id || ""
  ).trim();
  const amount = roundMoney(input.amount || input.amount_paid || 0);
  const ledgerTransactionId = input.ledgerTransactionId || input.ledger_transaction_id || null;
  const createdBy = String(input.createdBy || input.created_by || "system").slice(0, 120);
  const allocatedAt = input.allocatedAt || nowIso();

  if (!bookingId) throw new Error("booking_id is required for payment-plan reconciliation");
  if (!paymentIntentId) throw new Error("payment_intent_id is required for payment-plan reconciliation");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number");

  const allocationsTableAvailable = await ensureAllocationTableExists(sb);
  if (allocationsTableAvailable) {
    const { data: existingAllocations } = await sb
      .from("payment_plan_allocations")
      .select("id, plan_id, installment_id, amount_allocated, allocation_type, created_at")
      .eq("booking_id", bookingId)
      .eq("stripe_payment_intent_id", paymentIntentId)
      .order("allocation_order", { ascending: true });
    if (existingAllocations && existingAllocations.length > 0) {
      const amountAllocated = roundMoney(
        existingAllocations.reduce((sum, row) => sum + Number(row.amount_allocated || 0), 0)
      );
      return {
        ok: true,
        duplicate: true,
        booking_id: bookingId,
        payment_intent_id: paymentIntentId,
        amount_received: amount,
        amount_allocated: amountAllocated,
        amount_unapplied: roundMoney(Math.max(0, amount - amountAllocated)),
        allocations: existingAllocations,
      };
    }
  }

  const { data: allPlans, error: plansErr } = await sb
    .from("payment_plans")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });
  if (plansErr) throw new Error(`payment-plan reconciliation plan lookup failed: ${plansErr.message}`);

  const candidatePlans = (allPlans || []).filter((plan) => !isCancelledStatus(plan.status) && !isCompletedStatus(plan.status));
  if (candidatePlans.length === 0) {
    return {
      ok: true,
      duplicate: false,
      booking_id: bookingId,
      payment_intent_id: paymentIntentId,
      amount_received: amount,
      amount_allocated: 0,
      amount_unapplied: amount,
      allocations: [],
      message: "No active payment plan found for booking.",
    };
  }

  const allocations = [];
  let remainingToAllocate = amount;
  let allocationOrder = 0;

  for (const plan of candidatePlans) {
    if (remainingToAllocate <= 0) break;

    const { data: rawInstallments, error: instErr } = await sb
      .from("payment_plan_installments")
      .select("*")
      .eq("plan_id", plan.id)
      .order("due_date", { ascending: true })
      .order("installment_number", { ascending: true });
    if (instErr) throw new Error(`payment-plan reconciliation installment lookup failed: ${instErr.message}`);

    const installments = (rawInstallments || []).map(normalizeInstallment);

    for (const installment of installments) {
      if (remainingToAllocate <= 0) break;
      const outstanding = installmentOutstanding(installment);
      if (outstanding <= 0) continue;

      const allocation = roundMoney(Math.min(remainingToAllocate, outstanding));
      if (allocation <= 0) continue;

      const newAmountPaid = roundMoney((Number(installment.amount_paid || 0) + allocation));
      const paidInFull = newAmountPaid >= Number(installment.amount) - 0.009;
      const installmentStatus = paidInFull ? "paid" : "partial";

      const installmentUpdates = {
        amount_paid: newAmountPaid,
        status: installmentStatus,
        last_paid_at: allocatedAt,
        payment_intent_id: paymentIntentId,
        last_payment_intent_id: paymentIntentId,
        last_ledger_transaction_id: ledgerTransactionId || installment.last_ledger_transaction_id || null,
        last_allocation_at: allocatedAt,
      };
      if (paidInFull) {
        installmentUpdates.paid_at = installment.paid_at || allocatedAt;
        installmentUpdates.ledger_transaction_id = ledgerTransactionId || installment.ledger_transaction_id || null;
      }

      const { error: updateErr } = await sb
        .from("payment_plan_installments")
        .update(installmentUpdates)
        .eq("id", installment.id);
      if (updateErr) throw new Error(`payment-plan reconciliation installment update failed: ${updateErr.message}`);

      allocationOrder += 1;
      const allocationRow = {
        plan_id: plan.id,
        installment_id: installment.id,
        booking_id: bookingId,
        stripe_payment_intent_id: paymentIntentId,
        ledger_transaction_id: ledgerTransactionId,
        amount_allocated: allocation,
        allocation_order: allocationOrder,
        allocation_type: paidInFull ? "installment_paid" : "installment_partial",
        metadata: {
          installment_number: installment.installment_number,
          installment_amount: installment.amount,
          installment_amount_paid_before: installment.amount_paid || 0,
          installment_amount_paid_after: newAmountPaid,
          outstanding_before: outstanding,
          outstanding_after: roundMoney(Math.max(0, outstanding - allocation)),
          created_by: createdBy,
        },
      };
      allocations.push(allocationRow);

      if (allocationsTableAvailable) {
        const { error: allocErr } = await sb
          .from("payment_plan_allocations")
          .insert({ ...allocationRow, created_at: allocatedAt });
        if (allocErr && allocErr.code !== "23505") {
          throw new Error(`payment-plan allocation log failed: ${allocErr.message}`);
        }
      }

      remainingToAllocate = roundMoney(remainingToAllocate - allocation);
    }

    const { data: refreshInstallments, error: refreshErr } = await sb
      .from("payment_plan_installments")
      .select("*")
      .eq("plan_id", plan.id);
    if (refreshErr) throw new Error(`payment-plan refresh failed: ${refreshErr.message}`);
    await updatePlanRollup(sb, plan, refreshInstallments || []);
  }

  if (remainingToAllocate > 0) {
    allocationOrder += 1;
    const unappliedRow = {
      plan_id: candidatePlans[0].id,
      installment_id: null,
      booking_id: bookingId,
      stripe_payment_intent_id: paymentIntentId,
      ledger_transaction_id: ledgerTransactionId,
      amount_allocated: remainingToAllocate,
      allocation_order: allocationOrder,
      allocation_type: "overpayment_unapplied",
      metadata: { created_by: createdBy },
    };
    allocations.push(unappliedRow);
    if (allocationsTableAvailable) {
      const { error: overpayErr } = await sb
        .from("payment_plan_allocations")
        .insert({ ...unappliedRow, created_at: allocatedAt });
      if (overpayErr && overpayErr.code !== "23505") {
        throw new Error(`payment-plan overpayment log failed: ${overpayErr.message}`);
      }
    }
  }

  const allocatedAmount = roundMoney(allocations.reduce((sum, row) => sum + Number(row.amount_allocated || 0), 0));
  return {
    ok: true,
    duplicate: false,
    booking_id: bookingId,
    payment_intent_id: paymentIntentId,
    amount_received: amount,
    amount_allocated: allocatedAmount,
    amount_unapplied: roundMoney(Math.max(0, amount - allocatedAmount)),
    allocations,
  };
}
