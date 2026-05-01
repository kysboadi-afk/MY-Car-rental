// api/v2-dashboard.js
// SLYTRANS FLEET CONTROL v2 — Dashboard statistics endpoint.
// Returns aggregated KPIs, revenue trends, and alerts for the admin dashboard.
//
// POST /api/v2-dashboard
// Body: { "secret": "<ADMIN_SECRET>" }
//
// Financial source of truth: revenue_records (Supabase)
//   Gross Revenue = SUM(gross_amount  WHERE payment_status='paid' AND !is_cancelled AND !is_no_show)
//   Total Fees    = SUM(stripe_fee)   (null treated as 0 for unreconciled rows)
//   Net Revenue   = SUM(gross_amount − stripe_fee − refund_amount)
//   Net Profit    = Net Revenue − Total Expenses
//
// Falls back to bookings.json when Supabase is unavailable or revenue_records
// is empty, matching the same fallback behaviour as api/v2-revenue.js.

import { loadVehicles } from "./_vehicles.js";
import { loadExpenses } from "./_expenses.js";
import { loadBookings, isNetworkError } from "./_bookings.js";
import { computeAmount, getAllVehicleIds } from "./_pricing.js";
import { normalizeClockTime } from "./_time.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { normalizeVehicleId, uiVehicleId } from "./_vehicle-id.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const VEHICLE_NAMES    = {
  camry:     "Camry 2012",
  camry2013: "Camry 2013 SE",
};
const DB_TO_APP_STATUS = {
  pending:              "reserved_unpaid",
  reserved:             "reserved_unpaid",
  pending_verification: "reserved_unpaid",
  approved:             "booked_paid",
  booked_paid:          "booked_paid",
  active:               "active_rental",
  active_rental:        "active_rental",
  completed:            "completed_rental",
  completed_rental:     "completed_rental",
  cancelled:            "cancelled_rental",
  cancelled_rental:     "cancelled_rental",
};
const DEFAULT_RETURN_TIME = "10:00";

// Used only as a fallback when revenue_records is unavailable or empty.
function bookingRevenue(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) {
    return booking.amountPaid;
  }
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    const computed = computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate);
    return computed || 0;
  }
  return 0;
}

