// api/receive-textmagic-sms.js
// Vercel serverless function — TextMagic inbound SMS webhook.
//
// Handles customer replies including the EXTEND keyword.
//
// TextMagic sends a POST to this URL when a customer replies to an outbound SMS.
// Register this URL in the TextMagic dashboard under:
//   Messaging → SMS Settings → Reply-to webhook URL
//   https://sly-rides.vercel.app/api/receive-textmagic-sms
//
// Supported keywords (case-insensitive):
//   EXTEND  — customer wants to extend their rental
//   1, 2, 3, 4, 7 — option selections after EXTEND prompt
//   STOP    — opt-out (TextMagic handles this natively; no action needed)
//
// Required environment variables:
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY
//   GITHUB_TOKEN, GITHUB_REPO
//   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY
//   TEXTMAGIC_WEBHOOK_SECRET (optional) — if set, validates X-TM-Signature header

import Stripe from "stripe";
import crypto from "crypto";
import { sendSms } from "./_textmagic.js";
import {
  render,
  DEFAULT_LOCATION,
  EXTEND_UNAVAILABLE,
  EXTEND_LIMITED,
  EXTEND_FLEXIBLE_PROMPT,
  EXTEND_INVALID_INPUT,
  EXTEND_SELECTED,
  EXTEND_SELECTED_UPSELL,
  EXTEND_PAYMENT_PENDING,
} from "./_sms-templates.js";
import { loadBookings, saveBookings, normalizePhone } from "./_bookings.js";
import { CARS } from "./_pricing.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { validateLink, PAGE_URLS } from "./_link-validator.js";
import { computeFinalReturnDate } from "./_final-return-date.js";
import { formatTime12h } from "./_time.js";

// Disable Vercel's built-in body parser so we can read the raw request body
// for TEXTMAGIC_WEBHOOK_SECRET HMAC-SHA256 signature verification.
export const config = {
  api: { bodyParser: false },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const ECONOMY_EXTENSION_PRICES = {
  1: { days: 1,  label: "+1 day",  price: 55  },
  3: { days: 3,  label: "+3 days", price: 165 },
  7: { days: 7,  label: "+1 week", price: 350 },
};

/**
 * Find the index of a booking within `data[vehicleId]` by bookingId or paymentIntentId.
 * Returns -1 if not found or if the vehicle's booking array is missing/not an array.
 */
function findBookingIndex(data, vehicleId, bookingId) {
  if (!Array.isArray(data[vehicleId])) return -1;
  return data[vehicleId].findIndex(
    (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
  );
}

/**
 * Find the active rental for a given phone number.
 * @param {object} allBookings
 * @param {string} phone - any format; matched by normalized number
 * @returns {{ vehicleId: string, booking: object }|null}
 */
function findActiveRental(allBookings, phone) {
  const norm = normalizePhone(phone);
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (booking.status !== "active_rental") continue;
      if (normalizePhone(booking.phone) === norm) {
        return { vehicleId, booking };
      }
    }
  }
  return null;
}

/**
 * Find a booking awaiting extend selection for a given phone number.
 */
function findExtendPending(allBookings, phone) {
  const norm = normalizePhone(phone);
  for (const [vehicleId, bookings] of Object.entries(allBookings)) {
    for (const booking of bookings) {
      if (!booking.extendPending) continue;
      if (normalizePhone(booking.phone) === norm) {
        return { vehicleId, booking };
      }
    }
  }
  return null;
}

/**
 * Check whether there is a conflict (next booking) within `extraMinutes` of
 * the current return time for the given vehicle.
 * Returns the maximum available extension minutes (or Infinity if fully free).
 */
