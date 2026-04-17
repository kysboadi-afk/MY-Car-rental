// api/extend-rental.js
// Vercel serverless function — creates a Stripe PaymentIntent for a web-initiated
// rental extension.  Called from car.html when the current renter wants to
// extend their rental via the "Extend Rental" form.
//
// POST /api/extend-rental
// Body: { vehicleId, email, phone, newReturnDate, newReturnTime }
//
// Returns: { clientSecret, publishableKey, extensionAmount, extensionLabel,
//            newReturnDate, newReturnTime, vehicleName, renterName }
//
// Required environment variables:
//   STRIPE_SECRET_KEY
//   STRIPE_PUBLISHABLE_KEY
//   GITHUB_TOKEN   (to read/write bookings.json)
//   GITHUB_REPO    (defaults to kysboadi-afk/SLY-RIDES)

import Stripe from "stripe";
import { getVehicleById } from "./_vehicles.js";
import { loadPricingSettings, applyTax } from "./_settings.js";
import { loadBookings, updateBooking, normalizePhone } from "./_bookings.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/**
 * Parse a date+optional time into Unix ms.
 * Supports "H:MM AM/PM", "HH:MM", and falls back to midnight.
 */
function parseDateTimeMs(date, time) {
  if (!date) return NaN;
  const base = new Date(date + "T00:00:00");
  if (time && typeof time === "string") {
    const t = time.trim();
    const ampm = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const p = ampm[3].toUpperCase();
      if (p === "PM" && h !== 12) h += 12;
      if (p === "AM" && h === 12) h = 0;
      base.setHours(h, m, 0, 0);
    } else {
      const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
      if (h24) base.setHours(parseInt(h24[1], 10), parseInt(h24[2], 10), 0, 0);
    }
  }
  return base.getTime();
}

