// api/scheduled-reminders.js
// Vercel cron serverless function — scans bookings.json and sends automated
// SMS reminders based on booking status and timing.
//
// This endpoint is called by Vercel Cron on a frequent schedule (every 5 min).
// It is also callable manually from an admin panel via POST with an
// Authorization: Bearer <CRON_SECRET> header.
//
// Reminder types fired per booking status:
//
//  reserved_unpaid  → UNPAID_REMINDER_2H, UNPAID_REMINDER_FINAL
//  booked_paid      → PICKUP_REMINDER_24H
//                     + auto-activated → active_rental once pickup time arrives
//  active_rental    → LATE_WARNING_30MIN (30 min before return),
//                     LATE_AT_RETURN_TIME, LATE_GRACE_EXPIRED, LATE_FEE_APPLIED
//                     + auto-completed → completed_rental after AUTO_COMPLETE_HOURS
//  completed_rental → POST_RENTAL_THANK_YOU, RETENTION_DAY_7
//
// Extension awareness:
//   Return-time-based SMS (late_warning_30min, late_at_return, late_grace_expired,
//   late_fee_pending) are deduplicated via the Supabase sms_logs table keyed on
//   (booking_id, template_key, return_date_at_send).  When a rental is extended
//   the booking's return_date changes, so the old sms_logs rows no longer match
//   and the messages fire correctly for the new return date.
//
// Required environment variables:
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY
//   GITHUB_TOKEN, GITHUB_REPO
//   CRON_SECRET  — shared secret to authenticate manual trigger calls
//   STRIPE_SECRET_KEY  — for auto-charging late fees
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — for sms_logs deduplication
//
// Vercel cron configuration is in vercel.json.

import nodemailer from "nodemailer";
import { sendSms } from "./_textmagic.js";
import {
  render,
  DEFAULT_LOCATION,
  UNPAID_REMINDER_2H,
  UNPAID_REMINDER_FINAL,
  PICKUP_REMINDER_24H,
  ACTIVE_RENTAL_1H_BEFORE_END,
  LATE_WARNING_30MIN,
  LATE_AT_RETURN_TIME,
  LATE_GRACE_EXPIRED,
  LATE_FEE_APPLIED,
  POST_RENTAL_THANK_YOU,
  RETENTION_DAY_7,
} from "./_sms-templates.js";
import { loadBookings, saveBookings, normalizePhone, updateBooking } from "./_bookings.js";
import { upsertContact } from "./_contacts.js";
import { CARS } from "./_pricing.js";
import { autoUpsertBooking, autoUpsertCustomer } from "./_booking-automation.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { buildLateFeeUrls } from "./_late-fee-token.js";
import { loadBooleanSetting } from "./_settings.js";
import { formatTime12h, laHour } from "./_time.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { computeFinalReturnDate } from "./_final-return-date.js";
import {
  getSmsPriority,
  checkSmsCooldown,
  TIME_CRITICAL_KEYS,
} from "./_sms-priority.js";
import Stripe from "stripe";
import {
  saveWebhookBookingRecord,
  blockBookedDates,
  markVehicleUnavailable,
  sendWebhookNotificationEmails,
  mapVehicleId,
} from "./stripe-webhook.js";

// ─── Late fee amounts ($ per hour) per vehicle type ──────────────────────────
// Fee = Math.max(1, Math.ceil(hoursOverdue)) × rate, calculated from actual
// return datetime vs. expected return datetime (HH:MM 24-hour).
// The grace period gates when the fee is *assessed*, but the hourly count
// starts from the scheduled return time (not from grace expiry).  The minimum
// charge is always 1 hour, so a renter who is 1–59 minutes late is charged
// the same as one who is exactly 1 hour late.
const LATE_FEE_AMOUNTS = {
  slingshot:  100,  // $100/hour (rounded up, min 1 h)
  slingshot2: 100,  // $100/hour — same rate as slingshot (Unit 2)
  slingshot3: 100,  // $100/hour — same rate as slingshot (Unit 3)
  camry:       50,  // $50/hour  (rounded up, min 1 h)
  camry2013:   50,  // $50/hour  (rounded up, min 1 h)
};

// Hard cap on any single late-fee assessment.  Prevents runaway fees caused by
// stale bookings.json entries that remain as "active_rental" for days/weeks.
// Consistent with MAX_CHARGE_WARN_USD in approve-late-fee.js.
const MAX_LATE_FEE_USD = 500;

// Maximum hours-overdue window in which a late fee may be triggered.
// AUTO_COMPLETE_HOURS (4 h) auto-closes the booking; the late fee window is
// 2 h–8 h past the scheduled return.  If minsOverdue exceeds this threshold
// the booking was never auto-completed (stale status, cron outage, etc.) and
// firing a fee would produce unrealistic amounts.  Skip it and warn instead.
const MAX_FEE_OVERDUE_HOURS = 8;

// ─── Auto-completion threshold ────────────────────────────────────────────────
// Active rentals that are still open this many hours past the scheduled return
// time are automatically transitioned to "completed_rental".  This frees up
// the vehicle for new bookings without requiring manual admin intervention.
const AUTO_COMPLETE_HOURS = 4;

const OWNER_PHONE = process.env.OWNER_PHONE || "+12139166606";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";
const TRIGGER_WINDOW_MS  = 15 * 60 * 1000;
const GRACE_OFFSET_MS    = 60 * 60 * 1000;
const LATE_FEE_OFFSET_MS = 2 * 60 * 60 * 1000;

// Boundaries (in minutes) for the end-of-rental warning SMS window.
// Cron runs every 5 min so a 15-min window ensures the message fires exactly once.
// Window is (WARNING_BEFORE_END_LOWER_MIN, WARNING_BEFORE_END_UPPER_MIN]:
//   minutesUntilReturn > 15 && minutesUntilReturn <= 30  →  fires once per return event
const WARNING_BEFORE_END_UPPER_MIN = 30; // inclusive upper bound: fires when ≤ 30 min remain
const WARNING_BEFORE_END_LOWER_MIN = 15; // exclusive lower bound: does not fire when ≤ 15 min remain

// Boundaries (in minutes) for the 1-hour-before-return extension invitation window.
// Fires once in the 45–60 min window ("about 1 hour"), well clear of the 15–30 min
// return-obligation warning so renters never receive both in the same cron tick.
const EXT_REMINDER_UPPER_MIN = 60; // inclusive upper bound: fires when ≤ 60 min remain
const EXT_REMINDER_LOWER_MIN = 45; // exclusive lower bound: does not fire when ≤ 45 min remain

// SMS send-window boundaries — messages are only delivered between these hours
// in America/Los_Angeles time to avoid waking renters outside business hours.
const SMS_WINDOW_START_HOUR = 8;  // 8:00 AM LA
const SMS_WINDOW_END_HOUR   = 19; // 7:00 PM LA (exclusive)

// Sentinel date used in sms_logs for SMS that are not tied to a specific
// return date (pickup reminders, unpaid reminders, etc.).  Using a fixed
// non-null value lets the UNIQUE constraint (booking_id, template_key,
// return_date_at_send) work correctly for those messages too.
const SMS_LOGS_SENTINEL_DATE = "1970-01-01";

// ─── Supabase sms_logs helpers ────────────────────────────────────────────────
// These helpers provide extension-aware SMS deduplication.  Every return-time
// SMS is recorded with the booking's current return_date so that if the booking
// is extended the old log rows no longer match the new return_date, allowing the
// correct messages to fire for the new schedule.
//
// Both functions are non-fatal: if Supabase is unavailable the caller falls
// back to the bookings.json smsSentAt flags.

/**
 * Returns true when an SMS with this key has already been sent for the given
 * return_date (or for any date when returnDateStr is falsy/sentinel).
 * @param {string} bookingId      - booking_ref (bk-...)
 * @param {string} templateKey    - e.g. 'late_at_return'
 * @param {string} [returnDateStr] - YYYY-MM-DD return_date; omit for non-return-time messages
 * @returns {Promise<boolean>}
 */