// All booking statuses that represent a real, non-completed reservation.
// "active" and "active_rental" are distinct statuses (the latter is set by
// extend-rental.js). "reserved" and "reserved_unpaid" are also distinct:
// the former is an admin-created reservation, the latter a customer-initiated
// one without payment.  All eight statuses must be checked to correctly
// detect future reservations in any state.
const BLOCKING_SMS_STATUSES = new Set([
  "booked_paid", "reserved_unpaid", "active_rental",
  "reserved", "pending", "approved", "pending_verification", "active",
]);

function getAvailableExtensionMinutes(allBookings, vehicleId, currentReturnDate, currentReturnTime) {
  const returnDt = parseDateTime(currentReturnDate, currentReturnTime);
  if (isNaN(returnDt.getTime())) return Infinity;

  const vehicleBookings = (allBookings[vehicleId] || []).filter(
    (b) => BLOCKING_SMS_STATUSES.has(b.status)
  );

  let nextStart = Infinity;
  for (const b of vehicleBookings) {
    const start = parseDateTime(b.pickupDate, b.pickupTime).getTime();
    if (start > returnDt.getTime() && start < nextStart) {
      nextStart = start;
    }
  }

  if (nextStart === Infinity) return Infinity;
  return (nextStart - returnDt.getTime()) / 60000; // minutes until next booking starts
}

function parseDateTime(date, time) {
  if (!date) return new Date(NaN);
  const base = new Date(date + "T00:00:00");
  if (time) {
    const ampmMatch = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
      let h = parseInt(ampmMatch[1], 10);
      const m = parseInt(ampmMatch[2], 10);
      if (ampmMatch[3].toUpperCase() === "PM" && h !== 12) h += 12;
      if (ampmMatch[3].toUpperCase() === "AM" && h === 12) h = 0;
      base.setHours(h, m, 0, 0);
      return base;
    }
    const h24 = time.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (h24) {
      base.setHours(parseInt(h24[1], 10), parseInt(h24[2], 10), 0, 0);
      return base;
    }
  }
  return base;
}


/**
 * Parse a customer's freeform reply into a number of extension days.
 *
 * Accepted formats (case-insensitive):
 *   "3"           → 3
 *   "3 days"      → 3
 *   "3 day"       → 3
 *   "1 week"      → 7
 *   "2 weeks"     → 14
 *   "week"        → 7
 *   "month"       → 30
 *   "1 month"     → 30
 *   "2 months"    → 60
 *
 * Returns null when the input is unrecognisable or results in 0 / negative days.
 *
 * @param {string} text - raw customer reply (trimmed)
 * @returns {number|null}
 */
export function parseDaysFromMessage(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim().toLowerCase();

  // Bare "month" (no number prefix)
  if (t === "month") return 30;

  // "N months" / "N month"
  const monthMatch = t.match(/^(\d+)\s*months?$/);
  if (monthMatch) {
    const n = parseInt(monthMatch[1], 10);
    return n > 0 ? n * 30 : null;
  }

  // Bare "week" (no number prefix)
  if (t === "week") return 7;

  // "N weeks" / "N week"
  const weekMatch = t.match(/^(\d+)\s*weeks?$/);
  if (weekMatch) {
    const n = parseInt(weekMatch[1], 10);
    return n > 0 ? n * 7 : null;
  }

  // "N days" / "N day"
  const dayMatch = t.match(/^(\d+)\s*days?$/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1], 10);
    return n > 0 ? n : null;
  }

  // Plain integer
  const numMatch = t.match(/^(\d+)$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    return n > 0 ? n : null;
  }

  return null;
}

/**
 * Compute the extension price for a given number of days using the vehicle's
 * tiered pricing: monthly → biweekly → weekly → daily.
 *
 * Rates (camry defaults):
 *   1–6 days  → $55/day
 *   7 days    → $350
 *   14 days   → $650
 *   30 days   → $1,300
 *
 * @param {number} days       - number of extension days; values < 1 are clamped to 1
 * @param {object} [car]      - vehicle pricing object from CARS; defaults to camry rates
 * @returns {number}          - price in dollars (no tax applied)
 */
