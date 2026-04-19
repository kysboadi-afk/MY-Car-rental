// api/scheduled-reminders.js
// Vercel cron serverless function — scans bookings.json and sends automated
// SMS reminders based on booking status and timing.
//
// This endpoint is called by Vercel Cron on a frequent schedule (every 15 min).
// It is also callable manually from an admin panel via POST with an
// Authorization: Bearer <CRON_SECRET> header.
//
// Reminder types fired per booking status:
//
//  reserved_unpaid  → UNPAID_REMINDER_24H, UNPAID_REMINDER_2H, UNPAID_REMINDER_FINAL
//  booked_paid      → PICKUP_REMINDER_24H, PICKUP_REMINDER_2H, PICKUP_REMINDER_30MIN
//                     + auto-activated → active_rental once pickup time arrives
//  active_rental    → ACTIVE_RENTAL_MID, ACTIVE_RENTAL_1H_BEFORE_END,
//                     ACTIVE_RENTAL_15MIN_BEFORE_END, LATE_WARNING_30MIN,
//                     LATE_AT_RETURN_TIME, LATE_GRACE_EXPIRED, LATE_FEE_APPLIED
//                     + auto-completed → completed_rental after AUTO_COMPLETE_HOURS
//  completed_rental → POST_RENTAL_THANK_YOU, RETENTION_DAY_1/3/7/14/30
//
// Required environment variables:
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY
//   GITHUB_TOKEN, GITHUB_REPO
//   CRON_SECRET  — shared secret to authenticate manual trigger calls
//   STRIPE_SECRET_KEY  — for auto-charging late fees
//
// Vercel cron configuration is in vercel.json.

import nodemailer from "nodemailer";
import { sendSms } from "./_textmagic.js";
import {
  render,
  DEFAULT_LOCATION,
  UNPAID_REMINDER_24H,
  UNPAID_REMINDER_2H,
  UNPAID_REMINDER_FINAL,
  PICKUP_REMINDER_24H,
  PICKUP_REMINDER_2H,
  PICKUP_REMINDER_30MIN,
  ACTIVE_RENTAL_MID,
  ACTIVE_RENTAL_1H_BEFORE_END,
  ACTIVE_RENTAL_15MIN_BEFORE_END,
  LATE_WARNING_30MIN,
  LATE_AT_RETURN_TIME,
  LATE_GRACE_EXPIRED,
  LATE_FEE_APPLIED,
  POST_RENTAL_THANK_YOU,
  RETENTION_DAY_1,
  RETENTION_DAY_3,
  RETENTION_DAY_7,
  RETENTION_DAY_14,
  RETENTION_DAY_30,
} from "./_sms-templates.js";
import { loadBookings, saveBookings, normalizePhone, updateBooking } from "./_bookings.js";
import { upsertContact } from "./_contacts.js";
import { CARS } from "./_pricing.js";
import { autoUpsertBooking, autoUpsertCustomer } from "./_booking-automation.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { buildLateFeeUrls } from "./_late-fee-token.js";
import { loadBooleanSetting } from "./_settings.js";
import { getSupabaseAdmin } from "./_supabase.js";
import Stripe from "stripe";

// ─── Grace periods (in minutes) per vehicle type ──────────────────────────────
const GRACE_PERIODS = {
  slingshot:  30,   // 30-minute grace, then $100/hour late fee
  camry:      60,
  camry2013:  60,
};

// ─── Late fee amounts ($) per vehicle type ────────────────────────────────────
const LATE_FEE_AMOUNTS = {
  slingshot:  100,  // $100/hour after 30-min grace
  camry:      50,   // $50 flat after 2h; full day after 4–6h (simplified to $50 here)
  camry2013:  50,
};

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
 * Mark a vehicle as available in fleet-status.json (non-fatal).
 * Called after a booking is auto-completed and no other active_rental bookings
 * remain for this vehicle, so the website immediately shows it as bookable again.
 * @param {string} vehicleId
 */
async function markVehicleAvailable(vehicleId) {
  if (!process.env.GITHUB_TOKEN || !vehicleId) return;
  try {
    await updateJsonFileWithRetry({
      load:    loadFleetStatus,
      apply:   (data) => {
        if (!data[vehicleId]) data[vehicleId] = {};
        data[vehicleId].available = true;
      },
      save:    saveFleetStatus,
      message: `Auto-complete: mark ${vehicleId} available`,
    });
  } catch (err) {
    console.error("scheduled-reminders: markVehicleAvailable failed (non-fatal):", err.message);
  }
}

/**
 * Parse a booking's pickup/return into a JS Date.
 * Date: YYYY-MM-DD  |  Time: "3:00 PM" or "15:00"
 * @param {string} date  - YYYY-MM-DD
 * @param {string} [time] - optional time string
 * @returns {Date}
 */