async function isSmsLogged(bookingId, templateKey, returnDateStr) {
  const sb = getSupabaseAdmin();
  if (!sb || !bookingId) return false;
  try {
    const date = returnDateStr || SMS_LOGS_SENTINEL_DATE;
    const { data, error } = await sb
      .from("sms_logs")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("template_key", templateKey)
      .eq("return_date_at_send", date)
      .maybeSingle();
    if (error) {
      console.warn("scheduled-reminders: sms_logs read error (non-fatal):", error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.warn("scheduled-reminders: sms_logs check failed (non-fatal):", err.message);
    return false;
  }
}

/**
 * Persist a sent-SMS record to the sms_logs table.
 * Uses upsert so duplicate calls are idempotent.
 * Always stores `{ priority }` in metadata so the cross-cron cooldown gate
 * can compare priorities of messages from different cron jobs.
 * @param {string} bookingId
 * @param {string} templateKey
 * @param {string} [returnDateStr] - YYYY-MM-DD; omit for non-return-time messages
 * @param {object} [metadata]      - optional JSON payload (e.g. link validation result)
 */
async function logSmsToSupabase(bookingId, templateKey, returnDateStr, metadata) {
  const sb = getSupabaseAdmin();
  if (!sb || !bookingId) return;
  try {
    const date = returnDateStr || SMS_LOGS_SENTINEL_DATE;
    const row = {
      booking_id:          bookingId,
      template_key:        templateKey,
      return_date_at_send: date,
      // Always include priority so cross-cron cooldown queries are accurate.
      metadata: {
        priority: getSmsPriority(templateKey),
        ...(metadata && typeof metadata === "object" ? metadata : {}),
      },
    };
    const { error } = await sb
      .from("sms_logs")
      .upsert(
        row,
        { onConflict: "booking_id,template_key,return_date_at_send" }
      );
    if (error) {
      console.warn("scheduled-reminders: sms_logs write error (non-fatal):", error.message);
    }
  } catch (err) {
    console.warn("scheduled-reminders: sms_logs write failed (non-fatal):", err.message);
  }
}

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function loadBookedDates() {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });
  if (!getResp.ok) {
    if (getResp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null };
  }
  const fileData = await getResp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch { data = {}; }
  return { data, sha: fileData.sha };
}

async function saveBookedDates(data, sha, message) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content, branch: GITHUB_DATA_BRANCH };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
  }
}

/**
 * Remove a specific date range from booked-dates.json (non-fatal).
 * @param {string} vehicleId
 * @param {string} from - YYYY-MM-DD
 * @param {string} to   - YYYY-MM-DD
 */
async function removeFromBookedDates(vehicleId, from, to) {
  if (!process.env.GITHUB_TOKEN || !vehicleId || !from || !to) return;
  try {
    await updateJsonFileWithRetry({
      load:    loadBookedDates,
      apply:   (data) => {
        if (!Array.isArray(data[vehicleId])) return;
        data[vehicleId] = data[vehicleId].filter((r) => !(r.from === from && r.to === to));
      },
      save:    saveBookedDates,
      message: `Auto-complete: unblock ${vehicleId} ${from}→${to}`,
    });
  } catch (err) {
    console.error("scheduled-reminders: removeFromBookedDates failed (non-fatal):", err.message);
  }
}

async function loadFleetStatus() {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });
  if (!getResp.ok) {
    if (getResp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null };
  }
  const fileData = await getResp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch { data = {}; }
  return { data, sha: fileData.sha };
}

async function saveFleetStatus(data, sha, message) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content, branch: GITHUB_DATA_BRANCH };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
  }
}

/**
 * Previously wrote `available: true` to fleet-status.json on GitHub.
 * Availability is now derived automatically from the Supabase bookings table
 * by fleet-status.js — when a booking's status changes to `completed_rental`
 * it leaves the ACTIVE_BOOKING_STATUSES set, and the vehicle is automatically
 * shown as available again.  No manual flag write is needed.
 * @param {string} vehicleId
 */
async function markVehicleAvailable(vehicleId) {
  // No-op: availability is derived from bookings, not a manual flag.
  if (vehicleId) {
    console.log(`scheduled-reminders: markVehicleAvailable(${vehicleId}) — skipped, availability is now bookings-driven`);
  }
}

const BUSINESS_TZ = "America/Los_Angeles";

/**
 * Format a Date as a human-readable Los Angeles wall-clock string.
 * Used in debug logs so that timestamp comparisons are easy to reason about.
 * e.g. "5/1/2026, 3:00:00 PM PDT"
 * @param {Date} date
 * @returns {string}
 */
function toLAString(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return String(date);
  return date.toLocaleString("en-US", {
    timeZone:     BUSINESS_TZ,
    timeZoneName: "short",
    year:         "numeric",
    month:        "numeric",
    day:          "numeric",
    hour:         "numeric",
    minute:       "2-digit",
    second:       "2-digit",
    hour12:       true,
  });
}

function normalizeTimeForLAIso(time) {
  if (!time) return "00:00:00";
  const t = String(time).trim();
  const ampmMatch = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const mins = parseInt(ampmMatch[2], 10);
    const secs = parseInt(ampmMatch[3] || "0", 10);
    const period = ampmMatch[4].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  const h24Match = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24Match) {
    return `${String(parseInt(h24Match[1], 10)).padStart(2, "0")}:${String(parseInt(h24Match[2], 10)).padStart(2, "0")}:${String(parseInt(h24Match[3] || "0", 10)).padStart(2, "0")}`;
  }
  return "00:00:00";
}

/**
 * Centralized LA datetime builder for booking date+time fields.
 * Returns an absolute Date for the provided Los Angeles wall-clock datetime.
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - booking time (12h/24h)
 * @returns {Date}
 */
function buildDateTimeLA(date, time) {
  if (!date) return new Date(NaN);
  const datePart = String(date instanceof Date ? date.toISOString() : date).trim().split("T")[0];
  const timePart = normalizeTimeForLAIso(time);
  const approxUtc = new Date(`${datePart}T${timePart}Z`);
  let tzOffset = "-08:00"; // PST fallback when Intl offset extraction is unavailable
  try {
    const tzPart = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      timeZoneName: "longOffset",
    }).formatToParts(approxUtc).find((p) => p.type === "timeZoneName")?.value || "";
    const match = tzPart.match(/GMT([+-]\d{1,2}:\d{2})/);
    if (match) tzOffset = match[1];
  } catch {
    // Keep fallback offset.
  }
  return new Date(`${datePart}T${timePart}${tzOffset}`);
}

function parseBookingDateTimeLA(date, time) {
  return buildDateTimeLA(date, time);
}

/**
 * Parse a booking's pickup/return into a JS Date.
 * Date: YYYY-MM-DD  |  Time: "3:00 PM" or "15:00"
 *
 * NOTE: This function interprets times as server-local (UTC on Vercel).
 * Use parseBookingDateTimeLA for SMS trigger comparisons where LA wall-clock
 * time is required.
 *
 * @param {string} date  - YYYY-MM-DD
 * @param {string} [time] - optional time string
 * @returns {Date}
 */
function parseBookingDateTime(date, time) {
  if (!date) return new Date(NaN);
  const normalizedDate = date instanceof Date ? date.toISOString() : String(date).trim();
  const datePart = normalizedDate.split("T")[0];
  const base = new Date(datePart + "T00:00:00"); // midnight local
  if (time) {
    const t = time.trim();
    // "3:00 PM", "3:00:00 PM", or "3:00PM" format
    const ampmMatch = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (ampmMatch) {
      let hours = parseInt(ampmMatch[1], 10);
      const mins = parseInt(ampmMatch[2], 10);
      const secs = parseInt(ampmMatch[3] || "0", 10);
      const period = ampmMatch[4].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      base.setHours(hours, mins, secs, 0);
      return base;
    }
    // "15:00" or "15:00:00" format
    const h24Match = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (h24Match) {
      base.setHours(
        parseInt(h24Match[1], 10),
        parseInt(h24Match[2], 10),
        parseInt(h24Match[3] || "0", 10),
        0
      );
      return base;
    }
  }
  return base; // fall back to midnight if time can't be parsed
}

/**
 * Format a date object into a human-readable date string ("March 28").
 */
function formatDate(d) {
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/**
 * Format a date object into a human-readable time string ("3:00 PM").
 */
function formatTime(d) {
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/**
 * Safely send an SMS, catching errors so one failure doesn't abort the whole job.
 * @param {string} phone
 * @param {string} body
 * @returns {Promise<boolean>} true on success
 */
async function safeSend(phone, body) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    console.warn("scheduled-reminders: no phone number — skipping");
    return false;
  }
  try {
    await sendSms(normalized, body);
    return true;
  } catch (err) {
    console.error(`scheduled-reminders: SMS send failed to ${normalized}:`, err.message);
    return false;
  }
}

/**
 * Check if a reminder has already been sent for this booking.
 */
function alreadySent(booking, key) {
  return !!(booking.smsSentAt && booking.smsSentAt[key]);
}

function alreadySentAny(booking, keys) {
  return keys.some((key) => alreadySent(booking, key));
}