// Builds an absolute Date from a date+time string in America/Los_Angeles timezone.
// Stored times are LA wall-clock values, so we must apply the correct LA UTC
// offset (PDT = UTC-7, PST = UTC-8) rather than treating them as bare UTC.
function buildDateTimeLA(date, time) {
  if (!date) return null;
  const normalizedTime = normalizeClockTime(time || DEFAULT_RETURN_TIME);
  if (!normalizedTime) return null;
  // Interpret the stored LA wall-clock time as UTC momentarily to probe the
  // correct LA offset at that calendar date (handles PDT/PST automatically).
  const laAsUtcProbe = new Date(`${date}T${normalizedTime}:00Z`);
  if (Number.isNaN(laAsUtcProbe.getTime())) return null;
  let offset = "-08:00"; // PST fallback
  try {
    const tzPart = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "longOffset",
    }).formatToParts(laAsUtcProbe).find((p) => p.type === "timeZoneName")?.value || "";
    const m = tzPart.match(/GMT([+-]\d{1,2}:\d{2})/);
    if (m) offset = m[1];
  } catch {
    // keep PST fallback
  }
  const dt = new Date(`${date}T${normalizedTime}:00${offset}`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseReturnDateTime(returnDate, returnTime) {
  if (!returnDate) return null;
  return buildDateTimeLA(returnDate, returnTime || DEFAULT_RETURN_TIME);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret, scope } = req.body || {};
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = getSupabaseAdmin();

    // Resolve vehicle IDs dynamically so newly-added vehicles appear in dashboard
    // queries without requiring a code re-deploy.  Falls back to the static list
    // when Supabase is unavailable.
    const ALLOWED_VEHICLES = await getAllVehicleIds(sb);

    // Load expenses: prefer Supabase (matches the write path in add-expense.js),
    // fall back to GitHub expenses.json when Supabase is unavailable or errors.
    async function fetchExpenses() {
      if (sb) {
        const { data, error } = await sb.from("expenses").select("*");
        if (!error && data) {
          return { data };
        }
        console.warn("v2-dashboard: Supabase expenses query failed, falling back to GitHub:", error?.message);
      }
      return loadExpenses();
    }

    // Load bookings for non-financial KPIs.
    // Primary: Supabase bookings table. Fallback: bookings.json — only on network
    // error (Supabase unreachable). Empty result sets are valid and are NOT
    // grounds for fallback.
    async function fetchBookingsKpis() {
      if (sb) {
        try {
          const { data: rows, error } = await sb
            .from("bookings")
            .select(`
              booking_ref, vehicle_id, status,
              pickup_date, return_date, pickup_time, return_time,
              deposit_paid, created_at,
              customers ( name )
            `)
            .in("vehicle_id", ALLOWED_VEHICLES)
            .order("created_at", { ascending: false });
          if (error) throw error; // query error → propagate, do NOT fallback
          return (rows || []).map((r) => ({
            bookingId:   r.booking_ref || String(r.id),
            vehicleId:   uiVehicleId(r.vehicle_id),
            vehicleName: VEHICLE_NAMES[uiVehicleId(r.vehicle_id)] || r.vehicle_id,
            name:        r.customers?.name || "",
            status:      DB_TO_APP_STATUS[r.status] || r.status,
            pickupDate:  r.pickup_date  || "",
            returnDate:  r.return_date  || "",
            returnTime:  r.return_time  || "",
            amountPaid:  Number(r.deposit_paid || 0),
            createdAt:   r.created_at,
          }));
        } catch (err) {
          if (isNetworkError(err)) {
            console.error("[FALLBACK] Supabase unreachable in v2-dashboard, using bookings.json:", err.message);
            const { data } = await loadBookings();
            return Object.values(data).flat();
          }
          throw err; // non-network Supabase errors propagate
        }
      }
      // Supabase not configured — use bookings.json directly
      const { data } = await loadBookings();
      return Object.values(data).flat();
    }

    const metricsPromise = sb
      ? sb.from("admin_metrics_v2").select("*").single()
          .then((r) => r, (e) => {
            console.warn("v2-dashboard: admin_metrics_v2 query failed (non-fatal), falling back to revenue_records loop:", e?.message);
            return { data: null, error: e };
          })
      : Promise.resolve({ data: null });

    const bookingsPromise = sb
      ? sb.from("bookings")
          .select(`
            booking_ref, vehicle_id, status,
            pickup_date, return_date, pickup_time, return_time,
            deposit_paid, created_at,
            customers ( name )
          `)
          .in("vehicle_id", ALLOWED_VEHICLES)
          .order("created_at", { ascending: false })
          .limit(20)
          .then((r) => r, () => ({ data: null }))
      : Promise.resolve({ data: null });

    // Canonical ledger-based KPI — same view queried by v2-revenue.js `kpi` action.
    const kpiPromise = sb
      ? sb.from("total_revenue_kpi").select("total_revenue").single()
          .then((r) => r, (e) => {
            console.warn("v2-dashboard: total_revenue_kpi query failed (non-fatal):", e?.message);
            return { data: null, error: e };
          })
      : Promise.resolve({ data: null });

    const [{ data: vehicles }, { data: expenses }, allBookingsRaw, metricsViewResult, recentBkResult, kpiResult] =
      await Promise.all([
        loadVehicles(),
        fetchExpenses(),
        fetchBookingsKpis(),
        metricsPromise,
        bookingsPromise,
        kpiPromise,
      ]);

    // admin_metrics_v2: pre-aggregated dashboard KPIs.
    // When available it replaces the sequential revenue_records and charges queries.
    const metricsView = metricsViewResult?.data ?? null;
    const viewOk = !!metricsView && !metricsViewResult?.error;

    // Scope prefix selects the right pre-aggregated column set:
    //   "car"/"cars" → car_ prefix
    //   (none)       → total_ prefix
    const vp = (scope === "car" || scope === "cars") ? "car" : "total";

    // Filter vehicles by scope: "car" → exclude non-car types
    const filteredVehicleEntries = Object.entries(vehicles).filter(([, v]) => {
      const type = v.type || "";
      if (scope === "car" || scope === "cars") return true;
      return true;
    });
    const filteredVehicles   = Object.fromEntries(filteredVehicleEntries);
    const filteredVehicleIds = new Set(Object.keys(filteredVehicles));

    // All bookings limited to scoped vehicles (used for non-financial KPIs)
    const allBookings = allBookingsRaw
      .filter((b) => filteredVehicleIds.size === 0 || filteredVehicleIds.has(b.vehicleId));

    // Non-financial KPIs (from Supabase bookings, or bookings.json fallback)
    const now = new Date();
    // Anchor "today" to Los Angeles wall-clock time so the boundaries align with
    // LA operations regardless of where the Vercel function runs.
    // todayLA = LA midnight (start of current LA day).
    const todayLA = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    todayLA.setHours(0, 0, 0, 0);
    // ISO date string kept for the "returns today" check (date equality).
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
    let activeBookings    = 0;
    let pendingApprovals  = 0;
    let overdueCount      = 0;
    let returnsTodayCount = 0;
    let pickupsTodayCount = 0;
    const activeOrOverdueBookings = [];
    for (const booking of allBookings) {
      if (booking.status === "cancelled_rental" || booking.status === "completed_rental") {
        // Completed and cancelled bookings never contribute to active/overdue KPIs.
        // A completed_rental whose return date is in the past would otherwise be
        // incorrectly counted as overdue (now >= returnDateTime is true for any
        // past booking).  Only the revenue fallback loop below needs completed_rental.
        continue;
      }
      const returnDateTime = parseReturnDateTime(booking.returnDate, booking.returnTime);
      // Overdue: either explicitly flagged by an admin (status === "overdue") OR the
      // return datetime has provably passed. The explicit status check is intentional
      // — it covers cases where an admin marks a rental overdue without a precise
      // return time stored (returnDateTime would be null/invalid).
      const bookingIsOverdue = booking.status === "overdue"
        || (!!returnDateTime && now >= returnDateTime);
      // Active rental = date range only, timezone-safe:
      //   pickup midnight <= LA today  AND  return end-of-day >= LA today
      // Status-agnostic so new statuses never break the count.
      // Both dates must be present; missing dates do not inflate the KPI.
      let bookingIsActive = false;
      if (booking.pickupDate && booking.returnDate) {
        const pickup = new Date(booking.pickupDate);
        pickup.setHours(0, 0, 0, 0);
        const returnD = new Date(booking.returnDate);
        returnD.setHours(23, 59, 59, 999);
        bookingIsActive = pickup <= todayLA
          && returnD >= todayLA
          && (!returnDateTime || now < returnDateTime);
      }
      if (bookingIsActive || bookingIsOverdue) {
        activeBookings++;
        activeOrOverdueBookings.push(booking);
      }
      if (booking.status === "reserved_unpaid") pendingApprovals++;
      if (bookingIsOverdue) overdueCount++;
      if (booking.returnDate === todayStr && bookingIsActive
          && booking.status !== "completed_rental") {
        returnsTodayCount++;
      }
      // Pickups today: booked/approved rentals whose pickup date is today (LA).
      if (booking.pickupDate === todayStr
          && (booking.status === "reserved_unpaid" || booking.status === "booked_paid")) {
        pickupsTodayCount++;
      }
    }

    // Booking-count KPIs come exclusively from the JS loop above.
    // The admin_metrics_v2 view's booking counts are intentionally NOT used here
    // because the view schema may be behind code deployments: for example, if
    // migration 0064 standardised booking statuses to 'active_rental' but
    // migration 0079 (which adds 'active_rental' to the view's filter) has not
    // yet been applied, the view returns 0 for every active-rental count while
    // the JS loop above (which queries the live bookings table and is
    // status-agnostic for the active-rental check) gives the correct result.
    //
    // Long-term: once migration 0079 is confirmed applied to all environments,
    // it is safe to re-introduce the view override for additional accuracy (e.g.
    // server-side timezone handling for returns/pickups today). Until then the
    // JS loop is the single source of truth for these counts.

    // Total expenses (scoped)
    const totalExpenses = expenses
      .filter((e) => filteredVehicleIds.size === 0 || filteredVehicleIds.has(e.vehicle_id))
      .reduce((s, e) => s + Number(e.amount || 0), 0);

    // ── Financial KPIs: admin_metrics_v2 view (primary) or revenue_records loop (fallback) ─
    // The view pre-aggregates revenue_records + supplemental charges in SQL,
    // replacing the sequential revenue_records query and charges dedup loop below.
    // Falls back to the revenue_records JS loop when the view is unavailable.

    let totalRevenue    = 0;
    let totalStripeFees = 0;
    let netRevenue      = 0;
    let reconciledCount = 0;
    const monthlyRevenue     = {};
    const bookingsPerVehicle = {};
    // Per-vehicle revenue from revenue_records (keyed by vehicle_id)
    const rrByVehicle = {}; // { [vehicleId]: { gross, net, count } }
    // Per-booking revenue from revenue_records (for recentBookings display)
    const rrByBookingId = {}; // { [bookingId]: gross_amount }
    let financialsFromRevRecords = false;

    if (viewOk) {
      // Fast path: all financial totals come from the pre-aggregated view.
      const viewRevenue    = Number(metricsView[`${vp}_revenue`]          || 0);
      const viewReconciled = Number(metricsView[`${vp}_reconciled_count`] || 0);

      // Only trust the view's financial data when it contains real Stripe-backed
      // revenue OR when the view at least has reconciled records (even at $0).
      // When both are zero the revenue_records table is empty for this scope and
      // we fall through to the bookings-based fallback so the dashboard shows
      // deposit amounts as a best-effort estimate instead of a misleading $0.
      if (viewRevenue > 0 || viewReconciled > 0) {
        financialsFromRevRecords = true;
        totalRevenue    = viewRevenue;
        totalStripeFees = Number(metricsView[`${vp}_stripe_fees`]      || 0);
        netRevenue      = Number(metricsView[`${vp}_net_revenue`]      || 0);
        reconciledCount = viewReconciled;

        // Populate per-vehicle revenue map (used by vehicleStats computation below).
        // view includes both revenue_records and supplemental charges.
        // Accumulate (+=) rather than assign so that any vehicle_id aliases that
        // uiVehicleId() maps to the same canonical key are merged correctly.
        const vRevJson = metricsView.vehicle_revenue_json || {};
        for (const [vid, vr] of Object.entries(vRevJson)) {
          const normVid = uiVehicleId(vid);
          if (!rrByVehicle[normVid]) rrByVehicle[normVid] = { gross: 0, net: 0, count: 0 };
          rrByVehicle[normVid].gross += Number(vr.gross || 0);
          rrByVehicle[normVid].net   += Number(vr.net   || 0);
          rrByVehicle[normVid].count += Number(vr.count || 0);
          bookingsPerVehicle[normVid] = (bookingsPerVehicle[normVid] || 0) + Number(vr.count || 0);
        }
      }
    }

    // Run the direct revenue_records_effective loop when:
    //   a) the admin_metrics_v2 view is unavailable (!viewOk), OR
    //   b) the view is available but returned no financial data — this happens when
    //      revenue_reporting_base is empty (e.g. all paid records have is_orphan=true),
    //      which would otherwise cause the dashboard to fall back to booking deposits.
    if (sb && (!viewOk || !financialsFromRevRecords)) {
      try {
        const { data: rrRows, error: rrErr } = await sb
          .from("revenue_records_effective")
          .select("booking_id, vehicle_id, pickup_date, gross_amount, stripe_fee, stripe_net, refund_amount, is_cancelled, is_no_show")
          .eq("payment_status", "paid");

        if (rrErr) {
          console.error("v2-dashboard: revenue records unavailable, falling back to bookings.json:", rrErr.message);
        } else if ((rrRows || []).length > 0) {
          financialsFromRevRecords = true;
          for (const r of rrRows) {
            if (r.is_cancelled || r.is_no_show) continue;
            const vid = uiVehicleId(r.vehicle_id) || "unknown";
            if (filteredVehicleIds.size > 0 && !filteredVehicleIds.has(vid)) continue;

            const grossRaw = Number(r.gross_amount || 0);
            const gross  = Number.isFinite(grossRaw) ? grossRaw : 0;
            const fee    = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
            const refund = Number(r.refund_amount || 0);
            // Net = Gross − Stripe Fees − Refunds (strict formula, no stripe_net).
            const net    = gross - fee - refund;

            totalRevenue    += gross;
            totalStripeFees += fee;
            netRevenue      += net;
            if (r.stripe_fee != null) reconciledCount++;

            const monthKey = (r.pickup_date || "").slice(0, 7);
            if (monthKey) monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + gross;

            bookingsPerVehicle[vid] = (bookingsPerVehicle[vid] || 0) + 1;

            if (!rrByVehicle[vid]) rrByVehicle[vid] = { gross: 0, net: 0, count: 0 };
            rrByVehicle[vid].gross += gross;
            rrByVehicle[vid].net   += net;
            rrByVehicle[vid].count += 1;

            if (r.booking_id) rrByBookingId[r.booking_id] = (rrByBookingId[r.booking_id] || 0) + gross;
          }
        }
        // If rrRows is empty (no paid records yet) we fall through to bookings.json.
      } catch (rrEx) {
        console.warn("v2-dashboard: revenue_records unavailable, falling back to bookings.json:", rrEx.message);
      }
    }

    // Fallback: compute from bookings.json when Supabase unavailable or rev_records empty.
    // Mirrors the same fallback used by api/v2-revenue.js.
    if (!financialsFromRevRecords) {
      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
      for (const booking of allBookings) {
        if (!paidStatuses.has(booking.status)) continue;
        const amount = bookingRevenue(booking);
        totalRevenue += amount;
        netRevenue   += amount; // No Stripe fee data available in fallback

        const monthKey = (booking.pickupDate || "").slice(0, 7);
        if (monthKey) monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + amount;

        const vid = booking.vehicleId || "unknown";
        bookingsPerVehicle[vid] = (bookingsPerVehicle[vid] || 0) + 1;
      }
    }

    // ── Per-vehicle stats ─────────────────────────────────────────────────────
    const paidStatusesFallback = new Set(["booked_paid", "active_rental", "completed_rental"]);
    const vehicleStats = {};
    for (const [vehicleId, vehicle] of Object.entries(filteredVehicles)) {
      const vExpenses = expenses
        .filter((e) => e.vehicle_id === vehicleId)
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const purchasePrice = vehicle.purchase_price || 0;

      let vGross, vNet, vBookingCount;
      if (financialsFromRevRecords) {
        const vr  = rrByVehicle[vehicleId] || { gross: 0, net: 0, count: 0 };
        vGross        = vr.gross;
        vNet          = vr.net;
        vBookingCount = vr.count;
      } else {
        // Fallback from bookings data
        const vBookings = allBookings.filter(
          (b) => b.vehicleId === vehicleId && paidStatusesFallback.has(b.status)
        );
        vGross        = vBookings.reduce((s, b) => s + bookingRevenue(b), 0);
        vNet          = vGross; // Assume zero fees when no Stripe data available
        vBookingCount = vBookings.length;
      }

      const vNetProfit = vNet - vExpenses;
      vehicleStats[vehicleId] = {
        name:             vehicle.vehicle_name,
        status:           vehicle.status,
        revenue:          Math.round(vGross     * 100) / 100,
        expenses:         Math.round(vExpenses  * 100) / 100,
        netProfit:        Math.round(vNetProfit * 100) / 100,
        purchasePrice,
        roi:              purchasePrice > 0 ? Math.round((vNetProfit / purchasePrice) * 10000) / 100 : null,
        operationalROI:   vExpenses > 0 ? Math.round((vNetProfit / vExpenses) * 10000) / 100 : null,
        bookingCount:     vBookingCount,
      };
    }

    // ── Supplemental: succeeded extra charges (damages, late fees, etc.) ──────
    // Charges already tracked in revenue_records (via stripe-webhook.js post-rental
    // fee handling) are excluded here to prevent double-counting revenue totals.
    // Skipped when the admin_metrics_v2 view already provided financial data
    // (viewOk && financialsFromRevRecords) because the view's charges_net CTE
    // already incorporates these supplemental charges.
    if (sb && (!viewOk || !financialsFromRevRecords)) {
      const bookingVehicleMap = {};
      for (const b of allBookings) {
        if (b.bookingId) bookingVehicleMap[b.bookingId] = b.vehicleId;
      }
      try {
        const { data: chargesData } = await sb
          .from("charges")
          .select("booking_id, amount, created_at, stripe_payment_intent_id")
          .eq("status", "succeeded");

        // Find which charge PIs are already in revenue_records to avoid double-counting.
        const chargePiIds = (chargesData || [])
          .map((c) => c.stripe_payment_intent_id)
          .filter(Boolean);
        let revenueTrackedPis = new Set();
        if (chargePiIds.length > 0) {
          try {
            const { data: rrRows } = await sb
              .from("revenue_records")
              .select("payment_intent_id")
              .in("payment_intent_id", chargePiIds);
            revenueTrackedPis = new Set((rrRows || []).map((r) => r.payment_intent_id).filter(Boolean));
          } catch (piLookupErr) {
            console.warn("v2-dashboard: charge PI dedup lookup failed (non-fatal):", piLookupErr.message);
          }
        }

        for (const charge of (chargesData || [])) {
          // Skip charges already recorded in revenue_records to avoid double-counting.
          if (charge.stripe_payment_intent_id && revenueTrackedPis.has(charge.stripe_payment_intent_id)) continue;
          const vid = bookingVehicleMap[charge.booking_id];
          if (!vid) continue;
          if (filteredVehicleIds.size > 0 && !filteredVehicleIds.has(vid)) continue;
          const amount = Number(charge.amount || 0);
          totalRevenue += amount;
          netRevenue   += amount;
          const monthKey = (charge.created_at || "").slice(0, 7);
          if (monthKey) monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + amount;
          if (vehicleStats[vid]) {
            vehicleStats[vid].revenue   = Math.round((vehicleStats[vid].revenue   + amount) * 100) / 100;
            vehicleStats[vid].netProfit = Math.round((vehicleStats[vid].netProfit + amount) * 100) / 100;
            const pp  = vehicleStats[vid].purchasePrice || 0;
            const exp = vehicleStats[vid].expenses      || 0;
            vehicleStats[vid].roi = pp > 0
              ? Math.round((vehicleStats[vid].netProfit / pp) * 10000) / 100
              : null;
            vehicleStats[vid].operationalROI = exp > 0
              ? Math.round((vehicleStats[vid].netProfit / exp) * 10000) / 100
              : null;
          }
        }
      } catch (chargesErr) {
        console.error("v2-dashboard: charges load error (non-fatal):", chargesErr.message);
      }
    }

    // Vehicles available: computed from the JS loop's activeOrOverdueBookings
    // so it stays consistent with the booking counts above.
    // Using v.vehicle_id (not v.id — vehicle objects don't have a plain `id` field).
    const vehicleList = Object.values(filteredVehicles);
    const unavailableVehicleIds = new Set(
      activeOrOverdueBookings
        .map((b) => b.vehicleId)
    );
    const availableVehicles = vehicleList.filter(
      (v) => v.status === "active" && !unavailableVehicleIds.has(v.vehicle_id)
    ).length;

    // ── Alerts ────────────────────────────────────────────────────────────────
    const alerts = [];
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Vehicles with at least one active or overdue rental right now.
    // We suppress the negative-profit alert for these: their partial/deposit
    // payments are not yet in revenue_records so the profit figure is
    // temporarily understated until the booking is fully settled.
    const vehiclesWithActiveRentals = new Set(activeOrOverdueBookings.map((b) => b.vehicleId));

    for (const [vehicleId, stats] of Object.entries(vehicleStats)) {
      if (stats.netProfit < 0 && !vehiclesWithActiveRentals.has(vehicleId)) {
        alerts.push({
          type:    "warning",
          message: `${stats.name} has negative net profit ($${stats.netProfit.toFixed(2)})`,
          vehicleId,
        });
      }
    }

    for (const booking of allBookings) {
      if (booking.status !== "cancelled_rental" && booking.pickupDate) {
        const pickup = new Date(booking.pickupDate);
        if (pickup >= now && pickup <= in7d) {
          alerts.push({
            type:      "info",
            message:   `Upcoming: ${booking.vehicleId} for ${booking.name} on ${booking.pickupDate}`,
            bookingId: booking.bookingId,
          });
        }
      }
    }

    if (pendingApprovals > 0) {
      alerts.unshift({
        type:    "action",
        message: `${pendingApprovals} booking${pendingApprovals > 1 ? "s" : ""} pending approval`,
      });
    }

    // Revenue chart: last 12 months sorted (gross revenue by month).
    // When viewOk, prefer the pre-computed JSONB from the view (already sorted ASC).
    // Fall back to a booking-based approximation when the view chart is empty
    // (common when revenue_records lack pickup_date for older/partially-paid records).
    const viewChart = viewOk ? (metricsView[`${vp}_revenue_chart`] || []) : [];
    let revenueChart;
    if (viewChart.length > 0) {
      revenueChart = viewChart;
    } else if (monthlyRevenue && Object.keys(monthlyRevenue).length > 0) {
      // Non-view path: monthlyRevenue was populated by the revenue_records loop.
      revenueChart = Object.entries(monthlyRevenue)
          .sort(([a], [b]) => (a > b ? 1 : -1))
          .slice(-12)
          .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));
    } else {
      // Booking-based fallback: uses allBookings deposit/total amounts per month.
      // Less precise than revenue_records but guarantees a non-empty chart.
      const chartStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
      const bookingMonthly = {};
      for (const b of allBookings) {
        if (!chartStatuses.has(b.status)) continue;
        const monthKey = (b.pickupDate || "").slice(0, 7);
        if (monthKey) bookingMonthly[monthKey] = (bookingMonthly[monthKey] || 0) + bookingRevenue(b);
      }
      revenueChart = Object.entries(bookingMonthly)
          .sort(([a], [b]) => (a > b ? 1 : -1))
          .slice(-12)
          .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }));
    }

    // Recent bookings (last 10 across all vehicles).
    // When the view is available, use the dedicated bookings query (pre-sorted, limit 20).
    // Otherwise slice from the full allBookings list.
    let recentBookings;
    if (viewOk && recentBkResult?.data) {
      // Build a per-booking revenue map from revenue_records so that active rentals
      // paid via Stripe (where deposit_paid on the bookings row is 0/null) show the
      // correct amount instead of $0.
      const recentRefs = recentBkResult.data.map((r) => r.booking_ref).filter(Boolean);
      const rrRecentMap = {};
      if (sb && recentRefs.length > 0) {
        try {
          const { data: rrRecent } = await sb
            .from("revenue_records_effective")
            .select("booking_id, gross_amount")
            .eq("payment_status", "paid")
            .in("booking_id", recentRefs);
          for (const rr of (rrRecent || [])) {
            if (rr.booking_id && rr.gross_amount != null) {
              rrRecentMap[rr.booking_id] = (rrRecentMap[rr.booking_id] || 0) + Number(rr.gross_amount);
            }
          }
        } catch (_) { /* non-fatal — fall back to deposit_paid */ }
      }

      recentBookings = recentBkResult.data.slice(0, 10).map((r) => ({
        bookingId:   r.booking_ref || "",
        name:        r.customers?.name || "",
        vehicleId:   uiVehicleId(r.vehicle_id),
        vehicleName: VEHICLE_NAMES[uiVehicleId(r.vehicle_id)] || r.vehicle_id,
        pickupDate:  r.pickup_date  || "",
        returnDate:  r.return_date  || "",
        status:      DB_TO_APP_STATUS[r.status] || r.status,
        amountPaid:  r.booking_ref && rrRecentMap[r.booking_ref] != null
          ? rrRecentMap[r.booking_ref]
          : Number(r.deposit_paid || 0),
        createdAt:   r.created_at,
      }));
    } else {
      recentBookings = [...allBookings]
        .filter((b) => b.createdAt)
        .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
        .slice(0, 10)
        .map((b) => ({
          bookingId:   b.bookingId,
          name:        b.name,
          vehicleId:   b.vehicleId,
          vehicleName: b.vehicleName,
          pickupDate:  b.pickupDate,
          returnDate:  b.returnDate,
          status:      b.status,
          amountPaid:  financialsFromRevRecords && b.bookingId != null && rrByBookingId[b.bookingId] != null
            ? rrByBookingId[b.bookingId]
            : bookingRevenue(b),
          createdAt:   b.createdAt,
        }));
    }

    // Net profit = net revenue − total expenses
    const netProfit = netRevenue - totalExpenses;
    // Operational ROI = profit / expenses * 100 (null when no expenses recorded)
    const operationalROI = totalExpenses > 0
      ? Math.round((netProfit / totalExpenses) * 10000) / 100
      : null;
    console.log("v2-dashboard: totalExpenses =", totalExpenses, "(count:", expenses.length, ")");

    // Override totalRevenue with the canonical total_revenue_kpi value when
    // available — same source used by the Revenue Tracker page KPI card.
    const kpiRevenue = kpiResult?.data?.total_revenue != null
      ? Number(kpiResult.data.total_revenue)
      : null;
    const finalTotalRevenue = kpiRevenue !== null
      ? Math.round(kpiRevenue * 100) / 100
      : Math.round(totalRevenue * 100) / 100;

    return res.status(200)
      .setHeader("Cache-Control", "no-store")
      .json({
        kpis: {
          totalRevenue:    finalTotalRevenue,
          totalExpenses:   Math.round(totalExpenses   * 100) / 100,
          netRevenue:      Math.round(netRevenue      * 100) / 100,
          netProfit:       Math.round(netProfit       * 100) / 100,
          totalStripeFees: Math.round(totalStripeFees * 100) / 100,
          operationalROI,
          reconciledCount,
          activeBookings,
          availableVehicles,
          pendingApprovals,
          overdueCount,
          returnsTodayCount,
          pickupsTodayCount,
        },
        revenueChart,
        bookingsPerVehicle,
        vehicleStats,
        alerts,
        recentBookings,
      });
  } catch (err) {
    console.error("v2-dashboard error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
