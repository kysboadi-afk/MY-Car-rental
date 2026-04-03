// api/_admin-actions.js
// Safe tool executor for the AI admin assistant.
// All tool calls from admin-chat.js are routed through here.
// This module owns validation, audit logging, and all business-logic calls.
// admin-chat.js has ZERO direct Supabase or data-layer access.
//
// Data-layer strategy:
//   Supabase (service role) is the PRIMARY source for analytics reads and
//   ALL writes (ai_logs, fraud flags, vehicle mutations).
//   loadBookings() / loadVehicles() helpers provide fallback when Supabase
//   is not configured or a table does not yet exist.

import { loadBookings } from "./_bookings.js";
import { loadVehicles, saveVehicles } from "./_vehicles.js";
import { computeAmount } from "./_pricing.js";
import { sendSms } from "./_textmagic.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { scoreAllBookings } from "../lib/ai/fraud.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { randomBytes } from "crypto";

// DB → app status mapping (mirrors v2-bookings.js)
const DB_TO_APP_STATUS = {
  pending:   "reserved_unpaid",
  approved:  "booked_paid",
  active:    "active_rental",
  completed: "completed_rental",
  cancelled: "cancelled_rental",
};

// ── Revenue helper (mirrors v2-dashboard) ────────────────────────────────────
function revenueFromBooking(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) return booking.amountPaid;
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    return computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate) || 0;
  }
  return 0;
}

// ── AI audit logging (ai_logs table) ────────────────────────────────────────
/**
 * Log an AI tool execution to the ai_logs table.
 * Falls back to admin_action_logs when ai_logs doesn't exist yet.
 *
 * @param {string} action   - tool name
 * @param {object} input    - sanitised args (no secrets)
 * @param {object} output   - tool result
 * @param {string} adminId  - identifier for the admin session ("admin" by default)
 */
export async function logAiAction(action, input, output, adminId = "admin") {
  const sb = getSupabaseAdmin();
  if (!sb) return; // non-fatal: skip when Supabase not configured

  // Try ai_logs first (0019 migration); fall back to admin_action_logs (0018)
  try {
    const { error } = await sb.from("ai_logs").insert({
      action,
      input:  input  || null,
      output: output || null,
      admin_id: adminId,
    });
    if (!error) return;
    // If ai_logs table doesn't exist yet, fall through to legacy table
    if (!error.message?.includes("relation") && !error.message?.includes("does not exist")) {
      console.warn("_admin-actions: ai_logs insert error:", error.message);
      return;
    }
  } catch {
    // ignore
  }

  // Legacy fallback
  try {
    await sb.from("admin_action_logs").insert({
      action_name: action,
      args:        input  || null,
      result:      output || null,
    });
  } catch (err) {
    console.warn("_admin-actions: audit log fallback failed:", err.message);
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

// Columns selected from the Supabase bookings table for AI queries.
// Keep in sync with DB schema (migration 0019 adds flagged + risk_score).
const BOOKING_COLUMNS =
  "id, booking_id, vehicle_id, customer_name, phone, email, pickup_date, return_date, status, amount_paid, total_price, created_at, flagged, risk_score";

// ── Supabase-first helpers ───────────────────────────────────────────────────

/**
 * Load all bookings as a flat array.
 * Tries Supabase bookings table first; falls back to bookings.json.
 */
async function loadAllBookings() {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb
        .from("bookings")
        .select(BOOKING_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(500);
      if (!error && data) {
        return data.map((row) => ({
          bookingId:  row.booking_id || String(row.id),
          name:       row.customer_name || "",
          phone:      row.phone || "",
          email:      row.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.amount_paid || row.total_price || 0,
          createdAt:  row.created_at || "",
          flagged:    row.flagged || false,
          risk_score: row.risk_score || 0,
          _dbId:      row.id,
        }));
      }
    } catch {
      // fall through
    }
  }
  // Fallback: GitHub JSON
  const { data: bookingsData } = await loadBookings();
  return Object.values(bookingsData).flat();
}

/**
 * Load vehicles as a { [vehicleId]: vehicleObj } map.
 * Tries Supabase vehicles table first; falls back to vehicles.json.
 */
async function loadAllVehicles() {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb
        .from("vehicles")
        .select("vehicle_id, data, rental_status, bouncie_device_id, last_synced_at, decision_status, action_status");
      if (!error && data) {
        const map = {};
        for (const row of data) {
          map[row.vehicle_id] = {
            vehicle_id:        row.vehicle_id,
            ...(row.data || {}),
            rental_status:     row.rental_status     || null,
            bouncie_device_id: row.bouncie_device_id || null,
            last_synced_at:    row.last_synced_at    || null,
            decision_status:   row.decision_status   || null,
            action_status:     row.action_status     || null,
          };
        }
        return map;
      }
    } catch {
      // fall through
    }
  }
  const { data: vehicles } = await loadVehicles();
  return vehicles;
}

