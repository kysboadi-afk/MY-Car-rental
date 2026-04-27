// api/v2-system-health.js
// SLYTRANS Fleet Control v2 — System Health endpoint.
//
// Performs real-time integrity checks across Supabase to surface drift
// between payments, bookings, revenue records, and agreement documents.
//
// ── Modes ──────────────────────────────────────────────────────────────────
// 1. Manual run (admin panel / POST):
//    POST /api/v2-system-health
//    Body: { "secret": "<ADMIN_SECRET>", "action": "run" }
//
// 2. Per-check "Fix Now" (admin panel / POST):
//    POST /api/v2-system-health
//    Body: { "secret": "<ADMIN_SECRET>", "action": "fix_<checkKey>" }
//    Supported: fix_paymentBookingRevenue, fix_orphanRevenue,
//               fix_staleReservations, fix_stripePaymentNoBooking
//    Note: fix_smsDeliveryHealth is handled by POST /api/system-health-fix-sms
//
// 3. Scheduled cron (Vercel Cron / GET or Bearer-authenticated POST):
//    GET /api/v2-system-health
//    Headers: { "Authorization": "Bearer <CRON_SECRET>" }
//    Runs all checks, auto-repairs error-level findings, and sends
//    owner email + SMS when overallStatus === "error"
//    (deduplicated to once per hour via system_settings).
//
// ── Response shape (run mode) ───────────────────────────────────────────────
// {
//   checks: {
//     paymentBookingRevenue:   HealthCheck,
//     missingAgreements:       HealthCheck,
//     activeRentalCount:       HealthCheck,
//     orphanRevenue:           HealthCheck,
//     staleReservations:       HealthCheck,
//     stripePaymentNoBooking:  HealthCheck,
//     extensionReturnDateSync: HealthCheck,
//     smsDeliveryHealth:       HealthCheck,
//   },
//   overallStatus: "ok" | "warning" | "error",
//   checkedAt: ISO-8601 string,
// }
//
// HealthCheck shape:
// {
//   status:   "ok" | "warning" | "error",
//   label:    string,
//   summary:  string,
//   detail:   string | null,
//   fixable:  boolean,
//   items:    Array<{ id: string, info: string }>,
//   count:    number,
// }

import Stripe from "stripe";
import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { autoCreateRevenueRecord, ensureBlockedDate } from "./_booking-automation.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const OWNER_PHONE = process.env.OWNER_PHONE || "+12139166606";

// Stale reservation threshold
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SIXTY_DAYS_MS      = 60 * 24 * 60 * 60 * 1000;

// Dedup: only fire one alert per this many milliseconds.
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000; // 1 hour
const ALERT_COOLDOWN_KEY = "health_alert_last_sent_at";

// ── Small helpers ──────────────────────────────────────────────────────────

