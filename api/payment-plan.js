// api/payment-plan.js
// Phase 4.6 — Payment plan management.
//
// Creates and manages multi-installment payment plans for renters with
// outstanding balances.  Every paid installment links to its ledger transaction
// via ledger_transaction_id, ensuring installment payments reconcile cleanly
// against the booking's renter_balance_ledger totals.
//
// POST /api/payment-plan  (admin secret required)
//
// Actions:
//   create  — { secret, action:"create", booking_id, customer_email, total_amount, installments, interval_days, notes?, start_date? }
//   get     — { secret, action:"get", plan_id? | booking_id? }
//   list    — { secret, action:"list", status?, limit?, offset? }
//   update  — { secret, action:"update", plan_id, customer_email?, total_amount?, installments?, interval_days?, notes?, next_due_date? }
//   cancel  — { secret, action:"cancel", plan_id, reason? }
//   delete  — { secret, action:"delete", plan_id }
//   pay_installment — { secret, action:"pay_installment", plan_id, installment_number, payment_intent_id, amount_paid }
//
// Installment traceability:
//   - Each installment row carries ledger_transaction_id linking to renter_balance_ledger.
//   - Partial installment payments set status="partial" and can be followed by
//     another pay_installment call for the remainder.
//
// Plan auto-completion:
//   When all installments reach status="paid", the plan is automatically
//   transitioned to status="completed".

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";
import { computePaymentPlanProgress, reconcilePaymentPlanPayment } from "./_payment-plan-reconcile.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  if (!isAdminAuthorized(body.secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  const { action = "list" } = body;

  try {
    switch (action) {
      case "create":
        return await handleCreate(sb, body, res);
      case "get":
        return await handleGet(sb, body, res);
      case "list":
        return await handleList(sb, body, res);
      case "update":
        return await handleUpdate(sb, body, res);
      case "cancel":
        return await handleCancel(sb, body, res);
      case "delete":
        return await handleDelete(sb, body, res);
      case "pay_installment":
        return await handlePayInstallment(sb, body, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("[payment-plan] error:", err.message);
    return res.status(400).json({ error: err.message || "Request failed" });
  }
}

// ── Create ─────────────────────────────────────────────────────────────────────

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function formatDateKey(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function buildInstallmentRows(planId, totalAmount, installmentCount, intervalDays, startAt) {
  const totalAmt = roundMoney(totalAmount);
  const numInstallments = Number(installmentCount);
  const numInterval = Number(intervalDays);
  const baseInstallment = Math.floor((totalAmt / numInstallments) * 100) / 100;
  const remainder = roundMoney(totalAmt - baseInstallment * numInstallments);
  const rows = [];

  for (let i = 0; i < numInstallments; i++) {
    const dueDate = new Date(startAt.getTime() + i * numInterval * 24 * 60 * 60 * 1000);
    const amount = i === numInstallments - 1
      ? roundMoney(baseInstallment + remainder)
      : baseInstallment;
    rows.push({
      plan_id: planId,
      installment_number: i + 1,
      amount,
      due_date: dueDate.toISOString(),
    });
  }

  return rows;
}

async function handleCreate(sb, body, res) {
  const { booking_id, customer_email, total_amount, installments, interval_days, notes, start_date } = body;

  if (!booking_id) throw new Error("booking_id is required");
  if (!customer_email) throw new Error("customer_email is required");
  if (!total_amount || Number(total_amount) <= 0) throw new Error("total_amount must be a positive number");
  const numInstallments = Number(installments);
  if (!Number.isInteger(numInstallments) || numInstallments < 2 || numInstallments > 24) {
    throw new Error("installments must be an integer between 2 and 24");
  }
  const numInterval = Number(interval_days);
  if (!Number.isInteger(numInterval) || numInterval < 1 || numInterval > 90) {
    throw new Error("interval_days must be an integer between 1 and 90");
  }

  const totalAmt = roundMoney(total_amount);
  const startAt = start_date ? new Date(start_date) : new Date();

  // Create plan.
  const { data: plan, error: planErr } = await sb
    .from("payment_plans")
    .insert({
      booking_id,
      customer_email: String(customer_email).trim().toLowerCase(),
      total_amount: totalAmt,
      installments: numInstallments,
      interval_days: numInterval,
      next_due_date: startAt.toISOString(),
      notes: notes ? String(notes).trim().slice(0, 2000) : null,
      created_by: body.created_by || "admin",
    })
    .select("*")
    .single();
  if (planErr) throw new Error(`Could not create payment plan: ${planErr.message}`);

  // Create installment rows.
  const installmentRows = buildInstallmentRows(plan.id, totalAmt, numInstallments, numInterval, startAt);

  const { error: instErr } = await sb
    .from("payment_plan_installments")
    .insert(installmentRows);
  if (instErr) throw new Error(`Could not create installments: ${instErr.message}`);

  const { data: createdInstallments } = await sb
    .from("payment_plan_installments")
    .select("*")
    .eq("plan_id", plan.id)
    .order("installment_number", { ascending: true });

  return res.status(200).json({
    ok: true,
    message: "Payment plan created.",
    plan,
    installments: createdInstallments || [],
  });
}

// ── Get ────────────────────────────────────────────────────────────────────────

async function handleGet(sb, body, res) {
  const { plan_id, booking_id } = body;
  if (!plan_id && !booking_id) throw new Error("plan_id or booking_id is required");

  let q = sb.from("payment_plans").select("*");
  if (plan_id) q = q.eq("id", plan_id);
  if (booking_id) q = q.eq("booking_id", booking_id);
  const { data: plans, error } = await q.order("created_at", { ascending: false });
  if (error) throw new Error(`Could not fetch payment plan: ${error.message}`);

  const results = [];
  for (const plan of plans || []) {
    const { data: installments } = await sb
      .from("payment_plan_installments")
      .select("*")
      .eq("plan_id", plan.id)
      .order("installment_number", { ascending: true });
    const normalizedInstallments = (installments || []).map((row) => ({
      ...row,
      amount_paid: row.amount_paid != null
        ? roundMoney(row.amount_paid)
        : (row.status === "paid" ? roundMoney(row.amount) : 0),
    }));
    const remainingBalance = roundMoney(
      normalizedInstallments.reduce((sum, row) => (
        sum + Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0)))
      ), 0)
    );
    const overdueAmount = roundMoney(
      normalizedInstallments.reduce((sum, row) => {
        const openAmount = Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0)));
        if (openAmount <= 0 || !row.due_date) return sum;
        return new Date(row.due_date).getTime() < Date.now() ? sum + openAmount : sum;
      }, 0)
    );
    const nextDue = normalizedInstallments
      .filter((row) => Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0))) > 0 && row.due_date)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null;
    results.push({
      ...plan,
      installments: normalizedInstallments,
      remaining_balance: remainingBalance,
      overdue_amount: overdueAmount,
      remaining_installments: normalizedInstallments.filter((row) => (
        Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0))) > 0
      )).length,
      next_due_date: nextDue?.due_date || plan.next_due_date || null,
      last_payment_at: normalizedInstallments
        .map((row) => row.last_paid_at || row.paid_at || null)
        .filter(Boolean)
        .sort()
        .pop() || null,
    });
  }

  return res.status(200).json({ ok: true, plans: results });
}

