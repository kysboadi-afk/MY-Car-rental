// api/admin-ai-auto.js
// SLYTRANS Fleet Control — AI automation loop (cron job entry point).
//
// Called by Vercel Cron every 10 minutes (see vercel.json).
// Also callable manually via POST with Authorization: Bearer <CRON_SECRET>.
//
// Flow:
//   1. Fetch bookings + vehicles from Supabase (fallback: JSON files)
//   2. Compute insights
//   3. Detect problems
//   4. If AUTO_MODE env var = "true" → execute low-risk actions
//   5. Log everything to ai_logs
//
// Required env vars:
//   ADMIN_SECRET or CRON_SECRET — authentication
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — database
// Optional:
//   AUTO_MODE=true — enables automatic action execution (default: false)
//   OPENAI_API_KEY — required for AI-generated action summaries

import { executeAction, logAiAction } from "./_admin-actions.js";
import { loadBookings } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { computeAmount } from "./_pricing.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { computeInsights } from "../lib/ai/insights.js";
import { detectProblems } from "../lib/ai/monitor.js";
import { runAutoActions } from "../lib/ai/actions-auto.js";
import { computePriorityAlerts } from "../lib/ai/priority-alerts.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { sendSms } from "./_textmagic.js";
import nodemailer from "nodemailer";
import { buildServiceUrl } from "./_quick-service-token.js";
import { render, MAINTENANCE_AVAILABILITY_REQUEST } from "./_sms-templates.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const OWNER_PHONE = process.env.OWNER_PHONE || "+12139166606";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

// ── Priority alert helpers ────────────────────────────────────────────────────

// HTML-escape user-supplied strings before embedding in email HTML (XSS prevention)
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function safeSendSms(phone, text) {
  try {
    if (!phone) return false;
    await sendSms(phone, text);
    return true;
  } catch (err) {
    console.warn(`admin-ai-auto: SMS failed to ${phone}:`, err.message);
    return false;
  }
}

async function sendOwnerEmail(subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({ from: process.env.SMTP_USER, to: OWNER_EMAIL, subject, html });
    return true;
  } catch (err) {
    console.warn("admin-ai-auto: owner email failed:", err.message);
    return false;
  }
}

/**
 * Execute priority auto-alerts for all high-priority vehicles that need action.
 * Returns a summary array for logging.
 *
 * Safety: ONLY sends messages and advances action_status pending → in_progress.
 *         NEVER changes vehicle status, rental availability, or any destructive field.
 */
async function runPriorityAlerts({ vehicles, mileageStatMap, activeBookingByVehicle, sb }) {
  const alerts = computePriorityAlerts({ vehicles, mileageStatMap, activeBookingByVehicle });
  const summary = [];

  if (alerts.length === 0) return summary;

  for (const alert of alerts) {
    const { vehicleId, name, reason, isMaintenance, setInProgress, alertDriver, driverPhone, driverName, bookingId } = alert;
    const fired = [];

    // ── Owner SMS ────────────────────────────────────────────────────────────
    if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
      const ownerMsg = `🚨 HIGH PRIORITY — ${name}: ${reason}. Please review in the admin dashboard.`;
      const sent = await safeSendSms(OWNER_PHONE, ownerMsg);
      if (sent) fired.push("owner_sms");
    }

    // ── Owner email ──────────────────────────────────────────────────────────
    // For maintenance alerts, include one-click service completion links.
    const REASON_TO_SERVICE_TYPE = {
      "oil change":       "oil",
      "brake inspection": "brakes",
      "tire replacement": "tires",
    };
    const maintenanceLinks = isMaintenance
      ? Object.entries(REASON_TO_SERVICE_TYPE)
          .filter(([label]) => reason.includes(label))
          .map(([label, svcType]) => {
            const url = buildServiceUrl(vehicleId, svcType, undefined, 7 * 24 * 60 * 60 * 1000);
            return `<p><a href="${url}" style="display:inline-block;padding:8px 16px;background:#2e7d32;color:#fff;border-radius:4px;text-decoration:none">✅ Mark ${esc(label)} as complete</a></p>`;
          })
          .join("\n")
      : "";
    const emailSent = await sendOwnerEmail(
      `🚨 Fleet Alert — ${esc(name)} (High Priority)`,
      `<p>🚨 <strong>High-priority issue detected for ${esc(name)}</strong></p>
<p><strong>Issue:</strong> ${esc(reason)}</p>
${isMaintenance ? `<p><strong>Type:</strong> Maintenance overdue</p>` : ""}
${bookingId  ? `<p><strong>Active booking:</strong> ${esc(bookingId)}</p>` : ""}
${driverName  ? `<p><strong>Driver:</strong> ${esc(driverName)}</p>` : ""}
${driverPhone ? `<p><strong>Driver phone:</strong> ${esc(driverPhone)}</p>` : ""}
<p>Please log in to the admin dashboard to review and take action.</p>
${maintenanceLinks}
${isMaintenance ? `<p style="font-size:12px;color:#888">Quick-service links expire in 7 days. Open a new alert to get a fresh link.</p>` : ""}`
    );
    if (emailSent) fired.push("owner_email");

    // ── Driver SMS (maintenance only, requires active booking) ───────────────
    if (alertDriver && driverPhone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
      const customerName = driverName || "there";
      const driverMsg = render(MAINTENANCE_AVAILABILITY_REQUEST, { customer_name: customerName });
      const sent = await safeSendSms(driverPhone, driverMsg);
      if (sent) fired.push("driver_sms");
    }

    // ── Advance action_status: pending → in_progress ─────────────────────────
    if (setInProgress && sb) {
      try {
        await sb
          .from("vehicles")
          .update({ action_status: "in_progress", updated_at: new Date().toISOString() })
          .eq("vehicle_id", vehicleId);
        fired.push("action_status_in_progress");
      } catch (err) {
        console.warn(`admin-ai-auto: action_status update failed for ${vehicleId}:`, err.message);
      }
    }

    // ── Record dedup stamp ────────────────────────────────────────────────────
    if (fired.length > 0 && sb) {
      try {
        await sb
          .from("vehicles")
          .update({
            last_auto_action_at:     new Date().toISOString(),
            last_auto_action_reason: reason,
            updated_at:              new Date().toISOString(),
          })
          .eq("vehicle_id", vehicleId);
      } catch (err) {
        console.warn(`admin-ai-auto: dedup stamp failed for ${vehicleId}:`, err.message);
      }
    }

    summary.push({ vehicleId, name, reason, actions: fired });
  }

  return summary;
}



