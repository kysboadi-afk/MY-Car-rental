// api/renter-balance-ledger.js
// Phase 1 unified renter balance ledger API.
//
// Admin-protected endpoint for:
//   - summary: get derived balance totals
//   - history: get transaction history
//   - add_transaction: append a ledger transaction

import { withAdminAuth } from "./_middleware.js";
import { logDefaultOrgFallback } from "./_org-rollout-observability.js";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  getLedgerSummary,
  insertLedgerTransaction,
  listLedgerTransactions,
  addLedgerCharge,
  annotateLedgerTransactions,
  deleteLedgerTransaction,
  updateLedgerTransaction,
} from "./_renter-balance-ledger.js";

export default withAdminAuth(async function handler(req, res) {
  const body = req.body || {};
  const { action = "summary" } = body;

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  const bookingId = body.booking_id || body.booking_ref || null;
  const customerId = body.customer_id || null;

  try {
    switch (action) {
      case "summary": {
        const summary = await getLedgerSummary(sb, { bookingId, customerId });
        return res.status(200).json({
          success: true,
          booking_id: bookingId || null,
          customer_id: customerId || null,
          summary,
        });
      }
      case "history": {
        const limit = body.limit ?? 100;
        const offset = body.offset ?? 0;
        const transactions = await listLedgerTransactions(sb, { bookingId, customerId, limit, offset });
        const sortedAsc = [...transactions].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        const annotated = annotateLedgerTransactions(sortedAsc).transactions.reverse();
        return res.status(200).json({
          success: true,
          booking_id: bookingId || null,
          customer_id: customerId || null,
          count: annotated.length,
          transactions: annotated,
        });
      }
      case "add_charge": {
        logDefaultOrgFallback(req, { endpoint: "renter-balance-ledger", action: "add_charge", table: "renter_balance_ledger" });
        const result = await addLedgerCharge(sb, {
          bookingId,
          customerId,
          transactionType: body.transaction_type,
          amount: body.amount,
          notes: body.notes,
          dueDate: body.due_date,
          chargeRequestId: body.charge_request_id,
          relatedChargeId: body.related_charge_id,
          relatedTicketId: body.related_ticket_id,
          allocationScope: body.allocation_scope,
          targetTransactionType: body.target_transaction_type,
          targetLedgerTransactionId: body.target_ledger_transaction_id,
          metadata: body.metadata,
          createdBy: body.created_by || "admin",
        });
        return res.status(200).json({
          success: true,
          duplicate: result.duplicate,
          message: result.duplicate ? "Charge already recorded (idempotent)." : "Charge added to ledger.",
          transaction: result.transaction,
        });
      }
      case "add_transaction": {
        logDefaultOrgFallback(req, { endpoint: "renter-balance-ledger", action: "add_transaction", table: "renter_balance_ledger" });
        const transaction = await insertLedgerTransaction(sb, {
          bookingId,
          customerId,
          transactionType: body.transaction_type,
          direction: body.direction,
          amount: body.amount,
          notes: body.notes,
          sourceType: body.source_type,
          sourceId: body.source_id,
          stripePaymentIntentId: body.stripe_payment_intent_id,
          relatedChargeId: body.related_charge_id,
          relatedTicketId: body.related_ticket_id,
          allocationScope: body.allocation_scope,
          targetTransactionType: body.target_transaction_type,
          targetLedgerTransactionId: body.target_ledger_transaction_id,
          metadata: body.metadata,
          createdBy: body.created_by || "admin",
        });
        return res.status(200).json({
          success: true,
          message: "Ledger transaction recorded.",
          transaction,
        });
      }
      case "delete_transaction": {
        const result = await deleteLedgerTransaction(sb, {
          id: body.id,
        });
        return res.status(200).json({
          success: true,
          message: "Ledger entry deleted.",
          transaction: result.transaction,
        });
      }
      case "update_transaction": {
        const result = await updateLedgerTransaction(sb, {
          id: body.id,
          transactionType: body.transaction_type,
          amount: body.amount,
          notes: body.notes,
          dueDate: body.due_date,
        });
        return res.status(200).json({
          success: true,
          changed: result.changed,
          message: result.changed ? "Ledger entry updated." : "No changes made.",
          transaction: result.transaction,
        });
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message || "Request failed" });
  }
});
