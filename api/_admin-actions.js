// api/_admin-actions.js
// Safe tool executor for the AI admin assistant.
// All tool calls from admin-chat.js are routed through here.
// This module owns validation, audit logging, and all business-logic calls.
// admin-chat.js has ZERO direct Supabase or data-layer access.

import { loadBookings } from "./_bookings.js";
import { loadVehicles, saveVehicles } from "./_vehicles.js";
import { computeAmount } from "./_pricing.js";
import { sendSms } from "./_textmagic.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { scoreAllBookings } from "../lib/ai/fraud.js";

// ── Revenue helper (mirrors v2-dashboard) ────────────────────────────────────
function revenueFromBooking(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) return booking.amountPaid;
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    return computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate) || 0;
  }
  return 0;
}

// ── Audit logging ────────────────────────────────────────────────────────────
async function logAction(actionName, args, result) {
  const sb = getSupabaseAdmin();
  if (!sb) return; // No Supabase → skip logging (non-fatal)
  try {
    await sb.from("admin_action_logs").insert({
      action_name: actionName,
      args:        args   || null,
      result:      result || null,
    });
  } catch (err) {
    console.warn("_admin-actions: audit log failed:", err.message);
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function toolGetRevenue({ month } = {}) {
  const { data: bookingsData } = await loadBookings();
  const allBookings = Object.values(bookingsData).flat();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  let filtered = allBookings.filter((b) => paidStatuses.has(b.status));
  if (month) {
    filtered = filtered.filter((b) => (b.pickupDate || b.createdAt || "").startsWith(month));
  }

  const total = filtered.reduce((s, b) => s + revenueFromBooking(b), 0);

  // Per-vehicle breakdown
  const byVehicle = {};
  for (const b of filtered) {
    const vid = b.vehicleId || "unknown";
    if (!byVehicle[vid]) byVehicle[vid] = { count: 0, revenue: 0 };
    byVehicle[vid].count   += 1;
    byVehicle[vid].revenue += revenueFromBooking(b);
  }
  for (const v of Object.values(byVehicle)) {
    v.revenue = Math.round(v.revenue * 100) / 100;
  }

  return {
    period:    month || "all-time",
    total:     Math.round(total * 100) / 100,
    bookings:  filtered.length,
    byVehicle,
  };
}

async function toolGetBookings({ vehicleId, status, limit = 20 } = {}) {
  const safeLimit = Math.min(Number(limit) || 20, 100);
  const { data: bookingsData } = await loadBookings();
  let all = Object.values(bookingsData).flat();

  if (vehicleId) all = all.filter((b) => b.vehicleId === vehicleId);
  if (status)    all = all.filter((b) => b.status === status);

  // Sort newest first
  all.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  const results = all.slice(0, safeLimit).map((b) => ({
    bookingId:  b.bookingId,
    name:       b.name,
    phone:      b.phone,
    email:      b.email,
    vehicleId:  b.vehicleId,
    pickupDate: b.pickupDate,
    returnDate: b.returnDate,
    status:     b.status,
    amountPaid: revenueFromBooking(b),
    createdAt:  b.createdAt,
  }));

  return { total: all.length, returned: results.length, bookings: results };
}

async function toolGetVehicles() {
  const { data: vehicles } = await loadVehicles();
  const { data: bookingsData } = await loadBookings();
  const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

  const result = Object.entries(vehicles).map(([vehicleId, v]) => {
    const vBookings = (bookingsData[vehicleId] || []).filter((b) => paidStatuses.has(b.status));
    const revenue   = vBookings.reduce((s, b) => s + revenueFromBooking(b), 0);
    return {
      vehicleId,
      name:          v.vehicle_name || vehicleId,
      status:        v.status || "active",
      totalBookings: vBookings.length,
      totalRevenue:  Math.round(revenue * 100) / 100,
    };
  });

  return { vehicles: result };
}

async function toolAddVehicle({ vehicleId, vehicleName, type, dailyRate }) {
  if (!vehicleId || !vehicleName) throw new Error("vehicleId and vehicleName are required");
  if (!/^[a-z0-9_-]{2,50}$/.test(vehicleId)) throw new Error("vehicleId must be lowercase letters, digits, hyphens, or underscores (2–50 chars)");

  const { data: vehicles } = await loadVehicles();
  if (vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" already exists`);

  vehicles[vehicleId] = {
    vehicle_id:   vehicleId,
    vehicle_name: String(vehicleName).slice(0, 200),
    type:         type || "other",
    status:       "active",
    daily_rate:   dailyRate ? Number(dailyRate) : undefined,
  };

  await saveVehicles(vehicles);
  return { created: vehicleId, name: vehicleName };
}

async function toolUpdateVehicle({ vehicleId, updates = {} }) {
  if (!vehicleId) throw new Error("vehicleId is required");

  const { data: vehicles } = await loadVehicles();
  if (!vehicles[vehicleId]) throw new Error(`Vehicle "${vehicleId}" not found`);

  const allowed = ["vehicle_name", "status", "daily_rate"];
  const sanitized = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) sanitized[key] = updates[key];
  }

  if (sanitized.status) {
    const validStatuses = ["active", "maintenance", "inactive"];
    if (!validStatuses.includes(sanitized.status)) {
      throw new Error(`Invalid status "${sanitized.status}". Must be one of: ${validStatuses.join(", ")}`);
    }
  }

  vehicles[vehicleId] = { ...vehicles[vehicleId], ...sanitized };
  await saveVehicles(vehicles);
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
  const [{ data: bookingsData }, { data: vehicles }] = await Promise.all([
    loadBookings(),
    loadVehicles(),
  ]);
  const allBookings = Object.values(bookingsData).flat();

  const insights  = computeInsights({ allBookings, vehicles, revenueFromBooking });
  const problems  = detectProblems({ allBookings, vehicles, revenueFromBooking, insights });

  return { insights, problems };
}

async function toolGetFraudReport({ flaggedOnly = true } = {}) {
  const { data: bookingsData } = await loadBookings();
  const allBookings = Object.values(bookingsData).flat();

  let scored = scoreAllBookings(allBookings);
  if (flaggedOnly) scored = scored.filter((b) => b.flagged);

  // Sort by risk_score descending
  scored.sort((a, b) => b.risk_score - a.risk_score);

  return {
    total:    allBookings.length,
    flagged:  scored.filter((b) => b.flagged).length,
    results:  scored.slice(0, 50),
  };
}

// ── Destructive-action guard ──────────────────────────────────────────────────
// Tools that mutate data require the "confirmed" flag in their args.
const DESTRUCTIVE_TOOLS = new Set(["add_vehicle", "update_vehicle", "send_sms"]);

// ── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute a named tool with the given args.
 * Logs the action to admin_action_logs.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} [options]
 * @param {boolean} [options.requireConfirmation] - if true, reject destructive calls without args.confirmed
 * @returns {Promise<object>} Tool result
 */
