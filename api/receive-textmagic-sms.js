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
import { render, DEFAULT_LOCATION, EXTEND_UNAVAILABLE, EXTEND_LIMITED, EXTEND_OPTIONS_SLINGSHOT, EXTEND_OPTIONS_ECONOMY, EXTEND_SELECTED, EXTEND_PAYMENT_PENDING } from "./_sms-templates.js";
import { loadBookings, saveBookings, normalizePhone } from "./_bookings.js";
import { CARS } from "./_pricing.js";
import { getSupabaseAdmin } from "./_supabase.js";

// Disable Vercel's built-in body parser so we can read the raw request body
// for TEXTMAGIC_WEBHOOK_SECRET HMAC-SHA256 signature verification.
export const config = {
  api: { bodyParser: false },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Extension options per vehicle class
const SLINGSHOT_EXTENSION_PRICES = {
  1: { hours: 1,  label: "+1 hour",  price: 50  },
  2: { hours: 2,  label: "+2 hours", price: 100 },
  4: { hours: 4,  label: "+4 hours", price: 150 },
};

const ECONOMY_EXTENSION_PRICES = {
  1: { days: 1,  label: "+1 day",  price: 55  },
  3: { days: 3,  label: "+3 days", price: 165 },
  7: { days: 7,  label: "+1 week", price: 350 },
};

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
function getAvailableExtensionMinutes(allBookings, vehicleId, currentReturnDate, currentReturnTime) {
  const returnDt = parseDateTime(currentReturnDate, currentReturnTime);
  if (isNaN(returnDt.getTime())) return Infinity;

  const vehicleBookings = (allBookings[vehicleId] || []).filter(
    (b) => b.status === "booked_paid" || b.status === "reserved_unpaid" || b.status === "active_rental"
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

function isSlingshotVehicle(vehicleId) {
  return typeof vehicleId === "string" && vehicleId.startsWith("slingshot");
}

/**
 * Add hours to a time string ("3:00 PM" + 2h = "5:00 PM").
 * Returns both a formatted time string and the new ISO date/time.
 */
function addHoursToDateTime(date, time, extraHours) {
  const dt = parseDateTime(date, time);
  dt.setTime(dt.getTime() + extraHours * 3600000);
  const newTime = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
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
        payment_type: "rental_extension",
        booking_id:   booking.bookingId || booking.paymentIntentId,
        vehicle_id:          vehicleId,
        vehicle_name:        booking.vehicleName || vehicleId,
        renter_name:         booking.name  || "",
        renter_email:        booking.email || "",
        renter_phone:        booking.phone || "",
        extension_label:     label,
        new_return_date:     newReturnDate || "",
        new_return_time:     newReturnTime || "",
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
 * Handle the EXTEND keyword from a customer.
 */
async function handleExtend(fromPhone, allBookings, data, sha) {
  const match = findActiveRental(allBookings, fromPhone);
  if (!match) {
    await sendSms(fromPhone, "We couldn\u2019t find an active rental for this number. Please call us at (213) 916-6606.");
    return;
  }
  const { vehicleId, booking } = match;
  const isSlingshot = isSlingshotVehicle(vehicleId);

  // Check availability
  const availMinutes = getAvailableExtensionMinutes(allBookings, vehicleId, booking.returnDate, booking.returnTime);

  if (availMinutes <= 0) {
    await sendSms(fromPhone, render(EXTEND_UNAVAILABLE, {}));
    return;
  }

  // Check if extension is limited
  const minExtension = isSlingshot ? 60 : 24 * 60; // 1h for Slingshot, 1 day for economy
  if (availMinutes < minExtension) {
    const maxLabel = isSlingshot
      ? `${Math.floor(availMinutes)} minutes`
      : `${Math.floor(availMinutes / 60 / 24)} day(s)`;
    await sendSms(fromPhone, render(EXTEND_LIMITED, { max_available_time: maxLabel, vehicle: booking.vehicleName || vehicleId }));
    return;
  }

  // Mark this booking as awaiting option selection
  const bookingId = booking.bookingId || booking.paymentIntentId;
  const idx = data[vehicleId].findIndex(
    (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
  );
  if (idx !== -1) {
    data[vehicleId][idx].extendPending = true;
    data[vehicleId][idx].extendAvailMinutes = availMinutes;
    await saveBookings(data, sha, `Mark extendPending for booking ${bookingId}`);
    // Dual-write to Supabase so extend_pending is queryable without GitHub JSON.
    try {
      const sb = getSupabaseAdmin();
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
  const optionMsg = isSlingshot ? EXTEND_OPTIONS_SLINGSHOT : EXTEND_OPTIONS_ECONOMY;
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
  const isSlingshot = isSlingshotVehicle(vehicleId);
  const optionNum = parseInt(option, 10);

  const pricing = isSlingshot ? SLINGSHOT_EXTENSION_PRICES : ECONOMY_EXTENSION_PRICES;
  const selected = pricing[optionNum];

  if (!selected) {
    await sendSms(fromPhone, "Invalid option. " + (isSlingshot ? "Reply 1, 2, or 4." : "Reply 1, 3, or 7."));
    return;
  }

  // Check this option fits within available time
  const availMinutes = booking.extendAvailMinutes || Infinity;
  const requiredMinutes = isSlingshot ? selected.hours * 60 : (selected.days || 1) * 24 * 60;
  if (requiredMinutes > availMinutes) {
    const maxLabel = isSlingshot
      ? `${Math.floor(availMinutes)} minutes`
      : `${Math.floor(availMinutes / 60 / 24)} day(s)`;
    await sendSms(fromPhone, render(EXTEND_LIMITED, { max_available_time: maxLabel, vehicle: booking.vehicleName || vehicleId }));
    return;
  }

  // Compute new return time / date first (needed for PI metadata)
  let newReturnDate = booking.returnDate;
  let newReturnTime = booking.returnTime;

  if (isSlingshot) {
    const updated = addHoursToDateTime(booking.returnDate, booking.returnTime, selected.hours);
    newReturnDate = updated.newDate;
    newReturnTime = updated.newTime;
  } else {
    newReturnDate = addDaysToDate(booking.returnDate, selected.days);
  }

  // Create Stripe PaymentIntent for extension charge (with full metadata)
  const pi = await createExtensionPaymentIntent(vehicleId, booking, newReturnDate, newReturnTime, selected.price, selected.label);
  const paymentLink = pi
    ? buildExtensionPaymentLink(pi.client_secret, pi.id)
    : (booking.paymentLink || "https://www.slytrans.com/balance.html");

  // Save extension info to booking
  const bookingId = booking.bookingId || booking.paymentIntentId;
  const idx = data[vehicleId].findIndex(
    (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
  );
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
    } else if (/^[12347]$/.test(keyword)) {
      // Numeric reply — could be an extension option selection
      await handleExtendSelection(normalizedFrom, keyword, allBookings, data, sha);
    }
    // Unknown keywords are silently ignored

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("receive-textmagic-sms: handler error:", err);
    return res.status(200).json({ ok: true }); // acknowledge to TextMagic regardless
  }
}