/**
 * Build template variables for a booking.
 */
function vars(booking) {
  const pickupDt = parseBookingDateTime(booking.pickupDate, booking.pickupTime);
  const returnDt = parseBookingDateTime(booking.returnDate, booking.returnTime);
  return {
    customer_name: booking.name || "Customer",
    vehicle:       booking.vehicleName || booking.vehicleId,
    pickup_date:   booking.pickupDate ? formatDate(pickupDt) : booking.pickupDate || "",
    pickup_time:   booking.pickupTime ? (formatTime(pickupDt) || formatTime12h(booking.pickupTime)) : "",
    return_time:   booking.returnTime ? (formatTime(returnDt) || formatTime12h(booking.returnTime)) : "",
    return_date:   booking.returnDate ? formatDate(returnDt) : booking.returnDate || "",
    location:      booking.location || DEFAULT_LOCATION,
    payment_link:  booking.paymentLink || "https://www.slytrans.com/balance.html",
  };
}

/**
 * Request admin approval before charging a late fee.
 *
 * Sends the owner:
 *   1. An email with Approve / Decline buttons (HTML links).
 *   2. An SMS with a short Approve link (if TEXTMAGIC is configured).
 *
 * The customer is notified that a late fee has been assessed (same
 * LATE_FEE_APPLIED SMS that was sent before) so they are aware.
 * The actual Stripe charge only happens when the admin clicks Approve.
 *
 * @param {object} booking
 * @param {number} feeAmount  — USD
 * @returns {Promise<boolean>} true if at least one notification was sent
 */
async function requestLateFeeApproval(booking, feeAmount) {
  const bookingId  = booking.bookingId || booking.paymentIntentId;
  const renterName = booking.name || "Customer";
  const vehicle    = booking.vehicleName || booking.vehicleId || "";

  let sent = false;

  // Build HMAC-signed approve / adjust / decline URLs (24 h expiry)
  const { approveUrl, declineUrl, adjustUrl } = buildLateFeeUrls(bookingId, feeAmount);

  // ── Email to owner ──────────────────────────────────────────────────────
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && OWNER_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_PORT === "465",
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      const escStr = (s) => String(s || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      await transporter.sendMail({
        from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:      OWNER_EMAIL,
        subject: `[Action Required] Late Fee $${feeAmount} — ${renterName} (${vehicle})`,
        html: `
          <h2>⏰ Late Return — Approval Required</h2>
          <p><strong>${escStr(renterName)}</strong> is overdue on their <strong>${escStr(vehicle)}</strong> rental.</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(bookingId)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(renterName)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(vehicle)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Late Fee</strong></td><td style="padding:8px;border:1px solid #ddd;color:#e53935"><strong>$${escStr(String(feeAmount))}</strong></td></tr>
          </table>
          <p style="margin-top:24px">
            <a href="${escStr(approveUrl)}" style="display:inline-block;padding:12px 24px;background:#4caf50;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;margin-right:12px">
              ✅ Approve &amp; Charge $${escStr(String(feeAmount))}
            </a>
            <a href="${escStr(adjustUrl)}" style="display:inline-block;padding:12px 24px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;margin-right:12px">
              ✏️ Adjust Amount
            </a>
            <a href="${escStr(declineUrl)}" style="display:inline-block;padding:12px 24px;background:#888;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">
              ❌ Decline — Do Not Charge
            </a>
          </p>
          <p style="color:#888;font-size:12px;margin-top:16px">These links expire in 24 hours. You can also charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>
          <p><strong>Sly Transportation Services LLC 🚗</strong></p>
        `,
        text: [
          `Late Return — Approval Required`,
          ``,
          `${renterName} is overdue on their ${vehicle} rental.`,
          `Booking ID : ${bookingId}`,
          `Late Fee   : $${feeAmount}`,
          ``,
          `APPROVE & charge: ${approveUrl}`,
          `ADJUST amount:    ${adjustUrl}`,
          `DECLINE (no charge): ${declineUrl}`,
          ``,
          `Links expire in 24 hours. Or charge manually from https://www.slytrans.com/admin-v2/`,
        ].join("\n"),
      });
      sent = true;
    } catch (err) {
      console.warn("scheduled-reminders: owner late-fee approval email failed:", err.message);
    }
  }

  // ── SMS to owner (short approve link) ──────────────────────────────────
  if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
    try {
      const smsText =
        `[SLY RIDES] Late fee alert: ${renterName} (${vehicle}) is overdue.\n` +
        `Approve $${feeAmount} charge: ${approveUrl}\n` +
        `Adjust amount: ${adjustUrl}\n` +
        `Decline (no charge): ${declineUrl}`;
      await sendSms(OWNER_PHONE, smsText);
      sent = true;
    } catch (err) {
      console.warn("scheduled-reminders: owner late-fee approval SMS failed:", err.message);
    }
  }

  return sent;
}

/**
 * Process all reserved_unpaid bookings — send payment reminders.
 */
async function processUnpaid(allBookings, now, sentMarks) {
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "reserved_unpaid") continue;
      if (!booking.phone) continue;

      // Use LA-timezone datetime so SMS fires at the correct wall-clock time in LA
      const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      const minutesUntilPickup = (pickupDt - now) / 60000;
      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);

      console.log("[SMS_TRIGGER]", {
        booking_ref: id, vehicleId, status: "reserved_unpaid",
        pickup_datetime: pickupDt.toISOString(), minutesUntilPickup: Math.round(minutesUntilPickup),
      });

      // 2-hour reminder (window: 2h–90min)
      if (minutesUntilPickup <= 120 && minutesUntilPickup > 90 && !alreadySent(booking, "unpaid_2h")) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_2H, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "unpaid_2h" });
      } else if (minutesUntilPickup <= 120 && minutesUntilPickup > 90) {
        console.log(`[SMS_SKIP] ${id} unpaid_2h: already sent`);
      }

      // Final reminder (window: 30–15 min)
      if (minutesUntilPickup <= 30 && minutesUntilPickup > 15 && !alreadySent(booking, "unpaid_final")) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_FINAL, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "unpaid_final" });
      } else if (minutesUntilPickup <= 30 && minutesUntilPickup > 15) {
        console.log(`[SMS_SKIP] ${id} unpaid_final: already sent`);
      }
    }
  }
}

/**
 * Process all booked_paid bookings — send pre-pickup reminders.
 */
async function processPaidBookings(allBookings, now, sentMarks) {
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "booked_paid") continue;
      if (!booking.phone) continue;

      // Use LA-timezone datetime so SMS fires at the correct wall-clock time in LA
      const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      const minutesUntilPickup = (pickupDt - now) / 60000;
      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);

      console.log("[SMS_TRIGGER]", {
        booking_ref: id, vehicleId, status: "booked_paid",
        pickup_datetime: pickupDt.toISOString(), minutesUntilPickup: Math.round(minutesUntilPickup),
      });

      // 24-hour reminder (window: 24h–23h)
      if (minutesUntilPickup <= 24 * 60 && minutesUntilPickup > 23 * 60 && !alreadySent(booking, "pickup_24h")) {
        const sent = await safeSend(booking.phone, render(PICKUP_REMINDER_24H, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "pickup_24h" });
      } else if (minutesUntilPickup <= 24 * 60 && minutesUntilPickup > 23 * 60) {
        console.log(`[SMS_SKIP] ${id} pickup_24h: already sent`);
      }
    }
  }
}

function logSmsTrigger(bookingRef, returnDatetime, currentTime, triggerType) {
  console.log("[SMS_TRIGGER]", {
    booking_ref: bookingRef || "",
    return_datetime: returnDatetime || "",
    current_time: currentTime || "",
    trigger_type: triggerType || "",
  });
}

