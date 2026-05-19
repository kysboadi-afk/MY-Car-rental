// api/renter-ledger-summary.js
// Public renter-facing endpoint — returns the ledger summary and payment
// history for a booking reference.
//
// Auth: booking_ref (opaque string from booking confirmation).
// No admin secret required — the booking_ref is the renter's access token.
//
// POST /api/renter-ledger-summary
// Body: { booking_id: "bk-xxx" }
// Response: {
//   success, booking_ref, customer_name, vehicle_id, pickup_date, return_date,
//   status, summary: { total_charges, total_credits, total_paid, total_waived,
//     total_refunds, net_balance, remaining_balance, credit_balance,
//     transaction_count },
//   transactions: Array<LedgerRow>,
// }

import { getSupabaseAdmin }                   from "./_supabase.js";
import { getLedgerSummary, listLedgerTransactions } from "./_renter-balance-ledger.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const body = req.body || {};
  const bookingId = typeof body.booking_id === "string" ? body.booking_id.trim() : "";

  if (!bookingId) {
    return res.status(400).json({ error: "booking_id is required" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  // Verify the booking exists.  Use a minimal select for privacy — we only
  // return enough to display context on the renter balance page.
  const { data: booking, error: bkErr } = await sb
    .from("bookings")
    .select(
      "booking_ref, customer_name, vehicle_id, pickup_date, return_date, status"
    )
    .eq("booking_ref", bookingId)
    .maybeSingle();

  if (bkErr) {
    console.error("renter-ledger-summary: booking lookup error:", bkErr.message);
    return res.status(503).json({ error: "Database error. Please try again." });
  }
  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }

  let summary = {
    total_charges: 0, total_credits: 0, total_paid: 0, total_waived: 0,
    total_refunds: 0, net_balance: 0, remaining_balance: 0,
    credit_balance: 0, transaction_count: 0,
  };
  let transactions = [];

  try {
    [summary, transactions] = await Promise.all([
      getLedgerSummary(sb, { bookingId }),
      listLedgerTransactions(sb, { bookingId, limit: 50, offset: 0 }),
    ]);
  } catch (ledgerErr) {
    // Non-fatal: return empty ledger rather than failing completely.
    console.warn("renter-ledger-summary: ledger read error (returning empty):", ledgerErr.message);
  }

  return res.status(200).json({
    success:       true,
    booking_ref:   booking.booking_ref,
    customer_name: booking.customer_name || "",
    vehicle_id:    booking.vehicle_id    || "",
    pickup_date:   booking.pickup_date   || "",
    return_date:   booking.return_date   || "",
    status:        booking.status        || "",
    summary,
    transactions,
  });
}
