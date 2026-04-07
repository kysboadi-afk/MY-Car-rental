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
import { loadExpenses } from "./_expenses.js";
import { computeAmount, computeRentalDays, PROTECTION_PLAN_BASIC, PROTECTION_PLAN_STANDARD, PROTECTION_PLAN_PREMIUM } from "./_pricing.js";
import {
  loadPricingSettings,
  computeBreakdownLinesFromSettings,
  computeSlingshotAmountFromSettings,
  applyTax,
} from "./_settings.js";
import { sendSms } from "./_textmagic.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { scoreAllBookings } from "../lib/ai/fraud.js";
import { analyzeMileage } from "../lib/ai/mileage.js";
import { computeFleetAlerts } from "../lib/ai/maintenance.js";
import { computeVehiclePriority, sortByPriority, hasNoOverdueMaintenance, ACTION_STATUS_ORDER } from "../lib/ai/priority.js";
import { TEMPLATES } from "./_sms-templates.js";
import { fetchBookedDates } from "./_availability.js";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";

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
  "id, booking_ref, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, deposit_paid, total_price, payment_intent_id, created_at, flagged, risk_score, customers(name, phone, email)";

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
          bookingId:  row.booking_ref || String(row.id),
          name:       row.customers?.name  || "",
          phone:      row.customers?.phone || "",
          email:      row.customers?.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.deposit_paid || row.total_price || 0,
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
        .select("vehicle_id, data, rental_status, bouncie_device_id, last_synced_at, decision_status, action_status, mileage, maintenance_interval, is_tracked, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage");
      if (!error && data) {
        const map = {};
        for (const row of data) {
          map[row.vehicle_id] = {
            vehicle_id:                row.vehicle_id,
            ...(row.data || {}),
            rental_status:             row.rental_status              || null,
            bouncie_device_id:         row.bouncie_device_id          || null,
            last_synced_at:            row.last_synced_at             || null,
            decision_status:           row.decision_status            || null,
            action_status:             row.action_status              || null,
            mileage:                   row.mileage                    ?? null,
            maintenance_interval:      row.maintenance_interval       ?? 5000,
            is_tracked:                row.is_tracked                 ?? false,
            last_oil_change_mileage:   row.last_oil_change_mileage    ?? null,
            last_brake_check_mileage:  row.last_brake_check_mileage   ?? null,
            last_tire_change_mileage:  row.last_tire_change_mileage   ?? null,
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
      .eq("booking_ref", bookingId);
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

async function toolGetBookings({ vehicleId, status, search, limit = 20 } = {}) {
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

      if (search) {
        // Strip characters that have special meaning in PostgREST filter strings
        // to prevent filter injection via the .or() expression.
        const safeSearch = search.replace(/[,()'"\\]/g, "");
        // PostgREST does not support filtering on embedded (joined) table columns
        // inside .or() — restrict to booking_ref only.  Customer name/phone/email
        // searches fall through to the GitHub JSON fallback which handles them fine.
        query = query.or(`booking_ref.ilike.%${safeSearch}%`);
      }

      const { data, error, count } = await query;
      if (!error && data) {
        total   = count ?? data.length;
        results = data.map((row) => ({
          bookingId:  row.booking_ref || String(row.id),
          name:       row.customers?.name  || "",
          phone:      row.customers?.phone || "",
          email:      row.customers?.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.deposit_paid || row.total_price || 0,
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
  if (search) {
    const q = search.toLowerCase();
    all = all.filter((b) =>
      (b.name || "").toLowerCase().includes(q) ||
      (b.phone || "").includes(q) ||
      (b.email || "").toLowerCase().includes(q) ||
      (b.bookingId || "").toLowerCase().includes(q)
    );
  }
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

  // Fetch mileage stats for priority computation (cars with Bouncie only)
  let mileageStatMap = {};
  if (sb) {
    try {
      const [{ data: vehicleRows }, { data: tripRows }] = await Promise.all([
        sb.from("vehicles")
          .select("vehicle_id, mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
          .not("bouncie_device_id", "is", null),
        sb.from("trip_log")
          .select("vehicle_id, trip_distance, trip_at")
          .gte("trip_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      ]);
      const mileageInput = (vehicleRows || [])
        .filter((r) => (r.data?.type || r.data?.vehicle_type || "") !== "slingshot")
        .map((r) => ({
          vehicle_id:               r.vehicle_id,
          total_mileage:            Number(r.mileage) || 0,
          last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
        }));
      const { stats } = analyzeMileage(mileageInput, (tripRows || []).map((r) => ({
        vehicle_id: r.vehicle_id, trip_distance: r.trip_distance, trip_at: r.trip_at,
      })));
      for (const s of stats) mileageStatMap[s.vehicle_id] = s;
    } catch {
      // priority falls back to decision_status only
    }
  }

  const entries = Object.entries(vehicles).map(([vehicleId, v]) => {
    const vBookings  = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));
    const revenue    = vBookings.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
    const bookCount  = sbCounts ? (sbCounts[vehicleId] ?? vBookings.length) : vBookings.length;
    const vType      = v.type || v.vehicle_type || "";
    const isCar      = vType !== "slingshot";

    const { priority, reason: priorityReason } = computeVehiclePriority(v, mileageStatMap[vehicleId] || null);

    const entry = {
      vehicleId,
      name:              v.vehicle_name || vehicleId,
      type:              vType || "car",
      status:            v.status || "active",
      bouncie_device_id: v.bouncie_device_id || null,
      decision_status:   v.decision_status || null,
      action_status:     v.action_status    || null,
      priority,
      priority_reason:   priorityReason,
      totalBookings:     bookCount,
      totalRevenue:      Math.round(revenue * 100) / 100,
    };

    // Tracking warning: cars without a Bouncie device are not monitored
    if (isCar && !v.bouncie_device_id) {
      entry.tracking_warning = "⚠️ This vehicle is not tracked — no mileage or maintenance alerts";
    }

    return entry;
  });

  // Sort by priority: high → medium → low
  return { vehicles: sortByPriority(entries) };
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
    type:         type || "car",
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

// ISO date pattern YYYY-MM-DD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function toolCreateVehicle({ name, type, price_per_day, purchase_price, purchase_date, bouncie_device_id }) {
  // ── Validation ─────────────────────────────────────────────────────────────
  if (!name || !String(name).trim()) throw new Error("name is required");

  const resolvedType = (type || "car").toLowerCase();
  if (resolvedType === "slingshot") {
    throw new Error("Slingshots are managed separately and cannot be created via this tool.");
  }

  const dailyRate = Number(price_per_day);
  if (!price_per_day || isNaN(dailyRate) || dailyRate <= 0) {
    throw new Error("price_per_day must be a number greater than 0");
  }

  const purchaseCost = Number(purchase_price);
  if (!purchase_price || isNaN(purchaseCost) || purchaseCost <= 0) {
    throw new Error("purchase_price must be a number greater than 0");
  }

  if (!purchase_date || !ISO_DATE_RE.test(String(purchase_date))) {
    throw new Error("purchase_date must be a valid date in YYYY-MM-DD format (e.g. \"2024-01-10\")");
  }
  // Reject dates that parse as invalid (e.g. 2024-13-99)
  if (isNaN(Date.parse(purchase_date))) {
    throw new Error(`purchase_date "${purchase_date}" is not a valid calendar date`);
  }

  // ── ID generation (reuse same logic as toolAddVehicle) ────────────────────
  const vehicles = await loadAllVehicles();

  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45) || "vehicle";

  let vehicleId;
  if (!vehicles[base]) {
    vehicleId = base;
  } else {
    let attempts = 0;
    do {
      if (++attempts > 100) throw new Error(`Could not generate a unique vehicle ID from name "${name}"`);
      const suffix = randomBytes(3).toString("hex").slice(0, 4);
      vehicleId = `${base}-${suffix}`;
    } while (vehicles[vehicleId]);
  }

  // ── Build vehicle record ───────────────────────────────────────────────────
  const vehicleObj = {
    vehicle_id:     vehicleId,
    vehicle_name:   String(name).slice(0, 200),
    type:           resolvedType,
    status:         "active",
    daily_rate:     dailyRate,
    purchase_price: purchaseCost,
    purchase_date:  purchase_date,
  };

  // ── Write to Supabase ──────────────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (sb) {
    const insertPayload = {
      vehicle_id: vehicleId,
      data: vehicleObj,
    };
    if (bouncie_device_id) {
      insertPayload.bouncie_device_id = String(bouncie_device_id).trim();
    }
    const { error } = await sb.from("vehicles").insert(insertPayload);
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }
    // Mirror bouncie_device_id into the data blob for consistency
    if (bouncie_device_id) {
      vehicleObj.bouncie_device_id = String(bouncie_device_id).trim();
    }
  }

  // ── Write to vehicles.json fallback ───────────────────────────────────────
  const { data: jsonVehicles } = await loadVehicles();
  jsonVehicles[vehicleId] = vehicleObj;
  await saveVehicles(jsonVehicles);

  console.log(`toolCreateVehicle: created "${vehicleId}" (${name}), price=$${dailyRate}/day, purchase=$${purchaseCost}`);

  // ── Post-creation verification ────────────────────────────────────────────
  const hasTracking = !!bouncie_device_id;
  const warnings = [];
  if (!hasTracking) {
    warnings.push("No Bouncie device assigned — mileage and maintenance tracking is not active for this vehicle.");
  }

  return {
    created:        vehicleId,
    name:           vehicleObj.vehicle_name,
    type:           resolvedType,
    price_per_day:  dailyRate,
    purchase_price: purchaseCost,
    purchase_date,
    bouncie_device_id: bouncie_device_id || null,
    tracking_active: hasTracking,
    warnings,
  };
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

  // Load canonical vehicle names from the same source as the dashboard.
  // Non-fatal — falls back to the JSONB data field if unavailable.
  let vehicleNameMap = {};
  let vehicleTypeMap = {};
  try {
    const { data: vehicles } = await loadVehicles();
    for (const [vid, v] of Object.entries(vehicles)) {
      if (v.vehicle_name) vehicleNameMap[vid] = v.vehicle_name;
      if (v.type)         vehicleTypeMap[vid] = v.type;
    }
  } catch {
    // non-fatal
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

    // Surface DB errors rather than silently returning empty results.
    if (vehicleResult.error) {
      console.error("toolGetMileage: vehicles query error:", vehicleResult.error.message);
      return {
        tracked_vehicles:   0,
        stats:              [],
        alerts:             [],
        bouncie_configured: !!process.env.BOUNCIE_ACCESS_TOKEN,
        error:              vehicleResult.error.message,
      };
    }

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

  const rawBouncieRows = vehicleRows || [];
  const mileageData = rawBouncieRows
    .filter((r) => {
      // Use canonical type from vehicles.json first, then fall back to JSONB field.
      const type = vehicleTypeMap[r.vehicle_id] || r.data?.type || r.data?.vehicle_type || "";
      return type !== "slingshot";
    })
    .map((r) => ({
      vehicle_id:               r.vehicle_id,
      // Use canonical vehicle name from vehicles.json (same source as dashboard).
      vehicle_name:             vehicleNameMap[r.vehicle_id] || r.data?.vehicle_name || r.vehicle_id,
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

  // Derive a per-vehicle maintenance_status from the alerts produced above.
  const statsWithStatus = stats.map((s) => {
    const prefix = `${s.name}:`;
    const vehicleAlerts = alerts.filter((a) => a.includes(prefix));
    const hasOverdue  = vehicleAlerts.some((a) => a.startsWith("🚨"));
    const hasDueSoon  = vehicleAlerts.some((a) => a.startsWith("⚠️"));
    return {
      ...s,
      maintenance_status: hasOverdue ? "overdue" : hasDueSoon ? "due_soon" : "ok",
    };
  });

  return {
    tracked_vehicles:   mileageData.length,
    raw_bouncie_rows:   rawBouncieRows.length,
    stats:              statsWithStatus,
    alerts,
    bouncie_configured: !!process.env.BOUNCIE_ACCESS_TOKEN,
  };
}

async function toolGetExpenses({ vehicleId, category } = {}) {
  const sb = getSupabaseAdmin();
  let expenses = null;

  if (sb) {
    try {
      let q = sb.from("expenses").select("*").order("date", { ascending: false }).limit(200);
      if (vehicleId) q = q.eq("vehicle_id", vehicleId);
      if (category)  q = q.eq("category", category);
      const { data, error } = await q;
      if (!error) expenses = data || [];
    } catch {
      // fall through
    }
  }

  if (!expenses) {
    const { data } = await loadExpenses();
    expenses = data;
    if (vehicleId) expenses = expenses.filter((e) => e.vehicle_id === vehicleId);
    if (category)  expenses = expenses.filter((e) => e.category === category);
  }

  const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const byCategory = {};
  const byVehicle  = {};
  for (const e of expenses) {
    const cat = e.category || "other";
    byCategory[cat] = (byCategory[cat] || 0) + (Number(e.amount) || 0);
    const vid = e.vehicle_id || "unknown";
    byVehicle[vid] = (byVehicle[vid] || 0) + (Number(e.amount) || 0);
  }

  return {
    total:      Math.round(total * 100) / 100,
    count:      expenses.length,
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    byVehicle:  Object.fromEntries(Object.entries(byVehicle).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    expenses:   expenses.slice(0, 50),
  };
}

async function toolGetAnalytics({ action = "fleet", vehicleId, months = 6 } = {}) {
  const allBookings = await loadAllBookings();
  const { data: vehicles } = await loadVehicles();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  if (action === "revenue_trend") {
    const safeMonths = Math.min(Number(months) || 6, 24);
    const trend = [];
    const now = new Date();
    for (let i = safeMonths - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const monthBookings = allBookings.filter(
        (b) => paidStatuses.has(b.status) && (b.pickupDate || b.createdAt || "").startsWith(month)
      );
      const revenue = monthBookings.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
      trend.push({ month, revenue: Math.round(revenue * 100) / 100, bookings: monthBookings.length });
    }
    return { action: "revenue_trend", months: safeMonths, trend };
  }

  if (action === "vehicle" && vehicleId) {
    const v = vehicles[vehicleId];
    if (!v) return { error: `Vehicle "${vehicleId}" not found` };
    const vBookings = allBookings.filter((b) => b.vehicleId === vehicleId && paidStatuses.has(b.status));
    const revenue = vBookings.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
    const avgDays = vBookings.length
      ? vBookings.reduce((s, b) => {
          if (!b.pickupDate || !b.returnDate) return s;
          return s + Math.max(1, Math.round((new Date(b.returnDate) - new Date(b.pickupDate)) / 86400000));
        }, 0) / vBookings.length
      : 0;
    const dayCounts = {};
    for (const b of vBookings) {
      if (!b.pickupDate) continue;
      const day = new Date(b.pickupDate).toLocaleDateString("en-US", { weekday: "long" });
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }
    return {
      action: "vehicle",
      vehicleId,
      name:          v.vehicle_name || vehicleId,
      total_bookings: vBookings.length,
      total_revenue:  Math.round(revenue * 100) / 100,
      avg_rental_days: Math.round(avgDays * 10) / 10,
      popular_days:   Object.entries(dayCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([day, count]) => ({ day, count })),
    };
  }

  // Default: fleet overview
  const summary = Object.entries(vehicles).map(([vid, v]) => {
    const vBookings = allBookings.filter((b) => b.vehicleId === vid && paidStatuses.has(b.status));
    const revenue   = vBookings.reduce((s, b) => s + (b.amountPaid || revenueFromBooking(b)), 0);
    const firstBooking = vBookings.reduce((earliest, b) => {
      const d = b.pickupDate || b.createdAt || "";
      return !earliest || d < earliest ? d : earliest;
    }, null);
    const daysSinceFirst = firstBooking
      ? Math.max(90, Math.round((Date.now() - new Date(firstBooking).getTime()) / 86400000))
      : 90;
    // Estimate utilization: assume average 3 rental days per booking as a rough proxy.
    const AVG_RENTAL_DAYS = 3;
    const utilization = Math.min(100, Math.round((vBookings.length * AVG_RENTAL_DAYS / daysSinceFirst) * 100));
    return {
      vehicleId:        vid,
      name:             v.vehicle_name || vid,
      type:             v.type || "car",
      total_bookings:   vBookings.length,
      total_revenue:    Math.round(revenue * 100) / 100,
      utilization_pct:  utilization,
    };
  });

  return {
    action: "fleet",
    vehicles: summary.sort((a, b) => b.total_revenue - a.total_revenue),
    total_revenue: Math.round(summary.reduce((s, v) => s + v.total_revenue, 0) * 100) / 100,
    total_bookings: summary.reduce((s, v) => s + v.total_bookings, 0),
  };
}

async function toolGetCustomers({ search, flagged, banned, limit = 50 } = {}) {
  const sb = getSupabaseAdmin();
  const safeLimit = Math.min(Number(limit) || 50, 200);
  let customers = null;

  if (sb) {
    try {
      let q = sb.from("customers").select("*").order("total_bookings", { ascending: false }).limit(safeLimit);
      if (flagged !== undefined) q = q.eq("flagged", !!flagged);
      if (banned  !== undefined) q = q.eq("banned",  !!banned);
      if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
      const { data, error } = await q;
      if (!error) customers = data || [];
    } catch {
      // fall through
    }
  }

  if (!customers) {
    // Derive customers from bookings as fallback
    const allBookings = await loadAllBookings();
    const byPhone = {};
    for (const b of allBookings) {
      const phone = b.phone || "unknown";
      if (!byPhone[phone]) {
        byPhone[phone] = { phone, name: b.name || "", email: b.email || "", total_bookings: 0, total_spent: 0 };
      }
      byPhone[phone].total_bookings += 1;
      byPhone[phone].total_spent += b.amountPaid || revenueFromBooking(b);
    }
    customers = Object.values(byPhone);
    if (search) {
      const q = search.toLowerCase();
      customers = customers.filter((c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.phone || "").includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      );
    }
    customers = customers.sort((a, b) => b.total_bookings - a.total_bookings).slice(0, safeLimit);
  }

  return {
    total:     customers.length,
    customers: customers.map((c) => ({
      id:             c.id || undefined,
      name:           c.name || c.customer_name || "",
      phone:          c.phone || "",
      email:          c.email || "",
      total_bookings: c.total_bookings || 0,
      total_spent:    typeof c.total_spent === "number" ? Math.round(c.total_spent * 100) / 100 : undefined,
      flagged:        c.flagged || false,
      banned:         c.banned  || false,
      flag_reason:    c.flag_reason || undefined,
      ban_reason:     c.ban_reason  || undefined,
      notes:          c.notes       || undefined,
    })),
  };
}

async function toolGetProtectionPlans() {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.from("protection_plans")
        .select("id, name, description, daily_rate, liability_cap, is_active, sort_order")
        .order("sort_order").order("name");
      if (!error && data && data.length > 0) {
        return { plans: data };
      }
    } catch {
      // fall through
    }
  }

  // Hardcoded defaults (mirrors v2-protection-plans.js)
  return {
    plans: [
      { name: "None",     description: "No protection plan",                    daily_rate: 0,  liability_cap: 0,    is_active: true },
      { name: "Basic",    description: "Basic damage protection, $1,000 cap",   daily_rate: 15, liability_cap: 1000, is_active: true },
      { name: "Standard", description: "Standard coverage, $500 cap",           daily_rate: 25, liability_cap: 500,  is_active: true },
      { name: "Premium",  description: "Full coverage, $0 liability",           daily_rate: 40, liability_cap: 0,    is_active: true },
    ],
    source: "defaults",
  };
}

async function toolGetSystemSettings({ category } = {}) {
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      let q = sb.from("system_settings").select("key, value, description, category");
      if (category) q = q.eq("category", category);
      const { data, error } = await q;
      if (!error && data && data.length > 0) {
        return {
          settings: data.map((r) => ({ key: r.key, value: r.value, description: r.description, category: r.category })),
          count: data.length,
        };
      }
    } catch {
      // fall through to defaults
    }
  }

  // Hardcoded defaults (mirrors v2-system-settings.js)
  const defaults = [
    { key: "la_tax_rate",                value: 0.1025, description: "LA combined sales tax rate",             category: "tax" },
    { key: "slingshot_daily_rate",       value: 350,    description: "Slingshot R daily rate (USD)",           category: "pricing" },
    { key: "slingshot_3hr_rate",         value: 200,    description: "Slingshot R 3-hour rate (USD)",          category: "pricing" },
    { key: "slingshot_6hr_rate",         value: 250,    description: "Slingshot R 6-hour rate (USD)",          category: "pricing" },
    { key: "camry_daily_rate",           value: 55,     description: "Camry daily rate (USD)",                 category: "pricing" },
    { key: "camry_weekly_rate",          value: 350,    description: "Camry weekly rate (USD)",                category: "pricing" },
    { key: "slingshot_security_deposit", value: 150,    description: "Slingshot security deposit (USD)",       category: "pricing" },
    { key: "auto_block_dates_on_approve",value: true,   description: "Auto-block dates when booking approved", category: "automation" },
    { key: "notify_sms_on_approve",      value: true,   description: "Send SMS on booking approval",           category: "notification" },
    { key: "notify_email_on_approve",    value: true,   description: "Send email on booking approval",         category: "notification" },
  ];

  const filtered = category ? defaults.filter((s) => s.category === category) : defaults;
  return { settings: filtered, count: filtered.length, source: "defaults" };
}

/**
 * Compute a rental price quote using the live pricing system.
 * Routes to the appropriate settings-based helper depending on vehicle type:
 *   - Slingshot vehicles → computeSlingshotAmountFromSettings
 *   - Known economy cars (camry/camry2013) → computeBreakdownLinesFromSettings
 *   - Newly created "car" type vehicles → daily_rate × days + live tax
 */
async function toolGetPriceQuote({ vehicleId, pickup, returnDate, durationHours }) {
  if (!vehicleId) return { error: "vehicleId is required" };

  const settings = await loadPricingSettings();
  const vehicles = await loadAllVehicles();
  const vehicle  = vehicles[vehicleId];

  if (!vehicle) return { error: `Vehicle "${vehicleId}" not found` };

  const vType = (vehicle.type || vehicle.vehicle_type || "").toLowerCase();
  const isSlingshot = vType === "slingshot";

  // ── Slingshot (hourly-tier pricing) ───────────────────────────────────────
  if (isSlingshot) {
    const hours = Number(durationHours);
    if (!hours || ![3, 6, 24, 48, 72].includes(hours)) {
      return { error: "durationHours is required for Slingshot vehicles and must be 3, 6, 24, 48, or 72" };
    }
    // computeSlingshotAmountFromSettings returns (tier price × 2): rental + refundable deposit.
    // The rental fee equals the tier price; the security deposit equals the same tier price.
    const totalCharged = computeSlingshotAmountFromSettings(hours, settings);
    const tierPrice    = totalCharged / 2; // rental = deposit = tier price
    const tierLabel    = hours >= 24 ? `${hours / 24}-day` : `${hours}-hour`;
    return {
      vehicleId,
      vehicle_name: vehicle.vehicle_name || vehicleId,
      type:         "slingshot",
      duration:     `${hours} hours`,
      breakdown: [
        `${tierLabel} rental: $${tierPrice}`,
        `Refundable security deposit: $${tierPrice}`,
        `Total charged at booking: $${totalCharged}`,
      ],
      rental_amount:    tierPrice,
      security_deposit: tierPrice,
      total:            totalCharged,
      note: "Security deposit is refundable. Tax is not applied to Slingshot rentals.",
    };
  }

  // ── Economy / Car vehicles (daily/weekly pricing) ─────────────────────────
  if (!pickup || !returnDate) {
    return { error: "pickup and returnDate (YYYY-MM-DD) are required for car price quotes" };
  }

  const days = computeRentalDays(pickup, returnDate);

  // Known vehicles with configured tier rates in _settings.js
  if (vehicleId === "camry" || vehicleId === "camry2013") {
    const lines = computeBreakdownLinesFromSettings(vehicleId, pickup, returnDate, settings, false, null);
    if (!lines) return { error: `Could not compute price for "${vehicleId}"` };
    const totalLine = lines.find((l) => l.startsWith("Total:")) || "";
    const total = parseFloat(totalLine.replace("Total: $", "")) || 0;
    return {
      vehicleId,
      vehicle_name: vehicle.vehicle_name || vehicleId,
      type:         "car",
      pickup,
      return_date:  returnDate,
      days,
      breakdown:    lines,
      total,
      note: `Add Damage Protection Plan (basic $${PROTECTION_PLAN_BASIC}/day, standard $${PROTECTION_PLAN_STANDARD}/day, premium $${PROTECTION_PLAN_PREMIUM}/day) for additional coverage.`,
    };
  }

  // Newly created vehicles — use their stored daily_rate with live tax
  const dailyRate = Number(vehicle.daily_rate || vehicle.pricePerDay || 0);
  if (!dailyRate || dailyRate <= 0) {
    return { error: `Vehicle "${vehicleId}" has no daily rate configured. Update it with update_vehicle first.` };
  }

  const preTax    = days * dailyRate;
  const taxRate   = settings.la_tax_rate;
  const taxAmount = Math.round(preTax * taxRate * 100) / 100;
  const total     = Math.round((preTax + taxAmount) * 100) / 100;

  return {
    vehicleId,
    vehicle_name: vehicle.vehicle_name || vehicleId,
    type:         vType || "car",
    pickup,
    return_date:  returnDate,
    days,
    breakdown: [
      `${days} × Daily ($${dailyRate}/day): $${preTax}`,
      `Sales Tax (${(taxRate * 100).toFixed(2)}%): $${taxAmount.toFixed(2)}`,
      `Total: $${total.toFixed(2)}`,
    ],
    total,
    note: `Add Damage Protection Plan (basic $${PROTECTION_PLAN_BASIC}/day, standard $${PROTECTION_PLAN_STANDARD}/day, premium $${PROTECTION_PLAN_PREMIUM}/day) for additional coverage.`,
  };
}

async function toolGetSmsTemplates() {
  const sb = getSupabaseAdmin();
  let overrides = {};

  if (sb) {
    try {
      const { data, error } = await sb.from("sms_template_overrides").select("template_key, message, enabled");
      if (!error && data) {
        for (const row of data) {
          overrides[row.template_key] = { message: row.message, enabled: row.enabled };
        }
      }
    } catch {
      // use defaults only
    }
  }

  const templates = Object.entries(TEMPLATES).map(([key, defaultMessage]) => {
    const override = overrides[key];
    return {
      key,
      message:    override?.message  ?? defaultMessage,
      enabled:    override?.enabled  ?? true,
      customized: !!override,
    };
  });

  return { total: templates.length, templates };
}

async function toolGetBlockedDates({ vehicleId } = {}) {
  const sb = getSupabaseAdmin();
  let blockedDates = null;

  // Try Supabase blocked_dates table first
  if (sb) {
    try {
      let q = sb.from("blocked_dates").select("vehicle_id, start_date, end_date, reason").order("start_date");
      if (vehicleId) q = q.eq("vehicle_id", vehicleId);
      const { data, error } = await q;
      if (!error && data) {
        const byVehicle = {};
        for (const row of (data || [])) {
          const vid = row.vehicle_id;
          if (!byVehicle[vid]) byVehicle[vid] = [];
          byVehicle[vid].push({ from: row.start_date, to: row.end_date, reason: row.reason || undefined });
        }
        blockedDates = byVehicle;
      }
    } catch {
      // fall through
    }
  }

  // Fall back to booked-dates.json from GitHub
  if (!blockedDates) {
    try {
      const data = await fetchBookedDates();
      if (data) {
        blockedDates = vehicleId
          ? { [vehicleId]: data[vehicleId] || [] }
          : data;
      }
    } catch {
      // ignore
    }
  }

  if (!blockedDates) {
    return { blocked_dates: {}, note: "Could not retrieve blocked dates — GitHub or Supabase unavailable." };
  }

  const summary = {};
  let total = 0;
  for (const [vid, ranges] of Object.entries(blockedDates)) {
    const arr = Array.isArray(ranges) ? ranges : [];
    summary[vid] = arr;
    total += arr.length;
  }

  return { total_ranges: total, blocked_dates: summary };
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

/**
 * Run the fleet-wide maintenance status check.
 * Computes OK / DUE_SOON / OVERDUE for each tracked vehicle using
 * lib/ai/maintenance.js, upserts maintenance table rows, and escalates
 * OVERDUE vehicles to action_status = "pending".
 */
async function toolUpdateMaintenanceStatus() {
  const sb = getSupabaseAdmin();
  if (!sb) {
    return { error: "Database not configured — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set." };
  }

  let vehicleRows;
  try {
    const { data, error } = await sb
      .from("vehicles")
      .select("vehicle_id, data, mileage, maintenance_interval, is_tracked, bouncie_device_id, action_status");
    if (error) throw new Error(`vehicles query failed: ${error.message}`);
    vehicleRows = data || [];
  } catch (err) {
    console.error("toolUpdateMaintenanceStatus: vehicles query error:", err.message);
    return { error: err.message };
  }

  const enriched = vehicleRows
    .filter((v) => v.is_tracked || v.bouncie_device_id != null)
    .map((v) => ({
      ...v,
      vehicle_name:         v.data?.vehicle_name || v.data?.name || v.vehicle_id,
      last_service_mileage: v.data?.last_service_mileage ?? null,
    }));

  if (enriched.length === 0) {
    return {
      processed: 0,
      alerts:    [],
      overdue:   0,
      due_soon:  0,
      ok:        0,
      note:      "No tracked vehicles found. Set is_tracked = true on vehicles to enable monitoring.",
    };
  }

  const { results, alerts, overdue, due_soon, ok } = computeFleetAlerts(enriched);
  const now = new Date().toISOString();

  for (const result of results) {
    const { vehicle_id, status, miles_since_service, interval, miles_until_service } = result;
    const dbStatus = status === "OVERDUE"  ? "overdue"
                   : status === "DUE_SOON" ? "pending"
                   :                         "completed";

    try {
      const { error: upsertErr } = await sb
        .from("maintenance")
        .upsert(
          {
            vehicle_id,
            service_type: "general",
            status:       dbStatus,
            notes:        `Auto-computed: ${miles_since_service} mi since last service. Interval: ${interval} mi. Miles until next service: ${miles_until_service}.`,
            updated_at:   now,
          },
          { onConflict: "vehicle_id,service_type" }
        );
      if (upsertErr) console.error(`toolUpdateMaintenanceStatus: upsert failed for ${vehicle_id}:`, upsertErr.message);
    } catch (err) {
      console.error(`toolUpdateMaintenanceStatus: upsert threw for ${vehicle_id}:`, err.message);
    }

    if (status === "OVERDUE") {
      const v = enriched.find((row) => row.vehicle_id === vehicle_id);
      if (!v?.action_status || v.action_status === "resolved") {
        try {
          const { error: updateErr } = await sb
            .from("vehicles")
            .update({ action_status: "pending", updated_at: now })
            .eq("vehicle_id", vehicle_id);
          if (updateErr) console.error(`toolUpdateMaintenanceStatus: action_status update failed for ${vehicle_id}:`, updateErr.message);
        } catch (err) {
          console.error(`toolUpdateMaintenanceStatus: action_status update threw for ${vehicle_id}:`, err.message);
        }
      }
    }
  }

  return { processed: results.length, alerts, overdue, due_soon, ok };
}



/**
 * Get maintenance status for a vehicle looked up by name.
 * Queries maintenance_history (completed services), maintenance_appointments
 * (driver-scheduled appointments), the maintenance table (migration 0029),
 * and the mileage columns on vehicles (migration 0022).
 * Works for ALL vehicles regardless of GPS tracking.
 */
async function toolGetMaintenanceStatus({ vehicleName } = {}) {
  if (!vehicleName) {
    return { error: "vehicleName is required" };
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return { error: "Database not configured — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel." };
  }

  // Load vehicles to find matching vehicle_id by name
  let vehicleRows;
  try {
    const { data, error } = await sb
      .from("vehicles")
      .select("vehicle_id, data, mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, rental_status, bouncie_device_id, action_status");
    if (error) throw new Error(`vehicles query failed: ${error.message}`);
    vehicleRows = data || [];
  } catch (err) {
    console.error("toolGetMaintenanceStatus: vehicles query error:", err.message);
    return { error: err.message };
  }

  // Case-insensitive name match — check vehicle_name in data JSONB, then vehicle_id
  const lower = vehicleName.toLowerCase().trim();
  const vehicle = vehicleRows.find((r) => {
    const name = (r.data?.vehicle_name || r.data?.name || "").toLowerCase();
    return name.includes(lower) || r.vehicle_id.toLowerCase().includes(lower);
  });

  if (!vehicle) {
    const available = vehicleRows.map((r) => r.data?.vehicle_name || r.vehicle_id).filter(Boolean);
    return {
      error:              `No vehicle found matching "${vehicleName}".`,
      available_vehicles: available,
    };
  }

  const vehicleId          = vehicle.vehicle_id;
  const vehicleDisplayName = vehicle.data?.vehicle_name || vehicle.data?.name || vehicleId;
  const currentMileage     = Number(vehicle.mileage) || null;

  // Fetch all maintenance data in parallel; each query is non-fatal if table missing
  const [historyResult, appointmentsResult, maintenanceResult] = await Promise.allSettled([
    sb
      .from("maintenance_history")
      .select("id, service_type, mileage, notes, created_at, booking_id")
      .eq("vehicle_id", vehicleId)
      .order("created_at", { ascending: false })
      .limit(10),
    sb
      .from("maintenance_appointments")
      .select("id, service_type, scheduled_at, status, notes, created_at, missed_at")
      .eq("vehicle_id", vehicleId)
      .order("scheduled_at", { ascending: false })
      .limit(10),
    sb
      .from("maintenance")
      .select("id, service_type, due_date, status, notes, created_at, updated_at")
      .eq("vehicle_id", vehicleId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // Surface real errors, skip "relation does not exist" (table not migrated yet)
  const extractRows = (settled, label) => {
    if (settled.status === "rejected") {
      console.error(`toolGetMaintenanceStatus: ${label} query threw:`, settled.reason?.message);
      return [];
    }
    const { data, error } = settled.value;
    if (error) {
      const msg = error.message || "";
      if (!msg.includes("relation") && !msg.includes("does not exist")) {
        console.error(`toolGetMaintenanceStatus: ${label} error:`, msg);
      }
      return [];
    }
    return data || [];
  };

  const serviceHistory       = extractRows(historyResult,      "maintenance_history");
  const appointments         = extractRows(appointmentsResult, "maintenance_appointments");
  const maintenanceRecords   = extractRows(maintenanceResult,  "maintenance");

  // Compute mileage-based maintenance status from vehicle columns
  const lastOil    = vehicle.last_oil_change_mileage    != null ? Number(vehicle.last_oil_change_mileage)    : null;
  const lastBrakes = vehicle.last_brake_check_mileage   != null ? Number(vehicle.last_brake_check_mileage)   : null;
  const lastTires  = vehicle.last_tire_change_mileage   != null ? Number(vehicle.last_tire_change_mileage)   : null;

  // Use analyzeMileage to compute per-service alerts (same logic as get_mileage)
  let mileageAlerts = [];
  let mileageAlertsWarning = null;
  if (vehicle.bouncie_device_id && currentMileage) {
    try {
      const { alerts } = analyzeMileage([{
        vehicle_id:               vehicleId,
        vehicle_name:             vehicleDisplayName,
        total_mileage:            currentMileage,
        last_oil_change_mileage:  lastOil,
        last_brake_check_mileage: lastBrakes,
        last_tire_change_mileage: lastTires,
        last_service_mileage:     Number(vehicle.data?.last_service_mileage) || 0,
        bouncie_device_id:        vehicle.bouncie_device_id,
      }], []);
      mileageAlerts = alerts;
    } catch (err) {
      console.error("toolGetMaintenanceStatus: analyzeMileage error:", err.message);
      mileageAlertsWarning = "Could not compute mileage-based maintenance alerts.";
    }
  }

  return {
    vehicle_id:              vehicleId,
    vehicle_name:            vehicleDisplayName,
    rental_status:           vehicle.rental_status || null,
    action_status:           vehicle.action_status || null,
    mileage_tracked:         !!vehicle.bouncie_device_id,
    current_mileage:         currentMileage,
    mileage_based: {
      last_oil_change_mileage:    lastOil,
      last_brake_check_mileage:   lastBrakes,
      last_tire_change_mileage:   lastTires,
    },
    mileage_alerts:          mileageAlerts,
    mileage_alerts_warning:  mileageAlertsWarning,
    maintenance_records:     maintenanceRecords,   // from migration 0029 maintenance table
    appointments:            appointments,          // from maintenance_appointments (driver-scheduled)
    service_history:         serviceHistory,        // from maintenance_history (completed services)
  };
}



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
    .eq("booking_ref", bookingId);

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
    .eq("booking_ref", bookingId);

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

async function toolUpdateActionStatus({ vehicleId, action_status }) {
  if (!vehicleId)     throw new Error("vehicleId is required");
  if (!action_status) throw new Error("action_status is required");

  const validStatuses = ["pending", "in_progress", "resolved"];
  if (!validStatuses.includes(action_status)) {
    throw new Error(`Invalid action_status "${action_status}". Must be one of: ${validStatuses.join(", ")}`);
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase not configured — cannot update action status");

  // Fetch current action_status to enforce forward-only progression
  const { data: row, error: fetchErr } = await sb
    .from("vehicles")
    .select("action_status, decision_status, last_auto_action_at, last_auto_action_reason")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
  if (!row)     throw new Error(`Vehicle "${vehicleId}" not found`);
  if (!row.decision_status) {
    throw new Error(`Vehicle "${vehicleId}" has no active decision — use confirm_vehicle_action first`);
  }

  const currentOrder = ACTION_STATUS_ORDER[row.action_status] ?? -1;
  const newOrder     = ACTION_STATUS_ORDER[action_status];
  if (newOrder < currentOrder) {
    throw new Error(
      `Cannot move action_status backwards from "${row.action_status}" to "${action_status}". Allowed progression: pending → in_progress → resolved.`
    );
  }

  const resolvedAt  = action_status === "resolved" ? new Date().toISOString() : null;
  const resolutionPatch = resolvedAt
    ? {
        last_resolved_at:        resolvedAt,
        last_resolved_reason:    row.last_auto_action_reason || null,
        // Reset dedup state so the same issue can re-alert if it reoccurs
        last_auto_action_at:     null,
        last_auto_action_reason: null,
      }
    : {};

  const { error } = await sb
    .from("vehicles")
    .update({ action_status, updated_at: new Date().toISOString(), ...resolutionPatch })
    .eq("vehicle_id", vehicleId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  // Compute time-to-resolution when closing an issue
  let time_to_resolution_ms = null;
  if (resolvedAt && row.last_auto_action_at) {
    time_to_resolution_ms = new Date(resolvedAt).getTime() - new Date(row.last_auto_action_at).getTime();
  }

  return {
    success:               true,
    vehicleId,
    action_status,
    previous:              row.action_status,
    ...(resolvedAt && {
      last_resolved_at:     resolvedAt,
      last_resolved_reason: row.last_auto_action_reason || null,
      time_to_resolution_ms,
    }),
    message: `Action status for ${vehicleId} updated: ${row.action_status || "none"} → ${action_status}.`,
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


async function toolMarkMaintenance({ vehicleId, serviceType, mileage }) {
  if (!vehicleId)   throw new Error("vehicleId is required");
  if (!serviceType) throw new Error("serviceType is required (oil | brakes | tires)");
  const mapping = MAINTENANCE_SERVICE_COLUMNS[serviceType];
  if (!mapping) throw new Error(`Invalid serviceType "${serviceType}". Must be one of: ${Object.keys(MAINTENANCE_SERVICE_COLUMNS).join(", ")}`);

  if (mileage !== undefined && mileage !== null) {
    const parsed = Number(mileage);
    if (isNaN(parsed) || parsed < 0) throw new Error("mileage must be a non-negative number");
    mileage = parsed;
  }

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

  // Use provided mileage if given, otherwise fall back to current odometer
  const serviceMileage = (mileage !== undefined && mileage !== null) ? mileage : (Number(row.mileage) || 0);
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

  // ── Optional: auto-resolve action_status when no maintenance remains overdue ──
  // After recording the service, recompute mileage for this vehicle and check
  // whether ALL services are now within interval. If so and action_status is
  // pending/in_progress, set it to "resolved".
  let autoResolved = false;
  try {
    const { data: freshRow } = await sb
      .from("vehicles")
      .select("mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, action_status, data, last_auto_action_at, last_auto_action_reason")
      .eq("vehicle_id", vehicleId)
      .maybeSingle();

    if (freshRow) {
      const freshMiles = Number(freshRow.mileage) || 0;
      const { stats: freshStats } = analyzeMileage([{
        vehicle_id:               vehicleId,
        total_mileage:            freshMiles,
        last_oil_change_mileage:  freshRow.last_oil_change_mileage  != null ? Number(freshRow.last_oil_change_mileage)  : null,
        last_brake_check_mileage: freshRow.last_brake_check_mileage != null ? Number(freshRow.last_brake_check_mileage) : null,
        last_tire_change_mileage: freshRow.last_tire_change_mileage != null ? Number(freshRow.last_tire_change_mileage) : null,
      }], []);

      const activeActionStatus = freshRow.action_status;
      if (
        freshStats.length > 0 &&
        hasNoOverdueMaintenance(freshStats[0]) &&
        (activeActionStatus === "pending" || activeActionStatus === "in_progress")
      ) {
        const autoResolvedAt = new Date().toISOString();
        await sb
          .from("vehicles")
          .update({
            action_status:           "resolved",
            last_resolved_at:        autoResolvedAt,
            last_resolved_reason:    freshRow.last_auto_action_reason || null,
            // Reset dedup state so a reoccurrence triggers a fresh alert
            last_auto_action_at:     null,
            last_auto_action_reason: null,
            updated_at:              autoResolvedAt,
          })
          .eq("vehicle_id", vehicleId);
        autoResolved = true;
      }
    }
  } catch {
    // auto-resolve is best-effort — do not fail the maintenance record
  }

  return {
    success:         true,
    vehicleId,
    serviceType,
    service_label:   labels[serviceType],
    service_mileage: serviceMileage,
    auto_resolved:   autoResolved,
    message:         `${labels[serviceType]} recorded at ${serviceMileage.toLocaleString()} mi for ${vehicleId}.`
      + (autoResolved ? " Action status auto-resolved (no remaining overdue services)." : ""),
  };
}

// ── Destructive-action guard ──────────────────────────────────────────────────
// Tools that mutate data require the "confirmed" flag in their args.

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Re-send a booking confirmation email to the renter and owner.
 * Used when the browser-side email failed (e.g. "We couldn't send your confirmation")
 * or when a booking was added manually via admin.
 */
async function toolResendBookingConfirmation({ bookingId }) {
  if (!bookingId) throw new Error("bookingId is required");

  // ── Find the booking ─────────────────────────────────────────────────────
  const { data: bookingsData } = await loadBookings();
  let booking = null;
  for (const list of Object.values(bookingsData)) {
    if (!Array.isArray(list)) continue;
    const found = list.find(b => b.bookingId === bookingId);
    if (found) { booking = found; break; }
  }
  if (!booking) throw new Error(`No booking found with bookingId "${bookingId}"`);

  const {
    name, email, phone, vehicleName, vehicleId,
    pickupDate, pickupTime, returnDate, returnTime,
    amountPaid, totalPrice, status,
  } = booking;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP is not configured on the server — add SMTP_HOST, SMTP_USER, SMTP_PASS in Vercel environment variables.");
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const displayTotal = amountPaid != null ? `$${Number(amountPaid).toFixed(2)}` : (totalPrice != null ? `$${Number(totalPrice).toFixed(2)}` : "N/A");
  const pickupDisplay  = [pickupDate,  pickupTime ].filter(Boolean).join(" at ");
  const returnDisplay  = [returnDate,  returnTime ].filter(Boolean).join(" at ");
  const firstName = (name || "there").split(" ")[0];

  // ── Owner notification ────────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from:    `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:      OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject: `💰 Booking Confirmed (Admin Resend) — ${vehicleName || vehicleId || ""}`,
      html: `
        <h2>💰 Booking Confirmed — Admin Resend</h2>
        <p>This is a manually re-sent confirmation for a booking that was recorded in the admin panel. The original browser-side confirmation email failed.</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(bookingId)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName || vehicleId || "N/A")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name || "Not provided")}</td></tr>
          ${phone ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone)}</td></tr>` : ""}
          ${email ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email)}</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDisplay || "N/A")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDisplay || "N/A")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(displayTotal)}</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking Status</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(status || "booked_paid")}</td></tr>
        </table>
        <p style="margin-top:16px">Dates have been blocked on the booking calendar. The customer's confirmation email was also resent.</p>
      `,
      text: [
        "Booking Confirmed — Admin Resend",
        "",
        `Booking ID   : ${bookingId}`,
        `Vehicle      : ${vehicleName || vehicleId || "N/A"}`,
        `Renter       : ${name || "Not provided"}`,
        phone  ? `Phone        : ${phone}`  : "",
        email  ? `Email        : ${email}`  : "",
        `Pickup       : ${pickupDisplay || "N/A"}`,
        `Return       : ${returnDisplay || "N/A"}`,
        `Total        : ${displayTotal}`,
        `Status       : ${status || "booked_paid"}`,
      ].filter(Boolean).join("\n"),
    });
  } catch (ownerErr) {
    throw new Error(`Owner notification email failed: ${ownerErr.message}`);
  }

  // ── Customer confirmation ─────────────────────────────────────────────────
  let customerSent = false;
  if (email) {
    try {
      await transporter.sendMail({
        from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: "✅ Your Booking is Confirmed — Sly Transportation Services LLC",
        html: `
          <h2>✅ Payment Confirmed — Sly Transportation Services LLC</h2>
          <p>Hi ${esc(firstName)}, your payment has been received and your booking is confirmed!</p>
          <table style="border-collapse:collapse;width:100%;margin-top:12px">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName || vehicleId || "N/A")}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDisplay || "N/A")}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDisplay || "N/A")}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(displayTotal)}</strong></td></tr>
          </table>
          <p style="margin-top:16px">We will be in touch shortly to confirm your rental pick-up details.</p>
          <p>If you have any questions, please contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
          <p><strong>Sly Transportation Services LLC 🚗</strong></p>
        `,
        text: [
          "Payment Confirmed — Sly Transportation Services LLC",
          "",
          `Hi ${firstName}, your payment has been received and your booking is confirmed!`,
          "",
          `Vehicle : ${vehicleName || vehicleId || "N/A"}`,
          `Pickup  : ${pickupDisplay || "N/A"}`,
          `Return  : ${returnDisplay || "N/A"}`,
          `Total   : ${displayTotal}`,
          "",
          "We will be in touch shortly to confirm your rental pick-up details.",
          `Questions? Contact us at ${OWNER_EMAIL} or call (213) 916-6606.`,
          "",
          "Sly Transportation Services LLC",
        ].join("\n"),
      });
      customerSent = true;
    } catch (custErr) {
      console.error("toolResendBookingConfirmation: customer email failed:", custErr.message);
    }
  }

  return {
    success:       true,
    bookingId,
    renter:        name || "N/A",
    vehicle:       vehicleName || vehicleId || "N/A",
    ownerNotified: true,
    customerEmail: email || null,
    customerSent,
    message: customerSent
      ? `✅ Confirmation emails sent to owner and ${email}.`
      : `✅ Owner notification sent. No customer email — no email address on this booking.`,
  };
}

const IMEI_RE = /^\d{15}$/;
const BOUNCIE_SYNC_STALE_MS = 48 * 60 * 60 * 1000; // 48 hours

async function toolRegisterBouncieDevice({ vehicleId, imei }) {
  // ── Input validation ────────────────────────────────────────────────────
  if (!vehicleId) throw new Error("vehicleId is required");
  if (!imei)      throw new Error("imei is required — provide the 15-digit Bouncie device IMEI");

  const cleanImei = String(imei).replace(/[\s-]/g, "");
  if (!IMEI_RE.test(cleanImei)) {
    throw new Error(`Invalid IMEI "${imei}" — must be exactly 15 digits (e.g. 123456789012345)`);
  }

  // ── Vehicle existence check ─────────────────────────────────────────────
  const vehicles = await loadAllVehicles();
  if (!vehicles[vehicleId]) {
    throw new Error(`Vehicle "${vehicleId}" not found. Valid IDs: ${Object.keys(vehicles).join(", ")}`);
  }

  // ── Duplicate IMEI check (across all vehicles) ──────────────────────────
  for (const [vid, v] of Object.entries(vehicles)) {
    if (vid !== vehicleId && v.bouncie_device_id === cleanImei) {
      throw new Error(
        `IMEI ${cleanImei} is already assigned to vehicle "${v.vehicle_name || vid}". ` +
        `Each device can only be linked to one vehicle.`
      );
    }
  }

  // ── Write: Supabase + vehicles.json ─────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (sb) {
    const updatedData = { ...vehicles[vehicleId], bouncie_device_id: cleanImei };
    const { error } = await sb
      .from("vehicles")
      .update({ bouncie_device_id: cleanImei, data: updatedData })
      .eq("vehicle_id", vehicleId);
    if (error && !error.message?.includes("relation")) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }
  }

  const { data: jsonVehicles } = await loadVehicles();
  if (jsonVehicles[vehicleId]) {
    jsonVehicles[vehicleId] = { ...jsonVehicles[vehicleId], bouncie_device_id: cleanImei };
    await saveVehicles(jsonVehicles);
  }

  // ── Post-assignment verification ─────────────────────────────────────────
  // Read back the row so we can confirm bouncie_device_id was persisted
  // and report the current sync state.
  let confirmedImei = null;
  let lastSyncedAt  = null;

  if (sb) {
    try {
      const { data: row } = await sb
        .from("vehicles")
        .select("bouncie_device_id, last_synced_at")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();
      if (row) {
        confirmedImei = row.bouncie_device_id || null;
        lastSyncedAt  = row.last_synced_at    || null;
      }
    } catch {
      // non-fatal — we still report success from the write
    }
  }

  const vehicleName   = vehicles[vehicleId]?.vehicle_name || vehicleId;
  const syncPending   = !lastSyncedAt;
  const syncAgeMs     = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : null;
  const syncRecent    = syncAgeMs !== null && syncAgeMs <= BOUNCIE_SYNC_STALE_MS;

  return {
    success:           true,
    vehicleId,
    vehicle_name:      vehicleName,
    bouncie_device_id: confirmedImei || cleanImei,
    tracking_active:   !!confirmedImei,
    last_synced_at:    lastSyncedAt,
    sync_status:       syncPending
      ? "awaiting_first_sync"
      : syncRecent
        ? "active"
        : "stale",
    message:
      `Bouncie device ${cleanImei} assigned to ${vehicleName}. ` +
      (syncPending
        ? "Waiting for first GPS sync — this usually takes a few minutes once the device is powered on."
        : syncRecent
          ? `Tracking is active (last sync: ${lastSyncedAt}).`
          : `Device was last seen at ${lastSyncedAt} — check that the device is powered on.`),
  };
}

const DESTRUCTIVE_TOOLS = new Set([
  "create_vehicle",
  "add_vehicle",
  "update_vehicle",
  "send_sms",
  "mark_maintenance",
  "flag_booking",
  "update_booking_status",
  "confirm_vehicle_action",
  "update_action_status",
  "send_message_to_driver",
  "register_bouncie_device",
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
      case "create_vehicle":           result = await toolCreateVehicle(args);           break;
      case "add_vehicle":              result = await toolAddVehicle(args);              break;
      case "update_vehicle":           result = await toolUpdateVehicle(args);           break;
      case "send_sms":                 result = await toolSendSms(args);                 break;
      case "get_insights":             result = await toolGetInsights();                 break;
      case "get_fraud_report":         result = await toolGetFraudReport(args);          break;
      case "get_mileage":              result = await toolGetMileage();                  break;
      case "get_maintenance_status":   result = await toolGetMaintenanceStatus(args);    break;
      case "update_maintenance_status": result = await toolUpdateMaintenanceStatus();    break;
      case "mark_maintenance":         result = await toolMarkMaintenance(args);         break;
      case "flag_booking":             result = await toolFlagBooking(args);             break;
      case "update_booking_status":    result = await toolUpdateBookingStatus(args);     break;
      case "confirm_vehicle_action":   result = await toolConfirmVehicleAction(args);    break;
      case "update_action_status":     result = await toolUpdateActionStatus(args);      break;
      case "send_message_to_driver":   result = await toolSendMessageToDriver(args);     break;
      case "get_expenses":             result = await toolGetExpenses(args);             break;
      case "get_analytics":            result = await toolGetAnalytics(args);            break;
      case "get_customers":            result = await toolGetCustomers(args);            break;
      case "get_protection_plans":     result = await toolGetProtectionPlans();          break;
      case "get_system_settings":      result = await toolGetSystemSettings(args);       break;
      case "get_price_quote":          result = await toolGetPriceQuote(args);           break;
      case "get_sms_templates":        result = await toolGetSmsTemplates();             break;
      case "get_blocked_dates":        result = await toolGetBlockedDates(args);         break;
      case "register_bouncie_device":      result = await toolRegisterBouncieDevice(args);      break;
      case "resend_booking_confirmation":   result = await toolResendBookingConfirmation(args);   break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (err) {
    console.error("TOOL ERROR:", err);
    const errorResult = { error: adminErrorMessage(err), details: err.message };
    try { await logAiAction(toolName, args, errorResult, adminId); } catch (logErr) { console.error("TOOL ERROR: failed to log action:", logErr); }
    return errorResult;
  }

  await logAiAction(toolName, args, result, adminId);
  return result;
}

// ── Unified data loader ───────────────────────────────────────────────────────

/**
 * Load all core admin data in parallel from Supabase (with JSON fallbacks).
 * Returns a single context object used by all admin and AI systems.
 *
 * @returns {Promise<{
 *   bookings:      object[],
 *   vehicles:      object,
 *   expenses:      object[],
 *   settings:      object,
 *   maintenance:   object[],
 *   blocked_dates: object[],
 *   customers:     object[],
 * }>}
 */
export async function loadAdminContext() {
  const sb = getSupabaseAdmin();

  // Supabase-specific loaders — non-fatal when table missing or Supabase not configured
  async function loadMaintenance() {
    if (!sb) return [];
    try {
      const { data, error } = await sb
        .from("maintenance")
        .select("id, vehicle_id, service_type, due_date, status, notes, updated_at")
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error) {
        const msg = error.message || "";
        if (!msg.includes("relation") && !msg.includes("does not exist")) {
          console.error("loadAdminContext: maintenance query error:", msg);
        }
        return [];
      }
      return data || [];
    } catch (err) {
      console.error("loadAdminContext: maintenance query threw:", err.message);
      return [];
    }
  }

  async function loadBlockedDates() {
    if (!sb) return [];
    try {
      const { data, error } = await sb
        .from("blocked_dates")
        .select("*")
        .order("start_date", { ascending: true })
        .limit(500);
      if (error) {
        const msg = error.message || "";
        if (!msg.includes("relation") && !msg.includes("does not exist")) {
          console.error("loadAdminContext: blocked_dates query error:", msg);
        }
        return [];
      }
      return data || [];
    } catch (err) {
      console.error("loadAdminContext: blocked_dates query threw:", err.message);
      return [];
    }
  }

  async function loadCustomers() {
    if (!sb) return [];
    try {
      const { data, error } = await sb
        .from("customers")
        .select("id, name, phone, email, total_bookings, total_spent, is_banned, no_show_count, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) {
        const msg = error.message || "";
        if (!msg.includes("relation") && !msg.includes("does not exist")) {
          console.error("loadAdminContext: customers query error:", msg);
        }
        return [];
      }
      return data || [];
    } catch (err) {
      console.error("loadAdminContext: customers query threw:", err.message);
      return [];
    }
  }

  const [bookingsResult, vehiclesResult, expensesResult, settingsResult,
         maintenanceResult, blockedDatesResult, customersResult] = await Promise.allSettled([
    loadAllBookings(),
    loadAllVehicles(),
    loadExpenses().then((r) => r.data || []).catch(() => []),
    loadPricingSettings().catch(() => ({})),
    loadMaintenance(),
    loadBlockedDates(),
    loadCustomers(),
  ]);

  return {
    bookings:      bookingsResult.status      === "fulfilled" ? bookingsResult.value      : [],
    vehicles:      vehiclesResult.status      === "fulfilled" ? vehiclesResult.value      : {},
    expenses:      expensesResult.status      === "fulfilled" ? expensesResult.value      : [],
    settings:      settingsResult.status      === "fulfilled" ? settingsResult.value      : {},
    maintenance:   maintenanceResult.status   === "fulfilled" ? maintenanceResult.value   : [],
    blocked_dates: blockedDatesResult.status  === "fulfilled" ? blockedDatesResult.value  : [],
    customers:     customersResult.status     === "fulfilled" ? customersResult.value     : [],
  };
}