/**
 * Process all active_rental bookings — end reminder, return-time messages, and late fees.
 *
 * SMS flow per booking (ordered by priority, highest first):
 *
 *   P1 — CRITICAL (always deliver, bypass cross-cron cooldown):
 *     • +2 h overdue           → LATE_FEE_APPLIED + owner approval request
 *     • +1 h overdue           → LATE_GRACE_EXPIRED
 *
 *   P2 — IMPORTANT (time-critical narrow windows, bypass cross-cron cooldown):
 *     • At return time         → LATE_AT_RETURN_TIME
 *     • 30 min before return   → LATE_WARNING_30MIN
 *
 *   P3 — STANDARD (cross-cron cooldown applies):
 *     • ~1 h before return     → ACTIVE_RENTAL_1H_BEFORE_END (extension invitation)
 *
 * Priority ordering:
 *   Triggers are evaluated from highest to lowest priority.  The `sentThisBooking`
 *   flag ensures at most ONE SMS fires per booking per cron tick — if a higher-
 *   priority trigger fires, all lower-priority triggers are skipped.
 *
 *   Time-critical keys (P1-P2) bypass the global cross-cron cooldown because
 *   their trigger windows (≤15 min) are shorter than any cooldown period and they
 *   carry their own smsSentAt + sms_logs deduplication.  The P3 extension invite
 *   goes through checkSmsCooldown so it is suppressed if maintenance-alerts or
 *   oil-check-cron already contacted the renter recently.
 *
 * Extension awareness:
 *   Every return-time SMS is logged to the Supabase sms_logs table with
 *   return_date_at_send = booking.returnDate.  When a rental is extended the
 *   return_date changes, so the old log rows no longer match and the messages
 *   fire correctly for the new schedule.  The legacy smsSentAt flags in
 *   bookings.json are still written for backwards compatibility.
 *
 * Anti-spam:
 *   phonesContactedThisRun tracks every phone number that received any SMS
 *   during this invocation.  If the same phone number appears on a second
 *   active booking (e.g. overlapping rentals) it is silently skipped so that
 *   no renter ever receives more than one message per cron tick.
 */
export async function processActiveRentals(allBookings, now, sentMarks) {
  const sb = getSupabaseAdmin();
  // Per-run dedup: max 1 SMS per phone number per cron invocation.
  const phonesContactedThisRun = new Set();
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "active_rental") continue;
      if (!booking.phone) continue;

      // Per-run anti-spam: skip if we already sent to this phone this run.
      if (phonesContactedThisRun.has(booking.phone)) {
        const skipId = booking.bookingId || booking.paymentIntentId;
        console.log(`[SMS_SKIP] ${skipId}: phone ${booking.phone} already contacted this run`);
        continue;
      }

      // Compute the final return date/time, incorporating any paid extensions
      // recorded in revenue_records so that SMS triggers always fire against the
      // renter's true (extended) return schedule, not a stale bookings.json date.
      const id = booking.bookingId || booking.paymentIntentId;
      const { date: finalDate, time: finalTime } = await computeFinalReturnDate(
        sb, id, booking.returnDate, booking.returnTime
      );

      // Use LA-timezone return datetime so return-time SMS triggers fire at the correct
      // wall-clock time in Los Angeles, not at UTC equivalents.
      const returnDt = parseBookingDateTimeLA(finalDate, finalTime);
      if (isNaN(returnDt.getTime())) continue;

      const v = vars(booking);
      const minutesUntilReturn = (returnDt - now) / 60000;
      const minsOverdue = -minutesUntilReturn; // positive = overdue
      const graceAt   = new Date(returnDt.getTime() + GRACE_OFFSET_MS);
      const lateFeeAt = new Date(returnDt.getTime() + LATE_FEE_OFFSET_MS);
      const nowIso    = now.toISOString();
      const returnIso = returnDt.toISOString();

      console.log("[SMS_ACTIVE]", {
        booking_ref:       id,
        vehicleId,
        return_la:         toLAString(returnDt),
        mins_until_return: Math.round(minutesUntilReturn),
        sent: {
          active_rental_1h_before_end: alreadySent(booking, "active_rental_1h_before_end"),
          late_warning_30min: alreadySent(booking, "late_warning_30min"),
          late_at_return:     alreadySent(booking, "late_at_return"),
          late_grace_expired: alreadySent(booking, "late_grace_expired"),
          late_fee_pending:   alreadySent(booking, "late_fee_pending"),
        },
      });

      if (process.env.DEBUG_TIMEZONE) {
        console.log("[TZ_DEBUG][ACTIVE_RENTAL]", {
          timezone:          BUSINESS_TZ,
          now_la:            toLAString(now),
          return_raw:        `${booking.returnDate} ${booking.returnTime || ""}`,
          return_final:      `${finalDate} ${finalTime}`,
          return_la:         toLAString(returnDt),
          mins_until_return: Math.round(minutesUntilReturn),
        });
      }

      // returnDateStr is stored in sms_logs so old triggers are invalidated when
      // the booking is extended to a new return_date.
      const returnDateStr = finalDate;

      // Track sentMarks count before processing this booking so we can detect
      // whether any SMS was sent and mark the phone as contacted.
      const marksBeforeBooking = sentMarks.length;

      // `sentThisBooking` is set to true the moment any SMS fires for this
      // booking.  All lower-priority trigger blocks check it first so that at
      // most ONE message is sent per booking per cron tick.  Triggers are
      // evaluated in priority order: P1 (CRITICAL) → P4 (MARKETING).
      let sentThisBooking = false;

      // ── P1: Late fee at return_datetime + 2 h (once per return_date) ─────────
      // Evaluated FIRST so that if a stale booking is overdue on both the grace
      // and late-fee windows simultaneously, the more critical fee fires.
      // The late_fee_pending key is scoped to the current return_date via
      // isSmsLogged so that a new late fee can be assessed after an extension.
      if (
        !sentThisBooking &&
        now >= lateFeeAt &&
        !alreadySent(booking, "late_fee_applied") &&
        !alreadySent(booking, "late_fee_pending") &&
        !booking.lateFeeApplied &&
        !(await isSmsLogged(id, "late_fee_pending", returnDateStr))
      ) {
        const hoursOverdue = minsOverdue / 60;

        // ── Guard 1: maximum overdue window ───────────────────────────────────
        // The late fee may only fire within MAX_FEE_OVERDUE_HOURS of the
        // scheduled return.  Beyond that threshold the booking should already
        // have been auto-completed (AUTO_COMPLETE_HOURS = 4 h).  A booking
        // that is still "active_rental" after 8+ hours has a stale status
        // (cron outage, Supabase write failure, etc.) and must NOT generate
        // a fee — doing so produced the $15,900 alert on bk-bb-2026-0407.
        if (hoursOverdue > MAX_FEE_OVERDUE_HOURS) {
          console.warn(
            `[LATE_FEE] SKIPPED booking ${id}: ` +
            `${hoursOverdue.toFixed(1)}h overdue exceeds MAX_FEE_OVERDUE_HOURS ` +
            `(${MAX_FEE_OVERDUE_HOURS}h). Booking has stale active_rental status — ` +
            `auto-complete should have closed this at ${AUTO_COMPLETE_HOURS}h. ` +
            `No late-fee alert will be sent.`
          );
        } else {
          // ── Guard 2: live Supabase status check ─────────────────────────────
          // Verify the booking is STILL active_rental in Supabase before
          // firing any alert.  A booking completed in Supabase but not yet
          // flushed from bookings.json would otherwise send alerts to past
          // renters.
          let bookingStillActive = true;
          if (sb) {
            try {
              const { data: sbStatusRow } = await sb
                .from("bookings")
                .select("status")
                .eq("booking_ref", id)
                .maybeSingle();
              if (sbStatusRow && !["active_rental", "active", "overdue"].includes(sbStatusRow.status)) {
                console.warn(
                  `[LATE_FEE] SKIPPED booking ${id}: Supabase status is ` +
                  `"${sbStatusRow.status}" (expected active_rental). ` +
                  `This booking is no longer active; no alert will be sent.`
                );
                bookingStillActive = false;
              }
            } catch (statusCheckErr) {
              console.warn(
                `[LATE_FEE] Supabase status check failed (non-fatal, proceeding): ` +
                statusCheckErr.message
              );
            }
          }

          if (bookingStillActive) {
            logSmsTrigger(id, returnIso, nowIso, "late_fee");
            // Calculate fee based on actual hours overdue:
            //   lateHours = ceil(minsOverdue / 60), minimum 1 hour
            //   feeAmount = min(lateHours × hourlyRate, MAX_LATE_FEE_USD)
            // Both the hourly calc and the hard cap prevent extreme values.
            const hourlyRate   = LATE_FEE_AMOUNTS[vehicleId] || 50;
            const lateHours    = Math.max(1, Math.ceil(minsOverdue / 60));
            const rawFeeAmount = Math.round(lateHours * hourlyRate);
            const feeAmount    = Math.min(rawFeeAmount, MAX_LATE_FEE_USD);

            // Always log so any future anomaly is visible in Vercel logs.
            console.log("[LATE_FEE]", {
              booking_id:     id,
              vehicle_id:     vehicleId,
              hours_overdue:  lateHours,
              rate_per_hour:  hourlyRate,
              calculated_fee: rawFeeAmount,
              capped_fee:     feeAmount,
              capped:         rawFeeAmount > MAX_LATE_FEE_USD,
            });

            const feeVars = { ...v, late_fee: String(feeAmount) };
            // 1. Notify customer that a late fee has been assessed
            const smsSent = await safeSend(booking.phone, render(LATE_FEE_APPLIED, feeVars));
            // 2. Request owner approval before charging
            const approvalSent = await requestLateFeeApproval(booking, feeAmount);
            if (smsSent || approvalSent) {
              sentThisBooking = true;
              sentMarks.push({ vehicleId, id, key: "late_fee_pending" });
              sentMarks.push({ vehicleId, id, key: "_late_fee_amount", value: feeAmount });
              await logSmsToSupabase(id, "late_fee_pending", returnDateStr);

              // Persist late_fee_status to Supabase for audit trail (non-fatal).
              try {
                const sbFee = getSupabaseAdmin();
                if (sbFee && id) {
                  await sbFee
                    .from("bookings")
                    .update({
                      late_fee_status: "pending_approval",
                      late_fee_amount: feeAmount,
                      updated_at:      new Date().toISOString(),
                    })
                    .eq("booking_ref", id);
                }
              } catch (sbFeeErr) {
                console.warn("scheduled-reminders: late_fee_status write failed (non-fatal):", sbFeeErr.message);
              }
            }
          }
        }
      }

      // ── P1: Grace expired at return_datetime + 1 h (15 min window) ───────────
      if (
        !sentThisBooking &&
        now >= graceAt && now < new Date(graceAt.getTime() + TRIGGER_WINDOW_MS) &&
        !alreadySent(booking, "late_grace_expired") &&
        !(await isSmsLogged(id, "late_grace_expired", returnDateStr))
      ) {
        logSmsTrigger(id, returnIso, nowIso, "grace");
        const sent = await safeSend(booking.phone, render(LATE_GRACE_EXPIRED, v));
        if (sent) {
          sentThisBooking = true;
          sentMarks.push({ vehicleId, id, key: "late_grace_expired" });
          await logSmsToSupabase(id, "late_grace_expired", returnDateStr);
        }
      } else if (now >= graceAt && now < new Date(graceAt.getTime() + TRIGGER_WINDOW_MS)) {
        console.log(`[SMS_SKIP] ${id} late_grace_expired: already sent (dedup)`);
      }

      // ── P2: At return time (0–15 min window) ──────────────────────────────────
      if (
        !sentThisBooking &&
        now >= returnDt && now < new Date(returnDt.getTime() + TRIGGER_WINDOW_MS) &&
        !alreadySent(booking, "late_at_return") &&
        !(await isSmsLogged(id, "late_at_return", returnDateStr))
      ) {
        logSmsTrigger(id, returnIso, nowIso, "ended");
        const sent = await safeSend(booking.phone, render(LATE_AT_RETURN_TIME, v));
        if (sent) {
          sentThisBooking = true;
          sentMarks.push({ vehicleId, id, key: "late_at_return" });
          await logSmsToSupabase(id, "late_at_return", returnDateStr);
        }
      } else if (now >= returnDt && now < new Date(returnDt.getTime() + TRIGGER_WINDOW_MS)) {
        console.log(`[SMS_SKIP] ${id} late_at_return: already sent (dedup)`);
      }

      // ── P2: 30 min before return ───────────────────────────────────────────────
      // Single consolidated end-of-rental reminder (replaces TextMagic automations
      // that were sending separate 1h, 30min, and 15min messages).
      if (
        !sentThisBooking &&
        minutesUntilReturn <= WARNING_BEFORE_END_UPPER_MIN && minutesUntilReturn > WARNING_BEFORE_END_LOWER_MIN &&
        !alreadySent(booking, "late_warning_30min") &&
        !(await isSmsLogged(id, "late_warning_30min", returnDateStr))
      ) {
        logSmsTrigger(id, returnIso, nowIso, "warning_30min");
        const sent = await safeSend(booking.phone, render(LATE_WARNING_30MIN, v));
        if (sent) {
          sentThisBooking = true;
          sentMarks.push({ vehicleId, id, key: "late_warning_30min" });
          await logSmsToSupabase(id, "late_warning_30min", returnDateStr);
        }
      } else if (minutesUntilReturn <= WARNING_BEFORE_END_UPPER_MIN && minutesUntilReturn > WARNING_BEFORE_END_LOWER_MIN) {
        console.log(`[SMS_SKIP] ${id} late_warning_30min: already sent (dedup)`);
      }

      // ── P3: ~1 hour before return — extension invitation ──────────────────────
      // Fires once in the 45–60 min window (well clear of the 15–30 min return-
      // obligation window below) so renters never receive both in the same tick.
      // Cross-cron cooldown applies: if maintenance-alerts or oil-check-cron
      // already contacted this renter recently, this low-urgency invite is skipped.
      if (
        !sentThisBooking &&
        minutesUntilReturn <= EXT_REMINDER_UPPER_MIN && minutesUntilReturn > EXT_REMINDER_LOWER_MIN &&
        !alreadySent(booking, "active_rental_1h_before_end") &&
        !(await isSmsLogged(id, "active_rental_1h_before_end", returnDateStr))
      ) {
        const cooldown = await checkSmsCooldown(sb, id, "active_rental_1h_before_end");
        if (!cooldown.allowed) {
          console.log(`[SMS_SKIP] ${id} active_rental_1h_before_end: cross-cron cooldown (${cooldown.reason})`);
        } else {
          logSmsTrigger(id, returnIso, nowIso, "ext_reminder_1h");
          const sent = await safeSend(booking.phone, render(ACTIVE_RENTAL_1H_BEFORE_END, v));
          if (sent) {
            sentThisBooking = true;
            sentMarks.push({ vehicleId, id, key: "active_rental_1h_before_end" });
            await logSmsToSupabase(id, "active_rental_1h_before_end", returnDateStr);
          }
        }
      } else if (minutesUntilReturn <= EXT_REMINDER_UPPER_MIN && minutesUntilReturn > EXT_REMINDER_LOWER_MIN) {
        console.log(`[SMS_SKIP] ${id} active_rental_1h_before_end: already sent (dedup)`);
      }

      // Per-run dedup: if any SMS was sent for this booking, mark the phone so
      // a second active booking on the same number is skipped this run.
      if (sentMarks.length > marksBeforeBooking) {
        phonesContactedThisRun.add(booking.phone);
      }
    }
  }
}

