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
//   cancel  — { secret, action:"cancel", plan_id, reason? }
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

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
      case "cancel":
        return await handleCancel(sb, body, res);
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

  const totalAmt = Math.round(Number(total_amount) * 100) / 100;
  const baseInstallment = Math.floor((totalAmt / numInstallments) * 100) / 100;
  const remainder = Math.round((totalAmt - baseInstallment * numInstallments) * 100) / 100;

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
  const installmentRows = [];
  for (let i = 0; i < numInstallments; i++) {
    const dueDate = new Date(startAt.getTime() + i * numInterval * 24 * 60 * 60 * 1000);
    // Last installment gets the remainder to ensure total adds up exactly.
    const amount = i === numInstallments - 1
      ? Math.round((baseInstallment + remainder) * 100) / 100
      : baseInstallment;
    installmentRows.push({
      plan_id: plan.id,
      installment_number: i + 1,
      amount,
      due_date: dueDate.toISOString(),
    });
  }

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
    results.push({ ...plan, installments: installments || [] });
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

  return res.status(200).json({ ok: true, plans: plans || [] });
}

// ── Cancel ─────────────────────────────────────────────────────────────────────

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
  if (installment.status === "paid") throw new Error("Installment is already paid");

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

  // Determine installment status: partial vs paid.
  const outstanding = Math.round((Number(installment.amount) - amtPaid) * 100) / 100;
  const newStatus = outstanding > 0.01 ? "partial" : "paid";

  const { error: updateErr } = await sb
    .from("payment_plan_installments")
    .update({
      status: newStatus,
      paid_at: newStatus === "paid" ? new Date().toISOString() : null,
      payment_intent_id,
      ledger_transaction_id: ledgerTxId,
    })
    .eq("id", installment.id);
  if (updateErr) throw new Error(`Could not update installment: ${updateErr.message}`);

  // Check if all installments are now paid → auto-complete plan.
  const { data: allInst } = await sb
    .from("payment_plan_installments")
    .select("status")
    .eq("plan_id", plan_id);
  const allPaid = (allInst || []).every((i) => i.status === "paid");
  if (allPaid) {
    await sb.from("payment_plans").update({ status: "completed" }).eq("id", plan_id);
  } else {
    // Advance next_due_date to the next pending installment's due_date.
    const { data: nextInst } = await sb
      .from("payment_plan_installments")
      .select("due_date")
      .eq("plan_id", plan_id)
      .eq("status", "pending")
      .order("installment_number", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (nextInst) {
      await sb.from("payment_plans").update({ next_due_date: nextInst.due_date }).eq("id", plan_id);
    }
  }

  return res.status(200).json({
    ok: true,
    message: `Installment ${installment_number} ${newStatus}.`,
    installment_status: newStatus,
    ledger_transaction_id: ledgerTxId,
    plan_completed: allPaid,
    duplicate_ledger: isDuplicate,
  });
}
