// api/stripe-webhook.js
// Vercel serverless function — Stripe webhook handler.
//
// Handles the payment_intent.succeeded event fired when a PaymentIntent
// (created by create-payment-intent.js or pay-balance.js) is confirmed.
// This is the server-side authoritative fallback for availability updates —
// it runs even if the user closes the browser before success.html completes.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY      — starts with sk_live_ or sk_test_
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe dashboard
//     (Stripe CLI for local testing: stripe listen --forward-to localhost:3000/api/stripe-webhook)
//
// Register this endpoint in the Stripe dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://sly-rides.vercel.app/api/stripe-webhook
//   Events: payment_intent.succeeded

import Stripe from "stripe";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { updateBooking, loadBookings, saveBookings, normalizePhone } from "./_bookings.js";
import { sendSms } from "./_textmagic.js";
import { render, EXTEND_CONFIRMED_SLINGSHOT, EXTEND_CONFIRMED_ECONOMY, DEFAULT_LOCATION } from "./_sms-templates.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { hasOverlap } from "./_availability.js";
import { autoCreateRevenueRecord, autoUpsertCustomer, autoUpsertBooking, autoCreateBlockedDate, autoActivateIfPickupArrived } from "./_booking-automation.js";
import { persistBooking } from "./_booking-pipeline.js";
import { CARS, computeRentalDays } from "./_pricing.js";
import { loadPricingSettings, computeBreakdownLinesFromSettings } from "./_settings.js";
import { generateRentalAgreementPdf } from "./_rental-agreement-pdf.js";
import { sendExtensionConfirmationEmails } from "./_extension-email.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { normalizeClockTime, DEFAULT_RETURN_TIME } from "./_time.js";
import { buildUnifiedConfirmationEmail, buildDocumentNotes } from "./_booking-confirmation-template.js";

// Disable Vercel's built-in body parser so we can pass the raw request body
// to stripe.webhooks.constructEvent() for signature verification.
export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";
const MAX_ALERT_SMS_LENGTH = 900;

/**
 * Read booked-dates.json from GitHub and block the given date range.
 * Mirrors the same logic used by send-reservation-email.js.
 * Time fields (fromTime, toTime) are stored alongside the date range so that
 * time-aware overlap checks (hasDateTimeOverlap) work correctly for same-day
 * back-to-back bookings and same-day return/pickup windows.
 */
async function blockBookedDates(vehicleId, from, to, fromTime = "", toTime = "") {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping date blocking");
    return;
  }
  if (!vehicleId || !from || !to) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadBookedDates() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      return { data: {}, sha: null }; // non-fatal: don't throw, keep existing dates
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch {
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveBookedDates(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:  loadBookedDates,
    apply: (data) => {
      if (!Array.isArray(data[vehicleId])) {
        if (data[vehicleId] != null) {
          console.warn(`stripe-webhook: booked-dates entry for ${vehicleId} is not an array; resetting`);
        }
        data[vehicleId] = [];
      }
      const originalCount = data[vehicleId].length;
      const existing = data[vehicleId].filter((r) => r && r.from && r.to);
      if (existing.length !== originalCount) {
        console.warn(
          `stripe-webhook: dropped ${originalCount - existing.length} malformed booked-dates entries for ${vehicleId}`
        );
      }

      // Merge with any overlapping ranges so extension replays (same pickup date,
      // later return date) replace the old window instead of being skipped.
      // Times from the incoming range are carried through: if the incoming range
      // starts earlier than an existing one, its fromTime wins; if it ends later,
      // its toTime wins. When ranges share a boundary date the time from the
      // earlier/later extreme is preserved.
      let mergedFrom     = from;
      let mergedTo       = to;
      let mergedFromTime = fromTime || "";
      let mergedToTime   = toTime   || "";
      const kept = [];

      for (const range of existing) {
        // ISO dates (YYYY-MM-DD) compare correctly with lexicographic operators.
        const overlaps = mergedFrom <= range.to && range.from <= mergedTo;
        if (overlaps) {
          if (range.from < mergedFrom) {
            mergedFrom     = range.from;
            mergedFromTime = range.fromTime || "";
          } else if (range.from === mergedFrom && !mergedFromTime) {
            mergedFromTime = range.fromTime || "";
          }
          if (range.to > mergedTo) {
            mergedTo     = range.to;
            mergedToTime = range.toTime || "";
          } else if (range.to === mergedTo && !mergedToTime) {
            mergedToTime = range.toTime || "";
          }
        } else {
          kept.push(range);
        }
      }

      // Build the merged entry — only include time fields when they are non-empty
      // so legacy readers that don't understand time fields are unaffected.
      const entry = { from: mergedFrom, to: mergedTo };
      if (mergedFromTime) entry.fromTime = mergedFromTime;
      if (mergedToTime)   entry.toTime   = mergedToTime;
      kept.push(entry);
      kept.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
      data[vehicleId] = kept;
    },
    save:    saveBookedDates,
    message: `Block dates for ${vehicleId}: ${from}${fromTime ? " " + fromTime : ""} to ${to}${toTime ? " " + toTime : ""} (webhook)`,
  });
}

/**
 * Mark a vehicle as unavailable in fleet-status.json on GitHub.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function markVehicleUnavailable(vehicleId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping fleet-status update");
    return;
  }
  if (!vehicleId) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadFleetStatus() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      return { data: {}, sha: null }; // non-fatal
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch (parseErr) {
      console.error("stripe-webhook: malformed JSON in fleet-status.json, resetting:", parseErr);
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveFleetStatus(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:  loadFleetStatus,
    apply: (data) => {
      if (!data[vehicleId]) data[vehicleId] = {};
      data[vehicleId].available = false;
    },
    save:    saveFleetStatus,
    message: `Mark ${vehicleId} unavailable after confirmed booking (webhook)`,
  });
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
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
 * Determines the booking status for a Stripe payment based on payment_type.
 * Deposit-only payment types leave the booking in "reserved_unpaid" since
 * the rental fee is still owed; all other payment types are fully paid.
 *
 * @param {string} paymentType - value of metadata.payment_type
 * @returns {"reserved_unpaid" | "booked_paid"}
 */
function resolveBookingStatus(paymentType) {
  // "reservation_deposit"       = Camry deposit-only (balance owed)
  // "slingshot_security_deposit" = Slingshot deposit-only (balance owed)
  return (paymentType === "reservation_deposit" || paymentType === "slingshot_security_deposit")
    ? "reserved_unpaid"
    : "booked_paid";
}