/**
 * Process completed_rental bookings — post-rental and retention SMS.
 */
async function processCompleted(allBookings, now, sentMarks) {
  const retentionSchedule = [
    { days: 7,  key: "retention_7d",  template: RETENTION_DAY_7 },
  ];

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "completed_rental") continue;
      if (!booking.phone || !booking.completedAt) continue;

      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);
      const completedAt = new Date(booking.completedAt);
      const hoursSinceComplete = (now - completedAt) / 3600000;

      // Thank-you immediately on completion (within 1 hour)
      if (hoursSinceComplete < 1 && !alreadySent(booking, "post_thank_you")) {
        const sent = await safeSend(booking.phone, render(POST_RENTAL_THANK_YOU, v));
        if (sent) {
          sentMarks.push({ vehicleId, id, key: "post_thank_you" });
          // Promote to past_customer in TextMagic contact database
          if (booking.phone) {
            try {
              await upsertContact(normalizePhone(booking.phone), booking.name || "", {
                addTags:    ["past_customer"],
                removeTags: ["booked"],
              });
            } catch (contactErr) {
              console.error("scheduled-reminders: TextMagic contact update failed:", contactErr);
            }
          }
        }
      }

      // Retention sequence
      for (const item of retentionSchedule) {
        const targetHours = item.days * 24;
        if (
          hoursSinceComplete >= targetHours &&
          hoursSinceComplete < targetHours + 24 &&
          !alreadySent(booking, item.key)
        ) {
          const sent = await safeSend(booking.phone, render(item.template, v));
          if (sent) sentMarks.push({ vehicleId, id, key: item.key });
        }
      }
    }
  }
}

/**
 * Persist all reminder sent-marks back to bookings.json.
 * Uses updateJsonFileWithRetry so stale-SHA conflicts are retried automatically.
 */