/**
 * Get revenue for a period using the get_monthly_revenue SQL function when
 * available, otherwise fall back to summing booking records.
 */
async function getRevenueForMonth(month) {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.rpc("get_monthly_revenue", { month_input: month });
      if (!error && data !== null) return Number(data);
    } catch {
      // fall through
    }
  }
  // Fallback: compute from bookings
  const allBookings = await loadAllBookings();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
  return allBookings
    .filter((b) => paidStatuses.has(b.status) && (b.pickupDate || b.createdAt || "").startsWith(month))
    .reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
}

/**
 * Store fraud flags for a booking back to Supabase bookings table.
 * Non-fatal — failure is logged as a warning.
 */
async function storeFraudFlags(bookingId, flagged, riskScore) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    await sb
      .from("bookings")
      .update({ flagged, risk_score: riskScore })
      .eq("booking_id", bookingId);
  } catch (err) {
    console.warn("_admin-actions: storeFraudFlags failed:", err.message);
  }
}

// ── Vehicle writes: Supabase + JSON fallback ─────────────────────────────────

async function upsertVehicleToSupabase(vehicleId, vehicleData) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  try {
    await sb
      .from("vehicles")
      .upsert({ vehicle_id: vehicleId, data: vehicleData }, { onConflict: "vehicle_id" });
  } catch (err) {
    console.warn("_admin-actions: upsertVehicleToSupabase failed:", err.message);
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function toolGetRevenue({ month } = {}) {
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
  const allBookings  = await loadAllBookings();

  let filtered = allBookings.filter((b) => paidStatuses.has(b.status));
  if (month) {
    // Try Supabase RPC for total
    const sbTotal = await getRevenueForMonth(month);
    filtered = filtered.filter((b) => (b.pickupDate || b.createdAt || "").startsWith(month));

    // Per-vehicle breakdown from local data
    const byVehicle = {};
    for (const b of filtered) {
      const vid = b.vehicleId || "unknown";
      if (!byVehicle[vid]) byVehicle[vid] = { count: 0, revenue: 0 };
      byVehicle[vid].count   += 1;
      byVehicle[vid].revenue += b.amountPaid || revenueFromBooking(b);
    }
    for (const v of Object.values(byVehicle)) {
      v.revenue = Math.round(v.revenue * 100) / 100;
    }

    return {
      period:    month,
      total:     Math.round(sbTotal * 100) / 100,
      bookings:  filtered.length,
      byVehicle,
    };
  }

  const total = filtered.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
  const byVehicle = {};
  for (const b of filtered) {
    const vid = b.vehicleId || "unknown";
    if (!byVehicle[vid]) byVehicle[vid] = { count: 0, revenue: 0 };
    byVehicle[vid].count   += 1;
    byVehicle[vid].revenue += b.amountPaid || revenueFromBooking(b);
  }
  for (const v of Object.values(byVehicle)) {
    v.revenue = Math.round(v.revenue * 100) / 100;
  }

  return {
    period:    "all-time",
    total:     Math.round(total * 100) / 100,
    bookings:  filtered.length,
    byVehicle,
  };
}

async function toolGetBookings({ vehicleId, status, limit = 20 } = {}) {
  const safeLimit = Math.min(Number(limit) || 20, 100);
  const sb = getSupabaseAdmin();

  let results = [];
  let total   = 0;

  if (sb) {
    try {
      let query = sb
        .from("bookings")
        .select(BOOKING_COLUMNS, { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(safeLimit);

      if (vehicleId) query = query.eq("vehicle_id", vehicleId);

      // Map app status to DB status for filtering
      if (status) {
        const APP_TO_DB = {
          reserved_unpaid:  "pending",
          booked_paid:      "approved",
          active_rental:    "active",
          completed_rental: "completed",
          cancelled_rental: "cancelled",
        };
        const dbStatus = APP_TO_DB[status] || status;
        query = query.eq("status", dbStatus);
      }

      const { data, error, count } = await query;
      if (!error && data) {
        total   = count ?? data.length;
        results = data.map((row) => ({
          bookingId:  row.booking_id || String(row.id),
          name:       row.customer_name || "",
          phone:      row.phone || "",
          email:      row.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.amount_paid || row.total_price || 0,
          createdAt:  row.created_at || "",
          flagged:    row.flagged || false,
          risk_score: row.risk_score || 0,
        }));
        return { total, returned: results.length, bookings: results };
      }
    } catch {
      // fall through
    }
  }

  // Fallback: JSON files
  let all = await loadAllBookings();
  if (vehicleId) all = all.filter((b) => b.vehicleId === vehicleId);
  if (status)    all = all.filter((b) => b.status === status);
  all.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  total   = all.length;
  results = all.slice(0, safeLimit).map((b) => ({
    bookingId:  b.bookingId,
    name:       b.name,
    phone:      b.phone,
    email:      b.email,
    vehicleId:  b.vehicleId,
    pickupDate: b.pickupDate,
    returnDate: b.returnDate,
    status:     b.status,
    amountPaid: b.amountPaid || revenueFromBooking(b),
    createdAt:  b.createdAt,
  }));

  return { total, returned: results.length, bookings: results };
}

async function toolGetVehicles() {
  const sb = getSupabaseAdmin();
  const vehicles = await loadAllVehicles();
  const allBookings = await loadAllBookings();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  // Try to get booking counts from Supabase RPC
  let sbCounts = null;
  if (sb) {
    try {
      const { data, error } = await sb.rpc("get_vehicle_booking_counts");
      if (!error && data) {
        sbCounts = {};
        for (const row of data) sbCounts[row.vehicle_id] = Number(row.booking_count);
      }
    } catch {
      // fall through
    }
  }

  const result = Object.entries(vehicles).map(([vehicleId, v]) => {
    const vBookings  = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));
    const revenue    = vBookings.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
    const bookCount  = sbCounts ? (sbCounts[vehicleId] ?? vBookings.length) : vBookings.length;
    const vType      = v.type || v.vehicle_type || "";
    const isCar      = vType !== "slingshot";

    const entry = {
      vehicleId,
      name:             v.vehicle_name || vehicleId,
      type:             vType || "car",
      status:           v.status || "active",
      bouncie_device_id: v.bouncie_device_id || null,
      decision_status:  v.decision_status || null,
      action_status:    v.action_status    || null,
      totalBookings:    bookCount,
      totalRevenue:     Math.round(revenue * 100) / 100,
    };

    // Tracking warning: cars without a Bouncie device are not monitored
    if (isCar && !v.bouncie_device_id) {
      entry.tracking_warning = "⚠️ This vehicle is not tracked — no mileage or maintenance alerts";
    }

    return entry;
  });

  return { vehicles: result };
}

async function toolAddVehicle({ vehicleId, vehicleName, type, dailyRate }) {
  if (!vehicleName) throw new Error("vehicleName is required");

  const vehicles = await loadAllVehicles();

  if (!vehicleId) {
    // Auto-generate a slug from the vehicle name (max 45 chars to leave room for suffix)
    const base = vehicleName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45) || "vehicle";
    if (!vehicles[base]) {
      vehicleId = base;
    } else {
      // Append a guaranteed 4-char hex suffix using a cryptographically secure source
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let candidate;
      let attempts = 0;
      do {
        if (++attempts > 100) throw new Error(`Could not generate a unique vehicle ID from name "${vehicleName}"`);
        const suffix = randomBytes(3).toString("hex").slice(0, 4); // always 4 lowercase hex chars
        candidate = `${base}-${suffix}`;
      } while (vehicles[candidate]);
      vehicleId = candidate;
    }
  } else if (!/^[a-z0-9_-]{2,50}$/.test(vehicleId)) {
    throw new Error("vehicleId must be lowercase letters, digits, hyphens, or underscores (2–50 chars)");
  }

  if (vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" already exists`);

  const vehicleObj = {
    vehicle_id:   vehicleId,
    vehicle_name: String(vehicleName).slice(0, 200),
    type:         type || "other",
    status:       "active",
    daily_rate:   dailyRate ? Number(dailyRate) : undefined,
  };

  // Write to Supabase vehicles table
  const sb = getSupabaseAdmin();
  if (sb) {
    const { error } = await sb.from("vehicles").insert({
      vehicle_id: vehicleId,
      data: vehicleObj,
    });
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }
  }

  // Also update vehicles.json as fallback store
  const { data: jsonVehicles } = await loadVehicles();
  jsonVehicles[vehicleId] = vehicleObj;
  await saveVehicles(jsonVehicles);

  return { created: vehicleId, name: vehicleName };
}