/** Build a HealthCheck result object. */
function check(label, status, summary, items = [], detail = null, fixable = false) {
  return { label, status, summary, detail, fixable, items, count: items.length };
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Individual checks ──────────────────────────────────────────────────────

// Check 1 — Payment → Booking → Revenue consistency
async function checkPaymentBookingRevenue(sb) {
  try {
    // Fetch bookings that represent received payments using two complementary
    // filters so that legacy rows with NULL/partial payment_status are also caught:
    //   • payment_status = 'paid'   — normal path (Stripe + manual with correct sync)
    //   • deposit_paid > 0          — money was collected regardless of status column
    //     combined with a meaningful status — catches legacy rows written before the
    //     payment_status column was reliably populated.
    const [byStatusResult, byDepositResult] = await Promise.all([
      sb.from("bookings")
        .select("booking_ref, status, total_price, deposit_paid, payment_status, created_at, payment_intent_id")
        .eq("payment_status", "paid")
        .not("status", "in", '("cancelled","cancelled_rental")')
        .limit(500),
      sb.from("bookings")
        .select("booking_ref, status, total_price, deposit_paid, payment_status, created_at, payment_intent_id")
        .gt("deposit_paid", 0)
        .not("status", "in", '("cancelled","cancelled_rental")')
        .in("status", ["booked_paid", "active_rental", "completed_rental", "completed", "active", "overdue"])
        .limit(500),
    ]);

    if (byStatusResult.error) {
      console.error("[v2-system-health] paymentBookingRevenue query error:", byStatusResult.error.message);
      return check("Payment → Booking → Revenue", "error", "Could not query bookings: " + byStatusResult.error.message);
    }

    // Merge both result sets, deduplicating by booking_ref.
    const seen = new Set();
    const paidBookings = [];
    for (const b of [...(byStatusResult.data || []), ...(byDepositResult.data || [])]) {
      if (b.booking_ref && !seen.has(b.booking_ref)) {
        seen.add(b.booking_ref);
        paidBookings.push(b);
      }
    }

    const refs = paidBookings.map((b) => b.booking_ref).filter(Boolean);
    if (refs.length === 0) {
      return check("Payment → Booking → Revenue", "ok", "No paid bookings found to check.");
    }

    const { data: revRows, error: rErr } = await sb
      .from("revenue_records")
      .select("booking_id")
      .in("booking_id", refs);

    if (rErr) {
      console.error("[v2-system-health] paymentBookingRevenue revenue query error:", rErr.message);
      return check("Payment → Booking → Revenue", "error", "Could not query revenue_records: " + rErr.message);
    }

    const revenueRefs = new Set((revRows || []).map((r) => r.booking_id));

    // Secondary check: also consider bookings covered by a revenue record linked
    // via payment_intent_id (e.g. orphan records created by stripe-reconcile with
    // a "stripe-pi_xxx" booking_id before the real booking_ref was known).
    const piIds = paidBookings.map((b) => b.payment_intent_id).filter(Boolean);
    let coveredByPI = new Set();
    if (piIds.length > 0) {
      const { data: revByPI, error: piErr } = await sb
        .from("revenue_records")
        .select("payment_intent_id")
        .in("payment_intent_id", piIds);
      if (!piErr) {
        coveredByPI = new Set((revByPI || []).map((r) => r.payment_intent_id).filter(Boolean));
      }
    }

    // Tertiary check: also consider bookings covered by a revenue record linked
    // via original_booking_id (e.g. manual extension fees recorded via
    // "Record Extension Fee" produce records with booking_id="ext-..." and
    // original_booking_id=<booking_ref>).
    const { data: revByOrigRef, error: origRefErr } = await sb
      .from("revenue_records")
      .select("original_booking_id")
      .in("original_booking_id", refs);
    if (!origRefErr) {
      for (const r of revByOrigRef || []) {
        if (r.original_booking_id) revenueRefs.add(r.original_booking_id);
      }
    }

    const missingRevenue = paidBookings.filter(
      (b) =>
        b.booking_ref &&
        !revenueRefs.has(b.booking_ref) &&
        !(b.payment_intent_id && coveredByPI.has(b.payment_intent_id)),
    );

    if (missingRevenue.length === 0) {
      return check(
        "Payment → Booking → Revenue",
        "ok",
        `All ${refs.length} paid booking${refs.length !== 1 ? "s" : ""} have a revenue record.`,
      );
    }

    const items = missingRevenue.map((b) => ({
      id: b.booking_ref,
      info: `status=${b.status} total=$${b.total_price} created=${(b.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${missingRevenue.length} paid bookings without revenue records:`,
      missingRevenue.map((b) => b.booking_ref),
    );
    return check(
      "Payment → Booking → Revenue",
      "error",
      `${missingRevenue.length} paid booking${missingRevenue.length !== 1 ? "s" : ""} missing a revenue record.`,
      items,
      "Click 'Fix Now' to create the missing revenue records, or use Revenue → ⚡ Sync from Stripe.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] paymentBookingRevenue exception:", err);
    return check("Payment → Booking → Revenue", "error", "Unexpected error: " + err.message);
  }
}

// Check 2 — Missing agreement PDFs
async function checkMissingAgreements(sb) {
  try {
    const { data: missingDocs, error: dErr } = await sb
      .from("pending_booking_docs")
      .select("booking_id, email_sent, created_at")
      .is("agreement_pdf_url", null)
      .limit(100);

    if (dErr) {
      console.error("[v2-system-health] missingAgreements query error:", dErr.message);
      return check("Missing Agreement PDFs", "error", "Could not query pending_booking_docs: " + dErr.message);
    }

    const rows = missingDocs || [];
    if (rows.length === 0) {
      return check("Missing Agreement PDFs", "ok", "All booking documents have agreement PDFs stored.");
    }

    const items = rows.map((r) => ({
      id: r.booking_id,
      info: `email_sent=${r.email_sent} created=${(r.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${rows.length} bookings missing agreement_pdf_url:`,
      rows.map((r) => r.booking_id),
    );
    return check(
      "Missing Agreement PDFs",
      "warning",
      `${rows.length} booking document${rows.length !== 1 ? "s" : ""} without an agreement PDF.`,
      items,
      "Use the Bookings tab → Resend Confirmation to regenerate and store the PDF for each booking.",
      false,
    );
  } catch (err) {
    console.error("[v2-system-health] missingAgreements exception:", err);
    return check("Missing Agreement PDFs", "error", "Unexpected error: " + err.message);
  }
}

// Check 3 — Active rental count vs. date-based count
async function checkActiveRentalCount(sb) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [activeStatusRes, dateBasedRes] = await Promise.all([
      sb
        .from("bookings")
        .select("booking_ref, pickup_date, return_date, vehicle_id, status", { count: "exact" })
        .in("status", ["active", "active_rental"])
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
      return check("Active Rental Count", "error", "Could not query active rentals: " + msg);
    }

    const byStatus   = activeStatusRes.count ?? (activeStatusRes.data || []).length;
    const statusRefs = new Set((activeStatusRes.data || []).map((b) => b.booking_ref));
    const dateRefs   = new Set((dateBasedRes.data   || []).map((b) => b.booking_ref));

    const notMarkedActive        = (dateBasedRes.data   || []).filter((b) => !statusRefs.has(b.booking_ref));
    const markedActivePastReturn = (activeStatusRes.data || []).filter((b) => !dateRefs.has(b.booking_ref));
    const drift = notMarkedActive.length + markedActivePastReturn.length;

    if (drift === 0) {
      return check(
        "Active Rental Count",
        "ok",
        `${byStatus} active rental${byStatus !== 1 ? "s" : ""} — status matches date range.`,
      );
    }

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
    console.error(
      `[v2-system-health] active rental mismatch: ${notMarkedActive.length} unmarked, ${markedActivePastReturn.length} past return`,
    );
    return check(
      "Active Rental Count",
      "warning",
      `${drift} active-status mismatch${drift !== 1 ? "es" : ""} detected.`,
      items,
      "Review bookings and update status via the Bookings tab.",
      false,
    );
  } catch (err) {
    console.error("[v2-system-health] activeRentalCount exception:", err);
    return check("Active Rental Count", "error", "Unexpected error: " + err.message);
  }
}

// Check 4 — Orphan revenue records
async function checkOrphanRevenue(sb) {
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
      return check("Orphan Revenue Records", "error", "Could not query revenue_records: " + oErr.message);
    }

    const rows      = orphanRows || [];
    const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];

    if (bookingIds.length === 0) {
      return check("Orphan Revenue Records", "ok", "No revenue records to check.");
    }

    const { data: bookingRows, error: bErr } = await sb
      .from("bookings")
      .select("booking_id")
      .in("booking_id", bookingIds);

    if (bErr) {
      console.error("[v2-system-health] orphanRevenue bookings lookup error:", bErr.message);
      return check("Orphan Revenue Records", "error", "Could not verify booking refs: " + bErr.message);
    }

    const validRefs   = new Set((bookingRows || []).map((b) => b.booking_id));
    const trueOrphans = rows.filter((r) => r.booking_id && !validRefs.has(r.booking_id));

    if (trueOrphans.length === 0) {
      return check(
        "Orphan Revenue Records",
        "ok",
        `All ${rows.length} revenue record${rows.length !== 1 ? "s" : ""} reference valid bookings.`,
      );
    }

    const items = trueOrphans.map((r) => ({
      id: r.booking_id,
      info: `revenue_id=${r.id.slice(0, 8)} vehicle=${r.vehicle_id} gross=$${r.gross_amount} created=${(r.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${trueOrphans.length} orphan revenue records:`,
      trueOrphans.map((r) => r.booking_id),
    );
    return check(
      "Orphan Revenue Records",
      "warning",
      `${trueOrphans.length} revenue record${trueOrphans.length !== 1 ? "s" : ""} reference non-existent bookings.`,
      items,
      "Click 'Fix Now' to flag these as orphans, or use Revenue → 🧹 Fix Unknown.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] orphanRevenue exception:", err);
    return check("Orphan Revenue Records", "error", "Unexpected error: " + err.message);
  }
}

// Check 5 — Stale / stuck reservations
async function checkStaleReservations(sb) {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    const { data: staleRows, error: sErr } = await sb
      .from("bookings")
      .select("booking_ref, status, payment_status, created_at, vehicle_id")
      .in("payment_status", ["unpaid"])
      .in("status", ["pending", "reserved"])
      .lt("created_at", cutoff)
      .limit(100);

    if (sErr) {
      console.error("[v2-system-health] staleReservations query error:", sErr.message);
      return check("Stale Reservations", "error", "Could not query stale reservations: " + sErr.message);
    }

    const rows = staleRows || [];
    if (rows.length === 0) {
      return check("Stale Reservations", "ok", "No stale unpaid reservations older than 24 hours.");
    }

    const items = rows.map((r) => ({
      id: r.booking_ref,
      info: `status=${r.status} vehicle=${r.vehicle_id} created=${(r.created_at || "").slice(0, 10)}`,
    }));
    console.error(
      `[v2-system-health] ${rows.length} stale unpaid reservations:`,
      rows.map((r) => r.booking_ref),
    );
    return check(
      "Stale Reservations",
      "warning",
      `${rows.length} unpaid reservation${rows.length !== 1 ? "s" : ""} older than 24 hours (possible failed webhook).`,
      items,
      "Click 'Fix Now' to cancel these automatically, or review them in the Bookings tab.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] staleReservations exception:", err);
    return check("Stale Reservations", "error", "Unexpected error: " + err.message);
  }
}

// Check 6 — Stripe PaymentIntent exists but no booking
// Detects is_orphan=true revenue records with payment_intent_id set —
// these are Stripe-confirmed payments for which no booking was ever created.
async function checkStripePaymentNoBooking(sb) {
  try {
    const cutoff60d = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();

    const { data: orphanPIRows, error: oErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, vehicle_id, gross_amount, customer_name, created_at")
      .eq("is_orphan", true)
      .not("payment_intent_id", "is", null)
      .gte("created_at", cutoff60d)
      .limit(100);

    if (oErr) {
      console.error("[v2-system-health] stripePaymentNoBooking query error:", oErr.message);
      return check(
        "Stripe Payment → No Booking",
        "error",
        "Could not query revenue_records: " + oErr.message,
      );
    }

    const rows = orphanPIRows || [];
    if (rows.length === 0) {
      return check(
        "Stripe Payment → No Booking",
        "ok",
        "No unlinked Stripe payments in the last 60 days.",
      );
    }

    const items = rows.map((r) => ({
      id: r.payment_intent_id || r.booking_id,
      info: [
        r.customer_name ? `customer=${r.customer_name}` : null,
        r.vehicle_id    ? `vehicle=${r.vehicle_id}`     : null,
        `gross=$${r.gross_amount}`,
        `created=${(r.created_at || "").slice(0, 10)}`,
      ].filter(Boolean).join(" "),
    }));
    console.error(
      `[v2-system-health] ${rows.length} orphan Stripe payments (no booking):`,
      rows.map((r) => r.payment_intent_id || r.booking_id),
    );
    return check(
      "Stripe Payment → No Booking",
      "error",
      `${rows.length} Stripe payment${rows.length !== 1 ? "s" : ""} with no booking record.`,
      items,
      "Click 'Fix Now' to queue these for booking reconstruction via revenue-self-heal, or use Revenue → ⚡ Sync from Stripe.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] stripePaymentNoBooking exception:", err);
    return check("Stripe Payment → No Booking", "error", "Unexpected error: " + err.message);
  }
}

// Check 7 — Extension payment recorded but booking return_date not updated
// Detects cases where a renter paid for a rental extension (Stripe PI succeeded,
// type='extension' revenue record created) but the booking's return_date in the
// bookings table still shows the original date.  This happens when the
// autoUpsertBooking sync step inside stripe-webhook.js fails non-fatally —
// money was collected but the calendar date wasn't moved.
async function checkExtensionReturnDateSync(sb) {
  try {
    // Fetch all paid, non-cancelled extension revenue records.
    const { data: extRows, error: extErr } = await sb
      .from("revenue_records")
      .select("booking_id, return_date, gross_amount, vehicle_id")
      .eq("type", "extension")
      .eq("payment_status", "paid")
      .eq("is_cancelled", false)
      .not("return_date", "is", null)
      .not("booking_id", "is", null)
      // 500 is deliberately generous for this fleet size.  If the limit is ever
      // reached the check will still flag any mismatches it does find — it will
      // not silently pass.
      .limit(500);

    if (extErr) {
      console.error("[v2-system-health] extensionReturnDateSync query error:", extErr.message);
      return check("Extension Return Date Sync", "error", "Could not query extension records: " + extErr.message);
    }

    const rows = extRows || [];
    if (rows.length === 0) {
      return check("Extension Return Date Sync", "ok", "No paid extension records to check.");
    }

    // Find the latest (max) extension return_date per booking.
    const maxExtReturn = {};
    for (const r of rows) {
      const cur = maxExtReturn[r.booking_id];
      if (!cur || r.return_date > cur.return_date) {
        maxExtReturn[r.booking_id] = { return_date: r.return_date, vehicle_id: r.vehicle_id };
      }
    }

    const bookingIds = Object.keys(maxExtReturn);
    if (bookingIds.length === 0) {
      return check("Extension Return Date Sync", "ok", "No extension records with return dates.");
    }

    // Fetch the current return_date for those bookings.
    const { data: bookingRows, error: bErr } = await sb
      .from("bookings")
      .select("booking_ref, return_date, status")
      .in("booking_ref", bookingIds);

    if (bErr) {
      console.error("[v2-system-health] extensionReturnDateSync bookings query error:", bErr.message);
      return check("Extension Return Date Sync", "error", "Could not query bookings: " + bErr.message);
    }

    const bookingByRef = {};
    for (const b of bookingRows || []) {
      bookingByRef[b.booking_ref] = b;
    }

    // Flag bookings where the booking's return_date < the latest paid extension's
    // return_date (extension was paid but booking date wasn't moved forward).
    // Skip completed/cancelled bookings — stale dates there are expected.
    const SKIP_STATUSES = new Set(["completed", "completed_rental", "cancelled", "cancelled_rental"]);
    const mismatches = [];

    for (const [bookingId, ext] of Object.entries(maxExtReturn)) {
      const booking = bookingByRef[bookingId];
      if (!booking || SKIP_STATUSES.has(booking.status)) continue;
      if (booking.return_date && booking.return_date < ext.return_date) {
        mismatches.push({
          id:   bookingId,
          info: `booking return_date=${booking.return_date} but extension paid through ${ext.return_date} (vehicle=${ext.vehicle_id || "?"})`,
        });
      }
    }

    if (mismatches.length === 0) {
      return check(
        "Extension Return Date Sync",
        "ok",
        `All ${bookingIds.length} extended booking${bookingIds.length !== 1 ? "s" : ""} have correct return dates.`,
      );
    }

    console.error(
      `[v2-system-health] ${mismatches.length} extension return date mismatch(es):`,
      mismatches.map((m) => m.id),
    );
    return check(
      "Extension Return Date Sync",
      "error",
      `${mismatches.length} booking${mismatches.length !== 1 ? "s" : ""} with extension paid but return date not updated.`,
      mismatches,
      "The renter paid to extend their rental but the booking return date was not moved forward. Manually update the return date in the Bookings tab.",
      false,
    );
  } catch (err) {
    console.error("[v2-system-health] extensionReturnDateSync exception:", err);
    return check("Extension Return Date Sync", "error", "Unexpected error: " + err.message);
  }
}

// ── Check 8: SMS Delivery Health ────────────────────────────────────────────
// Detects active/overdue rentals that are missing required SMS communication:
//   • Active rentals with zero sms_logs entries (silent bookings)
//   • Overdue/recently-past-return bookings missing critical return-window SMS
//   • Active bookings with no customer_phone (cannot receive SMS)
async function checkSmsDeliveryHealth(sb) {
  try {
    const today     = new Date().toISOString().slice(0, 10);
    // Look back 48 h for recently-past-return bookings that may have missed critical SMS.
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const ACTIVE_STATUSES = ["active_rental", "active", "overdue"];

    const { data: activeRows, error: activeErr } = await sb
      .from("bookings")
      .select("booking_ref, status, customer_phone, customer_name, return_date, vehicle_id")
      .in("status", ACTIVE_STATUSES)
      .limit(200);

    if (activeErr) {
      console.error("[v2-system-health] smsDeliveryHealth query error:", activeErr.message);
      return check("SMS Delivery Health", "error", "Could not query bookings: " + activeErr.message);
    }

    const rows = activeRows || [];
    if (rows.length === 0) {
      return check("SMS Delivery Health", "ok", "No active or overdue rentals to check.");
    }

    const refs = rows.map((r) => r.booking_ref).filter(Boolean);

    // Fetch all sms_logs rows for these bookings in one query.
    const { data: smsRows, error: smsErr } = await sb
      .from("sms_logs")
      .select("booking_id, template_key, return_date_at_send")
      .in("booking_id", refs);

    if (smsErr) {
      console.error("[v2-system-health] smsDeliveryHealth sms_logs query error:", smsErr.message);
      return check("SMS Delivery Health", "error", "Could not query sms_logs: " + smsErr.message);
    }

    // Build a set of "template_key|return_date_at_send" tuples per booking.
    const smsByBooking = {};
    for (const log of smsRows || []) {
      if (!smsByBooking[log.booking_id]) smsByBooking[log.booking_id] = new Set();
      smsByBooking[log.booking_id].add(`${log.template_key}|${log.return_date_at_send}`);
    }

    const missingPhone   = [];
    const noSmsContact   = [];
    const missedCritical = [];

    for (const b of rows) {
      const ref = b.booking_ref;
      if (!ref) continue;

      // Sub-check A: booking missing a phone number
      if (!b.customer_phone) {
        missingPhone.push({
          id:   ref,
          info: `status=${b.status} vehicle=${b.vehicle_id || "?"} return=${b.return_date || "?"}`,
        });
        continue; // cannot send SMS without a phone number
      }

      const logs = smsByBooking[ref] || new Set();

      // Sub-check B: active rental with zero SMS contact ever
      if (logs.size === 0) {
        noSmsContact.push({
          id:   ref,
          info: `status=${b.status} vehicle=${b.vehicle_id || "?"} return=${b.return_date || "?"}`,
        });
      }

      // Sub-check C: overdue / recently-past-return without critical return-window SMS
      const returnDate = b.return_date ? String(b.return_date).split("T")[0] : null;
      if (returnDate && returnDate <= today && returnDate >= cutoff48h) {
        const criticalKeys = ["late_warning_30min", "late_at_return", "late_grace_expired"];
        const missed = criticalKeys.filter((k) => !logs.has(`${k}|${returnDate}`));
        if (missed.length > 0) {
          missedCritical.push({
            id:   ref,
            info: `status=${b.status} return=${returnDate} missed=[${missed.join(",")}] vehicle=${b.vehicle_id || "?"}`,
          });
        }
      }
    }

    const totalIssues = missingPhone.length + noSmsContact.length + missedCritical.length;
    if (totalIssues === 0) {
      return check(
        "SMS Delivery Health",
        "ok",
        `All ${rows.length} active rental${rows.length !== 1 ? "s" : ""} have SMS coverage.`,
      );
    }

    const allItems = [
      ...missedCritical.map((i) => ({ id: i.id, info: `[MISSED CRITICAL] ${i.info}` })),
      ...noSmsContact.map((i)   => ({ id: i.id, info: `[NO SMS] ${i.info}` })),
      ...missingPhone.map((i)   => ({ id: i.id, info: `[NO PHONE] ${i.info}` })),
    ];

    const parts = [];
    if (missedCritical.length > 0)
      parts.push(`${missedCritical.length} booking${missedCritical.length !== 1 ? "s" : ""} missed critical return-window SMS`);
    if (noSmsContact.length > 0)
      parts.push(`${noSmsContact.length} active rental${noSmsContact.length !== 1 ? "s" : ""} with no SMS contact`);
    if (missingPhone.length > 0)
      parts.push(`${missingPhone.length} booking${missingPhone.length !== 1 ? "s" : ""} without a phone number`);

    console.error(
      `[v2-system-health] smsDeliveryHealth: missedCritical=${missedCritical.length}` +
      ` noSmsContact=${noSmsContact.length} missingPhone=${missingPhone.length}`
    );

    return check(
      "SMS Delivery Health",
      missedCritical.length > 0 ? "error" : "warning",
      parts.join("; ") + ".",
      allItems,
      "Click 'Fix Now' to send any missing critical SMS. Bookings without a phone number require manual intervention.",
      true, // fixable — frontend routes Fix Now to /api/system-health-fix-sms
    );
  } catch (err) {
    console.error("[v2-system-health] smsDeliveryHealth exception:", err);
    return check("SMS Delivery Health", "error", "Unexpected error: " + err.message);
  }
}

// Check 9 — Booking ↔ Blocked Date Sync
// Detects active_rental / overdue bookings that are missing a blocked_dates
// row — the condition that causes a vehicle to incorrectly appear as available
// on the booking page while an active rental is in progress.
async function checkBookingBlockedDateSync(sb) {
  try {
    const { data: activeBookings, error: bErr } = await sb
      .from("bookings")
      .select("booking_ref, vehicle_id, return_date, return_time, status")
      .in("status", ["active_rental", "overdue"])
      .limit(200);

    if (bErr) {
      console.error("[v2-system-health] bookingBlockedDateSync query error:", bErr.message);
      return check("Booking ↔ Blocked Date Sync", "error", "Could not query active bookings: " + bErr.message);
    }

    const rows = activeBookings || [];
    if (rows.length === 0) {
      return check("Booking ↔ Blocked Date Sync", "ok", "No active or overdue rentals to check.");
    }

    const refs = rows.map((r) => r.booking_ref).filter(Boolean);

    // Fetch all blocked_dates rows linked to these bookings.
    const { data: blockRows, error: blockErr } = await sb
      .from("blocked_dates")
      .select("booking_ref")
      .in("booking_ref", refs)
      .eq("reason", "booking");

    if (blockErr) {
      console.error("[v2-system-health] bookingBlockedDateSync blocked_dates query error:", blockErr.message);
      return check("Booking ↔ Blocked Date Sync", "error", "Could not query blocked_dates: " + blockErr.message);
    }

    const blockedRefs = new Set((blockRows || []).map((r) => r.booking_ref).filter(Boolean));

    const missing = rows.filter((b) => b.booking_ref && !blockedRefs.has(b.booking_ref));

    if (missing.length === 0) {
      return check(
        "Booking ↔ Blocked Date Sync",
        "ok",
        `All ${rows.length} active rental${rows.length !== 1 ? "s" : ""} have a blocked_dates row.`,
      );
    }

    const items = missing.map((b) => ({
      id: b.booking_ref,
      info: `status=${b.status} vehicle=${b.vehicle_id || "?"} return=${b.return_date || "?"}`,
    }));
    console.error(
      `[v2-system-health] ${missing.length} active booking(s) missing blocked_dates row:`,
      missing.map((b) => b.booking_ref),
    );
    return check(
      "Booking ↔ Blocked Date Sync",
      "error",
      `${missing.length} active rental${missing.length !== 1 ? "s" : ""} missing a blocked_dates row (vehicle may show as available).`,
      items,
      "Click 'Fix Now' to rebuild the missing blocked_dates rows.",
      true,
    );
  } catch (err) {
    console.error("[v2-system-health] bookingBlockedDateSync exception:", err);
    return check("Booking ↔ Blocked Date Sync", "error", "Unexpected error: " + err.message);
  }
}

async function runAllChecks(sb) {
  const checks    = {};
  const checkedAt = new Date().toISOString();

  await Promise.all([
    checkPaymentBookingRevenue(sb)    .then((r) => { checks.paymentBookingRevenue    = r; }),
    checkMissingAgreements(sb)        .then((r) => { checks.missingAgreements        = r; }),
    checkActiveRentalCount(sb)        .then((r) => { checks.activeRentalCount        = r; }),
    checkOrphanRevenue(sb)            .then((r) => { checks.orphanRevenue            = r; }),
    checkStaleReservations(sb)        .then((r) => { checks.staleReservations        = r; }),
    checkStripePaymentNoBooking(sb)   .then((r) => { checks.stripePaymentNoBooking   = r; }),
    checkExtensionReturnDateSync(sb)  .then((r) => { checks.extensionReturnDateSync  = r; }),
    checkSmsDeliveryHealth(sb)        .then((r) => { checks.smsDeliveryHealth        = r; }),
    checkBookingBlockedDateSync(sb)   .then((r) => { checks.bookingBlockedDateSync   = r; }),
  ]);

  const statuses = Object.values(checks).map((c) => c.status);
  const overallStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("warning")
    ? "warning"
    : "ok";

  return { checks, overallStatus, checkedAt };
}

// ── Fix actions ────────────────────────────────────────────────────────────

// Fix 9: rebuild missing blocked_dates rows for active bookings
async function fixBookingBlockedDateSync(sb) {
  const { data: activeBookings, error: bErr } = await sb
    .from("bookings")
    .select("booking_ref, vehicle_id, pickup_date, return_date, return_time, status")
    .in("status", ["active_rental", "overdue"])
    .limit(200);

  if (bErr) throw new Error("Could not query active bookings: " + bErr.message);

  const rows = activeBookings || [];
  if (rows.length === 0) return { fixed: 0, message: "No active bookings found." };

  const refs = rows.map((r) => r.booking_ref).filter(Boolean);

  const { data: blockRows, error: blockErr } = await sb
    .from("blocked_dates")
    .select("booking_ref")
    .in("booking_ref", refs)
    .eq("reason", "booking");

  if (blockErr) throw new Error("Could not query blocked_dates: " + blockErr.message);

  const blockedRefs = new Set((blockRows || []).map((r) => r.booking_ref).filter(Boolean));
  const missing = rows.filter((b) => b.booking_ref && !blockedRefs.has(b.booking_ref));

  if (missing.length === 0) return { fixed: 0, message: "No missing blocked_dates rows found." };

  let fixed    = 0;
  let skipped  = 0;
  const failures = [];

  for (const b of missing) {
    try {
      const returnDate = b.return_date ? String(b.return_date).split("T")[0] : null;
      if (!returnDate || !b.vehicle_id || !b.booking_ref) {
        skipped++;
        continue;
      }
      const returnTime = b.return_time ? String(b.return_time).substring(0, 5) : null;
      const startDate  = b.pickup_date ? String(b.pickup_date).split("T")[0] : returnDate;

      const result = await ensureBlockedDate(b.vehicle_id, b.booking_ref, returnDate, returnTime, startDate);
      if (result.created) {
        fixed++;
        console.log(`[v2-system-health] fix_blocked_sync: rebuilt blocked_dates for ${b.booking_ref}`);
      } else {
        skipped++;
        console.log(`[v2-system-health] fix_blocked_sync: skipped ${b.booking_ref} (${result.reason})`);
      }
    } catch (err) {
      failures.push({ id: b.booking_ref, error: err.message });
      console.error(`[v2-system-health] fix_blocked_sync: failed for ${b.booking_ref}:`, err.message);
    }
  }

  return {
    fixed,
    skipped,
    failed: failures.length,
    failures,
    message: `Rebuilt ${fixed} blocked_dates row${fixed !== 1 ? "s" : ""}${failures.length ? `, ${failures.length} failed` : ""}.`,
  };
}

// Fix 1: create missing revenue records for paid bookings
async function fixPaymentBookingRevenue(sb) {
  // Use the same two-query strategy as checkPaymentBookingRevenue so that legacy
  // rows with NULL/partial payment_status are also repaired by Fix Now.
  const [byStatusResult, byDepositResult] = await Promise.all([
    sb.from("bookings")
      .select(
        "booking_ref, status, total_price, deposit_paid, payment_status, " +
        "payment_intent_id, payment_method, vehicle_id, pickup_date, return_date",
      )
      .eq("payment_status", "paid")
      .not("status", "in", '("cancelled","cancelled_rental")')
      .limit(500),
    sb.from("bookings")
      .select(
        "booking_ref, status, total_price, deposit_paid, payment_status, " +
        "payment_intent_id, payment_method, vehicle_id, pickup_date, return_date",
      )
      .gt("deposit_paid", 0)
      .not("status", "in", '("cancelled","cancelled_rental")')
      .in("status", ["booked_paid", "active_rental", "completed_rental", "completed", "active", "overdue"])
      .limit(500),
  ]);
  if (byStatusResult.error) throw new Error("Could not query bookings: " + byStatusResult.error.message);

  // Merge and deduplicate by booking_ref
  const seen = new Set();
  const paidBookings = [];
  for (const b of [...(byStatusResult.data || []), ...(byDepositResult.data || [])]) {
    if (b.booking_ref && !seen.has(b.booking_ref)) {
      seen.add(b.booking_ref);
      paidBookings.push(b);
    }
  }

  const refs = paidBookings.map((b) => b.booking_ref).filter(Boolean);
  if (refs.length === 0) return { fixed: 0, message: "No paid bookings found." };

  const { data: revRows, error: rErr } = await sb
    .from("revenue_records")
    .select("booking_id")
    .in("booking_id", refs);
  if (rErr) throw new Error("Could not query revenue_records: " + rErr.message);

  const revenueRefs = new Set((revRows || []).map((r) => r.booking_id));

  // Also check by payment_intent_id to detect revenue records (e.g. orphan records
  // created by stripe-reconcile with a "stripe-pi_xxx" booking_id) that already
  // cover the payment — these bookings are considered handled and excluded from the
  // missing list so Fix Now does not attempt a duplicate insert.
  const piIds = paidBookings.map((b) => b.payment_intent_id).filter(Boolean);
  let coveredByPI = new Set(); // payment_intent_ids already linked in revenue_records
  if (piIds.length > 0) {
    const { data: revByPI, error: piErr } = await sb
      .from("revenue_records")
      .select("payment_intent_id")
      .in("payment_intent_id", piIds);
    if (!piErr) {
      coveredByPI = new Set((revByPI || []).map((r) => r.payment_intent_id).filter(Boolean));
    }
  }

  // Also check via original_booking_id for manual extension fee records
  // (booking_id="ext-..." records where original_booking_id=<booking_ref>).
  const { data: revByOrigRef, error: origRefErr } = await sb
    .from("revenue_records")
    .select("original_booking_id")
    .in("original_booking_id", refs);
  if (!origRefErr) {
    for (const r of revByOrigRef || []) {
      if (r.original_booking_id) revenueRefs.add(r.original_booking_id);
    }
  }

  const missing = paidBookings.filter(
    (b) =>
      b.booking_ref &&
      !revenueRefs.has(b.booking_ref) &&
      !(b.payment_intent_id && coveredByPI.has(b.payment_intent_id)),
  );
  if (missing.length === 0) return { fixed: 0, message: "No missing revenue records found." };

  let fixed   = 0;
  let skipped = 0;
  const failures = [];

  for (const b of missing) {
    try {
      // Per-row idempotency guard — re-check immediately before inserting so
      // concurrent invocations (cron + manual) cannot create duplicate records.
      // This is a second check on top of the bulk revenueRefs filter above.
      const { data: existing, error: existErr } = await sb
        .from("revenue_records")
        .select("id")
        .eq("booking_id", b.booking_ref)
        .maybeSingle();
      if (existErr) {
        throw new Error(`pre-insert check failed for ${b.booking_ref}: ${existErr.message}`);
      }
      if (existing?.id) {
        // A record appeared between the bulk query and this insert — skip it.
        skipped++;
        console.log(`[v2-system-health] fix_revenue: skipped ${b.booking_ref} (record already exists)`);
        continue;
      }

      await autoCreateRevenueRecord({
        bookingId:       b.booking_ref,
        vehicleId:       b.vehicle_id,
        // Use deposit_paid as the actual collected amount (gross_amount in revenue_records).
        // Fall back to total_price only when deposit_paid is absent (e.g. very old rows).
        amountPaid:      Number(b.deposit_paid || b.total_price || 0),
        // totalPrice tracks the full rental cost for metadata; prefers total_price over
        // deposit_paid because partial deposits don't represent the full booking value.
        totalPrice:      Number(b.total_price || b.deposit_paid || 0),
        paymentIntentId: b.payment_intent_id || null,
        paymentMethod:   b.payment_method || "stripe",
        pickupDate:      b.pickup_date || null,
        returnDate:      b.return_date || null,
      }, { strict: false });
      fixed++;
      console.log(`[v2-system-health] fix_revenue: created revenue record for ${b.booking_ref}`);
    } catch (err) {
      failures.push({ id: b.booking_ref, error: err.message });
      console.error(`[v2-system-health] fix_revenue: failed for ${b.booking_ref}:`, err.message);
    }
  }

  return {
    fixed,
    failed: failures.length,
    failures,
    message: `Created ${fixed} revenue record${fixed !== 1 ? "s" : ""}${failures.length ? `, ${failures.length} failed` : ""}.`,
  };
}

// Fix 4: flag true-orphan revenue records as is_orphan=true
async function fixOrphanRevenue(sb) {
  const { data: orphanRows, error: oErr } = await sb
    .from("revenue_records")
    .select("id, booking_id")
    .eq("is_orphan", false)
    .eq("sync_excluded", false)
    .eq("type", "rental")
    .limit(500);
  if (oErr) throw new Error("Could not query revenue_records: " + oErr.message);

  const rows       = orphanRows || [];
  const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];
  if (bookingIds.length === 0) return { fixed: 0, message: "Nothing to fix." };

  const { data: bookingRows, error: bErr } = await sb
    .from("bookings")
    .select("booking_id")
    .in("booking_id", bookingIds);
  if (bErr) throw new Error("Could not verify booking refs: " + bErr.message);

  const validRefs   = new Set((bookingRows || []).map((b) => b.booking_id));
  const trueOrphans = rows.filter((r) => r.booking_id && !validRefs.has(r.booking_id));
  if (trueOrphans.length === 0) return { fixed: 0, message: "No true orphans found." };

  const ids = trueOrphans.map((r) => r.id);
  const { error: updateErr } = await sb
    .from("revenue_records")
    .update({ is_orphan: true })
    .in("id", ids);
  if (updateErr) throw new Error("Could not flag orphans: " + updateErr.message);

  console.log(`[v2-system-health] fix_orphans: flagged ${trueOrphans.length} records as is_orphan=true`);
  return {
    fixed: trueOrphans.length,
    message: `Flagged ${trueOrphans.length} orphan record${trueOrphans.length !== 1 ? "s" : ""} as is_orphan=true.`,
  };
}

// Fix 5: cancel stale unpaid reservations older than 24 hours
async function fixStaleReservations(sb) {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: staleRows, error: sErr } = await sb
    .from("bookings")
    .select("booking_ref, status")
    .in("payment_status", ["unpaid"])
    .in("status", ["pending", "reserved"])
    .lt("created_at", cutoff)
    .limit(100);
  if (sErr) throw new Error("Could not query stale reservations: " + sErr.message);

  const rows = staleRows || [];
  if (rows.length === 0) return { fixed: 0, message: "No stale reservations found." };

  const refs = rows.map((r) => r.booking_ref).filter(Boolean);
  const { error: updateErr } = await sb
    .from("bookings")
    .update({ status: "cancelled_rental" })
    .in("booking_ref", refs);
  if (updateErr) throw new Error("Could not cancel reservations: " + updateErr.message);

  console.log(`[v2-system-health] fix_stale: cancelled ${rows.length} stale reservations:`, refs);
  return {
    fixed: rows.length,
    message: `Cancelled ${rows.length} stale reservation${rows.length !== 1 ? "s" : ""}.`,
  };
}

// Fix 6: queue orphan-PI revenue records for booking reconstruction.
//
// Safety guards — reconstruction is ONLY queued when ALL of the following hold:
//   1. Stripe PaymentIntent status === "succeeded"
//   2. pi.metadata.booking_id is present
//   3. No booking with that booking_ref already exists in the DB
//
// If metadata is incomplete (guard 2 fails) → flag only, do NOT auto-repair.
// Idempotent: a booking that already exists is never reconstructed again.
async function fixStripePaymentNoBooking(sb) {
  const cutoff60d = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();

  const { data: rows, error: oErr } = await sb
    .from("revenue_records")
    .select("id, payment_intent_id, booking_id")
    .eq("is_orphan", true)
    .not("payment_intent_id", "is", null)
    .gte("created_at", cutoff60d)
    .limit(100);
  if (oErr) throw new Error("Could not query orphan revenue records: " + oErr.message);

  if (!rows || rows.length === 0) return { fixed: 0, message: "No unlinked Stripe payments found." };

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let queued             = 0;
  let skippedNotSucceeded = 0;
  let skippedIncomplete  = 0;
  let skippedExists      = 0;
  const failures         = [];

  for (const row of rows) {
    const piId = row.payment_intent_id;
    try {
      // Guard 1: PaymentIntent must have status "succeeded"
      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(piId);
      } catch (stripeErr) {
        failures.push({ id: piId, error: `Stripe retrieve failed: ${stripeErr.message}` });
        console.error(`[v2-system-health] fix_pi_no_booking: Stripe error for ${piId}:`, stripeErr.message);
        continue;
      }
      if (pi.status !== "succeeded") {
        skippedNotSucceeded++;
        console.log(`[v2-system-health] fix_pi_no_booking: skipped ${piId} (status=${pi.status})`);
        continue;
      }

      // Guard 2: metadata.booking_id must be present
      const bookingRef = pi.metadata?.booking_id;
      if (!bookingRef) {
        skippedIncomplete++;
        console.warn(
          `[v2-system-health] fix_pi_no_booking: flagged ${piId} — metadata.booking_id missing, not auto-repairing`,
        );
        continue;
      }

      // Guard 3: booking_ref must NOT already exist in the bookings table
      const { data: existing, error: bErr } = await sb
        .from("bookings")
        .select("booking_ref")
        .eq("booking_ref", bookingRef)
        .maybeSingle();
      if (bErr) {
        failures.push({ id: piId, error: `bookings lookup failed: ${bErr.message}` });
        console.error(`[v2-system-health] fix_pi_no_booking: bookings lookup error for ${piId}:`, bErr.message);
        continue;
      }
      if (existing?.booking_ref) {
        skippedExists++;
        console.log(
          `[v2-system-health] fix_pi_no_booking: skipped ${piId} — booking ${bookingRef} already exists`,
        );
        continue;
      }

      // All guards passed — queue for reconstruction
      const { error: updateErr } = await sb
        .from("revenue_records")
        .update({ is_orphan: false, sync_excluded: false })
        .eq("id", row.id);
      if (updateErr) {
        failures.push({ id: piId, error: `revenue_records update failed: ${updateErr.message}` });
        console.error(`[v2-system-health] fix_pi_no_booking: update error for ${piId}:`, updateErr.message);
        continue;
      }

      queued++;
      console.log(
        `[v2-system-health] fix_pi_no_booking: queued ${piId} (booking_ref=${bookingRef}) for reconstruction`,
      );
    } catch (err) {
      failures.push({ id: piId, error: err.message });
      console.error(`[v2-system-health] fix_pi_no_booking: unexpected error for ${piId}:`, err.message);
    }
  }

  const parts = [];
  if (queued > 0)              parts.push(`${queued} queued for reconstruction`);
  if (skippedExists > 0)       parts.push(`${skippedExists} already exist`);
  if (skippedIncomplete > 0)   parts.push(`${skippedIncomplete} flagged (incomplete metadata)`);
  if (skippedNotSucceeded > 0) parts.push(`${skippedNotSucceeded} not yet succeeded`);
  if (failures.length > 0)     parts.push(`${failures.length} failed`);

  return {
    fixed:               queued,
    skippedExists,
    skippedIncomplete,
    skippedNotSucceeded,
    failed:              failures.length,
    failures,
    message: parts.length ? parts.join(", ") + "." : "No eligible payments to reconstruct.",
  };
}