function parseBookingDateTime(date, time) {
  if (!date) return new Date(NaN);
  const datePart = String(date).split("T")[0];
  const base = new Date(datePart + "T00:00:00"); // midnight local
  if (time) {
    const t = time.trim();
    // "3:00 PM", "3:00:00 PM", or "3:00PM" format
    const ampmMatch = t.match(/^(0?[1-9]|1[0-2]):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)$/i);
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
    const h24Match = t.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
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
    pickup_time:   booking.pickupTime || "",
    return_time:   booking.returnTime || "",
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

  // Build HMAC-signed approve / decline URLs (24 h expiry)
  const { approveUrl, declineUrl } = buildLateFeeUrls(bookingId, feeAmount);

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
        `Decline: ${declineUrl}`;
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

      const pickupDt = parseBookingDateTime(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      const minutesUntilPickup = (pickupDt - now) / 60000;
      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);

      // 24-hour reminder (window: 24h–23h)
      if (minutesUntilPickup <= 24 * 60 && minutesUntilPickup > 23 * 60 && !alreadySent(booking, "unpaid_24h")) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_24H, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "unpaid_24h" });
      }

      // 2-hour reminder (window: 2h–90min)
      if (minutesUntilPickup <= 120 && minutesUntilPickup > 90 && !alreadySent(booking, "unpaid_2h")) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_2H, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "unpaid_2h" });
      }

      // Final reminder (window: 30–15 min)
      if (minutesUntilPickup <= 30 && minutesUntilPickup > 15 && !alreadySent(booking, "unpaid_final")) {
        const sent = await safeSend(booking.phone, render(UNPAID_REMINDER_FINAL, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "unpaid_final" });
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

      const pickupDt = parseBookingDateTime(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

      const minutesUntilPickup = (pickupDt - now) / 60000;
      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);

      // 24-hour reminder (window: 24h–23h)
      if (minutesUntilPickup <= 24 * 60 && minutesUntilPickup > 23 * 60 && !alreadySent(booking, "pickup_24h")) {
        const sent = await safeSend(booking.phone, render(PICKUP_REMINDER_24H, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "pickup_24h" });
      }

      // 2-hour reminder (window: 2h–90min)
      if (minutesUntilPickup <= 120 && minutesUntilPickup > 90 && !alreadySent(booking, "pickup_2h")) {
        const sent = await safeSend(booking.phone, render(PICKUP_REMINDER_2H, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "pickup_2h" });
      }

      // 30-minute reminder (window: 35–20 min)
      if (minutesUntilPickup <= 35 && minutesUntilPickup > 20 && !alreadySent(booking, "pickup_30min")) {
        const sent = await safeSend(booking.phone, render(PICKUP_REMINDER_30MIN, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "pickup_30min" });
      }
    }
  }
}

/**
 * Process all active_rental bookings — mid-rental, end reminders, late fees.
 */
async function processActiveRentals(allBookings, now, sentMarks) {
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "active_rental") continue;
      if (!booking.phone) continue;

      const pickupDt = parseBookingDateTime(booking.pickupDate, booking.pickupTime);
      const returnDt = parseBookingDateTime(booking.returnDate, booking.returnTime);
      if (isNaN(pickupDt.getTime()) || isNaN(returnDt.getTime())) continue;

      const id = booking.bookingId || booking.paymentIntentId;
      const v = vars(booking);
      const totalMinutes  = (returnDt - pickupDt) / 60000;
      const elapsedMinutes = (now - pickupDt) / 60000;
      const minutesUntilReturn = (returnDt - now) / 60000;
      const grace = GRACE_PERIODS[vehicleId] || 60;

      // Mid-rental: at the halfway point (±15 min window)
      const halfwayMinutes = totalMinutes / 2;
      if (
        elapsedMinutes >= halfwayMinutes - 15 &&
        elapsedMinutes < halfwayMinutes + 15 &&
        !alreadySent(booking, "active_mid")
      ) {
        const sent = await safeSend(booking.phone, render(ACTIVE_RENTAL_MID, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "active_mid" });
      }

      // 1 hour before end
      if (minutesUntilReturn <= 60 && minutesUntilReturn > 45 && !alreadySent(booking, "active_1h")) {
        const sent = await safeSend(booking.phone, render(ACTIVE_RENTAL_1H_BEFORE_END, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "active_1h" });
      }

      // 15 min before end
      if (minutesUntilReturn <= 15 && minutesUntilReturn > 0 && !alreadySent(booking, "active_15min")) {
        const sent = await safeSend(booking.phone, render(ACTIVE_RENTAL_15MIN_BEFORE_END, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "active_15min" });
      }

      // 30-min late warning (sent before return time)
      if (minutesUntilReturn <= 30 && minutesUntilReturn > 15 && !alreadySent(booking, "late_warning_30min")) {
        const sent = await safeSend(booking.phone, render(LATE_WARNING_30MIN, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "late_warning_30min" });
      }

      // At return time (window: 0–5 min past)
      const minsOverdue = -minutesUntilReturn; // positive = overdue
      if (minsOverdue >= 0 && minsOverdue < 5 && !alreadySent(booking, "late_at_return")) {
        const sent = await safeSend(booking.phone, render(LATE_AT_RETURN_TIME, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "late_at_return" });
      }

      // After grace period expired (window: grace–grace+15 min overdue)
      if (minsOverdue >= grace && minsOverdue < grace + 15 && !alreadySent(booking, "late_grace_expired")) {
        const sent = await safeSend(booking.phone, render(LATE_GRACE_EXPIRED, v));
        if (sent) sentMarks.push({ vehicleId, id, key: "late_grace_expired" });
      }

      // Late fee approval request — after grace, once per booking, no active extension
      if (
        minsOverdue >= grace &&
        !alreadySent(booking, "late_fee_applied") &&
        !alreadySent(booking, "late_fee_pending") &&
        !booking.lateFeeApplied
      ) {
        const feeAmount = LATE_FEE_AMOUNTS[vehicleId] || 50;
        const feeVars = { ...v, late_fee: String(feeAmount) };
        // 1. Notify customer that a late fee has been assessed
        const smsSent = await safeSend(booking.phone, render(LATE_FEE_APPLIED, feeVars));
        // 2. Request owner approval before charging (email + SMS with Approve/Decline links)
        const approvalSent = await requestLateFeeApproval(booking, feeAmount);
        if (smsSent || approvalSent) {
          // Mark as pending so we don't send the approval request again next cron tick
          sentMarks.push({ vehicleId, id, key: "late_fee_pending" });
          sentMarks.push({ vehicleId, id, key: "_late_fee_amount", value: feeAmount });
        }
      }
    }
  }
}

