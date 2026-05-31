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
import { withAdminAuth } from "./_middleware.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { isIncompleteCheckoutAppStatus, toAppBookingStatus } from "./_booking-status.js";
import { deriveBookingPaymentLifecycle } from "./_booking-payment-lifecycle.js";
import { listApplicationLifecycleSnapshot } from "./_renter-applications.js";
import { normalizeVehicleId, uiVehicleId } from "./_vehicle-id.js";

const VEHICLE_NAMES    = {
  camry:     "Camry 2012",
  camry2013: "Camry 2013 SE",
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

function roundTransitionMetric(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function logDashboardContractTransition(eventName, fields = {}, level = "info") {
  const logger = level === "warn" ? console.warn : console.info;
  logger("[v2-dashboard][contract-transition]", {
    event: eventName,
    ...fields,
  });
}

const OPERATOR_LEAD_PIPELINE_STATUSES = {
  new_lead: "newLeads",
  contacted: "contacted",
  demo_scheduled: "demoScheduled",
  onboarding: "qualified",
  active_operator: "converted",
  rejected: "closed",
};

export function buildOperatorLeadPipeline(rows = []) {
  const pipeline = {
    newLeads: 0,
    contacted: 0,
    demoScheduled: 0,
    qualified: 0,
    converted: 0,
    closed: 0,
    totalLeads: 0,
    conversionRate: 0,
  };
  const list = Array.isArray(rows) ? rows : [];
  list.forEach((row) => {
    const status = String(row?.status || "").trim().toLowerCase();
    const key = OPERATOR_LEAD_PIPELINE_STATUSES[status];
    if (!key) return;
    pipeline[key] += 1;
    pipeline.totalLeads += 1;
  });
  pipeline.conversionRate = pipeline.totalLeads > 0
    ? Math.round(((pipeline.converted / pipeline.totalLeads) * 100) * 10) / 10
    : 0;
  return pipeline;
}

export function buildContractTransitionKpiMismatches(input = {}) {
  const tolerance = Number.isFinite(Number(input.tolerance)) ? Number(input.tolerance) : 0.01;
  const mismatches = [];
  const appendMismatch = (metric, canonicalValue, legacyValue, meta = {}) => {
    const canonical = roundTransitionMetric(canonicalValue);
    const legacy = roundTransitionMetric(legacyValue);
    if (canonical == null || legacy == null) return;
    const diff = roundTransitionMetric(Math.abs(canonical - legacy));
    if (diff != null && diff > tolerance) {
      mismatches.push({
        metric,
        canonical,
        legacy,
        diff,
        ...meta,
      });
    }
  };

  appendMismatch("available_vehicles", input.viewAvailableVehicles, input.jsAvailableVehicles, {
    canonicalSource: "admin_metrics_v2",
    legacySource: "js_booking_loop",
  });
  appendMismatch("total_revenue", input.canonicalTotalRevenue, input.aggregatedTotalRevenue, {
    canonicalSource: input.canonicalTotalRevenueSource || "total_revenue_kpi_canonical",
    legacySource: input.aggregatedTotalRevenueSource || "revenue_aggregation_loop",
  });
  return mismatches;
}

function mergeTransitionFrequencyRows(rows = []) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = String(row?.key || "").trim();
    if (!key) return;
    const current = counts.get(key) || {
      key,
      label: row?.label || key,
      count: 0,
      module: row?.module || "",
      page: row?.page || "",
      fallback: row?.fallback || null,
      source: row?.source || null,
    };
    current.count += Number(row?.count || 0) || 0;
    counts.set(key, current);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function buildManageBookingTransitionSummary(bookings = []) {
  const rows = Array.isArray(bookings) ? bookings : [];
  const fallbackPathRows = [];
  const lifecycleMismatches = [];
  const financialSnapshotDiffs = [];
  let syntheticEvents = 0;
  let canonicalEvents = 0;

  rows.forEach((booking) => {
    const bookingId = booking?.bookingId || booking?.booking_ref || booking?.id || "";
    const total = roundTransitionMetric(booking?.totalPrice ?? booking?.total_price) || 0;
    const paid = roundTransitionMetric(booking?.amountPaid ?? booking?.depositPaid ?? booking?.deposit_paid) || 0;
    const rawBalance = Math.max(0, roundTransitionMetric(booking?.balanceDue ?? booking?.remainingBalance ?? booking?.remaining_balance) || 0);
    const canonicalBalance = rawBalance === 0 && total > 0 && paid < total
      ? Math.max(0, roundTransitionMetric(total - paid) || 0)
      : rawBalance;

    const canonicalLifecycle = deriveBookingPaymentLifecycle({
      status: booking?.status,
      paymentStatus: booking?.paymentStatus ?? booking?.payment_status,
      category: booking?.category,
      totalAmount: total,
      amountPaid: paid,
      remainingBalance: canonicalBalance,
      paymentPlan: booking?.paymentPlan || null,
    });
    const legacyLifecycle = deriveBookingPaymentLifecycle({
      status: booking?.status,
      paymentStatus: booking?.paymentStatus ?? booking?.payment_status,
      category: booking?.category,
      totalAmount: total,
      amountPaid: paid,
      remainingBalance: rawBalance,
      paymentPlan: booking?.paymentPlan || null,
    });

    const diffs = {};
    if (Math.abs(canonicalBalance - rawBalance) > 0.01) {
      diffs.balance = { canonical: canonicalBalance, legacy: rawBalance };
      fallbackPathRows.push({
        key: "remaining_balance_total_minus_paid",
        label: "remaining_balance_total_minus_paid",
        count: 1,
        module: "manage-booking",
        page: "Manage Booking",
        source: "effectiveBalanceDue",
      });
    }
    if (Object.keys(diffs).length > 0) {
      financialSnapshotDiffs.push({
        bookingId,
        diffs,
      });
    }
    if (
      canonicalLifecycle.lifecycleState !== legacyLifecycle.lifecycleState
      || canonicalLifecycle.canPayRemainingOnline !== legacyLifecycle.canPayRemainingOnline
    ) {
      lifecycleMismatches.push({
        bookingId,
        canonical: {
          lifecycleState: canonicalLifecycle.lifecycleState,
          canPayRemainingOnline: canonicalLifecycle.canPayRemainingOnline,
        },
        legacy: {
          lifecycleState: legacyLifecycle.lifecycleState,
          canPayRemainingOnline: legacyLifecycle.canPayRemainingOnline,
        },
      });
    }

    if (Object.keys(diffs).length > 0 || lifecycleMismatches.some((item) => item.bookingId === bookingId)) {
      syntheticEvents += 1;
    } else {
      canonicalEvents += 1;
    }
  });

  const sampleCount = rows.length;
  const impactedBookingIds = new Set([
    ...financialSnapshotDiffs.map((row) => row.bookingId),
    ...lifecycleMismatches.map((row) => row.bookingId),
  ]);
  const adoptedCount = Math.max(0, sampleCount - impactedBookingIds.size);
  const adoptionPercent = sampleCount > 0
    ? Math.round((adoptedCount / sampleCount) * 100)
    : 100;

  return {
    sampleCount,
    adoptedCount,
    adoptionPercent,
    lifecycleMismatchCount: lifecycleMismatches.length,
    financialSnapshotDiffCount: financialSnapshotDiffs.length,
    fallbackPathUsage: mergeTransitionFrequencyRows(fallbackPathRows),
    legacyDerivedSurfaces: sampleCount > 0 ? [{
      key: "manage_booking_dashboard",
      label: "Manage Booking dashboard",
      count: sampleCount,
      module: "manage-booking",
      page: "Manage Booking",
    }] : [],
    eventUsage: {
      synthetic: syntheticEvents,
      canonical: canonicalEvents,
    },
    samples: {
      lifecycleMismatches: lifecycleMismatches.slice(0, 5),
      financialSnapshotDiffs: financialSnapshotDiffs.slice(0, 5),
    },
  };
}

export function buildContractTransitionObservabilitySummary(input = {}) {
  const manageBooking = input.manageBooking || buildManageBookingTransitionSummary(input.manageBookingBookings || []);
  const dashboardFallbackPathRows = (Array.isArray(input.dashboardFallbackPaths) ? input.dashboardFallbackPaths : [])
    .map((row) => ({
      key: String(row?.path || "").trim(),
      label: String(row?.path || "").trim(),
      count: 1,
      module: "dashboard",
      page: "Dashboard",
      fallback: row?.fallback || null,
      source: row?.reason || null,
    }))
    .filter((row) => row.key);
  const dashboardFallbackUsage = mergeTransitionFrequencyRows(dashboardFallbackPathRows);
  const dashboardLegacyDerivedSurfaces = [];
  if (input.dashboardUsesLegacyBookingLoop) {
    dashboardLegacyDerivedSurfaces.push({
      key: "v2_dashboard_booking_count_loop",
      label: "Dashboard booking count loop",
      count: 1,
      module: "dashboard",
      page: "Dashboard",
    });
  }
  if (input.dashboardFinancialSource && input.dashboardFinancialSource !== "revenue_reporting_canonical") {
    dashboardLegacyDerivedSurfaces.push({
      key: "v2_dashboard_financial_kpis",
      label: "Dashboard financial KPIs",
      count: 1,
      module: "dashboard",
      page: "Dashboard",
    });
  }
  const dashboardKpiMismatches = Array.isArray(input.kpiMismatches) ? input.kpiMismatches : [];
  const dashboardSyntheticEvents = dashboardFallbackPathRows.length + dashboardKpiMismatches.length;
  const dashboardCanonicalEvents = dashboardSyntheticEvents === 0 ? 1 : 0;
  const dashboardChecks = [
    dashboardKpiMismatches.length === 0,
    dashboardFallbackPathRows.length === 0,
    dashboardLegacyDerivedSurfaces.length === 0,
  ];
  const dashboardAdoptedChecks = dashboardChecks.filter(Boolean).length;
  const dashboardAdoptionPercent = Math.round((dashboardAdoptedChecks / dashboardChecks.length) * 100);
  const moduleProgress = [
    {
      module: "dashboard",
      page: "Dashboard",
      adopted: dashboardAdoptedChecks,
      total: dashboardChecks.length,
      adoptionPercent: dashboardAdoptionPercent,
      legacyDependencyCount: dashboardLegacyDerivedSurfaces.length,
    },
    {
      module: "manage-booking",
      page: "Manage Booking",
      adopted: manageBooking.adoptedCount,
      total: manageBooking.sampleCount,
      adoptionPercent: manageBooking.adoptionPercent,
      legacyDependencyCount: manageBooking.legacyDerivedSurfaces.length,
    },
  ];
  const fallbackPathUsage = mergeTransitionFrequencyRows([
    ...dashboardFallbackPathRows,
    ...(manageBooking.fallbackPathUsage || []),
  ]);
  const legacyDerivedSurfaces = mergeTransitionFrequencyRows([
    ...dashboardLegacyDerivedSurfaces,
    ...(manageBooking.legacyDerivedSurfaces || []),
  ]);
  const totalSignals = moduleProgress.reduce((sum, item) => sum + Math.max(0, Number(item.total || 0)), 0);
  const adoptedSignals = moduleProgress.reduce((sum, item) => sum + Math.max(0, Number(item.adopted || 0)), 0);
  const adoptionPercent = totalSignals > 0 ? Math.round((adoptedSignals / totalSignals) * 100) : 100;
  const syntheticEventCount = dashboardSyntheticEvents + Number(manageBooking.eventUsage?.synthetic || 0);
  const canonicalEventCount = dashboardCanonicalEvents + Number(manageBooking.eventUsage?.canonical || 0);

  return {
    summary: {
      adoptionPercent,
      adoptedSignals,
      totalSignals,
      sampleBookings: manageBooking.sampleCount,
      openIssues:
        Number(manageBooking.lifecycleMismatchCount || 0)
        + Number(manageBooking.financialSnapshotDiffCount || 0)
        + dashboardKpiMismatches.length,
      fallbackEvents: fallbackPathUsage.reduce((sum, row) => sum + Number(row.count || 0), 0),
      remainingLegacySurfaces: legacyDerivedSurfaces.length,
    },
    counts: {
      lifecycleMismatches: Number(manageBooking.lifecycleMismatchCount || 0),
      financialSnapshotDiffs: Number(manageBooking.financialSnapshotDiffCount || 0),
      kpiAggregationMismatches: dashboardKpiMismatches.length,
    },
    eventUsage: {
      synthetic: syntheticEventCount,
      canonical: canonicalEventCount,
    },
    fallbackPathUsage: fallbackPathUsage.slice(0, 8),
    legacyDerivedSurfaces: legacyDerivedSurfaces.slice(0, 8),
    moduleProgress,
    highlights: {
      lifecycleMismatches: manageBooking.samples?.lifecycleMismatches || [],
      financialSnapshotDiffs: manageBooking.samples?.financialSnapshotDiffs || [],
      kpiAggregationMismatches: dashboardKpiMismatches.slice(0, 5),
    },
  };
}

export default withAdminAuth(async function handler(req, res) {
  const { scope } = req.body || {};

  try {
    const sb = getSupabaseAdmin();
    let bookingKpiSource = sb ? "supabase_bookings" : "bookings_json";
    let financialSource = "uninitialized";
    const dashboardFallbackPaths = [];
    const trackDashboardFallback = (details = {}) => {
      const row = {
        path: String(details?.path || "").trim(),
        fallback: details?.fallback || null,
        reason: details?.reason || null,
      };
      if (row.path) dashboardFallbackPaths.push(row);
      logDashboardContractTransition("fallback_path_used", details);
    };

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
              deposit_paid, remaining_balance, total_price, payment_status, category, created_at,
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
            status:      toAppBookingStatus(r.status),
            pickupDate:  r.pickup_date  || "",
            returnDate:  r.return_date  || "",
            returnTime:  r.return_time  || "",
            amountPaid:  Number(r.deposit_paid || 0),
            totalPrice:  Number(r.total_price || 0),
            remainingBalance: Number(r.remaining_balance || 0),
            paymentStatus: r.payment_status || "",
            category: r.category || "",
            createdAt:   r.created_at,
          }));
        } catch (err) {
          if (isNetworkError(err)) {
           bookingKpiSource = "bookings_json_network_fallback";
           trackDashboardFallback({
             path: "bookings_kpis",
             fallback: "bookings_json",
             reason: "supabase_network_error",
           });
            console.error("[FALLBACK] Supabase unreachable in v2-dashboard, using bookings.json:", err.message);
            const { data } = await loadBookings();
            return Object.values(data).flat();
          }
          throw err; // non-network Supabase errors propagate
        }
      }
      // Supabase not configured — use bookings.json directly
      bookingKpiSource = "bookings_json";
      trackDashboardFallback({
        path: "bookings_kpis",
        fallback: "bookings_json",
        reason: "supabase_unconfigured",
      });
      const { data } = await loadBookings();
      return Object.values(data).flat();
    }

    const metricsPromise = sb
      ? sb.from("admin_metrics_v2").select("*").single()
          .then((r) => r, (e) => {
            trackDashboardFallback({
              path: "admin_metrics_v2",
              fallback: "runtime_aggregations",
              reason: e?.message || "query_failed",
            });
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

    const normalizedScope = (scope === "car" || scope === "cars")
      ? scope
      : null;

    // Canonical ledger-based KPI — only for unscoped dashboard totals.
    // Scoped dashboards must keep their scoped totalRevenue to avoid cross-fleet mixing.
    const kpiPromise = sb && !normalizedScope
      ? sb.from("total_revenue_kpi_canonical").select("total_revenue").single()
          .then((r) => r, (e) => {
            trackDashboardFallback({
              path: "total_revenue_kpi_canonical",
              fallback: "revenue_aggregation_loop",
              reason: e?.message || "query_failed",
            });
            console.warn("v2-dashboard: total_revenue_kpi_canonical query failed (non-fatal):", e?.message);
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

    // ── Self-heal: deactivate Supabase vehicle rows absent from vehicles.json ──────
    // Phantom rows (e.g. legacy "camry2012" left over from old migrations, or
    // admin-UI vehicles whose GitHub save failed) inflate
    // admin_metrics_v2's available-vehicles count.  Silently mark them inactive so
    // the DB stays consistent with vehicles.json — the canonical vehicle source.
    if (sb) {
      try {
        const canonicalIds = new Set(Object.keys(vehicles));
        const { data: sbRows, error: sbRowsErr } = await sb.from("vehicles").select("vehicle_id, data");
        if (sbRowsErr) throw sbRowsErr;
        const deactivations = [];
        for (const row of (sbRows || [])) {
          if (canonicalIds.has(row.vehicle_id)) continue; // canonical — keep
          if (row.data?.status === "inactive")  continue; // already deactivated
          const newData = { ...(row.data || {}), status: "inactive" };
          deactivations.push(
            sb.from("vehicles")
              .update({ data: newData })
              .eq("vehicle_id", row.vehicle_id)
              .then(() => console.log(`v2-dashboard: deactivated phantom vehicle "${row.vehicle_id}"`))
              .catch((e) => console.warn(`v2-dashboard: could not deactivate "${row.vehicle_id}":`, e?.message))
          );
        }
        if (deactivations.length > 0) await Promise.all(deactivations);
      } catch (healErr) {
        console.warn("v2-dashboard: phantom vehicle self-heal skipped:", healErr?.message);
      }
    }

    // admin_metrics_v2: pre-aggregated dashboard KPIs.
    // When available it replaces the sequential revenue_records and charges queries.
    const metricsView = metricsViewResult?.data ?? null;
    const viewOk = !!metricsView && !metricsViewResult?.error;

    // Scope prefix selects the right pre-aggregated column set:
    //   "car"/"cars" → car_ prefix
    //   (none)        → total_ prefix
    const vp = (scope === "car" || scope === "cars") ? "car" : "total";

    // Filter vehicles by scope: "car" → car-type vehicles; none → all
    const DASHBOARD_CAR_TYPES = new Set(["car", "economy", "luxury", "suv", "truck", "van"]);
    const filteredVehicleEntries = Object.entries(vehicles).filter(([, v]) => {
      const type = (v.type || "").toLowerCase();
      if (scope === "car" || scope === "cars") return DASHBOARD_CAR_TYPES.has(type) || type === "";
      return true;
    });
    const filteredVehicles   = Object.fromEntries(filteredVehicleEntries);
    const filteredVehicleIds = new Set(Object.keys(filteredVehicles));

    // All bookings limited to scoped vehicles (used for non-financial KPIs)
    const allBookings = allBookingsRaw
      .filter((b) => filteredVehicleIds.size === 0 || filteredVehicleIds.has(b.vehicleId))
      .filter((b) => !isIncompleteCheckoutAppStatus(b.status));

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
    let incompleteCheckouts = 0;
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
    logDashboardContractTransition("legacy_derivation_surface_used", {
      surface: "v2_dashboard_booking_count_loop",
      source: bookingKpiSource,
      scope: vp,
    });

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

    // Financial totals prefer the canonical reporting layer below
    // (revenue_reporting_canonical) so Dashboard/Revenue/Fleet use identical
    // inclusion rules. When canonical data is unavailable, we fall back to
    // bookings-derived totals as a best-effort continuity path.

    // Run the direct canonical revenue loop when:
    //   a) the admin_metrics_v2 view is unavailable (!viewOk), OR
    //   b) the view is available but returned no financial data — this happens when
    //      revenue_reporting_base is empty (e.g. all paid records have is_orphan=true),
    //      which would otherwise cause the dashboard to fall back to booking deposits.
    if (sb && (!viewOk || !financialsFromRevRecords)) {
      try {
        const { data: rrRows, error: rrErr } = await sb
          .from("revenue_reporting_canonical")
          .select("booking_id, vehicle_id, pickup_date, gross_amount, stripe_fee, refund_amount");

        if (rrErr) {
          const logFn = isSchemaError(rrErr) ? console.warn : console.error;
          trackDashboardFallback({
            path: "revenue_reporting_canonical",
            fallback: "revenue_records_effective_or_bookings",
            reason: rrErr.message,
          });
          logFn("v2-dashboard: canonical revenue records unavailable, falling back to bookings.json:", rrErr.message,
            isSchemaError(rrErr) ? "(migration 0142 not yet applied)" : "");
        } else if ((rrRows || []).length > 0) {
          financialsFromRevRecords = true;
          financialSource = "revenue_reporting_canonical";
          for (const r of rrRows) {
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
        // If rrRows is empty (no paid records yet) we fall through to the orphan fallback.
      } catch (rrEx) {
        trackDashboardFallback({
          path: "revenue_reporting_canonical",
          fallback: "revenue_records_effective_or_bookings",
          reason: rrEx.message,
        });
        console.warn("v2-dashboard: canonical revenue records unavailable, falling back to bookings.json:", rrEx.message);
      }
    }

    // Orphan fallback: revenue_reporting_canonical excludes records with is_orphan=true.
    // When ALL paid records are orphans (e.g. Stripe-synced charges not yet re-linked to
    // bookings), the canonical loop above returns 0 rows and financialsFromRevRecords stays
    // false.  Before falling back to inaccurate booking deposits, try revenue_records_effective
    // which applies the same paid/cancelled/no_show filters but does NOT exclude orphans.
    if (sb && !financialsFromRevRecords) {
      try {
        const { data: rreRows, error: rreErr } = await sb
          .from("revenue_records_effective")
          .select("booking_id, vehicle_id, pickup_date, gross_amount, stripe_fee, refund_amount, is_cancelled, is_no_show")
          .eq("payment_status", "paid");
        if (!rreErr && (rreRows || []).length > 0) {
          financialsFromRevRecords = true;
          financialSource = "revenue_records_effective";
          trackDashboardFallback({
            path: "revenue_reporting_canonical",
            fallback: "revenue_records_effective",
            reason: "canonical_rows_empty_or_orphaned",
          });
          for (const r of rreRows) {
            if (r.is_cancelled || r.is_no_show) continue;
            const vid      = uiVehicleId(r.vehicle_id) || "unknown";
            if (filteredVehicleIds.size > 0 && !filteredVehicleIds.has(vid)) continue;
            const grossRaw = Number(r.gross_amount || 0);
            const gross    = Number.isFinite(grossRaw) ? grossRaw : 0;
            const fee      = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
            const refund   = Number(r.refund_amount || 0);
            const net      = gross - fee - refund;
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
      } catch (rreEx) {
        console.warn("v2-dashboard: revenue_records_effective orphan fallback failed:", rreEx.message);
      }
    }

    // Last-resort fallback: compute from bookings.json when Supabase is unavailable.
    // Mirrors the same fallback used by api/v2-revenue.js.
    if (!financialsFromRevRecords) {
      financialSource = "bookings_derived_financials";
      trackDashboardFallback({
        path: "financial_kpis",
        fallback: "bookings_derived_financials",
        reason: "canonical_reporting_unavailable",
      });
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

    // Supplemental charges are intentionally excluded from canonical revenue KPIs.

    // Vehicles available: JS fallback — counts active vehicles from vehicles.json
    // that have no active/overdue booking in the current loop.
    // Using v.vehicle_id (not v.id — vehicle objects don't have a plain `id` field).
    const vehicleList = Object.values(filteredVehicles);
    const unavailableVehicleIds = new Set(
      activeOrOverdueBookings
        .map((b) => b.vehicleId)
    );
    let availableVehicles = vehicleList.filter(
      (v) => v.status === "active" && !unavailableVehicleIds.has(v.vehicle_id)
    ).length;
    const jsAvailableVehicles = availableVehicles;

    // When the admin_metrics_v2 view is healthy, prefer its pre-aggregated count
    // over the JS calculation above.  The view's avail CTE queries the Supabase
    // vehicles table directly (excluding phantom/inactive rows) and applies the
    // same active/overdue status filter as the bookings table — making it the
    // authoritative source.  The JS calculation stays as fallback when viewOk is false.
    if (viewOk) {
      const viewAvail = metricsView[`${vp}_available_vehicles`];
      if (viewAvail != null) {
        availableVehicles = Number(viewAvail);
      }
    }

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
      if (!isIncompleteCheckoutAppStatus(booking.status) && booking.status !== "cancelled_rental" && booking.pickupDate) {
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

    if (incompleteCheckouts > 0) {
      alerts.unshift({
        type:    "warning",
        message: `${incompleteCheckouts} incomplete checkout attempt${incompleteCheckouts > 1 ? "s" : ""} need review`,
      });
    }

    if (pendingApprovals > 0) {
      alerts.unshift({
        type:    "action",
        message: `${pendingApprovals} unpaid reservation${pendingApprovals > 1 ? "s" : ""} pending approval`,
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
      // Filter by scope so the dashboard only shows bookings for the selected fleet.
      // reflects the scope-based vehicle set computed above.
      const scopedRecentData = filteredVehicleIds.size > 0
        ? recentBkResult.data.filter((r) => filteredVehicleIds.has(uiVehicleId(r.vehicle_id)))
        : recentBkResult.data;

      // Build a per-booking revenue map from revenue_records so that active rentals
      // paid via Stripe (where deposit_paid on the bookings row is 0/null) show the
      // correct amount instead of $0.
      const recentRefs = scopedRecentData.map((r) => r.booking_ref).filter(Boolean);
      const rrRecentMap = {};
      if (sb && recentRefs.length > 0) {
        try {
          const { data: rrRecent } = await sb
              .from("revenue_reporting_canonical")
              .select("booking_id, gross_amount")
              .in("booking_id", recentRefs);
          for (const rr of (rrRecent || [])) {
            if (rr.booking_id && rr.gross_amount != null) {
              rrRecentMap[rr.booking_id] = (rrRecentMap[rr.booking_id] || 0) + Number(rr.gross_amount);
            }
          }
        } catch (_) { /* non-fatal — fall back to deposit_paid */ }
      }

      recentBookings = scopedRecentData.slice(0, 10).map((r) => ({
        bookingId:   r.booking_ref || "",
        name:        r.customers?.name || "",
        vehicleId:   uiVehicleId(r.vehicle_id),
        vehicleName: VEHICLE_NAMES[uiVehicleId(r.vehicle_id)] || r.vehicle_id,
        pickupDate:  r.pickup_date  || "",
        returnDate:  r.return_date  || "",
        status:      toAppBookingStatus(r.status),
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
    const kpiMismatches = buildContractTransitionKpiMismatches({
      viewAvailableVehicles: viewOk ? metricsView[`${vp}_available_vehicles`] : null,
      jsAvailableVehicles,
      canonicalTotalRevenue: kpiRevenue,
      aggregatedTotalRevenue: totalRevenue,
      aggregatedTotalRevenueSource: financialSource,
    });
    kpiMismatches.forEach((mismatch) => {
      logDashboardContractTransition("kpi_aggregation_mismatch", {
        scope: vp,
        ...mismatch,
      }, "warn");
    });
    const finalTotalRevenue = kpiRevenue !== null
      ? Math.round(kpiRevenue * 100) / 100
      : Math.round(totalRevenue * 100) / 100;

    const applicationSnapshot = await listApplicationLifecycleSnapshot();
    const applicationSummary = applicationSnapshot.ok
      ? applicationSnapshot.summary
      : null;
    if (!applicationSnapshot.ok && applicationSnapshot.details) {
      console.error("v2-dashboard applications:", applicationSnapshot.details);
    }
    let leadPipeline = buildOperatorLeadPipeline();
    if (sb) {
      try {
        const { data: leadRows, error: leadError } = await sb
          .from("operator_leads")
          .select("status")
          .limit(5000);
        if (leadError) {
          console.error("v2-dashboard operator leads:", leadError.message || leadError);
        } else {
          leadPipeline = buildOperatorLeadPipeline(leadRows);
        }
      } catch (err) {
        console.error("v2-dashboard operator leads:", err?.message || err);
      }
    }

    const contractTransitionObservability = buildContractTransitionObservabilitySummary({
      dashboardFallbackPaths,
      dashboardUsesLegacyBookingLoop: true,
      dashboardFinancialSource: financialSource,
      kpiMismatches,
      manageBookingBookings: allBookings,
    });

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
          incompleteCheckouts,
          pendingApprovals,
          overdueCount,
          returnsTodayCount,
          pickupsTodayCount,
          newApplications: applicationSummary?.newApplications || 0,
          leadConversionRate: leadPipeline.conversionRate,
        },
        leadPipeline,
        revenueChart,
        bookingsPerVehicle,
        vehicleStats,
        alerts,
        recentBookings,
        applicationOps: applicationSummary,
        contractTransitionObservability,
      });
  } catch (err) {
    console.error("v2-dashboard error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
});
