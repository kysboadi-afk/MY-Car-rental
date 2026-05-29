// api/overdue-balances.js
// Phase 4.3 — Overdue detection + aging buckets.
//
// Returns bookings with a net ledger balance > 0 where at least one
// ledger entry has a past-due due_date, organized into aging buckets.
//
// POST /api/overdue-balances  (admin secret required)
//
// Body:
//   { secret, cutoff_days?, limit?, aging_buckets? }
//
// cutoff_days: number of days past due before a booking is included (default 0).
//   0 = include anything overdue right now.
//   7 = include anything overdue by more than 7 days.
//
// aging_buckets: bool (default true) — annotate each result with bucket.
//
// Response:
//   {
//     ok, total_overdue, total_outstanding_amount,
//     bucket_totals: { current, "30-59", "60-89", "90+" },
//     results: [{ booking_id, customer_email, net_balance, days_overdue, aging_bucket, ... }]
//   }
//
// Future hooks (architecture prepared):
//   - account_restrictions: trigger when bucket reaches 60+
//   - extension_block: prevent extend-rental.js when balance is overdue
//   - collections_status: lifecycle state driven by aging bucket transitions

import { getSupabaseAdmin } from "./_supabase.js";
import { getLedgerOverdueBookings } from "./_renter-balance-ledger.js";
import { withAdminAuth } from "./_middleware.js";

export default withAdminAuth(async function handler(req, res) {
  const body = req.body || {};

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database unavailable. Please try again." });
  }

  const cutoffDays = Math.max(0, Number(body.cutoff_days) || 0);
  const agingBuckets = body.aging_buckets !== false;
  const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 500);

  try {
    const results = await getLedgerOverdueBookings(sb, { cutoffDays, agingBuckets, limit });

    // Aggregate totals.
    const totalOutstanding = results.reduce((s, r) => s + Number(r.net_balance || 0), 0);
    const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

    const bucketTotals = {
      current: { count: 0, amount: 0 },
      "30-59": { count: 0, amount: 0 },
      "60-89": { count: 0, amount: 0 },
      "90+":   { count: 0, amount: 0 },
    };

    for (const r of results) {
      const bucket = r.aging_bucket || "current";
      if (bucketTotals[bucket]) {
        bucketTotals[bucket].count++;
        bucketTotals[bucket].amount = round2(bucketTotals[bucket].amount + Number(r.net_balance || 0));
      }
    }

    return res.status(200).json({
      ok: true,
      total_overdue: results.length,
      total_outstanding_amount: round2(totalOutstanding),
      bucket_totals: bucketTotals,
      results,
    });
  } catch (err) {
    console.error("[overdue-balances] error:", err.message);
    return res.status(500).json({ error: "Overdue balances query failed.", detail: err.message });
  }
});