async function persistSentMarks(sentMarks) {
  if (sentMarks.length === 0) return;
  if (!process.env.GITHUB_TOKEN) return;

  try {
    await updateJsonFileWithRetry({
      load:  loadBookings,
      apply: (data) => {
        for (const mark of sentMarks) {
          const { vehicleId, id, key, value } = mark;
          if (!Array.isArray(data[vehicleId])) continue;
          const idx = data[vehicleId].findIndex(
            (b) => b.bookingId === id || b.paymentIntentId === id
          );
          if (idx === -1) continue;

          if (key === "_late_fee_amount") {
            data[vehicleId][idx].lateFeeApplied = value;
          } else {
            if (!data[vehicleId][idx].smsSentAt) data[vehicleId][idx].smsSentAt = {};
            data[vehicleId][idx].smsSentAt[key] = new Date().toISOString();
          }
        }
      },
      save:    saveBookings,
      message: `scheduled-reminders: record ${sentMarks.length} sent marks`,
    });
  } catch (err) {
    console.error("scheduled-reminders: failed to persist sent marks:", err);
  }
}

/**
 * Auto-activate booked_paid bookings whose pickup date/time has arrived.
 * Transitions status from "booked_paid" → "active_rental" in bookings.json
 * and syncs to Supabase.  Non-fatal: errors are logged and never propagate.
 *
 * @param {object} allBookings - current bookings data snapshot
 * @param {Date}   now
 */
export async function processAutoActivations(allBookings, now) {
  if (!process.env.GITHUB_TOKEN) return;

  // Respect the admin toggle — skip the entire cycle when disabled.
  const enabled = await loadBooleanSetting("auto_activate_on_pickup", true);
  if (!enabled) {
    console.log("scheduled-reminders: auto_activate_on_pickup is disabled — skipping auto-activations");
    return;
  }

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "booked_paid") continue;

      // Use LA-timezone pickup datetime so auto-activation fires at the correct
      // wall-clock time in Los Angeles, not at the UTC equivalent.
      const pickupDt = parseBookingDateTimeLA(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      if (process.env.DEBUG_TIMEZONE) {
        console.log("[TZ_DEBUG][AUTO_ACTIVATE]", {
          timezone:        BUSINESS_TZ,
          now_la:          toLAString(now),
          pickup_raw:      `${booking.pickupDate} ${booking.pickupTime || ""}`,
          pickup_la:       toLAString(pickupDt),
        });
      }

      // Only activate once pickup time has arrived (or passed)
      if (now < pickupDt) continue;

      const id          = booking.bookingId || booking.paymentIntentId;
      const activatedAt = now.toISOString();

      console.log(
        `scheduled-reminders: auto-activating ${vehicleId} booking ${id} ` +
        `(pickup was ${booking.pickupDate} ${booking.pickupTime || ""})`
      );

      try {
        await updateBooking(vehicleId, id, {
          status:      "active_rental",
          activatedAt,
          updatedAt:   activatedAt,
        });

        const activatedBooking = {
          ...booking,
          status:      "active_rental",
          activatedAt,
          updatedAt:   activatedAt,
        };
        await autoUpsertBooking(activatedBooking);
      } catch (err) {
        console.error(
          `scheduled-reminders: auto-activation failed for ${vehicleId}/${id} (non-fatal):`,
          err.message
        );
      }
    }
  }
}

/**
 * Auto-complete active_rental bookings that are past their return time by
 * AUTO_COMPLETE_HOURS hours.  Updates bookings.json status to
 * "completed_rental", removes blocked dates, restores fleet-status.json to
 * available, and syncs to Supabase.
 * Non-fatal: errors are logged and never propagate.
 *
 * @param {object} allBookings - current bookings data snapshot
 * @param {Date}   now
 */