export async function executeAction(toolName, args = {}, { requireConfirmation = true } = {}) {
  // Guard: destructive ops need confirmation flag when requireConfirmation is enabled
  if (requireConfirmation && DESTRUCTIVE_TOOLS.has(toolName) && !args.confirmed) {
    const result = {
      requires_confirmation: true,
      message: `Action "${toolName}" requires confirmation. Ask the admin to confirm, then retry with confirmed:true.`,
    };
    await logAction(toolName, args, result);
    return result;
  }

  let result;
  try {
    switch (toolName) {
      case "get_revenue":       result = await toolGetRevenue(args);       break;
      case "get_bookings":      result = await toolGetBookings(args);      break;
      case "get_vehicles":      result = await toolGetVehicles();           break;
      case "add_vehicle":       result = await toolAddVehicle(args);       break;
      case "update_vehicle":    result = await toolUpdateVehicle(args);    break;
      case "send_sms":          result = await toolSendSms(args);          break;
      case "get_insights":      result = await toolGetInsights();           break;
      case "get_fraud_report":  result = await toolGetFraudReport(args);  break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (err) {
    const errorResult = { error: adminErrorMessage(err) };
    await logAction(toolName, args, errorResult);
    throw err;
  }

  await logAction(toolName, args, result);
  return result;
}