async function toolUpdateVehicle({ vehicleId, updates = {} }) {
  if (!vehicleId) throw new Error("vehicleId is required");

  const vehicles = await loadAllVehicles();
  if (!vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" not found`);

  const allowed = ["vehicle_name", "status", "daily_rate", "price_per_day", "bouncie_device_id"];
  const sanitized = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) sanitized[key] = updates[key];
  }
  // price_per_day is an alias for daily_rate
  if (sanitized.price_per_day !== undefined && sanitized.daily_rate === undefined) {
    sanitized.daily_rate = sanitized.price_per_day;
  }
  delete sanitized.price_per_day;

  if (sanitized.status) {
    const validStatuses = ["active", "maintenance", "inactive"];
    if (!validStatuses.includes(sanitized.status)) {
      throw new Error(`Invalid status "${sanitized.status}". Must be one of: ${validStatuses.join(", ")}`);
    }
  }

  const updated = { ...vehicles[vehicleId], ...sanitized };

  // Write to Supabase — bouncie_device_id lives as a real column as well as in data JSONB
  const sb = getSupabaseAdmin();
  if (sb) {
    const colUpdates = { data: updated };
    if (sanitized.bouncie_device_id !== undefined) {
      colUpdates.bouncie_device_id = sanitized.bouncie_device_id || null;
    }
    const { error } = await sb
      .from("vehicles")
      .update(colUpdates)
      .eq("vehicle_id", vehicleId);
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }
  }

  // Also update vehicles.json
  const { data: jsonVehicles } = await loadVehicles();
  if (jsonVehicles[vehicleId]) {
    jsonVehicles[vehicleId] = { ...jsonVehicles[vehicleId], ...sanitized };
    await saveVehicles(jsonVehicles);
  }

  return { updated: vehicleId, applied: sanitized };
}

