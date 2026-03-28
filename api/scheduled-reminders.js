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

import Stripe from "stripe";
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

const GITHUB_REPO       = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";

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
  const getResp = await fetch(apiUrl, { headers: ghHeaders() });
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
  const body = { message, content };
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

/**
 * Parse a booking's pickup/return into a JS Date.
 * Date: YYYY-MM-DD  |  Time: "3:00 PM" or "15:00"
 * @param {string} date  - YYYY-MM-DD
 * @param {string} [time] - optional time string
 * @returns {Date}
 */
function parseBookingDateTime(date, time) {
  if (!date) return new Date(NaN);
  const base = new Date(date + "T00:00:00"); // midnight local
  if (time) {
    const t = time.trim();
    // "3:00 PM" or "3:00PM" format
    const ampmMatch = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
      let hours = parseInt(ampmMatch[1], 10);
      const mins = parseInt(ampmMatch[2], 10);
      const period = ampmMatch[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      base.setHours(hours, mins, 0, 0);
      return base;
    }
    // "15:00" format
    const h24Match = t.match(/^(\d{1,2}):(\d{2})$/);
    if (h24Match) {
      base.setHours(parseInt(h24Match[1], 10), parseInt(h24Match[2], 10), 0, 0);
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
 * Auto-charge a late fee via Stripe.
 * @param {object} booking
 * @param {number} feeAmount - in dollars
 * @returns {Promise<boolean>} true if charge succeeded
 */
async function chargeLateFee(booking, feeAmount) {
  if (!process.env.STRIPE_SECRET_KEY || !booking.paymentIntentId) return false;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    // Retrieve the original PaymentIntent to get the customer / payment method
    const pi = await stripe.paymentIntents.retrieve(booking.paymentIntentId);
    const paymentMethod = pi.payment_method;
    const customer = pi.customer;
    if (!paymentMethod) {
      console.warn(`scheduled-reminders: no payment method for PI ${booking.paymentIntentId}`);
      return false;
    }
    await stripe.paymentIntents.create({
      amount:         Math.round(feeAmount * 100),
      currency:       "usd",
      customer:       customer || undefined,
      payment_method: paymentMethod,
      confirm:        true,
      off_session:    true,
      description:    `Late fee — ${booking.vehicleName || booking.vehicleId} — ${booking.name}`,
      metadata: {
        payment_type:       "late_fee",
        original_booking_id: booking.bookingId || booking.paymentIntentId,
        vehicle_id:          booking.vehicleId,
        renter_name:         booking.name || "",
      },
    });
    return true;
  } catch (err) {
    console.error(`scheduled-reminders: late fee charge failed for ${booking.bookingId}:`, err.message);
    return false;
  }
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

      // Late fee — after grace, only if not already charged, and no active extension
      if (
        minsOverdue >= grace &&
        !alreadySent(booking, "late_fee_applied") &&
        !booking.lateFeeApplied
      ) {
        const feeAmount = LATE_FEE_AMOUNTS[vehicleId] || 50;
        const charged = await chargeLateFee(booking, feeAmount);
        const feeVars = { ...v, late_fee: String(feeAmount) };
        const sent = await safeSend(booking.phone, render(LATE_FEE_APPLIED, feeVars));
        if (sent || charged) {
          sentMarks.push({ vehicleId, id, key: "late_fee_applied" });
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
 * Groups marks by vehicleId/id to minimize GitHub API calls.
 */
async function persistSentMarks(sentMarks) {
  if (sentMarks.length === 0) return;
  if (!process.env.GITHUB_TOKEN) return;

  try {
    const { data, sha } = await loadBookings();

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

    await saveBookings(data, sha, `scheduled-reminders: record ${sentMarks.length} sent marks`);
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
 * "completed_rental", removes blocked dates, and syncs to Supabase.
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
      } catch (err) {
        console.error(
          `scheduled-reminders: auto-completion failed for ${vehicleId}/${id} (non-fatal):`,
          err.message
        );
      }
    }
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

  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    console.warn("scheduled-reminders: TextMagic credentials not set — SMS will not be sent");
    return res.status(200).json({ skipped: true, reason: "TextMagic not configured" });
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
  const sentMarks = [];

  await Promise.allSettled([
    processUnpaid(allBookings, now, sentMarks),
    processPaidBookings(allBookings, now, sentMarks),
    processActiveRentals(allBookings, now, sentMarks),
    processCompleted(allBookings, now, sentMarks),
  ]);

  await persistSentMarks(sentMarks);

  // Auto-activate booked_paid bookings whose pickup time has arrived.
  // Runs after reminders so pickup-day reminders still fire before activation.
  await processAutoActivations(allBookings, now);

  // Auto-complete bookings that are past their return time by AUTO_COMPLETE_HOURS.
  // Runs after sentMarks are persisted to avoid racing with the same bookings.json write.
  await processAutoCompletions(allBookings, now);

  return res.status(200).json({ ok: true, remindersSent: sentMarks.filter(m => !m.key.startsWith("_")).length });
}
