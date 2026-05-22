// api/renter-statement.js
// Phase 4.5 — Renter-facing account statement.
//
// Returns a per-booking ledger statement for a renter, accessible by booking_ref
// only (no auth secret — same pattern as renter-ledger-summary.js).
//
// POST /api/renter-statement
//
// Body:
//   { booking_ref }
//
// Returns:
//   { ok, booking_ref, summary, transactions (sorted asc), running_balance_per_row }
//
// Each transaction row includes a running_balance column so the renter can see
// how each entry affected their outstanding balance.

import { getSupabaseAdmin } from "./_supabase.js";
import { annotateLedgerTransactions, getLedgerSummary, listLedgerTransactions } from "./_renter-balance-ledger.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  const bookingRef = String(body.booking_ref || "").trim();
  if (!bookingRef) {
    return res.status(400).json({ error: "booking_ref is required" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Service unavailable. Please try again." });
  }

  try {
    // Verify the booking exists.
    const { data: bk, error: bkErr } = await sb
      .from("bookings")
      .select("booking_ref, customer_name, customer_email, vehicle_id, pickup_date, return_date, status")
      .eq("booking_ref", bookingRef)
      .maybeSingle();
    if (bkErr) throw new Error(`Booking lookup failed: ${bkErr.message}`);
    if (!bk) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Fetch ledger summary and transactions.
    const [summary, rawTransactions] = await Promise.all([
      getLedgerSummary(sb, { bookingId: bookingRef }),
      listLedgerTransactions(sb, { bookingId: bookingRef, limit: 500, offset: 0 }),
    ]);

    const transactions = [...rawTransactions].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const statementRows = annotateLedgerTransactions(transactions).transactions.map((tx) => ({
      date: tx.created_at ? tx.created_at.slice(0, 10) : null,
      transaction_type: tx.transaction_type,
      direction: tx.direction,
      amount: Number(tx.amount),
      running_balance: Number(tx.running_balance || 0),
      notes: tx.notes || null,
      due_date: tx.due_date || null,
      source_type: tx.source_type || null,
      allocation_scope: tx.allocation_scope || null,
      allocation_targets: tx.allocation_targets || [],
      id: tx.id,
    }));

    return res.status(200).json({
      ok: true,
      booking_ref: bookingRef,
      booking: {
        customer_name: bk.customer_name,
        vehicle_id: bk.vehicle_id,
        pickup_date: bk.pickup_date,
        return_date: bk.return_date,
        status: bk.status,
      },
      summary,
      transactions: statementRows,
    });
  } catch (err) {
    console.error("[renter-statement] error:", err.message);
    return res.status(500).json({ error: "Statement unavailable. Please try again." });
  }
}
