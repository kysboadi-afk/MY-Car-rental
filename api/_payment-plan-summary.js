function formatMoney(value) {
  return (Math.round(Number(value || 0) * 100) / 100).toFixed(2);
}

export async function fetchPaymentPlanSummary(sb, bookingRef, { missingTableErrorCode = "42P01" } = {}) {
  if (!bookingRef || !sb) return null;

  const { data: plans, error: planErr } = await sb
    .from("payment_plans")
    .select("id, status, total_amount, installments, interval_days, next_due_date, created_at")
    .eq("booking_id", bookingRef)
    .in("status", ["active", "defaulted"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (planErr) {
    if (planErr.code !== missingTableErrorCode) {
      console.warn("payment-plan-summary: payment plan lookup failed (non-fatal):", planErr.message);
    }
    return null;
  }

  const plan = Array.isArray(plans) ? plans[0] : null;
  if (!plan) return null;

  const { data: installments, error: instErr } = await sb
    .from("payment_plan_installments")
    .select("installment_number, amount, due_date, paid_at, status")
    .eq("plan_id", plan.id)
    .order("installment_number", { ascending: true });

  if (instErr) {
    if (instErr.code !== missingTableErrorCode) {
      console.warn("payment-plan-summary: payment installments lookup failed (non-fatal):", instErr.message);
    }
    return {
      id: plan.id,
      status: plan.status,
      totalAmount: formatMoney(plan.total_amount),
      installments: Number(plan.installments || 0),
      intervalDays: Number(plan.interval_days || 0),
      nextDueDate: plan.next_due_date || null,
      paidInstallments: 0,
      totalInstallments: Number(plan.installments || 0),
      nextInstallmentNumber: null,
      nextInstallmentAmount: null,
      isOverdue: false,
      overdueDays: 0,
    };
  }

  const rows = Array.isArray(installments) ? installments : [];
  const paidCount = rows.filter((row) => row.status === "paid").length;
  const unpaidRows = rows
    .filter((row) => row.status !== "paid")
    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  const nextRow = unpaidRows[0] || null;
  const nowMs = Date.now();
  const nextDueMs = nextRow?.due_date ? new Date(nextRow.due_date).getTime() : NaN;
  const isOverdue = Number.isFinite(nextDueMs) && nextDueMs < nowMs;
  const overdueDays = isOverdue
    ? Math.floor((nowMs - nextDueMs) / (24 * 60 * 60 * 1000))
    : 0;

  return {
    id: plan.id,
    status: plan.status,
    totalAmount: formatMoney(plan.total_amount),
    installments: Number(plan.installments || rows.length || 0),
    intervalDays: Number(plan.interval_days || 0),
    nextDueDate: nextRow?.due_date || plan.next_due_date || null,
    paidInstallments: paidCount,
    totalInstallments: rows.length || Number(plan.installments || 0),
    nextInstallmentNumber: nextRow ? Number(nextRow.installment_number || 0) : null,
    nextInstallmentAmount: nextRow ? formatMoney(nextRow.amount) : null,
    isOverdue,
    overdueDays,
  };
}
