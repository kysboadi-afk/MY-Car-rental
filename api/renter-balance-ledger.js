// api/renter-balance-ledger.js
// Phase 1 unified renter balance ledger API.
//
// Admin-protected endpoint for:
//   - summary: get derived balance totals
//   - history: get transaction history
//   - add_transaction: append a ledger transaction

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  getLedgerSummary,
  insertLedgerTransaction,
  listLedgerTransactions,
} from "./_renter-balance-ledger.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  const { secret, action = "summary" } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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
        return res.status(200).json({
          success: true,
          booking_id: bookingId || null,
          customer_id: customerId || null,
          count: transactions.length,
          transactions,
        });
      }
      case "add_transaction": {
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
          metadata: body.metadata,
          createdBy: body.created_by || "admin",
        });
        return res.status(200).json({
          success: true,
          message: "Ledger transaction recorded.",
          transaction,
        });
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message || "Request failed" });
  }
}