export async function processAutoCompletions(allBookings, now) {
  if (!process.env.GITHUB_TOKEN) return;

  const sb = getSupabaseAdmin();
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "active_rental") continue;

      // Compute the final return date/time, incorporating any paid extensions
      // from revenue_records so auto-completion fires against the renter's true
      // (possibly extended) return schedule — never against a stale base date.
      const id = booking.bookingId || booking.paymentIntentId;
      const { date: finalDate, time: finalTime } = await computeFinalReturnDate(
        sb, id, booking.returnDate, booking.returnTime
      );

      // Use LA-timezone return datetime so the 4-hour auto-complete threshold is
      // measured from the correct Los Angeles wall-clock return time, not UTC.
      const returnDt = parseBookingDateTimeLA(finalDate, finalTime);
      if (isNaN(returnDt.getTime())) continue;

      const minsOverdue = (now - returnDt) / 60000;

      if (process.env.DEBUG_TIMEZONE) {
        console.log("[TZ_DEBUG][AUTO_COMPLETE]", {
          timezone:       BUSINESS_TZ,
          now_la:         toLAString(now),
          return_raw:     `${booking.returnDate} ${booking.returnTime || ""}`,
          return_final:   `${finalDate} ${finalTime}`,
          return_la:      toLAString(returnDt),
          mins_overdue:   Math.round(minsOverdue),
        });
      }

      if (minsOverdue < AUTO_COMPLETE_HOURS * 60) continue;

      const completedAt = now.toISOString();

      console.log(
        `scheduled-reminders: auto-completing ${vehicleId} booking ${id} ` +
        `(${Math.round(minsOverdue)} min past return time)`
      );

      try {
        // Update status and completedAt in bookings.json
        await updateBooking(vehicleId, id, {
          status:      "completed_rental",
          completedAt,
          updatedAt:   completedAt,
        });

        // Sync to Supabase
        const completedBooking = {
          ...booking,
          status:      "completed_rental",
          completedAt,
          updatedAt:   completedAt,
        };
        await autoUpsertCustomer(completedBooking, true); // countStats=true: increment total_bookings/total_spent
        await autoUpsertBooking(completedBooking);

        // Free up the dates in booked-dates.json
        await removeFromBookedDates(vehicleId, booking.pickupDate, booking.returnDate);

        // Re-enable the vehicle in fleet-status.json so the website shows it
        // as bookable again — but only if no other active_rental remains for
        // this vehicle (handles the case where a follow-on booking is already
        // active at the same time).
        const otherActiveRentals = (allBookings[vehicleId] || []).filter(
          (b) => (b.bookingId || b.paymentIntentId) !== id && b.status === "active_rental"
        );
        if (otherActiveRentals.length === 0) {
          await markVehicleAvailable(vehicleId);
        }

        // Send rental-completed notification emails (non-fatal).
        // Owner receives an alert so they know the rental has ended.
        // Renter receives a thank-you email with return confirmation.
        if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
          try {
            const escStr = (s) => String(s || "")
              .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

            const transporter = nodemailer.createTransport({
              host:   process.env.SMTP_HOST,
              port:   parseInt(process.env.SMTP_PORT || "587"),
              secure: process.env.SMTP_PORT === "465",
              auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            });

            const completedDate = new Date(completedAt).toLocaleDateString("en-US", {
              timeZone: "America/Los_Angeles",
              weekday: "long", year: "numeric", month: "long", day: "numeric",
            });
            const renterName   = booking.name        || "Valued Customer";
            const vehicleName  = booking.vehicleName || vehicleId;

            // Owner alert
            if (OWNER_EMAIL) {
              await transporter.sendMail({
                from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
                to:      OWNER_EMAIL,
                subject: `[SLY RIDES] ✅ Rental Completed — ${escStr(renterName)} (${escStr(vehicleName)})`,
                html: `
                  <h2 style="color:#1a237e">Rental Completed</h2>
                  <p><strong>${escStr(renterName)}</strong>'s rental of the <strong>${escStr(vehicleName)}</strong> has been automatically marked as completed.</p>
                  <table style="border-collapse:collapse;width:100%;margin:16px 0">
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd"><code>${escStr(id)}</code></td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(vehicleName)}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(renterName)}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.phone || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.pickupDate || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.returnDate || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Completed At</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(completedDate)} (LA time)</td></tr>
                    ${booking.extensionCount ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Extensions</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(String(booking.extensionCount))}</td></tr>` : ""}
                  </table>
                  <p style="color:#666;font-size:13px">This email was auto-generated by the SLY RIDES scheduler.</p>
                `,
              });
            }

            // Renter thank-you email
            const renterEmail = booking.email;
            if (renterEmail) {
              const firstName = renterName.split(" ")[0];
              await transporter.sendMail({
                from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
                to:      renterEmail,
                subject: "Thank you for renting with SLY RIDES!",
                html: `
                  <h2 style="color:#1a237e">Thank You for Renting with SLY RIDES!</h2>
                  <p>Hi ${escStr(firstName)},</p>
                  <p>Your rental of the <strong>${escStr(vehicleName)}</strong> has been completed on <strong>${escStr(completedDate)}</strong>.</p>
                  <p>We hope you had a great experience! We'd love to have you back.</p>
                  <table style="border-collapse:collapse;width:100%;margin:16px 0">
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(vehicleName)}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.pickupDate || "—")}</td></tr>
                    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return</strong></td><td style="padding:8px;border:1px solid #ddd">${escStr(booking.returnDate || "—")}</td></tr>
                  </table>
                  <p>Ready to book again? Visit <a href="https://www.slytrans.com/cars.html">www.slytrans.com</a>.</p>
                  <p>Questions? Call us at <a href="tel:+12139166606">(213) 916-6606</a> or email <a href="mailto:${escStr(OWNER_EMAIL)}">${escStr(OWNER_EMAIL)}</a>.</p>
                  <p style="color:#666;font-size:13px">Sly Transportation Services LLC · Los Angeles, CA</p>
                `,
              });
            }
          } catch (emailErr) {
            console.error(
              `scheduled-reminders: rental-completed email failed for ${vehicleId}/${id} (non-fatal):`,
              emailErr.message
            );
          }
        }
      } catch (err) {
        console.error(
          `scheduled-reminders: auto-completion failed for ${vehicleId}/${id} (non-fatal):`,
          err.message
        );
      }
    }
  }
}


/**
 * Returns true when all new-mismatch PIs have been handled (either auto-repaired
 * or intentionally skipped because they are non-new-booking payment types).
 */
function areAllPaymentsHandled(newMismatches, repairedPIIds, failedPIIds, nonNewBookingTypes) {
  if (failedPIIds.length > 0) return false;
  return newMismatches.every(
    (pi) => repairedPIIds.includes(pi.id) || nonNewBookingTypes.has((pi.metadata || {}).payment_type || "")
  );
}

/**
 * Reconciliation check — runs once per cron tick.
 *
 * Fetches the last 24 h of succeeded Stripe PaymentIntents and compares them
 * against the `revenue_records` table.  Any PaymentIntent that has no matching
 * revenue record (matched by payment_intent_id or booking_id column) is
 * flagged as a mismatch and an alert is sent to the owner via email and SMS.
 *
 * Non-fatal — errors are caught and logged so the rest of the cron job is
 * never blocked by a reconciliation failure.
 */
async function runReconciliation() {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // Fetch PaymentIntents succeeded in the last 24 hours
    const since = Math.floor(Date.now() / 1000) - 86400;
    const piList = await stripe.paymentIntents.list({
      limit:  100,
      created: { gte: since },
    });

    const succeededPIs = piList.data.filter((pi) => pi.status === "succeeded");
    if (succeededPIs.length === 0) return;

    // Fetch matching revenue_records by payment_intent_id
    const piIds = succeededPIs.map((pi) => pi.id);
    const { data: rrRows } = await sb
      .from("revenue_records")
      .select("payment_intent_id, booking_id")
      .in("payment_intent_id", piIds);

    const recordedPIIds = new Set((rrRows || []).map((r) => r.payment_intent_id).filter(Boolean));

    // Also match extension rows that use the PI id as booking_id
    const { data: extRows } = await sb
      .from("revenue_records")
      .select("booking_id")
      .in("booking_id", piIds);

    const recordedAsBookingId = new Set((extRows || []).map((r) => r.booking_id).filter(Boolean));

    // For rental_extension PIs whose revenue record stores the original booking ref
    // (not the PI id) as booking_id, perform an extra lookup by booking_id.
    // This prevents extension payments that were already processed by the webhook
    // from appearing as mismatches (and showing "⚠️ Skipped (manual)" in alerts).
    // Fall back to metadata.original_booking_id for PIs created before extend-rental.js
    // was updated to emit booking_id, preserving backward compatibility.
    const extensionOriginalBookingIds = succeededPIs
      .filter((pi) => (pi.metadata?.payment_type || pi.metadata?.type) === "rental_extension")
      .map((pi) => pi.metadata?.booking_id || pi.metadata?.original_booking_id)
      .filter(Boolean);

    const handledExtensionPIIds = new Set();
    if (extensionOriginalBookingIds.length > 0) {
      const { data: extRevenueRows } = await sb
        .from("revenue_records")
        .select("payment_intent_id, booking_id")
        .in("booking_id", extensionOriginalBookingIds);
      const processedExtPIIds = new Set(
        (extRevenueRows || []).map((r) => r.payment_intent_id).filter(Boolean)
      );
      for (const pi of succeededPIs) {
        if ((pi.metadata?.payment_type || pi.metadata?.type) === "rental_extension" && processedExtPIIds.has(pi.id)) {
          handledExtensionPIIds.add(pi.id);
        }
      }
    }

    const mismatches = succeededPIs.filter(
      (pi) => !recordedPIIds.has(pi.id) && !recordedAsBookingId.has(pi.id) && !handledExtensionPIIds.has(pi.id)
    );

    if (mismatches.length === 0) {
      console.log(`scheduled-reminders reconciliation: all ${succeededPIs.length} PI(s) have matching revenue records ✓`);
      return;
    }

    // ── Deduplication: only alert once per PI ID per 25-hour window ─────────
    // Without this guard the 15-minute cron re-alerts for the same payment up
    // to 96 times before the PI falls out of the 24-hour look-back window.
    const DEDUP_KEY = "reconciliation_alerted_pi_ids";
    let alertedPIs = {}; // { [piId]: ISO timestamp of when first alerted }
    try {
      const { data: configRow } = await sb
        .from("app_config")
        .select("value")
        .eq("key", DEDUP_KEY)
        .maybeSingle();
      if (configRow && configRow.value && typeof configRow.value === "object") {
        alertedPIs = configRow.value;
      }
    } catch (readErr) {
      console.warn("scheduled-reminders reconciliation: failed to read dedup state (non-fatal):", readErr.message);
    }

    // Prune entries older than 25 hours so the map doesn't grow unbounded
    const cutoffMs = Date.now() - 25 * 60 * 60 * 1000;
    for (const [piId, ts] of Object.entries(alertedPIs)) {
      if (new Date(ts).getTime() < cutoffMs) delete alertedPIs[piId];
    }

    const newMismatches = mismatches.filter((pi) => !alertedPIs[pi.id]);
    if (newMismatches.length === 0) {
      console.log(`scheduled-reminders reconciliation: ${mismatches.length} mismatch(es) already alerted — skipping repeat notification`);
      return;
    }

    console.warn(`scheduled-reminders reconciliation: ${newMismatches.length} PI(s) missing from revenue_records`, newMismatches.map((pi) => pi.id));

    // ── Auto-repair: replay full booking pipeline for each unmatched PI ──────
    // Uses the same pipeline as the Stripe webhook (stripe-webhook.js) so every
    // step fires: customer upsert → booking upsert → revenue record → blocked
    // dates → fleet-status update → owner + customer notification emails.
    // All steps are idempotent — safe to call even if a partial record already exists.
    //
    // Payment types that mutate an existing booking (rental_extension,
    // balance_payment, slingshot_balance_payment) are excluded — they must be
    // reviewed manually if they appear here.
    const NON_NEW_BOOKING_TYPES = new Set([
      "rental_extension",
      "balance_payment",
      "slingshot_balance_payment",
    ]);

    const repairedPIIds = [];
    const failedPIIds   = [];

    for (const pi of newMismatches) {
      const piMetaReconcile = pi.metadata || {};
      const paymentType = piMetaReconcile.payment_type || piMetaReconcile.type || "";
      if (NON_NEW_BOOKING_TYPES.has(paymentType)) {
        console.warn(
          `scheduled-reminders reconciliation: PI ${pi.id} has payment_type=${paymentType} — skipping auto-repair (manual review needed)`
        );
        continue;
      }

      try {
        // 1. Persist booking + revenue record (idempotent).
        //    saveWebhookBookingRecord performs the canonical vehicle_id mapping
        //    internally, so its result is authoritative for the vehicle key.
        await saveWebhookBookingRecord(pi);

        // 2. Block calendar dates and mark vehicle unavailable.
        //    mapVehicleId derives the canonical ID from PI metadata so that
        //    the GitHub JSON files always receive the correct key.
        const meta = pi.metadata || {};
        if (meta.pickup_date && meta.return_date) {
          let reconVehicleId = "";
          try {
            reconVehicleId = mapVehicleId(meta);
          } catch (mapErr) {
            console.warn(
              `scheduled-reminders reconciliation: vehicle_id mapping failed for PI ${pi.id}: ${mapErr.message}` +
              " — skipping blockBookedDates/markVehicleUnavailable"
            );
          }
          if (reconVehicleId) {
            await blockBookedDates(
              reconVehicleId,
              meta.pickup_date,
              meta.return_date,
              meta.pickup_time  || "",
              meta.return_time  || ""
            );
            await markVehicleUnavailable(reconVehicleId);
          }
        }

        // 3. Send owner + customer notification emails
        //    sendWebhookNotificationEmails checks the email_sent flag on
        //    pending_booking_docs so the owner is never emailed twice.
        await sendWebhookNotificationEmails(pi);

        repairedPIIds.push(pi.id);
        console.log(`scheduled-reminders reconciliation: auto-repaired PI ${pi.id} (${paymentType || "full_payment"})`);
      } catch (repairErr) {
        failedPIIds.push(pi.id);
        console.error(
          `scheduled-reminders reconciliation: auto-repair failed for PI ${pi.id}:`,
          repairErr.message
        );
      }
    }

    const escStr = (s) => String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const rows = newMismatches.map((pi) => {
      const meta      = pi.metadata || {};
      const repaired  = repairedPIIds.includes(pi.id);
      const failed    = failedPIIds.includes(pi.id);
      const status    = repaired ? "✅ Auto-processed" : (failed ? "❌ Repair failed" : "⚠️ Skipped (manual)");
      return `<tr>
        <td style="padding:6px;border:1px solid #ddd">${escStr(pi.id)}</td>
        <td style="padding:6px;border:1px solid #ddd">$${(pi.amount / 100).toFixed(2)}</td>
        <td style="padding:6px;border:1px solid #ddd">${escStr(meta.original_booking_id || meta.booking_id || "—")}</td>
        <td style="padding:6px;border:1px solid #ddd">${escStr(meta.payment_type || "—")}</td>
        <td style="padding:6px;border:1px solid #ddd">${new Date(pi.created * 1000).toISOString()}</td>
        <td style="padding:6px;border:1px solid #ddd">${status}</td>
      </tr>`;
    }).join("\n");

    const skippedPIIds = newMismatches
      .filter((pi) => !repairedPIIds.includes(pi.id) && !failedPIIds.includes(pi.id))
      .map((pi) => pi.id);
    // ✅ subject only when every mismatch was actually auto-processed (no failures, no skipped-for-manual-review)
    const allAutoProcessed = failedPIIds.length === 0 && skippedPIIds.length === 0 && repairedPIIds.length > 0;
    const subject = allAutoProcessed
      ? `[SLY RIDES] ✅ ${repairedPIIds.length} Payment(s) Auto-Processed`
      : `[SLY RIDES] ⚠️ ${newMismatches.length} Payment(s) Detected – ${repairedPIIds.length} Auto-Processed`;

    // Email alert
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && OWNER_EMAIL) {
      try {
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_PORT === "465",
          auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
          to:      OWNER_EMAIL,
          subject,
          html: `
            <h2>${allAutoProcessed ? "✅ Payments Auto-Processed" : "⚠️ Payment Recovery Summary"}</h2>
            <p>${newMismatches.length} Stripe PaymentIntent(s) were detected without matching revenue records. The system attempted to process each one${repairedPIIds.length > 0 ? " — a separate booking confirmation email has been sent for each successfully processed payment" : ""}.</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <thead>
                <tr style="background:#f5f5f5">
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">PaymentIntent ID</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Amount</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Booking ID</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Type</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Created</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            ${failedPIIds.length > 0
              ? `<p style="color:#d32f2f">⚠️ <strong>${failedPIIds.length} payment(s) could not be auto-processed.</strong> Please review them manually in the <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a> and the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
              : skippedPIIds.length > 0
                ? `<p style="color:#e65100">⚠️ <strong>${skippedPIIds.length} payment(s) require manual review</strong> (type not eligible for auto-processing). Please review them in the <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a> and the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
                : `<p>✅ All detected payments have been processed. Please verify them in the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`}
            <p><strong>Sly Transportation Services LLC 🚗</strong></p>
          `,
          text: [
            subject,
            "",
            allAutoProcessed
              ? `${repairedPIIds.length} payment(s) were auto-processed successfully.`
              : `${repairedPIIds.length}/${newMismatches.length} payment(s) were auto-processed. ${failedPIIds.length} failed. ${skippedPIIds.length} require manual review.`,
            "",
            ...newMismatches.map((pi) => {
              const repaired = repairedPIIds.includes(pi.id);
              const failed   = failedPIIds.includes(pi.id);
              const st       = repaired ? "[PROCESSED]" : (failed ? "[FAILED]" : "[SKIPPED]");
              return `  ${st} ${pi.id}  $${(pi.amount / 100).toFixed(2)}`;
            }),
            "",
            "Admin Panel: https://www.slytrans.com/admin-v2/",
          ].join("\n"),
        });
      } catch (emailErr) {
        console.warn("scheduled-reminders reconciliation: alert email failed:", emailErr.message);
      }
    }

    // SMS alert (brief — only when manual intervention is needed)
    const manualPIIds = [...failedPIIds, ...skippedPIIds];
    if (manualPIIds.length > 0 && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
      try {
        const manualSummary = newMismatches
          .filter((pi) => manualPIIds.includes(pi.id))
          .slice(0, 3)
          .map((pi) => `${pi.id} ($${(pi.amount / 100).toFixed(2)})`)
          .join(", ");
        const smsText = `[SLY RIDES] ⚠️ ${manualPIIds.length} payment(s) need manual review: ${manualSummary}${manualPIIds.length > 3 ? ` +${manualPIIds.length - 3} more` : ""}. Check email.`;
        await sendSms(OWNER_PHONE, smsText);
      } catch (smsErr) {
        console.warn("scheduled-reminders reconciliation: alert SMS failed:", smsErr.message);
      }
    }

    // Persist the newly alerted PI IDs so we don't re-alert on the next cron tick
    try {
      const nowIso = new Date().toISOString();
      for (const pi of newMismatches) alertedPIs[pi.id] = nowIso;
      await sb.from("app_config").upsert(
        { key: DEDUP_KEY, value: alertedPIs, updated_at: nowIso },
        { onConflict: "key" }
      );
    } catch (dedupErr) {
      console.warn("scheduled-reminders reconciliation: failed to persist dedup state (non-fatal):", dedupErr.message);
    }
  } catch (err) {
    console.error("scheduled-reminders reconciliation: unexpected error (non-fatal):", err.message);
  }
}


export default async function handler(req, res) {
  // Accept GET (Vercel cron) or POST (manual admin trigger)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Authenticate manual POST requests
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  let allBookings;
  try {
    // TODO (Phase 3 — pending Supabase schema for smsSentAt): migrate primary
    // booking read to Supabase once a smsSentAt column is added to the bookings
    // table. Until then, bookings.json remains authoritative for smsSentAt
    // deduplication markers used by all processAuto* and reminder functions.
    const loaded = await loadBookings();
    allBookings = loaded.data;
  } catch (err) {
    console.error("scheduled-reminders: failed to load bookings:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }

  const now = new Date();

  // Auto-activate and auto-complete bookings regardless of SMS configuration.
  // These must run on every cron tick so overdue bookings never stay stuck.
  await processAutoActivations(allBookings, now);
  await processAutoCompletions(allBookings, now);

  // Reconcile Stripe payments against revenue_records (runs every tick, non-fatal).
  await runReconciliation();

  // SMS reminders require TextMagic credentials.
  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    console.warn("scheduled-reminders: TextMagic credentials not set — SMS will not be sent");
    return res.status(200).json({ skipped: true, reason: "TextMagic not configured" });
  }

  // Enforce 8 AM – 7 PM LA send window for cron-triggered runs.
  // Manual POST bypasses the window to allow out-of-hours testing.
  // Auto-activations, auto-completions, and reconciliation already ran above
  // and are always executed regardless of the SMS window.
  if (req.method === "GET") {
    const hour = laHour();
    if (hour < SMS_WINDOW_START_HOUR || hour >= SMS_WINDOW_END_HOUR) {
      return res.status(200).json({
        skipped: true,
        reason:  `Outside SMS send window (${SMS_WINDOW_START_HOUR}:00–${SMS_WINDOW_END_HOUR}:00 LA). Current LA hour: ${hour}.`,
      });
    }
  }

  const sentMarks = [];

  await Promise.allSettled([
    processUnpaid(allBookings, now, sentMarks),
    processPaidBookings(allBookings, now, sentMarks),
    processActiveRentals(allBookings, now, sentMarks),
    processCompleted(allBookings, now, sentMarks),
  ]);

  await persistSentMarks(sentMarks);

  return res.status(200).json({ ok: true, remindersSent: sentMarks.filter(m => !m.key.startsWith("_")).length });
}