// ── List ───────────────────────────────────────────────────────────────────────

async function handleList(sb, body, res) {
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
  const offset = Math.max(Number(body.offset) || 0, 0);

  let q = sb.from("payment_plans").select("*").order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (body.status) q = q.eq("status", body.status);

  const { data: plans, error } = await q;
  if (error) throw new Error(`Could not list payment plans: ${error.message}`);

  const enrichedPlans = [];
  for (const plan of plans || []) {
    const progress = await computePaymentPlanProgress(sb, { bookingId: plan.booking_id });
    const { data: installments } = await sb
      .from("payment_plan_installments")
      .select("*")
      .eq("plan_id", plan.id)
      .order("installment_number", { ascending: true });
    const scopedInstallments = (installments || []).map((row) => ({
      ...row,
      amount_paid: row.amount_paid != null
        ? roundMoney(row.amount_paid)
        : (row.status === "paid" ? roundMoney(row.amount) : 0),
    }));
    const remainingBalance = roundMoney(
      scopedInstallments.reduce((sum, row) => (
        sum + Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0)))
      ), 0)
    );
    const overdueAmount = roundMoney(
      scopedInstallments.reduce((sum, row) => {
        const openAmount = Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0)));
        if (openAmount <= 0 || !row.due_date) return sum;
        return new Date(row.due_date).getTime() < Date.now() ? sum + openAmount : sum;
      }, 0)
    );
    const remainingInstallments = scopedInstallments.filter((row) => (
      Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0))) > 0
    )).length;
    const nextDue = scopedInstallments
      .filter((row) => Math.max(0, roundMoney(Number(row.amount || 0) - Number(row.amount_paid || 0))) > 0 && row.due_date)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null;

    enrichedPlans.push({
      ...plan,
      remaining_balance: remainingBalance,
      overdue_amount: overdueAmount,
      remaining_installments: remainingInstallments,
      next_due_date: nextDue?.due_date || plan.next_due_date || null,
      last_payment_at: scopedInstallments.map((row) => row.last_paid_at || row.paid_at || null).filter(Boolean).sort().pop() || null,
      active_plan_count_for_booking: progress.active_plan_count,
    });
  }

  return res.status(200).json({ ok: true, plans: enrichedPlans });
}