export function computeEconomyExtensionPriceDays(days, car = null) {
  const fallbackCar = { pricePerDay: 55, weekly: 350, biweekly: 650, monthly: 1300 };
  const c = (car && car.pricePerDay) ? car : (CARS.camry || fallbackCar);
  let remaining = Math.max(1, days);
  let cost = 0;

  if (c.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    cost += months * c.monthly;
    remaining = remaining % 30;
  }
  if (c.biweekly && remaining >= 14) {
    const periods = Math.floor(remaining / 14);
    cost += periods * c.biweekly;
    remaining = remaining % 14;
  }
  if (c.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    cost += weeks * c.weekly;
    remaining = remaining % 7;
  }
  cost += remaining * (c.pricePerDay || 55);
  return cost;
}

/**
 * Add hours to a time string ("3:00 PM" + 2h = "5:00 PM").
 * Returns both a formatted time string and the new ISO date/time.
 */
function addHoursToDateTime(date, time, extraHours) {
  const dt = parseDateTime(date, time);
  dt.setTime(dt.getTime() + extraHours * 3600000);
  const newTime = dt.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });
  const newDate = dt.toISOString().split("T")[0];
  return { newDate, newTime };
}

/**
 * Add days to a date string.
 */
function addDaysToDate(date, extraDays) {
  const dt = new Date(date + "T00:00:00");
  dt.setDate(dt.getDate() + extraDays);
  return dt.toISOString().split("T")[0];
}

/**
 * Create a Stripe PaymentIntent for the extension charge.
 * @param {string} vehicleId        - vehicle being extended
 * @param {object} booking          - active booking record
 * @param {string} newReturnDate    - new return date (YYYY-MM-DD)
 * @param {string} newReturnTime    - new return time (e.g. "3:00 PM")
 * @param {number} amount           - charge amount in dollars
 * @param {string} label            - human-readable extension label (e.g. "+2 days")
 */
async function createExtensionPaymentIntent(vehicleId, booking, newReturnDate, newReturnTime, amount, label) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const pi = await stripe.paymentIntents.create({
      amount:   Math.round(amount * 100),
      currency: "usd",
      description: `Rental extension — ${booking.vehicleName || vehicleId} — ${label} — ${booking.name}`,
      automatic_payment_methods: { enabled: true },
      metadata: {
        // "type" is the canonical field read by the webhook and booking_extensions pipeline.
        // "payment_type" is kept for backward compatibility with reconcile / scheduled-reminders.
        type:         "rental_extension",
        payment_type: "rental_extension",
        booking_id:   booking.bookingId || booking.paymentIntentId || "",
        vehicle_id:          vehicleId,
        vehicle_name:        booking.vehicleName || vehicleId || "",
        renter_name:         booking.name  || "",
        renter_email:        booking.email || "",
        renter_phone:        booking.phone || "",
        extension_label:     label,
        new_return_date:     newReturnDate || "",
        new_return_time:     newReturnTime ? formatTime12h(newReturnTime) : "",
      },
    });
    return pi;
  } catch (err) {
    console.error("receive-textmagic-sms: extension PaymentIntent failed:", err.message);
    return null;
  }
}

/**
 * Build the payment link for an extension.
 * The client secret and PaymentIntent ID are passed as query parameters so
 * balance.html can confirm the PaymentIntent in extension mode.
 */
function buildExtensionPaymentLink(clientSecret, piId) {
  const base = "https://www.slytrans.com/balance.html?ext=1";
  if (!clientSecret) return base;
  let url = `${base}&cs=${encodeURIComponent(clientSecret)}`;
  if (piId) url += `&piId=${encodeURIComponent(piId)}`;
  return url;
}