/**
 * Process completed_rental bookings — post-rental and retention SMS.
 */
async function processCompleted(allBookings, now, sentMarks) {
  const retentionSchedule = [
    { days: 1,  key: "retention_1d",  template: RETENTION_DAY_1 },
    { days: 3,  key: "retention_3d",  template: RETENTION_DAY_3 },
    { days: 7,  key: "retention_7d",  template: RETENTION_DAY_7 },
    { days: 14, key: "retention_14d", template: RETENTION_DAY_14 },
    { days: 30, key: "retention_30d", template: RETENTION_DAY_30 },
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

      const pickupDt = parseBookingDateTime(booking.pickupDate, booking.pickupTime);
      if (isNaN(pickupDt.getTime())) continue;

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

  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "active_rental") continue;

      const returnDt = parseBookingDateTime(booking.returnDate, booking.returnTime);
      if (isNaN(returnDt.getTime())) continue;

      const minsOverdue = (now - returnDt) / 60000;
      if (minsOverdue < AUTO_COMPLETE_HOURS * 60) continue;

      const id          = booking.bookingId || booking.paymentIntentId;
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

    const mismatches = succeededPIs.filter(
      (pi) => !recordedPIIds.has(pi.id) && !recordedAsBookingId.has(pi.id)
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

    const escStr = (s) => String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const rows = newMismatches.map((pi) => {
      const meta = pi.metadata || {};
      return `<tr>
        <td style="padding:6px;border:1px solid #ddd">${escStr(pi.id)}</td>
        <td style="padding:6px;border:1px solid #ddd">$${(pi.amount / 100).toFixed(2)}</td>
        <td style="padding:6px;border:1px solid #ddd">${escStr(meta.original_booking_id || meta.booking_id || "—")}</td>
        <td style="padding:6px;border:1px solid #ddd">${escStr(meta.payment_type || "—")}</td>
        <td style="padding:6px;border:1px solid #ddd">${new Date(pi.created * 1000).toISOString()}</td>
      </tr>`;
    }).join("\n");

    const subject = `[SLY RIDES] ⚠️ ${newMismatches.length} Payment(s) Not Reconciled`;

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
            <h2>⚠️ Payment Reconciliation Alert</h2>
            <p>${newMismatches.length} Stripe PaymentIntent(s) succeeded in the last 24 hours but have <strong>no matching revenue record</strong> in the database.</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
              <thead>
                <tr style="background:#f5f5f5">
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">PaymentIntent ID</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Amount</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Booking ID</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Type</th>
                  <th style="padding:8px;border:1px solid #ddd;text-align:left">Created</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <p>Please review these payments in the <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a> and the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>
            <p><strong>Sly Transportation Services LLC 🚗</strong></p>
          `,
          text: [
            subject,
            "",
            `${newMismatches.length} Stripe PaymentIntent(s) are missing from revenue_records:`,
            ...newMismatches.map((pi) => `  ${pi.id}  $${(pi.amount / 100).toFixed(2)}`),
            "",
            "Review at: https://dashboard.stripe.com/payments",
          ].join("\n"),
        });
      } catch (emailErr) {
        console.warn("scheduled-reminders reconciliation: alert email failed:", emailErr.message);
      }
    }

    // SMS alert (brief)
    if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && OWNER_PHONE) {
      try {
        const piSummary = newMismatches.slice(0, 3).map((pi) => `${pi.id} ($${(pi.amount / 100).toFixed(2)})`).join(", ");
        const smsText = `[SLY RIDES] ⚠️ ${newMismatches.length} payment(s) not reconciled: ${piSummary}${newMismatches.length > 3 ? ` +${newMismatches.length - 3} more` : ""}. Check email.`;
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