// ── Cancel ─────────────────────────────────────────────────────────────────────

async function handleUpdate(sb, body, res) {
  const { plan_id } = body;
  if (!plan_id) throw new Error("plan_id is required");
  if (body.booking_id != null) throw new Error("booking_id is immutable for existing payment plans");

  const { data: plan, error: planErr } = await sb
    .from("payment_plans")
    .select("*")
    .eq("id", plan_id)
    .maybeSingle();
  if (planErr) throw new Error(`Could not fetch payment plan: ${planErr.message}`);
  if (!plan) throw new Error("Payment plan not found");

  const { data: installments, error: installmentsErr } = await sb
    .from("payment_plan_installments")
    .select("*")
    .eq("plan_id", plan_id)
    .order("installment_number", { ascending: true });
  if (installmentsErr) throw new Error(`Could not fetch installments: ${installmentsErr.message}`);

  const updates = {};

  if (body.customer_email !== undefined) {
    const email = String(body.customer_email || "").trim().toLowerCase();
    if (!email) throw new Error("customer_email is required");
    updates.customer_email = email;
  }

  if (body.notes !== undefined) {
    updates.notes = body.notes ? String(body.notes).trim().slice(0, 2000) : null;
  }

  let scheduleStartAt = plan.next_due_date ? new Date(plan.next_due_date) : new Date();
  let structuralChange = false;

  if (body.total_amount !== undefined) {
    const totalAmt = roundMoney(body.total_amount);
    if (!totalAmt || totalAmt <= 0) throw new Error("total_amount must be a positive number");
    updates.total_amount = totalAmt;
    structuralChange = structuralChange || totalAmt !== roundMoney(plan.total_amount);
  }

  if (body.installments !== undefined) {
    const numInstallments = Number(body.installments);
    if (!Number.isInteger(numInstallments) || numInstallments < 2 || numInstallments > 24) {
      throw new Error("installments must be an integer between 2 and 24");
    }
    updates.installments = numInstallments;
    structuralChange = structuralChange || numInstallments !== Number(plan.installments);
  }

  if (body.interval_days !== undefined) {
    const numInterval = Number(body.interval_days);
    if (!Number.isInteger(numInterval) || numInterval < 1 || numInterval > 90) {
      throw new Error("interval_days must be an integer between 1 and 90");
    }
    updates.interval_days = numInterval;
    structuralChange = structuralChange || numInterval !== Number(plan.interval_days);
  }

  if (body.next_due_date !== undefined) {
    const nextDueDate = new Date(body.next_due_date);
    if (Number.isNaN(nextDueDate.getTime())) throw new Error("next_due_date must be a valid date");
    scheduleStartAt = nextDueDate;
    updates.next_due_date = nextDueDate.toISOString();
    structuralChange = structuralChange || formatDateKey(plan.next_due_date) !== formatDateKey(nextDueDate);
  }

  if (!Object.keys(updates).length) {
    return res.status(200).json({ ok: true, message: "No changes applied.", plan, installments: installments || [] });
  }

  if (structuralChange) {
    const hasRecordedPayments = (installments || []).some((installment) => (
      installment.status === "paid"
      || installment.status === "partial"
      || installment.payment_intent_id
      || installment.ledger_transaction_id
    ));
    if (hasRecordedPayments) {
      throw new Error("Cannot change the payment schedule after installment payments have been recorded");
    }
    if (plan.status !== "active") {
      throw new Error("Only active payment plans can have their schedule changed");
    }
  }

  const { data: updatedPlan, error: updateErr } = await sb
    .from("payment_plans")
    .update(updates)
    .eq("id", plan_id)
    .select("*")
    .single();
  if (updateErr) throw new Error(`Could not update payment plan: ${updateErr.message}`);

  if (structuralChange) {
    const { error: deleteInstallmentsErr } = await sb
      .from("payment_plan_installments")
      .delete()
      .eq("plan_id", plan_id);
    if (deleteInstallmentsErr) throw new Error(`Could not reset installments: ${deleteInstallmentsErr.message}`);

    const scheduleRows = buildInstallmentRows(
      plan_id,
      updates.total_amount ?? plan.total_amount,
      updates.installments ?? plan.installments,
      updates.interval_days ?? plan.interval_days,
      scheduleStartAt,
    );
    const { error: insertInstallmentsErr } = await sb
      .from("payment_plan_installments")
      .insert(scheduleRows);
    if (insertInstallmentsErr) throw new Error(`Could not recreate installments: ${insertInstallmentsErr.message}`);
  }

  const { data: refreshedInstallments, error: refreshedInstallmentsErr } = await sb
    .from("payment_plan_installments")
    .select("*")
    .eq("plan_id", plan_id)
    .order("installment_number", { ascending: true });
  if (refreshedInstallmentsErr) throw new Error(`Could not fetch updated installments: ${refreshedInstallmentsErr.message}`);

  return res.status(200).json({
    ok: true,
    message: "Payment plan updated.",
    plan: updatedPlan,
    installments: refreshedInstallments || [],
  });
}