const DB_TO_APP_STATUS = {
  pending:   "reserved_unpaid",
  approved:  "booked_paid",
  active:    "active_rental",
  completed: "completed_rental",
  cancelled: "cancelled_rental",
};

function revenueFromBooking(booking) {
  if (typeof booking.amountPaid === "number" && booking.amountPaid > 0) return booking.amountPaid;
  if (booking.pickupDate && booking.returnDate && booking.vehicleId) {
    return computeAmount(booking.vehicleId, booking.pickupDate, booking.returnDate) || 0;
  }
  return 0;
}

async function fetchAllData() {
  const sb = getSupabaseAdmin();

  let allBookings = [];
  if (sb) {
    try {
      const { data, error } = await sb
        .from("bookings")
        .select("booking_id, vehicle_id, customer_name, phone, email, pickup_date, return_date, status, amount_paid, total_price, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!error && data) {
        allBookings = data.map((row) => ({
          bookingId:  row.booking_id || "",
          name:       row.customer_name || "",
          phone:      row.phone || "",
          email:      row.email || "",
          vehicleId:  row.vehicle_id || "",
          pickupDate: row.pickup_date || "",
          returnDate: row.return_date || "",
          status:     DB_TO_APP_STATUS[row.status] || row.status,
          amountPaid: row.amount_paid || row.total_price || 0,
          createdAt:  row.created_at || "",
        }));
      }
    } catch {
      // fall through
    }
  }

  if (allBookings.length === 0) {
    const { data: bookingsData } = await loadBookings();
    allBookings = Object.values(bookingsData).flat();
  }

  // Include Bouncie fields so detectProblems can use tracking status as
  // source of truth, independent of booking/fleet status.
  // Also include decision/action status and dedup columns for priority alerts.
  let vehicles = {};
  if (sb) {
    try {
      const { data, error } = await sb
        .from("vehicles")
        .select("vehicle_id, data, rental_status, bouncie_device_id, last_synced_at, decision_status, action_status, last_auto_action_at, last_auto_action_reason");
      if (!error && data) {
        for (const row of data) {
          // Skip slingshots — they are managed by the dedicated slingshot admin
          const type = row.data?.type || row.data?.vehicle_type || "";
          if (type === "slingshot") continue;
          vehicles[row.vehicle_id] = {
            vehicle_id:              row.vehicle_id,
            ...(row.data || {}),
            rental_status:           row.rental_status           || null,
            bouncie_device_id:       row.bouncie_device_id       || null,
            last_synced_at:          row.last_synced_at          || null,
            decision_status:         row.decision_status         || null,
            action_status:           row.action_status           || null,
            last_auto_action_at:     row.last_auto_action_at     || null,
            last_auto_action_reason: row.last_auto_action_reason || null,
          };
        }
      }
    } catch {
      // fall through
    }
  }
  if (Object.keys(vehicles).length === 0) {
    const { data } = await loadVehicles();
    for (const [id, v] of Object.entries(data)) {
      if ((v.type || "") === "slingshot") continue;
      vehicles[id] = v;
    }
  }

  // Mileage data for Bouncie-tracked vehicles — rental_status is ignored when
  // deciding what to track; last_synced_at is the source of truth for activity.
  let mileageData = [];
  let recentTrips = [];
  let mileageStatMap = {};
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
          vehicle_id:           r.vehicle_id,
          vehicle_name:         r.data?.vehicle_name || r.vehicle_id,
          total_mileage:        Number(r.mileage) || 0,
          last_oil_change_mileage:  r.last_oil_change_mileage  != null ? Number(r.last_oil_change_mileage)  : null,
          last_brake_check_mileage: r.last_brake_check_mileage != null ? Number(r.last_brake_check_mileage) : null,
          last_tire_change_mileage: r.last_tire_change_mileage != null ? Number(r.last_tire_change_mileage) : null,
          last_service_mileage:     Number(r.data?.last_service_mileage) || 0,
          last_synced_at:       r.last_synced_at,
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

  // Build mileageStatMap for priority computation (if analyzeMileage is available)
  // We import analyzeMileage lazily to avoid pulling it in for the non-Supabase fallback path.
  if (mileageData.length > 0) {
    try {
      const { analyzeMileage } = await import("../lib/ai/mileage.js");
      const { stats } = analyzeMileage(mileageData, recentTrips);
      for (const s of stats) mileageStatMap[s.vehicle_id] = s;
    } catch {
      // mileageStatMap stays empty — priority falls back to decision_status only
    }
  }

  // Build active booking map (vehicle → booking with active_rental status)
  // Only include car vehicles (slingshots already excluded from vehicles map)
  const carVehicleIds = new Set(Object.keys(vehicles));
  const filteredBookings = allBookings.filter((b) => !b.vehicleId || carVehicleIds.has(b.vehicleId));

  const activeBookingByVehicle = {};
  for (const booking of filteredBookings) {
    if (booking.status === "active_rental" && booking.vehicleId) {
      // Keep the most recent active booking per vehicle
      if (!activeBookingByVehicle[booking.vehicleId]) {
        activeBookingByVehicle[booking.vehicleId] = booking;
      }
    }
  }

  return { allBookings: filteredBookings, vehicles, mileageData, recentTrips, mileageStatMap, activeBookingByVehicle };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Authentication ────────────────────────────────────────────────────────
  // Vercel Cron sends GET; manual triggers send POST with Bearer token.
  if (req.method === "POST") {
    const authHeader  = req.headers.authorization || "";
    const cronSecret  = process.env.CRON_SECRET;
    const adminSecret = process.env.ADMIN_SECRET;

    const validCron  = cronSecret  && authHeader === `Bearer ${cronSecret}`;
    const validAdmin = adminSecret && authHeader === `Bearer ${adminSecret}`;

    if (!validCron && !validAdmin) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  // GET requests from Vercel Cron are trusted implicitly (internal network).
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const autoMode = process.env.AUTO_MODE === "true";

  console.time("AI request");

  try {
    const runStart = Date.now();
    const { allBookings, vehicles, mileageData, recentTrips, mileageStatMap, activeBookingByVehicle } = await fetchAllData();

    const insights = computeInsights({ allBookings, vehicles, revenueFromBooking });
    const problems = detectProblems({ allBookings, vehicles, revenueFromBooking, insights, mileageData, recentTrips });

    // Run auto-action engine (revenue / maintenance suggestions)
    const { suggestions, actions_taken } = await runAutoActions({
      insights,
      problems,
      autoMode,
      execute: executeAction,
      secret:  process.env.ADMIN_SECRET,
    });

    // Run priority-based auto-alerts (owner SMS/email + driver SMS for HIGH priority)
    const sb = getSupabaseAdmin();
    const priorityAlerts = await runPriorityAlerts({
      vehicles,
      mileageStatMap,
      activeBookingByVehicle,
      sb,
    });

    const runMs = Date.now() - runStart;

    const output = {
      ran_at:            new Date().toISOString(),
      auto_mode:         autoMode,
      duration_ms:       runMs,
      problems_found:    problems.length,
      problems,
      suggestions,
      actions_taken,
      priority_alerts:   priorityAlerts,
      revenue_this_week: insights.revenue?.thisWeek,
      bookings_last_7d:  insights.bookings?.last7Days,
    };

    // Log the auto-run to ai_logs
    await logAiAction("auto_run", { auto_mode: autoMode, booking_count: allBookings.length }, output, "cron");

    console.timeEnd("AI request");
    return res.status(200).json(output);
  } catch (err) {
    console.timeEnd("AI request");
    console.error("admin-ai-auto error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
