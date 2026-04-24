// api/v2-system-health.js
// SLYTRANS Fleet Control v2 — System Health endpoint.
//
// Performs real-time integrity checks across Supabase to surface drift
// between payments, bookings, revenue records, and agreement documents.
//
// POST /api/v2-system-health
// Body: { "secret": "<ADMIN_SECRET>" }
//
// Response shape:
// {
//   checks: {
//     paymentBookingRevenue:  HealthCheck,
//     missingAgreements:      HealthCheck,
//     activeRentalCount:      HealthCheck,
//     orphanRevenue:          HealthCheck,
//     staleReservations:      HealthCheck,
//   },
//   overallStatus: "ok" | "warning" | "error",
//   checkedAt: ISO-8601 string,
// }
//
// HealthCheck shape:
// {
//   status:  "ok" | "warning" | "error",
//   label:   string,
//   summary: string,
//   detail:  string | null,
//   items:   Array<{ id: string, info: string }>,
//   count:   number,
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/** Build a HealthCheck result object. */
function check(label, status, summary, items = [], detail = null) {
  return { label, status, summary, detail, items, count: items.length };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret } = req.body || {};
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase not configured." });
  }

  const checkedAt = new Date().toISOString();
  const checks = {};

  // ── 1. Payment → Booking → Revenue consistency ────────────────────────────
  // Find bookings where payment_status = 'paid' but no matching rental
  // revenue_record exists.  These bookings took money but never got a ledger row.
  try {
    const PAID_STATUSES = [
      "booked_paid", "active", "active_rental", "completed", "completed_rental",
      "extended", "overdue",
    ];

    const { data: paidBookings, error: bErr } = await sb
      .from("bookings")
      .select("booking_ref, status, total_price, payment_status, created_at, customer_id")
      .eq("payment_status", "paid")
      .limit(500);

    if (bErr) {
      console.error("[v2-system-health] paymentBookingRevenue booking query error:", bErr.message);
      checks.paymentBookingRevenue = check(
        "Payment → Booking → Revenue",
        "error",
        "Could not query bookings: " + bErr.message,
      );
    } else {
      const refs = (paidBookings || []).map((b) => b.booking_ref).filter(Boolean);

      let missingRevenue = [];
      if (refs.length > 0) {
        const { data: revRows, error: rErr } = await sb
          .from("revenue_records")
          .select("booking_id")
          .in("booking_id", refs)
          .eq("type", "rental");

        if (rErr) {
          console.error("[v2-system-health] paymentBookingRevenue revenue query error:", rErr.message);
          checks.paymentBookingRevenue = check(
            "Payment → Booking → Revenue",
            "error",
            "Could not query revenue_records: " + rErr.message,
          );
        } else {
          const revenueRefs = new Set((revRows || []).map((r) => r.booking_id));
          missingRevenue = (paidBookings || []).filter(
            (b) => b.booking_ref && !revenueRefs.has(b.booking_ref),
          );

          if (missingRevenue.length === 0) {
            checks.paymentBookingRevenue = check(
              "Payment → Booking → Revenue",
              "ok",
              `All ${refs.length} paid booking${refs.length !== 1 ? "s" : ""} have a revenue record.`,
            );
          } else {
            const items = missingRevenue.map((b) => ({
              id: b.booking_ref,
              info: `status=${b.status} total=$${b.total_price} created=${(b.created_at || "").slice(0, 10)}`,
            }));
            checks.paymentBookingRevenue = check(
              "Payment → Booking → Revenue",
              "error",
              `${missingRevenue.length} paid booking${missingRevenue.length !== 1 ? "s" : ""} missing a revenue record.`,
              items,
              "Use the Revenue tab → '⚡ Sync from Stripe' to repair these records.",
            );
            console.error(
              `[v2-system-health] ${missingRevenue.length} paid bookings without revenue records:`,
              missingRevenue.map((b) => b.booking_ref),
            );
          }
        }
      } else {
        checks.paymentBookingRevenue = check(
          "Payment → Booking → Revenue",
          "ok",
          "No paid bookings found to check.",
        );
      }
    }
  } catch (err) {
    console.error("[v2-system-health] paymentBookingRevenue exception:", err);
    checks.paymentBookingRevenue = check(
      "Payment → Booking → Revenue",
      "error",
      "Unexpected error: " + err.message,
    );
  }

  // ── 2. Missing agreement PDFs ─────────────────────────────────────────────
  // Find pending_booking_docs rows where agreement_pdf_url IS NULL.
  // These bookings were processed without generating or storing the PDF.
  try {
    const { data: missingDocs, error: dErr } = await sb
      .from("pending_booking_docs")
      .select("booking_id, email_sent, created_at")
      .is("agreement_pdf_url", null)
      .limit(100);

    if (dErr) {
      console.error("[v2-system-health] missingAgreements query error:", dErr.message);
      checks.missingAgreements = check(
        "Missing Agreement PDFs",
        "error",
        "Could not query pending_booking_docs: " + dErr.message,
      );
    } else {
      const rows = missingDocs || [];
      if (rows.length === 0) {
        checks.missingAgreements = check(
          "Missing Agreement PDFs",
          "ok",
          "All booking documents have agreement PDFs stored.",
        );
      } else {
        const items = rows.map((r) => ({
          id: r.booking_id,
          info: `email_sent=${r.email_sent} created=${(r.created_at || "").slice(0, 10)}`,
        }));
        checks.missingAgreements = check(
          "Missing Agreement PDFs",
          "warning",
          `${rows.length} booking document${rows.length !== 1 ? "s" : ""} without an agreement PDF.`,
          items,
          "Use the Bookings tab → Resend Confirmation to regenerate and store the PDF.",
        );
        console.error(
          `[v2-system-health] ${rows.length} bookings missing agreement_pdf_url:`,
          rows.map((r) => r.booking_id),
        );
      }
    }
  } catch (err) {
    console.error("[v2-system-health] missingAgreements exception:", err);
    checks.missingAgreements = check(
      "Missing Agreement PDFs",
      "error",
      "Unexpected error: " + err.message,
    );
  }

  // ── 3. Active rental count vs. date-based count ───────────────────────────
  // Compare bookings with status='active' against bookings where today falls
  // between pickup_date and return_date (with a paid/active payment status).
  // A large mismatch means the fleet status is out of sync.
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [activeStatusRes, dateBasedRes] = await Promise.all([
      sb
        .from("bookings")
        .select("booking_ref, pickup_date, return_date, vehicle_id, status", { count: "exact" })
        .eq("status", "active")
        .limit(200),
      sb
        .from("bookings")
        .select("booking_ref, pickup_date, return_date, vehicle_id, status", { count: "exact" })
        .lte("pickup_date", today)
        .gte("return_date", today)
        .in("payment_status", ["paid", "partial"])
        .not("status", "in", '("completed","completed_rental","cancelled","cancelled_rental")')
        .limit(200),
    ]);

    if (activeStatusRes.error || dateBasedRes.error) {
      const msg = (activeStatusRes.error || dateBasedRes.error).message;
      console.error("[v2-system-health] activeRentalCount query error:", msg);
      checks.activeRentalCount = check(
        "Active Rental Count",
        "error",
        "Could not query active rentals: " + msg,
      );
    } else {
      const byStatus = activeStatusRes.count ?? (activeStatusRes.data || []).length;
      const byDate   = dateBasedRes.count   ?? (dateBasedRes.data   || []).length;

      // Build sets for diffing
      const statusRefs = new Set((activeStatusRes.data || []).map((b) => b.booking_ref));
      const dateRefs   = new Set((dateBasedRes.data   || []).map((b) => b.booking_ref));

      // Bookings in date range but not marked active
      const notMarkedActive = (dateBasedRes.data || []).filter(
        (b) => !statusRefs.has(b.booking_ref),
      );
      // Bookings marked active but outside date range today
      const markedActivePastReturn = (activeStatusRes.data || []).filter(
        (b) => !dateRefs.has(b.booking_ref),
      );

      const drift = notMarkedActive.length + markedActivePastReturn.length;

      if (drift === 0) {
        checks.activeRentalCount = check(
          "Active Rental Count",
          "ok",
          `${byStatus} active rental${byStatus !== 1 ? "s" : ""} — status matches date range.`,
        );
      } else {
        const items = [
          ...notMarkedActive.map((b) => ({
            id: b.booking_ref,
            info: `in date range but status=${b.status} (${b.pickup_date} → ${b.return_date})`,
          })),
          ...markedActivePastReturn.map((b) => ({
            id: b.booking_ref,
            info: `status=active but return_date=${b.return_date} is outside today (${today})`,
          })),
        ];
        checks.activeRentalCount = check(
          "Active Rental Count",
          "warning",
          `${drift} active-status mismatch${drift !== 1 ? "es" : ""} detected.`,
          items,
          "Review bookings and update status via the Bookings tab.",
        );
        console.error(
          `[v2-system-health] active rental mismatch: ${notMarkedActive.length} unmarked active, ${markedActivePastReturn.length} past return date`,
        );
      }
    }
  } catch (err) {
    console.error("[v2-system-health] activeRentalCount exception:", err);
    checks.activeRentalCount = check(
      "Active Rental Count",
      "error",
      "Unexpected error: " + err.message,
    );
  }

  // ── 4. Orphan revenue records ─────────────────────────────────────────────
  // Revenue records where is_orphan = false but the booking_id doesn't match
  // any bookings.booking_ref — a data integrity gap.
  try {
    const { data: orphanRows, error: oErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, vehicle_id, gross_amount, created_at")
      .eq("is_orphan", false)
      .eq("sync_excluded", false)
      .eq("type", "rental")
      .limit(500);

    if (oErr) {
      console.error("[v2-system-health] orphanRevenue query error:", oErr.message);
      checks.orphanRevenue = check(
        "Orphan Revenue Records",
        "error",
        "Could not query revenue_records: " + oErr.message,
      );
    } else {
      const rows = orphanRows || [];
      const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];
      let trueOrphans = [];

      if (bookingIds.length > 0) {
        const { data: bookingRows, error: bErr } = await sb
          .from("bookings")
          .select("booking_ref")
          .in("booking_ref", bookingIds);

        if (bErr) {
          console.error("[v2-system-health] orphanRevenue bookings lookup error:", bErr.message);
          checks.orphanRevenue = check(
            "Orphan Revenue Records",
            "error",
            "Could not verify booking refs: " + bErr.message,
          );
        } else {
          const validRefs = new Set((bookingRows || []).map((b) => b.booking_ref));
          trueOrphans = rows.filter((r) => r.booking_id && !validRefs.has(r.booking_id));

          if (trueOrphans.length === 0) {
            checks.orphanRevenue = check(
              "Orphan Revenue Records",
              "ok",
              `All ${rows.length} revenue record${rows.length !== 1 ? "s" : ""} reference valid bookings.`,
            );
          } else {
            const items = trueOrphans.map((r) => ({
              id: r.booking_id,
              info: `revenue_id=${r.id.slice(0, 8)} vehicle=${r.vehicle_id} gross=$${r.gross_amount} created=${(r.created_at || "").slice(0, 10)}`,
            }));
            checks.orphanRevenue = check(
              "Orphan Revenue Records",
              "warning",
              `${trueOrphans.length} revenue record${trueOrphans.length !== 1 ? "s" : ""} reference non-existent bookings.`,
              items,
              "Use Revenue tab → '🧹 Fix Unknown' to resolve or mark these records as orphans.",
            );
            console.error(
              `[v2-system-health] ${trueOrphans.length} orphan revenue records:`,
              trueOrphans.map((r) => r.booking_id),
            );
          }
        }
      } else {
        checks.orphanRevenue = check(
          "Orphan Revenue Records",
          "ok",
          "No revenue records to check.",
        );
      }
    }
  } catch (err) {
    console.error("[v2-system-health] orphanRevenue exception:", err);
    checks.orphanRevenue = check(
      "Orphan Revenue Records",
      "error",
      "Unexpected error: " + err.message,
    );
  }

  // ── 5. Stale / stuck reservations ─────────────────────────────────────────
  // Reservations that are unpaid and older than 24 hours — these should have
  // either been paid or cancelled.  They represent possible webhook failures.
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: staleRows, error: sErr } = await sb
      .from("bookings")
      .select("booking_ref, status, payment_status, created_at, vehicle_id")
      .in("payment_status", ["unpaid"])
      .in("status", ["pending", "reserved"])
      .lt("created_at", cutoff)
      .limit(100);

    if (sErr) {
      console.error("[v2-system-health] staleReservations query error:", sErr.message);
      checks.staleReservations = check(
        "Stale Reservations",
        "error",
        "Could not query stale reservations: " + sErr.message,
      );
    } else {
      const rows = staleRows || [];
      if (rows.length === 0) {
        checks.staleReservations = check(
          "Stale Reservations",
          "ok",
          "No stale unpaid reservations older than 24 hours.",
        );
      } else {
        const items = rows.map((r) => ({
          id: r.booking_ref,
          info: `status=${r.status} vehicle=${r.vehicle_id} created=${(r.created_at || "").slice(0, 10)}`,
        }));
        checks.staleReservations = check(
          "Stale Reservations",
          "warning",
          `${rows.length} unpaid reservation${rows.length !== 1 ? "s" : ""} older than 24 hours (possible failed webhook).`,
          items,
          "Review in the Bookings tab and cancel or manually confirm as appropriate.",
        );
        console.error(
          `[v2-system-health] ${rows.length} stale unpaid reservations:`,
          rows.map((r) => r.booking_ref),
        );
      }
    }
  } catch (err) {
    console.error("[v2-system-health] staleReservations exception:", err);
    checks.staleReservations = check(
      "Stale Reservations",
      "error",
      "Unexpected error: " + err.message,
    );
  }

  // ── Overall status ─────────────────────────────────────────────────────────
  const statuses = Object.values(checks).map((c) => c.status);
  const overallStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("warning")
    ? "warning"
    : "ok";

  return res.status(200).json({ checks, overallStatus, checkedAt });
}