/**
 * Validate a payment link and log the result to sms_logs.metadata.
 *
 * Only the base page (balance.html) is validated via HEAD — the client_secret
 * query parameters are not reachable server-side and are not sent to the
 * validator.  If the base page is unreachable, the fallback URL is returned
 * and `fallbackUsed: true` is included in the log metadata.
 *
 * @param {string} fullLink    - the full payment URL (may contain ?cs=...)
 * @param {string} bookingId   - booking_ref for sms_logs write
 * @param {string} templateKey - sms template key for the sms_logs row
 * @returns {Promise<{ url: string, meta: object }>}
 */
async function validatePaymentLinkForSms(fullLink, bookingId, templateKey) {
  const validation = await validateLink(fullLink, {
    baseUrlForValidation: PAGE_URLS.balance,
    fallback:             PAGE_URLS.cars,
  });

  const meta = {
    link:          fullLink,
    validated:     validation.ok,
    http_status:   validation.status,
    fallback_used: validation.fallbackUsed,
    validated_at:  new Date().toISOString(),
  };

  // Best-effort: log to sms_logs.metadata for audit
  try {
    const sb = getSupabaseAdmin();
    if (sb && bookingId) {
      await sb.from("sms_logs").upsert(
        {
          booking_id:          bookingId,
          template_key:        templateKey,
          return_date_at_send: "1970-01-01",
          metadata:            meta,
        },
        { onConflict: "booking_id,template_key,return_date_at_send" }
      );
    }
  } catch (logErr) {
    console.warn("receive-textmagic-sms: sms_logs link metadata write failed (non-fatal):", logErr.message);
  }

  return { url: validation.url, meta };
}

/**
 * Handle the EXTEND keyword from a customer.
 */
