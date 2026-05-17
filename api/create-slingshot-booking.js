// api/create-slingshot-booking.js
// Vercel serverless function — creates a Stripe PaymentIntent for a slingshot
// package booking.  Slingshots are priced in fixed hourly packages (2hr / 3hr /
// 6hr / 24hr).  No sales tax applies and no DPP / insurance choice is required.
//
// POST /api/create-slingshot-booking
// Body: {
//   vehicleId, slingshotPackage, pickupDate, pickupTime,
//   name, email, phone, paymentOption, identitySessionId,
//   identityOnly, adminOverride, testMode
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
import { toDbBookingStatus } from "./_booking-status.js";
import { upsertBookingPrewrite } from "./_booking-prewrite.js";
import { normalizeVehicleId } from "./_vehicle-id.js";
import { createManageToken } from "./_manage-booking-token.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const DEFAULT_SLINGSHOT_IDENTITY_RETURN_URL = "https://www.slytrans.com/slingshot-book.html";
const SLINGSHOT_MANUAL_PAYMENT_ENABLED = /^(true|1|yes|on)$/i.test(String(process.env.SLINGSHOT_NO_PAYMENT || ""));
const SLINGSHOT_IDENTITY_POLL_ATTEMPTS = 5;
const SLINGSHOT_IDENTITY_POLL_DELAY_MS = 1500;