function formatSupabaseError(err) {
  if (!err) return "unknown Supabase error";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(`message=${err.message}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(err);
}

/**
 * Looks up a customer's UUID in the Supabase customers table by phone then email.
 * Returns null if not found or if Supabase is unavailable.
 *
 * @param {string} [phone] - normalised phone number
 * @param {string} [email] - email address
 * @returns {Promise<string|null>} customer UUID or null
 */
async function resolveCustomerIdFromSupabase(phone, email) {
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  try {
    if (phone && phone.trim()) {
      const { data } = await sb.from("customers").select("id").eq("phone", phone.trim()).maybeSingle();
      if (data?.id) return data.id;
    }
    if (email && email.trim()) {
      const { data } = await sb.from("customers").select("id").eq("email", email.trim().toLowerCase()).maybeSingle();
      if (data?.id) return data.id;
    }
  } catch {
    // Non-fatal — extension record will be created without customer_id.
  }
  return null;
}

async function bookingExistsInSupabase(bookingId, paymentIntentId) {
  const sb = getSupabaseAdmin();
  if (!sb) return false;
  if (!bookingId && !paymentIntentId) return false;
  try {
    if (bookingId) {
      const { data, error } = await sb
        .from("bookings")
        .select("id")
        .eq("booking_ref", bookingId)
        .maybeSingle();
      if (error) throw error;
      if (data?.id) return true;
    }
    if (paymentIntentId) {
      const { data, error } = await sb
        .from("bookings")
        .select("id")
        .eq("payment_intent_id", paymentIntentId)
        .maybeSingle();
      if (error) throw error;
      if (data?.id) return true;
    }
  } catch (err) {
    console.error("stripe-webhook: bookingExistsInSupabase lookup error:", formatSupabaseError(err));
  }
  return false;
}

async function revenueRecordCompleteInSupabase(bookingId, paymentIntentId) {
  const sb = getSupabaseAdmin();
  if (!sb) return false;
  if (!bookingId && !paymentIntentId) return false;
  try {
    let row = null;
    if (paymentIntentId) {
      const { data, error } = await sb
        .from("revenue_records")
        .select("id, gross_amount, stripe_fee, payment_intent_id")
        .eq("payment_intent_id", paymentIntentId)
        .maybeSingle();
      if (error) throw error;
      row = data || null;
    }
    if (!row && bookingId) {
      const { data, error } = await sb
        .from("revenue_records")
        .select("id, gross_amount, stripe_fee, payment_intent_id")
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (error) throw error;
      row = data || null;
    }
    if (!row) return false;
    return row.gross_amount != null &&
      row.stripe_fee != null &&
      !!row.payment_intent_id;
  } catch (err) {
    console.error("stripe-webhook: revenueRecordCompleteInSupabase lookup error:", formatSupabaseError(err));
    return false;
  }
}

async function resolveStripeFeeFields(stripe, paymentIntent) {
  const piId = paymentIntent?.id;
  if (!piId) throw new Error("missing paymentIntent.id for stripe fee lookup");

  const expanded = await stripe.paymentIntents.retrieve(piId, {
    expand: ["latest_charge.balance_transaction"],
  });
  const charge = expanded?.latest_charge;
  const bt = charge && typeof charge === "object" ? charge.balance_transaction : null;
  if (!bt || typeof bt !== "object") {
    throw new Error(`missing latest_charge.balance_transaction for PI ${piId}`);
  }
  const stripeFee = bt.fee != null ? Number(bt.fee) / 100 : null;
  const stripeNet = bt.net != null ? Number(bt.net) / 100 : null;
  if (!Number.isFinite(stripeFee) || stripeFee < 0) {
    throw new Error(`invalid stripe fee for PI ${piId}`);
  }
  return {
    stripeFee: Math.round(stripeFee * 100) / 100,
    stripeNet: Number.isFinite(stripeNet) ? (Math.round(stripeNet * 100) / 100) : null,
  };
}

async function bookingExistsInJson(vehicleId, bookingId, paymentIntentId) {
  if (!vehicleId) return false;
  try {
    const { data } = await loadBookings();
    const list = Array.isArray(data?.[vehicleId]) ? data[vehicleId] : [];
    return list.some((b) =>
      (bookingId && b.bookingId === bookingId) ||
      (paymentIntentId && b.paymentIntentId === paymentIntentId)
    );
  } catch (err) {
    console.error("stripe-webhook: bookingExistsInJson lookup error:", err.message);
    return false;
  }
}

async function sendBookingPersistenceAlert(paymentIntent, reason, details = {}) {
  const alertLines = [
    "🚨 Stripe webhook booking persistence failure",
    `PaymentIntent: ${paymentIntent?.id || "<missing>"}`,
    `Reason: ${reason || "unknown"}`,
    `Vehicle: ${details.vehicle_id || "<missing>"}`,
    `Booking ID: ${details.booking_id || "<missing>"}`,
    `Pickup: ${details.pickup_date || "<missing>"}`,
    `Return: ${details.return_date || "<missing>"}`,
    `Attempts: ${details.attempts || 0}`,
  ];
  const alertText = alertLines.join("\n");
  console.error(alertText);

  if (process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY && process.env.OWNER_PHONE) {
    try {
      const ownerPhone = String(process.env.OWNER_PHONE || "").trim();
      if (!ownerPhone || !/\d/.test(ownerPhone)) {
        throw new Error("OWNER_PHONE has no digits");
      }
      await sendSms(normalizePhone(ownerPhone), alertText.slice(0, MAX_ALERT_SMS_LENGTH));
    } catch (smsErr) {
      console.error("stripe-webhook: booking persistence SMS alert failed:", smsErr.message);
    }
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from: `"Sly Transportation Alerts" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `🚨 Booking persistence failed for ${paymentIntent?.id || "unknown PI"}`,
      text: alertText,
      html: `<pre style="font-family:monospace;white-space:pre-wrap">${esc(alertText)}</pre>`,
    });
  } catch (mailErr) {
    console.error("stripe-webhook: booking persistence email alert failed:", mailErr.message);
  }
}

