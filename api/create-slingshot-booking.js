// api/create-slingshot-booking.js
// Vercel serverless function — creates a Stripe PaymentIntent for a slingshot
// package booking.  Slingshots are priced in fixed hourly packages (2hr / 3hr /
// 6hr / 24hr).  No sales tax applies and no DPP / insurance choice is required.
//
// POST /api/create-slingshot-booking
// Body: {
//   vehicleId, slingshotPackage, pickupDate, pickupTime,
//   name, email, phone, idFileName, idBackFileName,
//   adminOverride, testMode
// }
// Returns: { clientSecret, publishableKey, bookingId, stripeCustomerId }

import crypto from "crypto";
import Stripe from "stripe";
import { getVehicleById } from "./_vehicles.js";
import {
  getSlingshotPackage,
  SLINGSHOT_DEPOSIT,
  MS_PER_HOUR,
  computeSlingshotReturn,
  isReturnWithinBusinessHours,
  splitDatetimeLA,
} from "./_slingshot-packages.js";
import { buildDateTimeLA, normalizeClockTime, formatTime12h } from "./_time.js";
import { isDatesAndTimesAvailable, isVehicleAvailable } from "./_availability.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { normalizeVehicleId } from "./_vehicle-id.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("create-slingshot-booking: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is missing." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("create-slingshot-booking: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_PUBLISHABLE_KEY is missing." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const {
      vehicleId,
      slingshotPackage,
      pickupDate,
      pickupTime: rawPickupTime,
      name,
      email,
      phone,
      idFileName,
      idBackFileName,
      adminOverride,
      testMode,
    } = req.body || {};

    const adminOverrideEnabled = adminOverride === true || /^(true|1)$/i.test(String(adminOverride || ""));
    const testModeEnabled = testMode === true || /^(true|1)$/i.test(String(testMode || ""));
    const testAvailabilityOverride = adminOverrideEnabled && testModeEnabled;

    // ── Validate vehicle ──────────────────────────────────────────────────────
    const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
    if (!vehicleData) {
      return res.status(400).json({ error: "Invalid vehicle. Please go back and select a slingshot." });
    }
    if (vehicleData.type !== "slingshot") {
      return res.status(400).json({ error: "This booking endpoint is only for slingshot vehicles." });
    }

    // ── Validate package ──────────────────────────────────────────────────────
    const pkg = getSlingshotPackage(slingshotPackage);
    if (!pkg) {
      return res.status(400).json({ error: "Invalid rental package. Please select 2hr, 3hr, 6hr, or 24hr." });
    }

    // ── Validate pickup date/time ─────────────────────────────────────────────
    if (!pickupDate || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      return res.status(400).json({ error: "Pickup date is required (YYYY-MM-DD)." });
    }
    const normalizedPickupTime = normalizeClockTime(rawPickupTime);
    if (!normalizedPickupTime) {
      return res.status(400).json({ error: "Pickup time is required." });
    }

    // ── Build pickup datetime in LA timezone ──────────────────────────────────
    const pickupDatetimeLA = buildDateTimeLA(pickupDate, normalizedPickupTime);
    if (isNaN(pickupDatetimeLA.getTime())) {
      return res.status(400).json({ error: "Invalid pickup date or time." });
    }

    // Must not be in the past (10-min grace for slow connections).
    if (pickupDatetimeLA.getTime() < Date.now() - 10 * 60 * 1000) {
      return res.status(400).json({ error: "Pickup time cannot be in the past. Please select a future time." });
    }

    // ── Compute return datetime ───────────────────────────────────────────────
    const returnDatetimeLA = computeSlingshotReturn(pickupDatetimeLA, slingshotPackage);
    if (!returnDatetimeLA) {
      return res.status(400).json({ error: "Could not compute return datetime." });
    }

    // ── Business hours check ──────────────────────────────────────────────────
    if (!isReturnWithinBusinessHours(slingshotPackage, returnDatetimeLA)) {
      return res.status(400).json({
        error: `The ${pkg.label} package would return the vehicle after 8:00 PM Los Angeles time. ` +
               "Please select an earlier pickup time. Only 24-hour bookings may end after business hours.",
      });
    }

    // Extract date/time components in LA timezone.
    const { date: returnDate, time: returnTime } = splitDatetimeLA(returnDatetimeLA);
    const { date: pickupDateLA } = splitDatetimeLA(pickupDatetimeLA);

    // ── Validate contact info ─────────────────────────────────────────────────
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Full name is required." });
    }
    const trimmedName  = name.trim();
    const trimmedPhone = phone && typeof phone === "string" ? phone.trim() : "";
    if (!trimmedPhone) {
      return res.status(400).json({ error: "Phone number is required." });
    }

    // ── ID upload validation ──────────────────────────────────────────────────
    const trimmedIdFileName = typeof idFileName === "string" ? idFileName.trim() : "";
    if (!trimmedIdFileName) {
      return res.status(400).json({ error: "A government-issued ID (front) is required for all bookings." });
    }
    const trimmedIdBackFileName = typeof idBackFileName === "string" ? idBackFileName.trim() : "";
    if (!trimmedIdBackFileName) {
      return res.status(400).json({ error: "The back of your Driver's License / ID is required." });
    }

    // ── Availability check ────────────────────────────────────────────────────
    if (!testAvailabilityOverride) {
      const available = await isDatesAndTimesAvailable(
        vehicleId,
        pickupDateLA,
        returnDate,
        normalizedPickupTime,
        returnTime
      );
      if (!available) {
        return res.status(409).json({ error: "This time slot is no longer available. Please select a different time." });
      }
      const vehicleAvailable = await isVehicleAvailable(vehicleId);
      if (!vehicleAvailable) {
        return res.status(409).json({ error: "This vehicle is currently unavailable for booking." });
      }
    }

    const sb = getSupabaseAdmin();
    if (!sb) {
      return res.status(503).json({ error: "Database unavailable. Please try again." });
    }

    // ── Outstanding balance check ─────────────────────────────────────────────
    try {
      const { data: balanceRows } = await sb
        .from("bookings")
        .select("booking_ref, balance_due")
        .eq("customer_email", email.toLowerCase().trim())
        .gt("balance_due", 0)
        .limit(1);
      if (balanceRows && balanceRows.length > 0) {
        const outstanding = Number(balanceRows[0].balance_due || 0);
        return res.status(402).json({
          error: `You have an outstanding balance of $${outstanding.toFixed(2)} from a previous booking. ` +
                 "Please complete your payment at https://www.slytrans.com/balance.html before booking again.",
        });
      }
    } catch (balanceErr) {
      console.warn("[SLINGSHOT_BOOKING] Balance check failed (non-fatal):", balanceErr.message);
    }

    // ── Compute total amount (no tax on slingshots) ───────────────────────────
    // Total = package price + $500 refundable security deposit.
    const totalAmount = pkg.price + SLINGSHOT_DEPOSIT;

    // ── Find or create Stripe Customer ────────────────────────────────────────
    let stripeCustomerId;
    try {
      const existing = await stripe.customers.list({ email, limit: 1 });
      if (existing.data.length > 0) {
        stripeCustomerId = existing.data[0].id;
      } else {
        const newCust = await stripe.customers.create({
          email,
          name: trimmedName,
          ...(trimmedPhone ? { phone: trimmedPhone } : {}),
        });
        stripeCustomerId = newCust.id;
      }
    } catch (custErr) {
      console.error("[SLINGSHOT_BOOKING] Stripe Customer error:", custErr.message);
      return res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }

    // ── Pre-write booking to Supabase BEFORE creating Stripe PI ──────────────
    const bookingId = "bk-" + crypto.randomBytes(6).toString("hex");
    const normalizedVehicleId = normalizeVehicleId(vehicleId) || vehicleId;

    const preWriteRow = {
      booking_ref:       bookingId,
      vehicle_id:        normalizedVehicleId || null,
      pickup_date:       pickupDateLA,
      return_date:       returnDate,
      pickup_time:       normalizedPickupTime || null,
      return_time:       returnTime || null,
      status:            "pending",
      total_price:       totalAmount,
      deposit_paid:      0,
      remaining_balance: totalAmount,
      payment_status:    "unpaid",
      payment_method:    "stripe",
      customer_name:     trimmedName  || null,
      customer_email:    email        || null,
      customer_phone:    trimmedPhone || null,
      renter_phone:      trimmedPhone || null,
    };

    const { error: preWriteErr } = await sb
      .from("bookings")
      .upsert(preWriteRow, { onConflict: "booking_ref" });

    if (preWriteErr) {
      console.error("[SLINGSHOT_BOOKING_PREWRITE_FAILED]", {
        bookingId,
        vehicleId,
        error: preWriteErr.message,
        code:  preWriteErr.code,
      });
      return res.status(503).json({ error: "Booking could not be saved. Please try again." });
    }

    console.log("[SLINGSHOT_BOOKING_PREWRITE]", {
      bookingId,
      vehicleId: normalizedVehicleId,
      pickupDateLA,
      returnDate,
      package: slingshotPackage,
      totalAmount,
    });

    // ── Create Stripe PaymentIntent ───────────────────────────────────────────
    const paymentIntentParams = {
      amount:   Math.round(totalAmount * 100), // Stripe expects whole cents
      currency: "usd",
      customer: stripeCustomerId,
      setup_future_usage: "off_session",
      receipt_email: email,
      description: `Sly Transportation Services LLC – ${vehicleData.name} – ${pkg.label}`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      metadata: {
        booking_id:         bookingId,
        booking_type:       "slingshot",
        stripe_customer_id: stripeCustomerId,
        renter_name:        trimmedName,
        renter_phone:       trimmedPhone,
        renter_email:       email,
        vehicle_id:         normalizedVehicleId || vehicleId,
        vehicle_name:       vehicleData.name,
        vehicle_vin:        vehicleData.vin || "",
        vehicle_plate:      vehicleData.licensePlate || vehicleData.license_plate || "",
        package_key:        slingshotPackage,
        package_label:      pkg.label,
        package_hours:      String(pkg.hours),
        package_price:      String(pkg.price),
        deposit_amount:     String(SLINGSHOT_DEPOSIT),
        pickup_date:        pickupDateLA,
        return_date:        returnDate,
        pickup_time:        formatTime12h(normalizedPickupTime),
        return_time:        formatTime12h(returnTime),
        payment_type:       "full_payment",
        full_rental_amount: totalAmount.toFixed(2),
      },
    };

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);
    } catch (piErr) {
      console.error("[SLINGSHOT_PI_CREATE_FAILED]", { bookingId, vehicleId, error: piErr.message });
      // Cancel the pre-written booking to release the slot.
      try {
        await sb
          .from("bookings")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("booking_ref", bookingId);
        console.log("[SLINGSHOT_PREWRITE_CANCELLED]", { bookingId, reason: "PI creation failed" });
      } catch (cancelErr) {
        console.error("[SLINGSHOT_PREWRITE_CANCEL_FAILED]", { bookingId, error: cancelErr.message });
      }
      return res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }

    // ── Link PI back to the pre-written booking row ───────────────────────────
    try {
      await sb
        .from("bookings")
        .update({ payment_intent_id: paymentIntent.id, updated_at: new Date().toISOString() })
        .eq("booking_ref", bookingId);
    } catch (linkErr) {
      console.warn("[SLINGSHOT_PI_LINK_FAILED]", { bookingId, piId: paymentIntent.id, error: linkErr.message });
    }

    return res.status(200).json({
      clientSecret:    paymentIntent.client_secret,
      publishableKey:  process.env.STRIPE_PUBLISHABLE_KEY,
      bookingId,
      stripeCustomerId,
    });
  } catch (err) {
    console.error("[SLINGSHOT_BOOKING] Unhandled error:", err);
    return res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