async function toolSendSms({ phone, message }) {
  if (!phone)   throw new Error("phone is required");
  if (!message) throw new Error("message is required");
  if (typeof message !== "string" || message.length > 1000) {
    throw new Error("message must be a string of 1–1000 characters");
  }

  const result = await sendSms(phone, message);
  return { sent: true, to: phone, id: result?.id };
}

async function toolGetInsights() {
  const sb = getSupabaseAdmin();
  const [allBookings, vehicles] = await Promise.all([
    loadAllBookings(),
    loadAllVehicles(),
  ]);

  // Fetch Bouncie mileage and recent trips so detectProblems can include
  // maintenance/idle alerts.  These use bouncie_device_id as source of truth —
  // rental_status is intentionally ignored when deciding what to track.
  let mileageData = [];
  let recentTrips = [];
  if (sb) {
    try {
      const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicles")
          .select("vehicle_id, mileage, last_synced_at, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
          .not("bouncie_device_id", "is", null),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);
      mileageData = (vehicleRows || [])
        .filter((r) => {
          const type = r.data?.type || r.data?.vehicle_type || "";
          return type !== "slingshot";
        })
        .map((r) => ({
          vehicle_id:               r.vehicle_id,
          vehicle_name:             r.data?.vehicle_name || r.vehicle_id,
          total_mileage:            Number(r.mileage) || 0,
          last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
          last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
          last_synced_at:           r.last_synced_at,
        }));
      recentTrips = (tripRows || []).map((r) => ({
        vehicle_id:    r.vehicle_id,
        trip_distance: r.trip_distance,
        trip_at:       r.trip_at,
      }));
    } catch {
      // mileage data unavailable — detectProblems will skip mileage section
    }
  }

  const insights = computeInsights({ allBookings, vehicles, revenueFromBooking });
  const problems = detectProblems({ allBookings, vehicles, revenueFromBooking, insights, mileageData, recentTrips });

  return { insights, problems };
}