function buildSlingshotIdentityReturnUrl(vehicleId) {
  const url = new URL(DEFAULT_SLINGSHOT_IDENTITY_RETURN_URL);
  if (vehicleId) url.searchParams.set("vehicle", vehicleId);
  url.searchParams.set("identity", "return");
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retrieveVerifiedSlingshotIdentitySession(stripe, sessionId) {
  let session = null;
  for (let attempt = 0; attempt < SLINGSHOT_IDENTITY_POLL_ATTEMPTS; attempt += 1) {
    session = await stripe.identity.verificationSessions.retrieve(sessionId);
    const status = String(session?.status || "").toLowerCase();
    if (status === "verified") return session;
    if (status !== "processing" || attempt === SLINGSHOT_IDENTITY_POLL_ATTEMPTS - 1) {
      return session;
    }
    await sleep(SLINGSHOT_IDENTITY_POLL_DELAY_MS);
  }
  return session;
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
      paymentOption,
      identitySessionId,
      identityOnly,
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

    // ── Stripe Identity session creation (step 1) ────────────────────────────
    if (identityOnly === true) {
      const verificationSession = await stripe.identity.verificationSessions.create({
        type: "document",
        metadata: {
          booking_type: "slingshot",
          vehicle_id: vehicleId,
          renter_email: email,
          renter_phone: trimmedPhone,
          renter_name: trimmedName,
        },
        options: {
          document: {
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
        return_url: buildSlingshotIdentityReturnUrl(vehicleId),
      });

      return res.status(200).json({
        success: true,
        identityStatus: "requires_input",
        verificationSessionId: verificationSession.id,
        identityClientSecret: verificationSession.client_secret,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      });
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

    // ── Stripe Identity validation (step 2) ──────────────────────────────────
    const trimmedIdentitySessionId = typeof identitySessionId === "string" ? identitySessionId.trim() : "";
    if (!trimmedIdentitySessionId) {
      return res.status(400).json({ error: "Identity verification is required before reserving a slingshot." });
    }
    let verifiedIdentitySession;
    try {
      verifiedIdentitySession = await retrieveVerifiedSlingshotIdentitySession(stripe, trimmedIdentitySessionId);
    } catch (identityErr) {
      return res.status(400).json({ error: "Could not verify your identity session. Please try again." });
    }
    const verifiedIdentityStatus = String(verifiedIdentitySession?.status || "").toLowerCase();
    if (verifiedIdentityStatus === "processing") {
      return res.status(409).json({ error: "Identity verification is still processing. Please wait a few seconds and try again." });
    }
    if (verifiedIdentityStatus !== "verified") {
      return res.status(400).json({ error: "Identity verification is incomplete. Please complete verification and try again." });
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

    // ── Compute reservation pricing (no tax on slingshots) ────────────────────
    const totalAmount = pkg.price + SLINGSHOT_DEPOSIT;
    const normalizedPaymentOption = String(paymentOption || "deposit").trim().toLowerCase();
    if (normalizedPaymentOption !== "deposit" && normalizedPaymentOption !== "full") {
      return res.status(400).json({ error: "Invalid payment option. Choose deposit or full payment." });
    }
    const chargeAmount = normalizedPaymentOption === "full" ? totalAmount : SLINGSHOT_DEPOSIT;
    const balanceAtPickup = Math.max(0, totalAmount - chargeAmount);
    const paymentType = normalizedPaymentOption === "full" ? "full_payment" : "reservation_deposit";

    // ── Pre-write booking to Supabase BEFORE creating Stripe PI ──────────────
    const bookingId = "bk-" + crypto.randomBytes(6).toString("hex");
    const normalizedVehicleId = normalizeVehicleId(vehicleId) || vehicleId;
    const manageToken = createManageToken(bookingId);
    const manageLink = `https://www.slytrans.com/manage-booking.html?t=${encodeURIComponent(manageToken)}`;

    const preWriteRow = {
      booking_ref:       bookingId,
      vehicle_id:        normalizedVehicleId || null,
      pickup_date:       pickupDateLA,
      return_date:       returnDate,
      pickup_time:       normalizedPickupTime || null,
      return_time:       returnTime || null,
      status:            toDbBookingStatus(SLINGSHOT_MANUAL_PAYMENT_ENABLED ? "agreement_pending" : "pending_checkout"),
      total_price:       totalAmount,
      deposit_paid:      0,
      remaining_balance: totalAmount,
      payment_status:    SLINGSHOT_MANUAL_PAYMENT_ENABLED ? "manual_pending" : "unpaid",
      payment_method:    SLINGSHOT_MANUAL_PAYMENT_ENABLED ? "manual" : "stripe",
      category:          "slingshot",
      customer_name:     trimmedName  || null,
      customer_email:    email        || null,
      customer_phone:    trimmedPhone || null,
      renter_phone:      trimmedPhone || null,
      manage_token:      manageToken,
      identity_session_id: trimmedIdentitySessionId,
    };

    const { error: preWriteErr, attemptedRow, isConflict } = await upsertBookingPrewrite(sb, preWriteRow, {
      context: "SLINGSHOT_BOOKING_PREWRITE",
    });

    if (preWriteErr) {
      if (isConflict) {
        return res.status(409).json({ error: "This time slot is no longer available. Please select a different time." });
      }
      console.error("[SLINGSHOT_BOOKING_PREWRITE_FAILED]", {
        bookingId,
        vehicleId,
        attemptedStatus: attemptedRow?.status,
        hadCategory: Object.prototype.hasOwnProperty.call(attemptedRow || {}, "category"),
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
      status: attemptedRow?.status || preWriteRow.status,
      totalAmount,
    });

    if (SLINGSHOT_MANUAL_PAYMENT_ENABLED) {
      return res.status(200).json({
        success: true,
        bookingId,
        manageLink,
        identityStatus: "verified",
        nextStatus: "agreement_pending",
        manualPayment: true,
        totalAmount,
        balanceAtPickup,
      });
    }

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

    // ── Create Stripe PaymentIntent ───────────────────────────────────────────
    const paymentIntentParams = {
      amount:   Math.round(chargeAmount * 100), // Stripe expects whole cents
      currency: "usd",
      customer: stripeCustomerId,
      setup_future_usage: "off_session",
      receipt_email: email,
      description: `Sly Transportation Services LLC – ${vehicleData.name} ${normalizedPaymentOption === "full" ? "Full Payment" : "Reservation Deposit"} – ${pkg.label}`,
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
        identity_session_id: trimmedIdentitySessionId,
        pickup_date:        pickupDateLA,
        return_date:        returnDate,
        pickup_time:        formatTime12h(normalizedPickupTime),
        return_time:        formatTime12h(returnTime),
        payment_type:       paymentType,
        payment_option:     normalizedPaymentOption,
        deposit_refundable: "true",
        full_rental_amount: totalAmount.toFixed(2),
        balance_at_pickup:  balanceAtPickup.toFixed(2),
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
          .update({ status: toDbBookingStatus("payment_failed"), updated_at: new Date().toISOString() })
          .eq("booking_ref", bookingId);
        console.log("[CHECKOUT_CLEANUP]", {
          bookingId,
          fromStatus: "pending_checkout",
          toStatus: "payment_failed",
          reason: "slingshot_payment_intent_create_failed",
          releasedTemporaryHold: true,
        });
      } catch (cancelErr) {
        console.error("[CHECKOUT_CLEANUP_FAILED]", { bookingId, reason: "slingshot_payment_intent_create_failed", error: cancelErr.message });
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