async function handleCancel(sb, body, res) {
  const { plan_id, reason } = body;
  if (!plan_id) throw new Error("plan_id is required");

  const { data: updated, error } = await sb
    .from("payment_plans")
    .update({ status: "cancelled", notes: reason ? String(reason).trim().slice(0, 2000) : null })
    .eq("id", plan_id)
    .select("*")
    .single();
  if (error) throw new Error(`Could not cancel payment plan: ${error.message}`);

  return res.status(200).json({ ok: true, message: "Payment plan cancelled.", plan: updated });
}

async function handleDelete(sb, body, res) {
  const { plan_id } = body;
  if (!plan_id) throw new Error("plan_id is required");

  const { data: plan, error: planErr } = await sb
    .from("payment_plans")
    .select("id")
    .eq("id", plan_id)
    .maybeSingle();
  if (planErr) throw new Error(`Could not fetch payment plan: ${planErr.message}`);
  if (!plan) throw new Error("Payment plan not found");

  const { data: installments, error: installmentsErr } = await sb
    .from("payment_plan_installments")
    .select("status,payment_intent_id,ledger_transaction_id")
    .eq("plan_id", plan_id);
  if (installmentsErr) throw new Error(`Could not inspect installments: ${installmentsErr.message}`);

  const hasRecordedPayments = (installments || []).some((installment) => (
    installment.status === "paid"
    || installment.status === "partial"
    || installment.payment_intent_id
    || installment.ledger_transaction_id
  ));
  if (hasRecordedPayments) {
    throw new Error("Cannot delete a payment plan with recorded installment payments");
  }

  const { error: deleteErr } = await sb
    .from("payment_plans")
    .delete()
    .eq("id", plan_id);
  if (deleteErr) throw new Error(`Could not delete payment plan: ${deleteErr.message}`);

  return res.status(200).json({ ok: true, message: "Payment plan deleted." });
}

// ── Pay installment ────────────────────────────────────────────────────────────