async function toolGetMileage() {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return {
      tracked_vehicles:   0,
      stats:              [],
      alerts:             [],
      bouncie_configured: false,
      note:               "Database not configured — mileage tracking requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set in Vercel.",
    };
  }

  let vehicleRows = null;
  let tripRows    = [];
  try {
    const [vehicleResult, tripResult] = await Promise.all([
      sb.from("vehicles")
        .select("vehicle_id, mileage, last_synced_at, bouncie_device_id, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
        .not("bouncie_device_id", "is", null),
      sb.from("trip_log")
        .select("vehicle_id, trip_distance, trip_at")
        .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString())
        .catch(() => ({ data: [] })),
    ]);
    vehicleRows = vehicleResult.data;
    tripRows    = tripResult.data || [];
  } catch (err) {
    console.error("toolGetMileage: DB error:", err.message);
    return {
      tracked_vehicles:   0,
      stats:              [],
      alerts:             [],
      bouncie_configured: !!process.env.BOUNCIE_ACCESS_TOKEN,
      error:              adminErrorMessage(err),
    };
  }

  const mileageData = (vehicleRows || [])
    .filter((r) => {
      const type = r.data?.type || r.data?.vehicle_type || "";
      return type !== "slingshot";
    })
    .map((r) => ({
      vehicle_id:               r.vehicle_id,
      vehicle_name:             r.data?.vehicle_name || r.vehicle_id,
      total_mileage:            Number(r.mileage) || 0,
      last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
      last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
      last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
      last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
      bouncie_device_id:        r.bouncie_device_id,
      last_synced_at:           r.last_synced_at,
    }));

  const { alerts, stats } = analyzeMileage(mileageData, tripRows.map((r) => ({
    vehicle_id:    r.vehicle_id,
    trip_distance: r.trip_distance,
    trip_at:       r.trip_at,
  })));

  return {
    tracked_vehicles:   mileageData.length,
    stats,
    alerts,
    bouncie_configured: !!process.env.BOUNCIE_ACCESS_TOKEN,
  };
}