async function handleExtend(fromPhone, allBookings, data, sha) {
  const match = findActiveRental(allBookings, fromPhone);
  if (!match) {
    await sendSms(fromPhone, "We couldn\u2019t find an active rental for this number. Please call us at (833) 252-1093.");
    return;
  }
  const { vehicleId, booking } = match;
  // Resolve the true final return date/time from revenue_records so that
  // availability checks and extension limits use the renter's actual current
  // return schedule (including any paid extensions), not a stale JSON value.
  const bookingId   = booking.bookingId || booking.paymentIntentId;
  const sb          = getSupabaseAdmin();
  const { date: finalReturnDate, time: finalReturnTime } = await computeFinalReturnDate(
    sb, bookingId, booking.returnDate, booking.returnTime
  );

  // Check availability using the final (possibly extended) return date/time.
  const availMinutes = getAvailableExtensionMinutes(
    allBookings, vehicleId, finalReturnDate, finalReturnTime || booking.returnTime
  );

  if (availMinutes <= 0) {
    await sendSms(fromPhone, render(EXTEND_UNAVAILABLE, {}));
    return;
  }

  // Check if extension is limited
  const minExtension = 24 * 60;
  if (availMinutes < minExtension) {
    const maxLabel = `${Math.floor(availMinutes / 60 / 24)} day(s)`;
    await sendSms(fromPhone, render(EXTEND_LIMITED, { max_available_time: maxLabel, vehicle: booking.vehicleName || vehicleId }));
    return;
  }

  // Mark this booking as awaiting option selection
  const idx = data[vehicleId].findIndex(
    (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
  );
  if (idx !== -1) {
    data[vehicleId][idx].extendPending = true;
    data[vehicleId][idx].extendAvailMinutes = availMinutes;
    await saveBookings(data, sha, `Mark extendPending for booking ${bookingId}`);
    // Dual-write to Supabase so extend_pending is queryable without GitHub JSON.
    try {
      if (sb && bookingId) {
        await sb
          .from("bookings")
          .update({ extend_pending: true, updated_at: new Date().toISOString() })
          .eq("booking_ref", bookingId);
      }
    } catch (sbErr) {
      console.error("receive-textmagic-sms: Supabase extendPending write failed (non-fatal):", sbErr.message);
    }
  }

  // Send option SMS
  const optionMsg = EXTEND_FLEXIBLE_PROMPT;
  await sendSms(fromPhone, optionMsg);
}

/**
 * Handle an extension option selection (1, 2, 3, 4, or 7).
 */
async function handleExtendSelection(fromPhone, option, allBookings, data, sha) {
  const match = findExtendPending(allBookings, fromPhone);
  if (!match) {
    // No pending extend — ignore unknown keyword
    return;
  }
  const { vehicleId, booking } = match;
  const optionNum = parseInt(option, 10);

  const pricing = ECONOMY_EXTENSION_PRICES;
  const selected = pricing[optionNum];

  if (!selected) {
    await sendSms(fromPhone, "Invalid option. Reply 1, 3, or 7.");
    return;
  }

  // Check this option fits within available time
  const availMinutes = booking.extendAvailMinutes || Infinity;
  const requiredMinutes = (selected.days || 1) * 24 * 60;
  if (requiredMinutes > availMinutes) {
    const maxLabel = `${Math.floor(availMinutes / 60 / 24)} day(s)`;
    await sendSms(fromPhone, render(EXTEND_LIMITED, { max_available_time: maxLabel, vehicle: booking.vehicleName || vehicleId }));
    return;
  }

  // Resolve the true final return date/time from revenue_records so the new
  // return date is computed from the renter's actual current end time, not a
  // potentially stale bookings.json value.
  const selectionBookingId = booking.bookingId || booking.paymentIntentId;
  const selSb = getSupabaseAdmin();
  const { date: selFinalDate, time: selFinalTime } = await computeFinalReturnDate(
    selSb, selectionBookingId, booking.returnDate, booking.returnTime
  );

  // Compute new return time / date first (needed for PI metadata)
  let newReturnDate = selFinalDate || booking.returnDate;
  let newReturnTime = selFinalTime || booking.returnTime;

  newReturnDate = addDaysToDate(newReturnDate, selected.days);

  // Create Stripe PaymentIntent for extension charge (with full metadata)
  const pi = await createExtensionPaymentIntent(vehicleId, booking, newReturnDate, newReturnTime, selected.price, selected.label);
  const rawPaymentLink = pi
    ? buildExtensionPaymentLink(pi.client_secret, pi.id)
    : (booking.paymentLink || "https://www.slytrans.com/balance.html");

  // Validate the base page is reachable before storing or sending the link
  const bookingId = booking.bookingId || booking.paymentIntentId;
  const { url: paymentLink } = await validatePaymentLinkForSms(
    rawPaymentLink,
    bookingId,
    "extend_selected"
  );

  // Save extension info to booking
  const idx = findBookingIndex(data, vehicleId, bookingId);
  if (idx !== -1) {
    data[vehicleId][idx].extendPending = false;
    data[vehicleId][idx].extensionPendingPayment = {
      option:         optionNum,
      label:          selected.label,
      price:          selected.price,
      newReturnDate,
      newReturnTime,
      paymentIntentId: pi ? pi.id : null,
      paymentLink,
      createdAt:      new Date().toISOString(),
    };
    if (!data[vehicleId][idx].extensionCount) data[vehicleId][idx].extensionCount = 0;
    await saveBookings(data, sha, `Save extension selection for booking ${bookingId}`);
    // Dual-write to Supabase so extension_pending_payment is durable.
    try {
      const sb = getSupabaseAdmin();
      if (sb && bookingId) {
        await sb
          .from("bookings")
          .update({
            extend_pending:            false,
            extension_pending_payment: data[vehicleId][idx].extensionPendingPayment,
            updated_at:                new Date().toISOString(),
          })
          .eq("booking_ref", bookingId);
      }
    } catch (sbErr) {
      console.error("receive-textmagic-sms: Supabase extensionPendingPayment write failed (non-fatal):", sbErr.message);
    }
  }

  await sendSms(
    fromPhone,
    render(EXTEND_SELECTED, {
      extra_time:   selected.label,
      vehicle:      booking.vehicleName || vehicleId,
      price:        String(selected.price),
      payment_link: paymentLink,
    })
  );
}

/**
 * Handle a flexible day-count extension for economy vehicles.
 * Called after `parseDaysFromMessage` has successfully extracted the number of days.
 *
 * Pricing tiers (camry defaults):
 *   1–6 days  → $55/day
 *   7 days    → $350
 *   14 days   → $650
 *   30 days   → $1,300
 *
 * Upsell: when the customer requests fewer than 7 days, the confirmation SMS
 * includes a note that a full 7-day extension is available at the weekly rate.
 *
 * @param {string} fromPhone
 * @param {number} days          - parsed extension days (must be ≥ 1)
 * @param {object} allBookings
 * @param {object} data          - mutable bookings data snapshot
 * @param {string} sha           - current GitHub SHA for optimistic locking
 */
async function handleFlexibleEconomyExtension(fromPhone, days, allBookings, data, sha) {
  const match = findExtendPending(allBookings, fromPhone);
  if (!match) return; // shouldn't happen — caller verified this

  const { vehicleId, booking } = match;

  // Check calendar availability
  const availMinutes = getAvailableExtensionMinutes(allBookings, vehicleId, booking.returnDate, booking.returnTime);
  const requiredMinutes = days * 24 * 60;

  if (availMinutes !== Infinity && requiredMinutes > availMinutes) {
    const maxDays = Math.max(0, Math.floor(availMinutes / 60 / 24));
    await sendSms(
      fromPhone,
      render(EXTEND_LIMITED, {
        max_available_time: `${maxDays} day${maxDays !== 1 ? "s" : ""}`,
        vehicle: booking.vehicleName || vehicleId,
      })
    );
    return;
  }

  // Compute tiered price using the booking vehicle's rates (fall back to camry)
  const car = CARS[vehicleId] || CARS.camry;
  const price = computeEconomyExtensionPriceDays(days, car);
  const label = `+${days} day${days !== 1 ? "s" : ""}`;
  const newReturnDate = addDaysToDate(booking.returnDate, days);
  const newReturnTime = booking.returnTime || "";

  // Create Stripe PaymentIntent for the extension charge
  const pi = await createExtensionPaymentIntent(vehicleId, booking, newReturnDate, newReturnTime, price, label);
  const rawPaymentLink = pi
    ? buildExtensionPaymentLink(pi.client_secret, pi.id)
    : (booking.paymentLink || "https://www.slytrans.com/balance.html");

  // Validate base page before storing or sending the link
  const bookingId = booking.bookingId || booking.paymentIntentId;
  const templateKey = days < 7 ? "extend_selected_upsell" : "extend_selected";
  const { url: paymentLink } = await validatePaymentLinkForSms(rawPaymentLink, bookingId, templateKey);
  const idx = findBookingIndex(data, vehicleId, bookingId);
  if (idx !== -1) {
    data[vehicleId][idx].extendPending = false;
    data[vehicleId][idx].extensionPendingPayment = {
      days,
      label,
      price,
      newReturnDate,
      newReturnTime,
      paymentIntentId: pi ? pi.id : null,
      paymentLink,
      createdAt: new Date().toISOString(),
    };
    await saveBookings(data, sha, `Save flexible extension selection for booking ${bookingId}`);
    // Dual-write to Supabase
    try {
      const sb = getSupabaseAdmin();
      if (sb && bookingId) {
        await sb
          .from("bookings")
          .update({
            extend_pending:            false,
            extension_pending_payment: data[vehicleId][idx].extensionPendingPayment,
            updated_at:                new Date().toISOString(),
          })
          .eq("booking_ref", bookingId);
      }
    } catch (sbErr) {
      console.error("receive-textmagic-sms: Supabase flexibleExtension write failed (non-fatal):", sbErr.message);
    }
  }

  // Send confirmation SMS — include weekly upsell when days < 7
  const weeklyPrice = car.weekly || 350;
  if (days < 7) {
    await sendSms(
      fromPhone,
      render(EXTEND_SELECTED_UPSELL, {
        extra_time:   label,
        vehicle:      booking.vehicleName || vehicleId,
        price:        String(price),
        payment_link: paymentLink,
        weekly_price: String(weeklyPrice),
      })
    );
  } else {
    await sendSms(
      fromPhone,
      render(EXTEND_SELECTED, {
        extra_time:   label,
        vehicle:      booking.vehicleName || vehicleId,
        price:        String(price),
        payment_link: paymentLink,
      })
    );
  }
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

  // Buffer raw body (required for signature verification and manual JSON parsing).
  const chunks = [];
  try {
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => { chunks.push(chunk); });
      req.on("end", resolve);
      req.on("error", reject);
    });
  } catch (bufErr) {
    console.error("receive-textmagic-sms: failed to read request body:", bufErr);
    return res.status(400).json({ error: "Failed to read request body" });
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");

  // Validate X-TM-Signature header when TEXTMAGIC_WEBHOOK_SECRET is configured.
  const tmSecret = process.env.TEXTMAGIC_WEBHOOK_SECRET;
  const tmSig = req.headers["x-tm-signature"];
  if (tmSecret) {
    if (!tmSig) {
      console.warn("receive-textmagic-sms: missing X-TM-Signature header — rejecting request");
      return res.status(403).json({ error: "Missing signature" });
    }
    const expectedSig = crypto
      .createHmac("sha256", tmSecret)
      .update(rawBody)
      .digest("hex");
    if (expectedSig !== tmSig) {
      console.warn("receive-textmagic-sms: X-TM-Signature mismatch — rejecting request");
      return res.status(403).json({ error: "Invalid signature" });
    }
  }

  // Parse the JSON body (Vercel body parser is disabled above).
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (parseErr) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  // TextMagic sends: { from, to, text, id, ... }
  const { from: fromPhone, text: messageText } = body;

  if (!fromPhone || !messageText) {
    return res.status(400).json({ error: "Missing from or text" });
  }

  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    console.warn("receive-textmagic-sms: TextMagic credentials not set");
    return res.status(200).json({ ok: true }); // acknowledge to avoid TextMagic retries
  }

  const keyword = messageText.trim().toUpperCase();

  // STOP is handled natively by TextMagic — acknowledge and exit
  if (keyword === "STOP") {
    return res.status(200).json({ ok: true });
  }

  let allBookings, data, sha;
  try {
    const loaded = await loadBookings();
    allBookings = loaded.data;
    data = loaded.data;
    sha = loaded.sha;
  } catch (err) {
    console.error("receive-textmagic-sms: failed to load bookings:", err);
    return res.status(500).json({ error: "Internal error" });
  }

  try {
    const normalizedFrom = normalizePhone(fromPhone);

    if (keyword === "EXTEND") {
      await handleExtend(normalizedFrom, allBookings, data, sha);
    } else {
      // Check if this customer has a pending extend selection
      const pendingMatch = findExtendPending(allBookings, normalizedFrom);
      if (pendingMatch) {
        // Economy: flexible day input ("3", "3 days", "2 weeks", "month", …)
        {
          const days = parseDaysFromMessage(messageText.trim());
          if (days === null) {
            await sendSms(
              normalizedFrom,
              render(EXTEND_INVALID_INPUT, {
                options: "a number of days — e.g. 3, 7, 14, or say \"2 weeks\", \"month\"",
              })
            );
          } else {
            await handleFlexibleEconomyExtension(normalizedFrom, days, allBookings, data, sha);
          }
        }
      }
      // Unknown keywords with no pending extension are silently ignored
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("receive-textmagic-sms: handler error:", err);
    return res.status(200).json({ ok: true }); // acknowledge to TextMagic regardless
  }
}