// ── Alerting ───────────────────────────────────────────────────────────────

async function shouldSendAlert(sb) {
  try {
    const { data, error } = await sb
      .from("system_settings")
      .select("value")
      .eq("key", ALERT_COOLDOWN_KEY)
      .maybeSingle();
    if (error || !data?.value) return true;
    const lastSent = new Date(data.value).getTime();
    return Date.now() - lastSent > ALERT_COOLDOWN_MS;
  } catch {
    return true;
  }
}

async function recordAlertSent(sb) {
  try {
    await sb
      .from("system_settings")
      .upsert({ key: ALERT_COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });
  } catch (err) {
    console.error("[v2-system-health] recordAlertSent error:", err.message);
  }
}

async function sendOwnerAlerts(checks, overallStatus, checkedAt) {
  const issueChecks = Object.values(checks).filter((c) => c.status !== "ok");
  if (issueChecks.length === 0) return;

  const formattedTime = new Date(checkedAt).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
  });
  const subject =
    `[SLY RIDES] 🚨 System Health Alert — ${issueChecks.length} issue${issueChecks.length !== 1 ? "s" : ""} detected`;

  // Build SMS text
  const smsText =
    `[SLY RIDES] System Health ${overallStatus.toUpperCase()}: ` +
    issueChecks.map((c) => c.label).join(", ") +
    ` — https://www.slytrans.com/admin-v2/`;

  // Build plain text body
  const plainText = [
    `System Health Alert — ${formattedTime}`,
    "",
    ...issueChecks.map((c) => {
      const icon = c.status === "error" ? "❌" : "⚠️";
      const topItems = (c.items || []).slice(0, 3)
        .map((i) => `  • ${i.id}: ${i.info}`)
        .join("\n");
      return `${icon} ${c.label}\n   ${c.summary}${topItems ? "\n" + topItems : ""}`;
    }),
    "",
    `Open admin panel: https://www.slytrans.com/admin-v2/`,
  ].join("\n");

  // ── Email ──
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && OWNER_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_PORT === "465",
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const htmlRows = issueChecks.map((c) => {
        const icon  = c.status === "error" ? "❌" : "⚠️";
        const color = c.status === "error" ? "#dc2626" : "#d97706";
        const topItems = (c.items || []).slice(0, 5)
          .map(
            (i) =>
              `<li style="font-family:monospace;font-size:12px;margin:2px 0;">` +
              `<strong>${escHtml(i.id)}</strong> — ${escHtml(i.info)}</li>`,
          )
          .join("");
        return (
          `<tr>` +
          `<td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">` +
          `<strong style="color:${color}">${icon} ${escHtml(c.label)}</strong><br>` +
          `<span style="font-size:13px;color:#374151;">${escHtml(c.summary)}</span>` +
          (topItems ? `<ul style="margin:6px 0 0;padding-left:16px;">${topItems}</ul>` : "") +
          `</td></tr>`
        );
      }).join("");

      await transporter.sendMail({
        from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:      OWNER_EMAIL,
        subject,
        html: `<div style="font-family:sans-serif;max-width:640px;margin:0 auto;">
          <h2 style="color:#dc2626;margin-bottom:4px;">🚨 System Health Alert</h2>
          <p style="color:#6b7280;margin-top:0;">Detected at ${escHtml(formattedTime)} (LA time) — ` +
          `${issueChecks.length} issue${issueChecks.length !== 1 ? "s" : ""}</p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          ${htmlRows}</table>
          <p style="margin-top:16px;">
            <a href="https://www.slytrans.com/admin-v2/"
               style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;` +
               `text-decoration:none;border-radius:6px;font-weight:600;">🩺 Open Admin Panel</a>
          </p>
          <p style="color:#9ca3af;font-size:12px;">
            This alert will not repeat for 1 hour. Alerts only fire when overallStatus is "error".
          </p></div>`,
        text: plainText,
      });
      console.log("[v2-system-health] owner alert email sent to", OWNER_EMAIL);
    } catch (err) {
      console.error("[v2-system-health] owner alert email error:", err.message);
    }
  }

  // ── SMS ──
  if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
    try {
      const { sendSms } = await import("./_textmagic.js");
      await sendSms(OWNER_PHONE, smsText);
      console.log("[v2-system-health] owner alert SMS sent to", OWNER_PHONE);
    } catch (err) {
      console.error("[v2-system-health] owner alert SMS error:", err.message);
    }
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase not configured." });
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  // Path A (Vercel Cron): GET  — or POST with Authorization: Bearer CRON_SECRET
  // Path B (Admin panel): POST with { secret: ADMIN_SECRET } in body
  const authHeader = req.headers.authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall =
    req.method === "GET" ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`);

  if (!isCronCall) {
    // Admin-panel POST path
    if (!isAdminConfigured()) {
      return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
    }
    const { secret, action } = req.body || {};
    if (!isAdminAuthorized(secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Dispatch fix actions ────────────────────────────────────────────────
    if (action && action.startsWith("fix_")) {
      const checkKey = action.slice(4);
      try {
        let result;
        if      (checkKey === "paymentBookingRevenue")  result = await fixPaymentBookingRevenue(sb);
        else if (checkKey === "orphanRevenue")          result = await fixOrphanRevenue(sb);
        else if (checkKey === "staleReservations")      result = await fixStaleReservations(sb);
        else if (checkKey === "stripePaymentNoBooking") result = await fixStripePaymentNoBooking(sb);
        else if (checkKey === "bookingBlockedDateSync") result = await fixBookingBlockedDateSync(sb);
        else return res.status(400).json({ error: `Unknown fix action: ${action}` });
        return res.status(200).json({ ok: true, action, ...result });
      } catch (err) {
        console.error(`[v2-system-health] fix action ${action} failed:`, err.message);
        return res.status(500).json({ ok: false, action, error: err.message });
      }
    }
  } else if (cronSecret && authHeader && authHeader !== `Bearer ${cronSecret}`) {
    // CRON_SECRET is configured but header doesn't match — reject
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Run all checks ─────────────────────────────────────────────────────────
  const { checks, overallStatus, checkedAt } = await runAllChecks(sb);

  // ── Cron mode extras: auto-repair + alert ──────────────────────────────────
  if (isCronCall) {
    const autoRepairResults = {};

    const autoRepairMap = {
      paymentBookingRevenue:  fixPaymentBookingRevenue,
      orphanRevenue:          fixOrphanRevenue,
      staleReservations:      fixStaleReservations,
      stripePaymentNoBooking: fixStripePaymentNoBooking,
      bookingBlockedDateSync: fixBookingBlockedDateSync,
    };
    for (const [key, fixFn] of Object.entries(autoRepairMap)) {
      if (checks[key]?.status === "error" && checks[key]?.fixable) {
        try {
          autoRepairResults[key] = await fixFn(sb);
        } catch (err) {
          autoRepairResults[key] = { error: err.message };
          console.error(`[v2-system-health] cron auto-repair ${key} failed:`, err.message);
        }
      }
    }

    if (overallStatus === "error") {
      const canAlert = await shouldSendAlert(sb);
      if (canAlert) {
        await sendOwnerAlerts(checks, overallStatus, checkedAt);
        await recordAlertSent(sb);
      }
    }

    return res.status(200).json({ checks, overallStatus, checkedAt, autoRepair: autoRepairResults });
  }

  return res.status(200).json({ checks, overallStatus, checkedAt });
}