async function toolGetFraudReport({ flaggedOnly = true } = {}) {
  const allBookings = await loadAllBookings();
  let scored = scoreAllBookings(allBookings);

  // Persist risk scores to Supabase in the background (non-blocking)
  const flaggedItems = scored.filter((b) => b.flagged);
  Promise.all(
    flaggedItems.map((b) => storeFraudFlags(b.bookingId, b.flagged, b.risk_score))
  ).catch((err) => console.warn("_admin-actions: batch fraud persist failed:", err.message));

  if (flaggedOnly) scored = scored.filter((b) => b.flagged);
  scored.sort((a, b) => b.risk_score - a.risk_score);

  return {
    total:    allBookings.length,
    flagged:  flaggedItems.length,
    results:  scored.slice(0, 50),
  };
}

// Maps serviceType → DB column name and JSONB key (matches v2-mileage.js and migration 0022)
const MAINTENANCE_SERVICE_COLUMNS = {
  oil:    { col: "last_oil_change_mileage",   jsonKey: "last_oil_change_mileage" },
  brakes: { col: "last_brake_check_mileage",  jsonKey: "last_brake_check_mileage" },
  tires:  { col: "last_tire_change_mileage",  jsonKey: "last_tire_change_mileage" },
};

// Risk score assigned when an admin manually flags a booking
const ADMIN_FLAGGED_RISK_SCORE = 100;

async function toolFlagBooking({ bookingId, reason }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!reason)    throw new Error("reason is required");

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot flag booking");

  const { error } = await sb
    .from("bookings")
    .update({ flagged: true, risk_score: ADMIN_FLAGGED_RISK_SCORE })
    .eq("booking_id", bookingId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  return { success: true, bookingId, flagged: true, reason };
}

async function toolUpdateBookingStatus({ bookingId, status }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!status)    throw new Error("status is required");

  const APP_TO_DB_STATUS = {
    reserved_unpaid:  "pending",
    booked_paid:      "approved",
    active_rental:    "active",
    completed_rental: "completed",
    cancelled_rental: "cancelled",
  };
  const validStatuses = Object.keys(APP_TO_DB_STATUS);
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${validStatuses.join(", ")}`);
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot update booking status");

  const { error } = await sb
    .from("bookings")
    .update({ status: APP_TO_DB_STATUS[status] })
    .eq("booking_id", bookingId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  return { success: true, bookingId, status };
}

async function toolConfirmVehicleAction({ vehicleId, action }) {
  if (!vehicleId) throw new Error("vehicleId is required");
  if (!action)    throw new Error("action is required");

  const validActions = ["review_for_sale", "needs_attention"];
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action "${action}". Must be one of: ${validActions.join(", ")}`);
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot update vehicle action");

  const { error } = await sb
    .from("vehicles")
    .update({
      decision_status: action,
      action_status:   "pending",
      updated_at:      new Date().toISOString(),
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  const labels = { review_for_sale: "Review for sale", needs_attention: "Needs attention" };
  return {
    success:         true,
    vehicleId,
    decision_status: action,
    action_status:   "pending",
    message:         `${labels[action]} decision recorded for ${vehicleId}. Action status set to pending.`,
  };
}

async function toolSendMessageToDriver({ bookingId, message }) {
  if (!bookingId) throw new Error("bookingId is required");
  if (!message)   throw new Error("message is required");
  if (typeof message !== "string" || message.length > 1000) {
    throw new Error("message must be a string of 1–1000 characters");
  }

  const allBookings = await loadAllBookings();
  const booking = allBookings.find((b) => b.bookingId === bookingId);
  if (!booking)   throw new Error(`Booking "${bookingId}" not found`);
  if (!booking.phone) throw new Error(`Booking "${bookingId}" has no phone number on record`);

  const result = await sendSms(booking.phone, message);
  return { sent: true, bookingId, to: booking.phone, name: booking.name, id: result?.id };
}


async function toolMarkMaintenance({ vehicleId, serviceType }) {
  if (!vehicleId)   throw new Error("vehicleId is required");
  if (!serviceType) throw new Error("serviceType is required (oil | brakes | tires)");
  const mapping = MAINTENANCE_SERVICE_COLUMNS[serviceType];
  if (!mapping) throw new Error(`Invalid serviceType "${serviceType}". Must be one of: ${Object.keys(MAINTENANCE_SERVICE_COLUMNS).join(", ")}`);

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot record maintenance");

  // Look up the vehicle's current odometer and JSONB data
  const { data: row, error: fetchErr } = await sb
    .from("vehicles")
    .select("mileage, data")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
  if (!row)     throw new Error(`Vehicle "${vehicleId}" not found`);

  const serviceMileage = Number(row.mileage) || 0;
  const updatedData    = { ...(row.data || {}), [mapping.jsonKey]: serviceMileage };

  const { error } = await sb
    .from("vehicles")
    .update({
      [mapping.col]: serviceMileage,
      data:          updatedData,
      updated_at:    new Date().toISOString(),
    })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  // Log to maintenance_history (non-fatal)
  sb.from("maintenance_history")
    .insert({ vehicle_id: vehicleId, service_type: serviceType, mileage: serviceMileage })
    .then(() => {})
    .catch((err) => console.warn(`_admin-actions: maintenance_history insert failed:`, err.message));

  const labels = { oil: "Oil change", brakes: "Brake inspection", tires: "Tire change" };
  return {
    success:         true,
    vehicleId,
    serviceType,
    service_label:   labels[serviceType],
    service_mileage: serviceMileage,
    message:         `${labels[serviceType]} recorded at ${serviceMileage.toLocaleString()} mi for ${vehicleId}.`,
  };
}

// ── Destructive-action guard ──────────────────────────────────────────────────
// Tools that mutate data require the "confirmed" flag in their args.
const DESTRUCTIVE_TOOLS = new Set([
  "add_vehicle",
  "update_vehicle",
  "send_sms",
  "mark_maintenance",
  "flag_booking",
  "update_booking_status",
  "confirm_vehicle_action",
  "send_message_to_driver",
]);

// ── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute a named tool with the given args.
 * Logs the action to ai_logs (falls back to admin_action_logs).
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} [options]
 * @param {boolean} [options.requireConfirmation] - if true, reject destructive calls without args.confirmed
 * @param {string}  [options.adminId]             - identifier for the admin session
 * @returns {Promise<object>} Tool result
 */