export default async function handler(req, res) {
  // CORS — allow requests from the production frontend only
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("extend-rental: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("extend-rental: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  const { vehicleId, email, phone, newReturnDate, newReturnTime } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────────
  const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
  if (!vehicleData) {
    return res.status(400).json({ error: "Invalid vehicle." });
  }

  const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";

  if (!trimmedEmail && !trimmedPhone) {
    return res.status(400).json({ error: "Email or phone number is required to verify your rental." });
  }

  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  if (!newReturnDate || !/^\d{4}-\d{2}-\d{2}$/.test(newReturnDate)) {
    return res.status(400).json({ error: "New return date is required (YYYY-MM-DD)." });
  }

  try {
    // ── Load bookings and find the active rental ────────────────────────────
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicleId] || [];

    const normalizedPhone = trimmedPhone ? normalizePhone(trimmedPhone) : null;

    let activeBooking = null;
    let activeIdx = -1;

    for (let i = 0; i < vehicleBookings.length; i++) {
      const b = vehicleBookings[i];
      if (b.status !== "active_rental") continue;

      const emailMatch = trimmedEmail && b.email &&
        b.email.trim().toLowerCase() === trimmedEmail;
      const phoneMatch = normalizedPhone && b.phone &&
        normalizePhone(b.phone) === normalizedPhone;

      if (emailMatch || phoneMatch) {
        activeBooking = b;
        activeIdx = i;
        break;
      }
    }

    if (!activeBooking) {
      return res.status(404).json({
        error: "No active rental found for this vehicle with the provided contact info. " +
               "Please check your email or phone number, or call us at (213) 916-6606.",
      });
    }

    // ── Enforce return_time = pickup_time ───────────────────────────────────
    // The system rule is that a rental's return time must always equal its
    // pickup time so windows are clean and predictable.  Any return_time
    // supplied by the caller is ignored and replaced with the booking's
    // pickup_time.  If the booking has no pickupTime (legacy data), we fall
    // back to its existing returnTime so the comparison below still works.
    const resolvedReturnTime = activeBooking.pickupTime || activeBooking.returnTime || "";
    if (newReturnTime && newReturnTime !== resolvedReturnTime) {
      console.warn(
        `extend-rental: new_return_time "${newReturnTime}" overridden with ` +
        `pickup_time "${resolvedReturnTime}" for active booking of ${vehicleId}`
      );
    }

    // ── Validate new return date is after current return date ───────────────
    const currentReturnMs = parseDateTimeMs(activeBooking.returnDate, activeBooking.returnTime || "");
    const newReturnMs     = parseDateTimeMs(newReturnDate, resolvedReturnTime);

    if (isNaN(newReturnMs)) {
      return res.status(400).json({ error: "Invalid new return date/time." });
    }

    if (newReturnMs <= currentReturnMs) {
      return res.status(400).json({
        error: "New return date/time must be after your current return date/time " +
               `(${activeBooking.returnDate}${resolvedReturnTime ? " " + resolvedReturnTime : ""}).`,
      });
    }

    // ── Check for conflicts with future bookings ────────────────────────────
    for (const b of vehicleBookings) {
      if (b === activeBooking) continue;
      if (b.status === "cancelled" || b.status === "completed_rental") continue;

      // Conflict: a future booking's pickup is at or before our new return
      const futurePickupMs = parseDateTimeMs(b.pickupDate, b.pickupTime || "");
      if (!isNaN(futurePickupMs) && futurePickupMs < newReturnMs) {
        const fmtDate = new Date(b.pickupDate + "T00:00:00")
          .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        return res.status(409).json({
          error: `The new return date conflicts with another booking starting on ${fmtDate}. ` +
                 "Please choose an earlier return date.",
        });
      }
    }

    // ── Compute extension price ────────────────────────────────────────────
    const settings = await loadPricingSettings();
    const isSlingshot = vehicleData.isSlingshot;

    let extensionAmountPreTax;
    let extensionLabel;

    if (isSlingshot) {
      // Slingshot: bill by extra hours at daily rate ÷ 24
      const extraMs    = newReturnMs - currentReturnMs;
      const extraHours = Math.max(1, Math.ceil(extraMs / 3600000));
      const dailyRate  = settings.slingshot_daily_rate || 350;
      const hourlyRate = dailyRate / 24;
      extensionAmountPreTax = Math.ceil(extraHours * hourlyRate);
      extensionLabel = `+${extraHours} hour${extraHours !== 1 ? "s" : ""}`;
    } else {
      // Economy/car vehicles: bill by extra days using the same tiered pricing as
      // the main booking flow (monthly → bi-weekly → weekly → daily).
      // Use the vehicle's own stored rates so newly added vehicles are priced
      // correctly (not at the hardcoded Camry rates).
      const extraMs   = newReturnMs - currentReturnMs;
      const extraDays = Math.max(1, Math.ceil(extraMs / (24 * 3600000)));
      extensionLabel  = `+${extraDays} day${extraDays !== 1 ? "s" : ""}`;

      const dailyRate   = vehicleData.pricePerDay    || settings.camry_daily_rate    || 55;
      const weeklyRate  = vehicleData.weekly         || settings.camry_weekly_rate   || null;
      const biweekRate  = vehicleData.biweekly       || settings.camry_biweekly_rate || null;
      const monthlyRate = vehicleData.monthly        || settings.camry_monthly_rate  || null;

      let cost      = 0;
      let remaining = extraDays;

      if (monthlyRate && remaining >= 30) {
        const months = Math.floor(remaining / 30);
        cost      += months * monthlyRate;
        remaining  = remaining % 30;
      }
      if (biweekRate && remaining >= 14) {
        const periods = Math.floor(remaining / 14);
        cost      += periods * biweekRate;
        remaining  = remaining % 14;
      }
      if (weeklyRate && remaining >= 7) {
        const weeks = Math.floor(remaining / 7);
        cost      += weeks * weeklyRate;
        remaining  = remaining % 7;
      }
      cost += remaining * dailyRate;

      extensionAmountPreTax = cost;
    }

    // Slingshot: no tax — consistent with the main booking flow which also charges no tax.
    // Economy vehicles: apply LA sales tax (same as the main booking flow).
    const extensionAmount = isSlingshot
      ? extensionAmountPreTax
      : applyTax(extensionAmountPreTax, settings);

    // ── Create Stripe PaymentIntent ─────────────────────────────────────────
    const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);

    const pi = await stripe.paymentIntents.create({
      amount:   Math.round(extensionAmount * 100),
      currency: "usd",
      description: `Rental extension — ${vehicleData.name} — ${extensionLabel} — ${activeBooking.name || ""}`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      receipt_email: activeBooking.email || undefined,
      metadata: {
        payment_type:        "rental_extension",
        original_booking_id: activeBooking.bookingId || activeBooking.paymentIntentId || "",
        vehicle_id:          vehicleId,
        vehicle_name:        vehicleData.name,
        renter_name:         activeBooking.name  || "",
        renter_email:        activeBooking.email || "",
        renter_phone:        activeBooking.phone || "",
        extension_label:     extensionLabel,
        new_return_date:     newReturnDate,
        new_return_time:     resolvedReturnTime,
      },
    });

    // ── Store extensionPendingPayment on the booking ────────────────────────
    // updateBooking() uses updateJsonFileWithRetry internally and handles SHA
    // conflicts gracefully.
    const bookingId = activeBooking.bookingId || activeBooking.paymentIntentId;
    if (bookingId) {
      try {
        await updateBooking(vehicleId, bookingId, {
          extensionPendingPayment: {
            label:           extensionLabel,
            price:           extensionAmount,
            newReturnDate,
            newReturnTime:   resolvedReturnTime,
            paymentIntentId: pi.id,
            createdAt:       new Date().toISOString(),
          },
        });
      } catch (updateErr) {
        // Non-fatal: the webhook can fall back to PI metadata if the booking
        // record was not updated.
        console.warn("extend-rental: could not update extensionPendingPayment (non-fatal):", updateErr.message);
      }
    }

    return res.status(200).json({
      clientSecret:    pi.client_secret,
      publishableKey:  process.env.STRIPE_PUBLISHABLE_KEY,
      extensionAmount: extensionAmount.toFixed(2),
      extensionLabel,
      newReturnDate,
      newReturnTime:   resolvedReturnTime,
      vehicleName:     vehicleData.name,
      renterName:      activeBooking.name || "",
    });
  } catch (err) {
    console.error("extend-rental error:", err);
    return res.status(500).json({ error: "Failed to create extension payment. Please try again or call (213) 916-6606." });
  }
}