/**
 * Save a booking record to bookings.json and Supabase from PaymentIntent metadata,
 * routing through the centralised booking pipeline (persistBooking) so every step
 * fires in the correct order — identical to manual bookings:
 *   customer upsert → booking upsert → revenue record → blocked_dates
 *
 * This is the guaranteed server-side path for every new booking — it fires on
 * every payment_intent.succeeded event, meaning bookings land in the admin
 * portal automatically without requiring the browser to complete success.html.
 * persistBooking() is idempotent: it deduplicates by paymentIntentId so a
 * double-save with the browser-side record is always safe.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function saveWebhookBookingRecord(paymentIntent, extraFields = {}) {
  const meta = paymentIntent.metadata || {};
  const {
    booking_id,
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    email,
    payment_type,
    full_rental_amount,
    protection_plan_tier,
  } = meta;

  if (!vehicle_id || !pickup_date || !return_date) {
    const reason =
      `stripe-webhook: saveWebhookBookingRecord metadata missing for PI ${paymentIntent.id}` +
      ` vehicle_id=${vehicle_id || "<missing>"} pickup_date=${pickup_date || "<missing>"} return_date=${return_date || "<missing>"}`;
    await sendBookingPersistenceAlert(paymentIntent, reason, {
      booking_id,
      vehicle_id,
      pickup_date,
      return_date,
      attempts: 0,
    });
    throw new Error(reason);
  }

  const amountPaid  = paymentIntent.amount ? Math.round(paymentIntent.amount) / 100 : 0;
  const totalPrice  = full_rental_amount ? Math.round(parseFloat(full_rental_amount) * 100) / 100 : amountPaid;
  const status = resolveBookingStatus(payment_type);

  // Route through the centralised booking pipeline — same as manual bookings.
  // This ensures the correct order: customer upsert → booking upsert → revenue record → blocked_dates.
  const persistPayload = {
    bookingId:             booking_id || ("wh-" + crypto.randomBytes(8).toString("hex")),
    name:                  renter_name || "",
    phone:                 renter_phone ? normalizePhone(renter_phone) : "",
    email:                 email || "",
    vehicleId:             vehicle_id,
    vehicleName:           vehicle_name || vehicle_id,
    pickupDate:            pickup_date,
    pickupTime:            pickup_time  || "",
    returnDate:            return_date,
    returnTime:            return_time  || "",
    location:              DEFAULT_LOCATION,
    status,
    amountPaid,
    totalPrice,
    paymentIntentId:       paymentIntent.id,
    paymentMethod:         "stripe",
    source:                "stripe_webhook",
    requireStripeFee:      true,
    stripeCustomerId:      paymentIntent.customer          || null,
    stripePaymentMethodId: paymentIntent.payment_method    || null,
    ...(protection_plan_tier ? { protectionPlanTier: protection_plan_tier } : {}),
    ...extraFields,
  };

  let result = null;
  let supabaseExists = false;
  let jsonExists = false;
  let revenueComplete = false;
  let lastPersistError = null;
  const envAttempts = parseInt(process.env.WEBHOOK_BOOKING_RETRY_ATTEMPTS || "", 10);
  const maxAttempts = Number.isFinite(envAttempts) && envAttempts > 0 ? envAttempts : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await persistBooking(persistPayload);
      lastPersistError = null;
    } catch (err) {
      lastPersistError = err;
      result = {
        ok: false,
        bookingId: persistPayload.bookingId,
        booking: persistPayload,
        errors: [err.message],
      };
    }
    supabaseExists = await bookingExistsInSupabase(persistPayload.bookingId, paymentIntent.id);
    revenueComplete = await revenueRecordCompleteInSupabase(persistPayload.bookingId, paymentIntent.id);
    jsonExists = await bookingExistsInJson(vehicle_id, persistPayload.bookingId, paymentIntent.id);

    if (supabaseExists && jsonExists && revenueComplete) {
      if (!result.ok) {
        console.warn(
          `stripe-webhook: PI ${paymentIntent.id} persisted after recovery attempt ${attempt}; initial errors: ${result.errors.join("; ")}`
        );
      } else {
        console.log(`stripe-webhook: booking pipeline succeeded for PI ${paymentIntent.id} (${vehicle_id}) bookingId=${persistPayload.bookingId}`);
      }
      break;
    }

    console.error(
      `stripe-webhook: booking persistence verification failed for PI ${paymentIntent.id} attempt=${attempt} ` +
      `supabaseExists=${supabaseExists} revenueComplete=${revenueComplete} jsonExists=${jsonExists} ` +
      `errors=${(result.errors || []).join("; ")}${lastPersistError ? ` lastPersistError=${lastPersistError.message}` : ""}`
    );
  }

  if (!supabaseExists || !jsonExists || !revenueComplete) {
    const failureReason =
      `stripe-webhook: booking persistence guarantee failed for PI ${paymentIntent.id} ` +
      `(supabaseExists=${supabaseExists} revenueComplete=${revenueComplete} jsonExists=${jsonExists})`;
    await sendBookingPersistenceAlert(paymentIntent, failureReason, {
      booking_id: persistPayload.bookingId,
      vehicle_id,
      pickup_date,
      return_date,
      attempts: maxAttempts,
    });
    throw new Error(`${failureReason}${lastPersistError ? ` lastPersistError=${lastPersistError.message}` : ""}`);
  }

  // If the booking is fully paid and the pickup time has already arrived
  // (e.g. same-day rental), immediately transition to active_rental without
  // waiting for the next 15-minute cron cycle.
  if (result?.booking?.status === "booked_paid") {
    try {
      await autoActivateIfPickupArrived(result.booking);
    } catch (err) {
      console.error("stripe-webhook: autoActivateIfPickupArrived error (non-fatal):", err.message);
    }
  }
}

/**
 * Send a server-side fallback notification email to the owner and customer
 * using data extracted from the PaymentIntent metadata.
 *
 * This is the guaranteed backup path that fires even when the customer's
 * browser loses sessionStorage during a 3DS redirect and never calls
 * send-reservation-email.js.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function sendWebhookNotificationEmails(paymentIntent) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("stripe-webhook: SMTP not configured — skipping fallback email");
    return;
  }

  const meta = paymentIntent.metadata || {};
  const {
    booking_id,
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    email,
    payment_type,
    full_rental_amount,
    balance_at_pickup,
    protection_plan_tier,
  } = meta;

  const amountNumber = paymentIntent.amount ? (paymentIntent.amount / 100) : NaN;
  const amountDollars = Number.isFinite(amountNumber) ? amountNumber.toFixed(2) : "N/A";
  const isDepositMode = payment_type === "reservation_deposit";

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // ── Retrieve pre-stored booking docs (signature, ID, insurance) ───────────
  // These are saved by the booking page (car.js → store-booking-docs.js)
  // before the Stripe payment is confirmed so the webhook can send the owner
  // the full email regardless of what happens in the customer's browser.
  let storedDocs = null;
  if (booking_id) {
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        const { data: docsRow } = await sb
          .from("pending_booking_docs")
          .select("*")
          .eq("booking_id", booking_id)
          .eq("email_sent", false)
          .maybeSingle();
        storedDocs = docsRow || null;
      }
    } catch (docsErr) {
      console.warn("stripe-webhook: could not retrieve pending_booking_docs (non-fatal):", docsErr.message);
    }
  }

  // ── Build attachments from stored docs ────────────────────────────────────
  const attachments = [];

  // Generate rental agreement PDF if signature is available.
  if (storedDocs && storedDocs.signature) {
    try {
      const vehicleInfo = (vehicle_id && CARS[vehicle_id]) ? CARS[vehicle_id] : {};
      const rentalDays  = (pickup_date && return_date) ? computeRentalDays(pickup_date, return_date) : 0;
      const hasProtectionPlan = !!protection_plan_tier;

      const pdfBody = {
        vehicleId:   vehicle_id  || "",
        car:         vehicle_name || vehicleInfo.name || vehicle_id || "",
        vehicleMake:  vehicleInfo.make  || null,
        vehicleModel: vehicleInfo.model || null,
        vehicleYear:  vehicleInfo.year  || null,
        vehicleVin:   vehicleInfo.vin   || null,
        vehicleColor: vehicleInfo.color || null,
        name:         renter_name || "",
        email:        email       || "",
        phone:        renter_phone || "",
        pickup:       pickup_date  || "",
        pickupTime:   pickup_time  || "",
        returnDate:   return_date  || "",
        returnTime:   return_time  || "",
        total:        full_rental_amount || amountDollars,
        deposit:      vehicleInfo.deposit || 0,
        days:         rentalDays,
        protectionPlan:     hasProtectionPlan,
        protectionPlanTier: protection_plan_tier || null,
        signature:          storedDocs.signature,
        fullRentalCost:     full_rental_amount || null,
        balanceAtPickup:    balance_at_pickup  || null,
        insuranceCoverageChoice: storedDocs.insurance_coverage_choice ||
          (hasProtectionPlan ? "no" : "yes"),
      };

      const pdfBuffer = await generateRentalAgreementPdf(pdfBody);
      const safeName  = (renter_name || "renter").replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      const safeDate  = (pickup_date || "booking").replace(/[^0-9-]/g, "");
      attachments.push({
        filename:    `rental-agreement-${safeName}-${safeDate}.pdf`,
        content:     pdfBuffer,
        contentType: "application/pdf",
      });
      console.log(`stripe-webhook: rental agreement PDF generated for PI ${paymentIntent.id}`);
    } catch (pdfErr) {
      console.error("stripe-webhook: PDF generation failed (non-fatal):", pdfErr.message);
    }
  }

  // Attach renter's ID photo if available.
  if (storedDocs && storedDocs.id_base64 && storedDocs.id_filename) {
    try {
      attachments.push({
        filename:    storedDocs.id_filename,
        content:     Buffer.from(storedDocs.id_base64, "base64"),
        contentType: storedDocs.id_mimetype || "application/octet-stream",
      });
    } catch (idErr) {
      console.error("stripe-webhook: ID attachment failed (non-fatal):", idErr.message);
    }
  }

  // Attach insurance document if available.
  if (storedDocs && storedDocs.insurance_base64 && storedDocs.insurance_filename) {
    try {
      attachments.push({
        filename:    storedDocs.insurance_filename,
        content:     Buffer.from(storedDocs.insurance_base64, "base64"),
        contentType: storedDocs.insurance_mimetype || "application/octet-stream",
      });
    } catch (insErr) {
      console.error("stripe-webhook: insurance attachment failed (non-fatal):", insErr.message);
    }
  }

  const hasFullDocs = attachments.length > 0;
  const insuranceStatusMeta = String(meta.insurance_status || "").toLowerCase();
  const hasProtectionPlan = !!(
    protection_plan_tier ||
    meta.protection_plan === "true" ||
    insuranceStatusMeta === "no_insurance_dpp"
  );

  let breakdownLines = null;
  try {
    const isHourly = !!(vehicle_id && CARS[vehicle_id] && CARS[vehicle_id].hourlyTiers);
    if (!isHourly && vehicle_id && pickup_date && return_date) {
      const pricingSettings = await loadPricingSettings();
      breakdownLines = computeBreakdownLinesFromSettings(
        vehicle_id,
        pickup_date,
        return_date,
        pricingSettings,
        hasProtectionPlan,
        protection_plan_tier || null
      );
    }
  } catch (err) {
    console.warn("stripe-webhook: pricing breakdown generation failed (non-fatal):", err.message);
  }

  const insuranceStatus = storedDocs?.insurance_coverage_choice === "no"
    ? "No personal insurance provided (Damage Protection Plan or renter liability applies)"
    : (storedDocs?.insurance_coverage_choice === "yes"
        ? (storedDocs?.insurance_filename ? "Own insurance provided (document attached)" : "Own insurance selected (proof not uploaded)")
        : (hasProtectionPlan
            ? `Protection plan selected (${protection_plan_tier || "tier not specified"})`
            : "Not selected / No protection plan"));

  const missingItemNotes = buildDocumentNotes({
    idUploaded:        !!storedDocs?.id_base64,
    signatureUploaded: !!storedDocs?.signature,
    insuranceUploaded: !!storedDocs?.insurance_base64,
    insuranceExpected: storedDocs?.insurance_coverage_choice === "yes",
  });

  // ── Owner notification ────────────────────────────────────────────────────
  const ownerEmail = buildUnifiedConfirmationEmail({
    audience:           "owner",
    bookingId:          booking_id || paymentIntent.id,
    vehicleName:        vehicle_name,
    vehicleId:          vehicle_id,
    renterName:         renter_name,
    renterEmail:        email,
    renterPhone:        renter_phone,
    pickupDate:         pickup_date,
    pickupTime:         pickup_time,
    returnDate:         return_date,
    returnTime:         return_time,
    amountPaid:         amountNumber,
    totalPrice:         Number(full_rental_amount || amountNumber),
    fullRentalCost:     full_rental_amount || null,
    balanceAtPickup:    balance_at_pickup || null,
    paymentMethodLabel: isDepositMode ? "Website (Stripe) — Reservation deposit" : "Website (Stripe)",
    insuranceStatus,
    pricingBreakdownLines: breakdownLines || [],
    missingItemNotes: [
      ...missingItemNotes,
      ...(attachments.length ? [`Attachments: ${attachments.map(a => a.filename).join(", ")}`] : []),
    ],
  });

  try {
    await transporter.sendMail({
      from:        `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:          OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject:     ownerEmail.subject,
      attachments: attachments,
      text:        ownerEmail.text,
      html:        ownerEmail.html,
    });
    console.log(`stripe-webhook: owner email sent for PI ${paymentIntent.id} (hasFullDocs=${hasFullDocs})`);
  } catch (emailErr) {
    console.error("stripe-webhook: owner email failed:", emailErr.message);
  }

  // ── Mark docs as sent so the browser-side email skips the owner copy ──────
  if (storedDocs && booking_id) {
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        await sb
          .from("pending_booking_docs")
          .update({ email_sent: true })
          .eq("booking_id", booking_id);
      }
    } catch (markErr) {
      console.warn("stripe-webhook: could not mark docs email_sent (non-fatal):", markErr.message);
    }
  }

  // ── Customer confirmation ─────────────────────────────────────────────────
  if (email) {
    const customerEmail = buildUnifiedConfirmationEmail({
      audience:           "customer",
      bookingId:          booking_id || paymentIntent.id,
      vehicleName:        vehicle_name,
      vehicleId:          vehicle_id,
      renterName:         renter_name,
      renterEmail:        email,
      renterPhone:        renter_phone,
      pickupDate:         pickup_date,
      pickupTime:         pickup_time,
      returnDate:         return_date,
      returnTime:         return_time,
      amountPaid:         amountNumber,
      totalPrice:         Number(full_rental_amount || amountNumber),
      fullRentalCost:     full_rental_amount || null,
      balanceAtPickup:    balance_at_pickup || null,
      paymentMethodLabel: isDepositMode ? "Website (Stripe) — Reservation deposit" : "Website (Stripe)",
      insuranceStatus,
      pricingBreakdownLines: breakdownLines || [],
      missingItemNotes,
      firstName: renter_name ? renter_name.split(" ")[0] : "there",
    });
    try {
      await transporter.sendMail({
        from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: customerEmail.subject,
        text:    customerEmail.text,
        html:    customerEmail.html,
      });
      console.log(`stripe-webhook: customer email sent to ${email} for PI ${paymentIntent.id}`);
    } catch (custErr) {
      console.error("stripe-webhook: customer email failed:", custErr.message);
    }
  }
}

/**
 * Read the raw request body from a Node.js IncomingMessage stream.
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function logPaymentIntentReceived(event, paymentIntent) {
  const meta = paymentIntent.metadata || {};
  // booking_id = new-booking PI flows; original_booking_id = extension/balance
  // flows that mutate an existing booking. We log whichever identifier is present.
  const bookingRef = meta.booking_id || meta.original_booking_id || "<missing>";
  console.log(
    `stripe-webhook: received payment_intent.succeeded` +
    ` event=${event.id || "unknown_event"}` +
    ` pi=${paymentIntent.id}` +
    ` payment_type=${meta.payment_type || "unspecified"}` +
    ` vehicle_id=${meta.vehicle_id || "<missing>"}` +
    ` pickup_date=${meta.pickup_date || "<missing>"}` +
    ` return_date=${meta.return_date || "<missing>"}` +
    ` booking_id=${bookingRef}`
  );
}

function logWebhookSkip(paymentIntent, reason) {
  const meta = paymentIntent.metadata || {};
  console.log(
    `stripe-webhook: skipped branch for PI ${paymentIntent.id}` +
    ` payment_type=${meta.payment_type || "unspecified"} reason=${reason}`
  );
}

function logWebhookRouting(paymentIntent, reason) {
  const meta = paymentIntent.metadata || {};
  console.log(
    `stripe-webhook: routing PI ${paymentIntent.id}` +
    ` payment_type=${meta.payment_type || "unspecified"} reason=${reason}`
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).send("Server configuration error");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET environment variable is not set");
    return res.status(500).send("Server configuration error");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    const paymentType = (paymentIntent.metadata || {}).payment_type || "";
    logPaymentIntentReceived(event, paymentIntent);

    // Handle rental extension payment confirmations.
    if (paymentType === "rental_extension") {
      const {
        vehicle_id,
        original_booking_id,
        renter_name,
        renter_email,
        extension_label,
        new_return_date,
        new_return_time,
      } = paymentIntent.metadata || {};

      if (vehicle_id && original_booking_id) {
        try {
          if (!new_return_date) {
            console.error(
              `stripe-webhook: rental_extension missing metadata new_return_date for booking ${original_booking_id}`
            );
            return res.status(200).json({ received: true });
          }

          let foundBooking = false;
          let alreadyApplied = false;
          let invalidStatus = null;
          let oldReturnDate = "";
          let updatedBooking = null;
          let extensionAmountDollars = 0;

          await updateJsonFileWithRetry({
            load: loadBookings,
            apply: (freshData) => {
              const list = Array.isArray(freshData[vehicle_id]) ? freshData[vehicle_id] : [];
              const idx = list.findIndex(
                (b) => b.bookingId === original_booking_id || b.paymentIntentId === original_booking_id
              );
              if (idx === -1) return;

              foundBooking = true;
              const cur = list[idx];
              const normalizedCurrentReturnTime = normalizeClockTime(cur.returnTime);
              const resolvedReturnTime = normalizedCurrentReturnTime || DEFAULT_RETURN_TIME;
              const shouldPersistReturnTime = !cur.returnTime || cur.returnTime !== resolvedReturnTime;

              if (cur.returnDate === new_return_date) {
                alreadyApplied = true;
                if (shouldPersistReturnTime) {
                  cur.returnTime = resolvedReturnTime;
                  updatedBooking = { ...cur };
                }
                return;
              }

              if (cur.status !== "active_rental" && cur.status !== "reserved") {
                invalidStatus = cur.status || "<missing>";
                return;
              }

              oldReturnDate = cur.returnDate || "";

              const metadataReturnTime = normalizeClockTime(new_return_time);
              if (metadataReturnTime && metadataReturnTime !== resolvedReturnTime) {
                console.warn(
                  `stripe-webhook: rental_extension return_time "${metadataReturnTime}" ignored ` +
                  `for booking ${original_booking_id}; preserving "${resolvedReturnTime}"`
                );
              }

              const ext = cur.extensionPendingPayment || {};
              extensionAmountDollars = Math.round(
                ((ext.price != null ? ext.price : paymentIntent.amount / 100) || 0) * 100
              ) / 100;

              const existingPayments = Array.isArray(cur.payments) ? cur.payments : [];
              const paymentAlreadyRecorded = existingPayments.some(
                (p) => p && (p.paymentIntentId === paymentIntent.id || p.id === paymentIntent.id)
              );
              const updatedPayments = paymentAlreadyRecorded
                ? existingPayments
                : [
                    ...existingPayments,
                    {
                      paymentIntentId: paymentIntent.id,
                      type: "rental_extension",
                      amount: extensionAmountDollars,
                      appliedAt: new Date().toISOString(),
                    },
                  ];

              cur.amountPaid = Math.round(((cur.amountPaid || 0) + extensionAmountDollars) * 100) / 100;
              cur.returnDate = new_return_date;
              cur.returnTime = resolvedReturnTime;
              cur.extensionPendingPayment = null;
              cur.extensionCount = (cur.extensionCount || 0) + 1;
              cur.payments = updatedPayments;

              // Clear late-return and end-of-rental markers so they re-fire for the new return date.
              if (cur.smsSentAt) {
                delete cur.smsSentAt.late_warning_30min;
                delete cur.smsSentAt.late_at_return;
                delete cur.smsSentAt.late_grace_expired;
                delete cur.smsSentAt.late_fee_pending;
                delete cur.smsSentAt.active_1h;
                delete cur.smsSentAt.active_15min;
              }
              delete cur.lateFeeApplied;
              updatedBooking = { ...cur };
            },
            save: saveBookings,
            message: `Confirm extension for booking ${original_booking_id}`,
          });

          if (!foundBooking) {
            console.error(
              `stripe-webhook: rental_extension booking not found vehicle_id=${vehicle_id} booking_id=${original_booking_id}`
            );
            return res.status(200).json({ received: true });
          }

          if (invalidStatus) {
            console.error(
              `stripe-webhook: rental_extension invalid status for booking ${original_booking_id}: ${invalidStatus}`
            );
            return res.status(200).json({ received: true });
          }

          if (alreadyApplied) {
            console.log(
              `stripe-webhook: rental_extension already applied for booking ${original_booking_id} return_date=${new_return_date}`
            );
            return res.status(200).json({ received: true });
          }

          if (!updatedBooking) {
            console.error(
              `stripe-webhook: rental_extension update did not produce booking snapshot for ${original_booking_id}`
            );
            return res.status(200).json({ received: true });
          }

          // Sync updated booking to Supabase.
          try {
            await autoUpsertBooking(updatedBooking);
          } catch (syncErr) {
            console.error("stripe-webhook: Supabase extension sync error (non-fatal):", syncErr.message);
          }

          // Create a new extension revenue record (type='extension').
          try {
            const extCustomerId = await resolveCustomerIdFromSupabase(
              updatedBooking.phone || "",
              updatedBooking.email || renter_email || "",
            );

            await autoCreateRevenueRecord({
              bookingId:       original_booking_id,
              paymentIntentId: paymentIntent.id,
              vehicleId:       vehicle_id,
              customerId:      extCustomerId,
              name:            updatedBooking.name || renter_name || "",
              phone:           updatedBooking.phone || "",
              email:           updatedBooking.email || renter_email || "",
              pickupDate:      updatedBooking.pickupDate || "",
              returnDate:      updatedBooking.returnDate || "",
              amountPaid:      extensionAmountDollars,
              paymentMethod:   "stripe",
              type:            "extension",
            });
          } catch (revErr) {
            console.error("stripe-webhook: extension revenue record error (non-fatal):", revErr.message);
          }

          // Update public booked-dates.json availability.
          if (updatedBooking.pickupDate && updatedBooking.returnDate) {
            try {
              await blockBookedDates(
                vehicle_id,
                updatedBooking.pickupDate,
                updatedBooking.returnDate,
                updatedBooking.pickupTime || "",
                updatedBooking.returnTime || updatedBooking.pickupTime || "",
              );
            } catch (bdErr) {
              console.error("stripe-webhook: booked-dates.json extension update failed (non-fatal):", bdErr.message);
            }
          }

          // Update Supabase blocked_dates availability.
          if (updatedBooking.pickupDate && updatedBooking.returnDate) {
            try {
              await autoCreateBlockedDate(vehicle_id, updatedBooking.pickupDate, updatedBooking.returnDate, "booking");
            } catch (sbBlockErr) {
              console.error("stripe-webhook: Supabase blocked_dates extension update failed (non-fatal):", sbBlockErr.message);
            }
          }

          // Send extension confirmed SMS
          if (updatedBooking.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
            const isSlingshot = vehicle_id && vehicle_id.startsWith("slingshot");
            const template = isSlingshot ? EXTEND_CONFIRMED_SLINGSHOT : EXTEND_CONFIRMED_ECONOMY;
            try {
              await sendSms(normalizePhone(updatedBooking.phone), render(template, {
                return_time: updatedBooking.returnTime || "",
                return_date: updatedBooking.returnDate || "",
              }));
            } catch (smsErr) {
              console.error("stripe-webhook: extension confirmed SMS failed:", smsErr.message);
            }
          }

          // Send extension confirmation emails (with updated agreement PDF) to owner and renter.
          if (!updatedBooking.extensionEmailSent) {
            try {
              await sendExtensionConfirmationEmails({
                paymentIntent,
                booking: updatedBooking,
                updatedReturnDate: updatedBooking.returnDate || "",
                updatedReturnTime: updatedBooking.returnTime || "",
                extensionLabel: extension_label || "",
                vehicleId: vehicle_id,
                renterEmail: updatedBooking.email || renter_email || "",
                renterName: updatedBooking.name || renter_name || "",
                originalReturnDate: oldReturnDate,
                extensionCount: updatedBooking.extensionCount || 1,
              });
              try {
                await updateBooking(vehicle_id, original_booking_id, { extensionEmailSent: true });
              } catch (markErr) {
                console.warn("stripe-webhook: could not mark extensionEmailSent (non-fatal):", markErr.message);
              }
            } catch (emailErr) {
              console.error("stripe-webhook: extension email failed (non-fatal):", emailErr.message);
            }
          } else {
            console.log(`stripe-webhook: extension emails already sent for booking ${original_booking_id} — skipping`);
          }

          console.log("EXTENSION_APPLIED", {
            booking_id: original_booking_id,
            old_return: oldReturnDate,
            new_return: updatedBooking.returnDate,
            payment_intent_id: paymentIntent.id,
          });
        } catch (err) {
          console.error("stripe-webhook: extension confirmation error:", err);
        }
      } else {
        logWebhookSkip(
          paymentIntent,
          `rental_extension missing required metadata vehicle_id=${vehicle_id || "<missing>"} original_booking_id=${original_booking_id || "<missing>"}`
        );
      }
      return res.status(200).json({ received: true });
    }

    // Skip balance payments — dates were already blocked when the deposit was paid.
    if (paymentType === "balance_payment") {
      console.log(
        `stripe-webhook: balance_payment for PaymentIntent ${paymentIntent.id} — skipping date blocking`
      );
      // Update booking status to booked_paid when full balance is paid
      const { vehicle_id } = paymentIntent.metadata || {};
      const originalPiId = (paymentIntent.metadata || {}).original_payment_intent_id ||
        (paymentIntent.metadata || {}).deposit_payment_intent_id;
      if (vehicle_id && originalPiId) {
        try {
          await updateBooking(vehicle_id, originalPiId, { status: "booked_paid" });
          // Sync the status change to Supabase bookings table
          const { data: updatedData } = await loadBookings();
          const updatedBooking = (updatedData[vehicle_id] || []).find(
            (b) => b.bookingId === originalPiId || b.paymentIntentId === originalPiId
          );
          if (updatedBooking) {
            await autoUpsertBooking(updatedBooking);
            // Auto-activate if the renter's pickup time has already arrived —
            // e.g. they paid the balance on the day of pickup.
            try {
              await autoActivateIfPickupArrived(updatedBooking);
            } catch (activErr) {
              console.error("stripe-webhook: autoActivateIfPickupArrived (balance) error (non-fatal):", activErr.message);
            }
          }
        } catch (err) {
          console.error("stripe-webhook: updateBooking (balance) error:", err);
        }
      } else {
        logWebhookSkip(
          paymentIntent,
          `balance_payment missing linkage metadata vehicle_id=${vehicle_id || "<missing>"} original_payment_intent_id=${originalPiId || "<missing>"}`
        );
      }
      return res.status(200).json({ received: true });
    }

    // ── Slingshot security-deposit-only payment ───────────────────────────────
    // When a renter pays only the security deposit, we:
    //   1. Block the dates (vehicle is now reserved).
    //   2. Save the booking record with payment_status = "deposit_paid".
    //   3. Generate a unique payment_link_token and store it in the booking.
    //   4. Send email + SMS to the customer with the completion link.
    if (paymentType === "slingshot_security_deposit") {
      const meta = paymentIntent.metadata || {};
      const {
        vehicle_id, pickup_date, return_date,
        pickup_time, return_time,
        renter_name, renter_phone, email,
        rental_price, security_deposit, remaining_balance,
        full_rental_amount, rental_duration,
      } = meta;

      console.log(
        `stripe-webhook: slingshot_security_deposit — vehicle=${vehicle_id} pi=${paymentIntent.id}`
      );

      // Block dates so the vehicle shows as reserved
      if (vehicle_id && pickup_date && return_date) {
        try {
          await blockBookedDates(vehicle_id, pickup_date, return_date, pickup_time || "", return_time || "");
        } catch (err) {
          console.error("stripe-webhook: blockBookedDates (slingshot deposit) error:", err);
        }
      }

      // Generate a unique token for the completion link
      const paymentLinkToken = crypto.randomBytes(24).toString("hex");

      // Persist the booking record with the token and deposit-paid status.
      // Route through persistBooking so all four pipeline steps fire in the
      // correct order (customer → booking → revenue record → blocked_dates).
      // Extra slingshot-specific fields are passed through into the booking record.
      const amountPaid = paymentIntent.amount ? Math.round(paymentIntent.amount) / 100 : 0;
      let slingshotDepositResult = null;
      try {
        const feeFields = await resolveStripeFeeFields(stripe, paymentIntent);
        slingshotDepositResult = await persistBooking({
          bookingId:                meta.booking_id || ("wh-" + crypto.randomBytes(8).toString("hex")),
          name:                     renter_name || "",
          phone:                    renter_phone ? normalizePhone(renter_phone) : "",
          email:                    email || "",
          vehicleId:                vehicle_id,
          vehicleName:              meta.vehicle_name || vehicle_id,
          pickupDate:               pickup_date,
          pickupTime:               meta.pickup_time || "",
          returnDate:               return_date,
          returnTime:               meta.return_time || "",
          location:                 DEFAULT_LOCATION,
          status:                   "reserved_unpaid",
          amountPaid,
          totalPrice:               Number(full_rental_amount || 0) || amountPaid,
          paymentIntentId:          paymentIntent.id,
          paymentMethod:            "stripe",
          source:                   "stripe_webhook",
          requireStripeFee:         true,
          // Extra slingshot-specific fields passed through into the booking record
          paymentStatus:            "deposit_paid",
          slingshot_payment_status: "deposit_paid",
          bookingStatus:            "reserved",
          slingshot_booking_status: "reserved",
          rentalPrice:              Number(rental_price || 0),
          securityDeposit:          Number(security_deposit || 0),
          remainingBalance:         Number(remaining_balance || rental_price || 0),
          fullRentalAmount:         Number(full_rental_amount || 0),
          rentalDuration:           rental_duration || "",
          paymentLinkToken,
          stripeCustomerId:         paymentIntent.customer          || null,
          stripePaymentMethodId:    paymentIntent.payment_method    || null,
          ...feeFields,
        });
        console.log(`stripe-webhook: slingshot deposit pipeline succeeded (PI ${paymentIntent.id}) bookingId=${slingshotDepositResult.bookingId}`);
      } catch (err) {
        console.error(`stripe-webhook: slingshot deposit pipeline failed for PI ${paymentIntent.id}:`, err.message);
        slingshotDepositResult = null;
      }

      // Build the completion link
      const completionLink = `https://www.slytrans.com/complete-booking.html?token=${paymentLinkToken}`;

      // Send email to customer with completion link
      if (email && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          await sendSlingshotDepositEmail({
            to:              email,
            renterName:      renter_name || "",
            vehicleName:     meta.vehicle_name || vehicle_id,
            pickupDate:      pickup_date,
            returnDate:      return_date,
            rentalDuration:  rental_duration || "",
            securityDeposit: amountPaid,
            remainingBalance: Number(remaining_balance || rental_price || 0),
            completionLink,
          });
        } catch (emailErr) {
          console.error("stripe-webhook: slingshot deposit customer email error:", emailErr.message);
        }
      }

      // Send owner notification email
      try {
        await sendSlingshotDepositOwnerEmail({
          renterName:      renter_name || "",
          renterPhone:     renter_phone || "",
          renterEmail:     email || "",
          vehicleName:     meta.vehicle_name || vehicle_id,
          pickupDate:      pickup_date,
          returnDate:      return_date,
          rentalDuration:  rental_duration || "",
          securityDeposit: amountPaid,
          remainingBalance: Number(remaining_balance || rental_price || 0),
          completionLink,
          paymentIntentId: paymentIntent.id,
        });
      } catch (ownerEmailErr) {
        console.error("stripe-webhook: slingshot deposit owner email error:", ownerEmailErr.message);
      }

      // Send SMS to customer with completion link
      if (renter_phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
        try {
          const smsText = `Your Slingshot booking is reserved! Complete your payment here: ${completionLink}`;
          await sendSms(normalizePhone(renter_phone), smsText);
          console.log(`stripe-webhook: slingshot deposit SMS sent to ${renter_phone}`);
        } catch (smsErr) {
          console.error("stripe-webhook: slingshot deposit SMS error:", smsErr.message);
        }
      }

      return res.status(200).json({ received: true });
    }

    // ── Slingshot balance completion payment ─────────────────────────────────
    // When a renter pays the remaining rental balance via the complete-booking page.
    if (paymentType === "slingshot_balance_payment") {
      const meta = paymentIntent.metadata || {};
      const { vehicle_id, payment_link_token, renter_name, email, renter_phone } = meta;

      console.log(
        `stripe-webhook: slingshot_balance_payment — vehicle=${vehicle_id} pi=${paymentIntent.id}`
      );

      // Update the booking record: fully_paid, remaining_balance = 0
      if (vehicle_id && payment_link_token) {
        try {
          const { data: bkData } = await loadBookings();
          const list = Array.isArray(bkData[vehicle_id]) ? bkData[vehicle_id] : [];
          const booking = list.find((b) => b.paymentLinkToken === payment_link_token);
          if (booking) {
            const bookingId = booking.bookingId || booking.paymentIntentId;
            await updateBooking(vehicle_id, bookingId, {
              status:                   "booked_paid",
              paymentStatus:            "fully_paid",
              slingshot_payment_status: "fully_paid",
              bookingStatus:            "reserved",
              slingshot_booking_status: "reserved",
              remainingBalance:         0,
              completionPaymentIntentId: paymentIntent.id,
              completedAt:              new Date().toISOString(),
            });
            console.log(`stripe-webhook: slingshot balance booking updated to fully_paid (${bookingId})`);

            // Send confirmation email to customer
            if ((email || booking.email) && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
              try {
                await sendSlingshotFullyPaidEmail({
                  to:          email || booking.email,
                  renterName:  renter_name || booking.name || "",
                  vehicleName: meta.vehicle_name || booking.vehicleName || vehicle_id,
                  pickupDate:  meta.pickup_date  || booking.pickupDate,
                  returnDate:  meta.return_date  || booking.returnDate,
                  amountPaid:  paymentIntent.amount ? (paymentIntent.amount / 100) : 0,
                });
              } catch (emailErr) {
                console.error("stripe-webhook: slingshot balance paid email error:", emailErr.message);
              }
            }

            // Send confirmation SMS
            const phone = renter_phone || booking.phone;
            if (phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
              try {
                const vehicleName = meta.vehicle_name || booking.vehicleName || "Slingshot";
                await sendSms(normalizePhone(phone), `✅ Payment complete! Your ${vehicleName} rental is fully booked. See you at pickup. – Sly Rides`);
              } catch (smsErr) {
                console.error("stripe-webhook: slingshot balance SMS error:", smsErr.message);
              }
            }
          }
        } catch (err) {
          console.error("stripe-webhook: slingshot balance booking update error:", err);
        }
      } else {
        logWebhookSkip(
          paymentIntent,
          `slingshot_balance_payment missing linkage metadata vehicle_id=${vehicle_id || "<missing>"} payment_link_token=${payment_link_token || "<missing>"}`
        );
      }

      return res.status(200).json({ received: true });
    }

    const { vehicle_id, pickup_date, return_date, pickup_time: meta_pickup_time, return_time: meta_return_time } = paymentIntent.metadata || {};

    if (!paymentType) {
      logWebhookRouting(paymentIntent, "payment_type missing — processing with generic booking path");
    } else if (paymentType !== "full_payment" && paymentType !== "reservation_deposit") {
      logWebhookRouting(paymentIntent, `unexpected payment_type=${paymentType} — processing with generic booking path`);
    } else {
      logWebhookRouting(paymentIntent, `${paymentType} — processing with generic booking path`);
    }

    // Persist booking first so slow/non-critical side effects cannot prevent
    // core booking + revenue writes from happening.
    try {
      const feeFields = await resolveStripeFeeFields(stripe, paymentIntent);
      await saveWebhookBookingRecord(paymentIntent, feeFields);
    } catch (bookingErr) {
      console.error("stripe-webhook: saveWebhookBookingRecord error:", bookingErr);
    }

    // Block the booked dates and mark the vehicle unavailable.
    if (vehicle_id && pickup_date && return_date) {
      try {
        await blockBookedDates(vehicle_id, pickup_date, return_date, meta_pickup_time || "", meta_return_time || "");
      } catch (err) {
        console.error("stripe-webhook: blockBookedDates error:", err);
      }
      try {
        await markVehicleUnavailable(vehicle_id);
      } catch (err) {
        console.error("stripe-webhook: markVehicleUnavailable error:", err);
      }
    } else {
      logWebhookSkip(
        paymentIntent,
        `calendar/fleet updates skipped — missing metadata vehicle_id=${vehicle_id || "<missing>"} pickup_date=${pickup_date || "<missing>"} return_date=${return_date || "<missing>"}`
      );
    }

    // Send server-side backup notification emails to the owner and customer.
    // These fire on every confirmed payment as a guaranteed fallback for the
    // browser-side send-reservation-email call (which can fail if the customer's
    // sessionStorage is lost during a 3DS redirect or if the browser is closed
    // before success.html completes).
    try {
      await sendWebhookNotificationEmails(paymentIntent);
    } catch (emailErr) {
      console.error("stripe-webhook: sendWebhookNotificationEmails error:", emailErr.message);
    }
  }

  return res.status(200).json({ received: true });
}

// ── Named exports for stripe-replay.js ───────────────────────────────────────
// These allow the replay endpoint to call the exact same pipeline steps as the
// webhook's generic handler (full_payment / reservation_deposit path) without
// duplicating any logic. Each export is a self-contained async function with no
// shared mutable state — safe to call from any module.
export {
  saveWebhookBookingRecord,
  blockBookedDates,
  markVehicleUnavailable,
  sendWebhookNotificationEmails,
};

// ── Slingshot deposit-paid notification email to customer ──────────────────

async function sendSlingshotDepositEmail({
  to, renterName, vehicleName, pickupDate, returnDate, rentalDuration,
  securityDeposit, remainingBalance, completionLink,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const firstName = renterName ? renterName.split(" ")[0] : "there";
  await transporter.sendMail({
    from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
    to,
    subject: "Complete Your Slingshot Booking – Sly Transportation Services LLC",
    html: `
      <h2>🏎️ Your Slingshot is Reserved!</h2>
      <p>Hi ${esc(firstName)},</p>
      <p>Your vehicle has been reserved with a security deposit. To complete your booking, please use the link below:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
        ${rentalDuration ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Duration</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(rentalDuration)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Security Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(securityDeposit.toFixed ? securityDeposit.toFixed(2) : securityDeposit))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Remaining Balance</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(String(remainingBalance.toFixed ? remainingBalance.toFixed(2) : remainingBalance))}</strong></td></tr>
      </table>
      <p><a href="${esc(completionLink)}" style="display:inline-block;background:#ffb400;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:700">Complete Payment →</a></p>
      <p style="color:#aaa;font-size:0.9em">You can complete this now or when you arrive for pickup. Full payment must be completed before the vehicle is handed over.</p>
      <p>If you have any questions, contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
      <p><strong>Sly Transportation Services LLC 🏎️</strong></p>
    `,
    text: [
      "Your Slingshot is Reserved!",
      "",
      `Hi ${firstName},`,
      "Your vehicle has been reserved with a security deposit.",
      "To complete your booking, please use the link below:",
      "",
      `Vehicle            : ${vehicleName}`,
      rentalDuration ? `Duration           : ${rentalDuration}` : "",
      `Pickup Date        : ${pickupDate}`,
      `Return Date        : ${returnDate}`,
      `Security Deposit   : $${typeof securityDeposit === "number" ? securityDeposit.toFixed(2) : securityDeposit}`,
      `Remaining Balance  : $${typeof remainingBalance === "number" ? remainingBalance.toFixed(2) : remainingBalance}`,
      "",
      `Complete Payment: ${completionLink}`,
      "",
      "You can complete this now or when you arrive for pickup.",
      "Full payment must be completed before the vehicle is handed over.",
      "",
      `Questions? Contact ${OWNER_EMAIL} or call (213) 916-6606.`,
      "",
      "Sly Transportation Services LLC",
    ].filter((l) => l !== undefined).join("\n"),
  });
}

// ── Slingshot deposit-paid notification email to owner ────────────────────

async function sendSlingshotDepositOwnerEmail({
  renterName, renterPhone, renterEmail, vehicleName, pickupDate, returnDate,
  rentalDuration, securityDeposit, remainingBalance, completionLink, paymentIntentId,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from:    `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
    to:      OWNER_EMAIL,
    ...(renterEmail ? { replyTo: renterEmail } : {}),
    subject: `🔒 Slingshot Deposit Paid – ${esc(renterName || "New Renter")} (Balance Pending)`,
    html: `
      <h2>🔒 Slingshot Security Deposit Received</h2>
      <p>A renter has paid the security deposit. Remaining balance is pending.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterName || "N/A")}</td></tr>
        ${renterEmail ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterEmail)}</td></tr>` : ""}
        ${renterPhone ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterPhone)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
        ${rentalDuration ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Duration</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(rentalDuration)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Security Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(typeof securityDeposit === "number" ? securityDeposit.toFixed(2) : securityDeposit))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Remaining Balance</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(String(typeof remainingBalance === "number" ? remainingBalance.toFixed(2) : remainingBalance))}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Stripe Payment ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentIntentId || "N/A")}</td></tr>
      </table>
      <p>The customer's completion link: <a href="${esc(completionLink)}">${esc(completionLink)}</a></p>
      <p style="color:#ff9800"><strong>⚠️ Full payment must be received before handing over the vehicle.</strong></p>
    `,
    text: [
      "Slingshot Security Deposit Received",
      "",
      `Renter             : ${renterName || "N/A"}`,
      renterEmail ? `Email              : ${renterEmail}` : "",
      renterPhone ? `Phone              : ${renterPhone}` : "",
      `Vehicle            : ${vehicleName}`,
      rentalDuration ? `Duration           : ${rentalDuration}` : "",
      `Pickup Date        : ${pickupDate}`,
      `Return Date        : ${returnDate}`,
      `Security Deposit   : $${typeof securityDeposit === "number" ? securityDeposit.toFixed(2) : securityDeposit}`,
      `Remaining Balance  : $${typeof remainingBalance === "number" ? remainingBalance.toFixed(2) : remainingBalance}`,
      `Stripe PI          : ${paymentIntentId || "N/A"}`,
      "",
      `Completion link: ${completionLink}`,
      "",
      "⚠️ Full payment must be received before handing over the vehicle.",
    ].filter((l) => l !== undefined).join("\n"),
  });
}

// ── Slingshot fully-paid confirmation email to customer ───────────────────

async function sendSlingshotFullyPaidEmail({
  to, renterName, vehicleName, pickupDate, returnDate, amountPaid,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const firstName = renterName ? renterName.split(" ")[0] : "there";
  await transporter.sendMail({
    from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
    to,
    subject: "✅ Slingshot Booking Fully Paid – Sly Transportation Services LLC",
    html: `
      <h2>✅ Your Slingshot Booking is Fully Paid!</h2>
      <p>Hi ${esc(firstName)}, your payment has been received and your booking is complete.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount Paid</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>$${esc(String(typeof amountPaid === "number" ? amountPaid.toFixed(2) : amountPaid))}</strong></td></tr>
      </table>
      <p>See you at pickup! If you have any questions, contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
      <p><strong>Sly Transportation Services LLC 🏎️</strong></p>
    `,
    text: [
      "✅ Your Slingshot Booking is Fully Paid!",
      "",
      `Hi ${firstName}, your payment has been received and your booking is complete.`,
      "",
      `Vehicle     : ${vehicleName}`,
      `Pickup Date : ${pickupDate}`,
      `Return Date : ${returnDate}`,
      `Amount Paid : $${typeof amountPaid === "number" ? amountPaid.toFixed(2) : amountPaid}`,
      "",
      `Questions? Contact ${OWNER_EMAIL} or call (213) 916-6606.`,
      "",
      "Sly Transportation Services LLC",
    ].join("\n"),
  });
}