export async function executeAction(toolName, args = {}, { requireConfirmation = true, adminId = "admin" } = {}) {
  // Guard: destructive ops need confirmation flag when requireConfirmation is enabled
  if (requireConfirmation && DESTRUCTIVE_TOOLS.has(toolName) && !args.confirmed) {
    const result = {
      requires_confirmation: true,
      message: `Action "${toolName}" requires confirmation. Ask the admin to confirm, then retry with confirmed:true.`,
    };
    await logAiAction(toolName, args, result, adminId);
    return result;
  }

  let result;
  try {
    switch (toolName) {
      case "get_revenue":              result = await toolGetRevenue(args);              break;
      case "get_bookings":             result = await toolGetBookings(args);             break;
      case "get_vehicles":             result = await toolGetVehicles();                 break;
      case "add_vehicle":              result = await toolAddVehicle(args);              break;
      case "update_vehicle":           result = await toolUpdateVehicle(args);           break;
      case "send_sms":                 result = await toolSendSms(args);                 break;
      case "get_insights":             result = await toolGetInsights();                 break;
      case "get_fraud_report":         result = await toolGetFraudReport(args);          break;
      case "get_mileage":              result = await toolGetMileage();                  break;
      case "mark_maintenance":         result = await toolMarkMaintenance(args);         break;
      case "flag_booking":             result = await toolFlagBooking(args);             break;
      case "update_booking_status":    result = await toolUpdateBookingStatus(args);     break;
      case "confirm_vehicle_action":   result = await toolConfirmVehicleAction(args);    break;
      case "send_message_to_driver":   result = await toolSendMessageToDriver(args);     break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (err) {
    const errorResult = { error: adminErrorMessage(err) };
    await logAiAction(toolName, args, errorResult, adminId);
    throw err;
  }

  await logAiAction(toolName, args, result, adminId);
  return result;
}