async function handlePayInstallment(sb, body, res) {
  const { plan_id, installment_number, payment_intent_id, amount_paid } = body;
  if (!plan_id) throw new Error("plan_id is required");
  if (!installment_number) throw new Error("installment_number is required");
  if (!payment_intent_id) throw new Error("payment_intent_id is required");
  if (!amount_paid || Number(amount_paid) <= 0) throw new Error("amount_paid must be a positive number");

  const amtPaid = Math.round(Number(amount_paid) * 100) / 100;

  // Fetch plan + installment.
  const { data: plan, error: planErr } = await sb
    .from("payment_plans")
    .select("*")
    .eq("id", plan_id)
    .maybeSingle();
  if (planErr) throw new Error(`Could not fetch plan: ${planErr.message}`);
  if (!plan) throw new Error("Payment plan not found");
  if (plan.status === "cancelled") throw new Error("Cannot pay a cancelled plan");
  if (plan.status === "completed") throw new Error("Payment plan is already completed");

  const { data: installment, error: instErr } = await sb
    .from("payment_plan_installments")
    .select("*")
    .eq("plan_id", plan_id)
    .eq("installment_number", Number(installment_number))
    .maybeSingle();
  if (instErr) throw new Error(`Could not fetch installment: ${instErr.message}`);
  if (!installment) throw new Error("Installment not found");
  const normalizedAmountPaid = installment.amount_paid != null
    ? roundMoney(installment.amount_paid)
    : (installment.status === "paid" ? roundMoney(installment.amount) : 0);
  if (normalizedAmountPaid >= roundMoney(installment.amount) - 0.009) {
    throw new Error("Installment is already paid");
  }

  // Use a distinct source_type for payment plan installments so these credits
  // are distinguishable from regular one-time Stripe payments in the ledger.
  // source_id = payment_intent_id for Stripe dedup; source_type = "payment_plan_installment"
  // for traceability (allows future non-Stripe installment methods without key conflicts).
  const sourceType = "payment_plan_installment";
  const sourceId = payment_intent_id;

  // Idempotency check — if this PI was already written for this installment, return existing.
  const { data: existingLedger } = await sb
    .from("renter_balance_ledger")
    .select("id")
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .maybeSingle();

  let ledgerTxId = null;
  let isDuplicate = false;

  if (existingLedger) {
    ledgerTxId = existingLedger.id;
    isDuplicate = true;
  } else {
    // Write a ledger payment entry for this installment.
    const { data: ledgerRow, error: ledgerErr } = await sb
      .from("renter_balance_ledger")
      .insert({
        booking_id: plan.booking_id,
        transaction_type: "payment",
        direction: "credit",
        amount: amtPaid,
        source_type: sourceType,
        source_id: sourceId,
        stripe_payment_intent_id: payment_intent_id,
        notes: `Payment plan installment ${installment_number} of ${plan.installments}`,
        metadata: { plan_id: plan.id, installment_number: Number(installment_number) },
        created_by: body.created_by || "admin",
      })
      .select("id")
      .single();
    if (ledgerErr) throw new Error(`Could not write ledger transaction: ${ledgerErr.message}`);
    ledgerTxId = ledgerRow.id;
  }

  const reconcile = await reconcilePaymentPlanPayment(sb, {
    booking_id: plan.booking_id,
    payment_intent_id,
    amount: amtPaid,
    ledger_transaction_id: ledgerTxId,
    created_by: body.created_by || "admin",
  });
  const allocatedInstallment = (reconcile.allocations || []).find((row) => (
    String(row.installment_id || "") === String(installment.id)
  ));
  const newStatus = allocatedInstallment?.allocation_type === "installment_paid"
    ? "paid"
    : "partial";

  const latestProgress = await computePaymentPlanProgress(sb, { bookingId: plan.booking_id, includeInstallments: true });
  const planCompleted = latestProgress.remaining_balance <= 0.009;

  return res.status(200).json({
    ok: true,
    message: `Installment ${installment_number} ${newStatus}.`,
    installment_status: newStatus,
    ledger_transaction_id: ledgerTxId,
    plan_completed: planCompleted,
    duplicate_ledger: isDuplicate,
    reconciliation: reconcile,
    plan_progress: latestProgress,
  });
}
