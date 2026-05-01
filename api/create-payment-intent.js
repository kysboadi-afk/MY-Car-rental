// api/create-payment-intent.js
// Vercel serverless function — creates a Stripe PaymentIntent so the
// embedded Stripe Payment Element can be mounted on the booking page.
//
// Required environment variables (set in Vercel dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_
import crypto from "crypto";
import Stripe from "stripe";
import { computeRentalDays, getVehiclePricing, computeAmountFromPricing } from "./_pricing.js";
import { loadPricingSettings, computeDppCostFromSettings, applyTax } from "./_settings.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { isDatesAndTimesAvailable, isVehicleAvailable } from "./_availability.js";
import { getVehicleById } from "./_vehicles.js";
import { normalizeClockTime, formatTime12h } from "./_time.js";
import { normalizeVehicleId } from "./_vehicle-id.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/**
 * Derive the canonical vehicle_id to embed in Stripe PaymentIntent metadata.
 *
 * Uses the raw vehicle ID from the booking flow whenever present so UI and DB
 * IDs stay exactly aligned. Only falls back to a name-derived ID when no
 * vehicle_id was provided.
 *
 * Examples:
 *   ("camry", "Camry 2012") → "camry"
 *   ("camry2013", "Camry 2013 SE") → "camry2013"
 *   ("", "Camry 2012") → "camry"
 *   ("camry2013","Camry 2013 SE") → "camry2013" (id already specific)
 *
 * @param {string} vehicleIdRaw  - internal vehicle key (e.g. "camry")
 * @param {string} vehicleNameRaw - human-readable name (e.g. "Camry 2012")
 * @returns {string} canonical vehicle_id
 */
function canonicalVehicleIdForStripe(vehicleIdRaw, vehicleNameRaw) {
  const normId = String(vehicleIdRaw || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  let nameId = "";
  if (vehicleNameRaw) {
    const allTokens = String(vehicleNameRaw).toLowerCase().replace(/[^a-z0-9]/g, " ").trim().split(/\s+/);
    const parts = [];
    for (const t of allTokens) {
      if (/^[a-z]$/.test(t)) continue; // skip single-letter tokens (e.g. "r")
      parts.push(t);
      if (/\d/.test(t)) break;         // stop after first numeric token (year)
    }
    if (parts.length > 0) nameId = parts.join("");
  }

  return normId || nameId;
}

export default async function handler(req, res) {
  // CORS — allow requests from the production frontend
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Guard: fail fast if Stripe keys are missing (common setup mistake)
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is missing. Add it in your Vercel project → Settings → Environment Variables." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("STRIPE_PUBLISHABLE_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_PUBLISHABLE_KEY is missing. Add it in your Vercel project → Settings → Environment Variables." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vehicleId, name, email, phone, pickup, returnDate, protectionPlan, protectionPlanTier, paymentMode, insuranceCoverageChoice, pickupTime, returnTime, idFileName, insuranceFileName, adminOverride, testMode } = req.body;
    const adminOverrideEnabled = adminOverride === true || /^(true|1)$/i.test(String(adminOverride || ""));
    const testModeEnabled = testMode === true || /^(true|1)$/i.test(String(testMode || ""));
    const testAvailabilityOverride = adminOverrideEnabled && testModeEnabled;

    // Validate vehicleId against the live vehicle database (CARS → Supabase → vehicles.json)
    const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
    if (!vehicleData) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }

    // Pickup time is required for all vehicles — it anchors the rental window and
    // is enforced as the return time for economy cars (return_time = pickup_time).
    const trimmedPickupTime = normalizeClockTime(pickupTime);
    if (!trimmedPickupTime) {
      return res.status(400).json({ error: "Pickup time is required. Please select a pickup time before proceeding." });
    }
    const trimmedReturnTime = normalizeClockTime(returnTime);
    if (!trimmedReturnTime) {
      return res.status(400).json({ error: "Return time is required. Please select a return time before proceeding." });
    }

    // For economy vehicles: enforce that the renter declared either
    // personal auto insurance (verified at pickup) OR selected a valid DPP tier.
    // This is a server-side guard that cannot be bypassed via browser DevTools.
    if (insuranceCoverageChoice !== "yes" && insuranceCoverageChoice !== "no") {
      return res.status(400).json({ error: "Please indicate whether you have personal auto insurance or would like to add a Damage Protection Plan." });
    }
    if (insuranceCoverageChoice === "no") {
      if (protectionPlan !== true || !["basic", "standard", "premium"].includes(protectionPlanTier)) {
        return res.status(400).json({ error: "A valid Damage Protection Plan (Basic, Standard, or Premium) is required when you do not have personal auto insurance." });
      }
    }

    // Government-issued ID is required for every booking — this server-side check
    // cannot be bypassed by enabling the payment button via browser DevTools.
    const trimmedIdFileName = typeof idFileName === "string" ? idFileName.trim() : "";
    if (!trimmedIdFileName) {
      return res.status(400).json({ error: "A government-issued ID is required for all bookings. Please upload your Driver's License or ID." });
    }

    // Proof of insurance is required when the renter claims personal auto coverage.
    if (insuranceCoverageChoice === "yes") {
      const trimmedInsuranceFileName = typeof insuranceFileName === "string" ? insuranceFileName.trim() : "";
      if (!trimmedInsuranceFileName) {
        return res.status(400).json({ error: "Proof of insurance is required when you select personal auto insurance coverage. Please upload your insurance document." });
      }
    }

    // Validate dates
    const pickupD = new Date(pickup + "T00:00:00");
    const returnD = new Date(returnDate + "T00:00:00");
    if (isNaN(pickupD.getTime()) || isNaN(returnD.getTime()) || returnD < pickupD) {
      return res.status(400).json({ error: "Invalid dates" });
    }

    const derivedReturnTime = trimmedPickupTime;

    // ── Availability check ──────────────────────────────────────────────────
    // Check the specific requested vehicle.
    // The check is time-aware: a booking from 9 AM to 9 AM does not block
    // a subsequent booking starting at 9 AM on the same return date.
    let assignedVehicleId = vehicleId;
    console.log("[VEHICLE_ID_INPUT]", JSON.stringify({
      vehicleId_raw:  vehicleId,
      vehicle_name:   vehicleData?.name || null,
    }));
    if (!testAvailabilityOverride) {
      // For economy cars the return time always equals the pickup time.
      // Use the same time for both bounds so the check is symmetric.
      const available = await isDatesAndTimesAvailable(vehicleId, pickup, returnDate, trimmedPickupTime, trimmedPickupTime);
      if (!available) {
        return res.status(409).json({ error: "These dates are no longer available. Please select different dates." });
      }

      // Check vehicle-level availability — reject if the vehicle is globally marked unavailable
      const vehicleAvailable = await isVehicleAvailable(vehicleId);
      if (!vehicleAvailable) {
        return res.status(409).json({ error: "This vehicle is currently unavailable for booking. Please browse other available vehicles." });
      }
    }

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Validate name
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }
    const trimmedName = name.trim();

    // Validate phone — required so we can contact the renter and link them to a customer record
    const trimmedPhone = phone && typeof phone === "string" ? phone.trim() : "";
    if (!trimmedPhone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Load live pricing from Supabase system_settings (admin-configurable).
    const settings = await loadPricingSettings();

    // Fetch vehicle pricing from the vehicle_pricing table — DB is the sole source of truth.
    const sb = getSupabaseAdmin();
    if (!sb) {
      return res.status(503).json({ error: "Database unavailable. Please try again." });
    }
    const pricing = await getVehiclePricing(sb, vehicleId);

    // Compute rental days and apply flat tier pricing via shared helper.
    const days = computeRentalDays(pickup, returnDate);
    const computedFullRental = computeAmountFromPricing(pricing, days);
    console.log('[pricing-booking]', { vehicle: vehicleId, days, pricing, price: computedFullRental });
    const tier = protectionPlanTier || null;
    const protectionCost = protectionPlan ? computeDppCostFromSettings(days, tier) : 0;

    // For Camry with paymentMode:'deposit': charge only the booking deposit now; rest at pickup.
    // For all other modes: charge the after-tax total.
    const preTaxFullRental = computedFullRental + protectionCost;
    const afterTaxFullRental = applyTax(preTaxFullRental, settings);

    let totalAmount;

    if (paymentMode === "deposit") {
      totalAmount = settings.camry_booking_deposit;
    } else {
      totalAmount = afterTaxFullRental;
    }

    const isCamryDepositMode = paymentMode === "deposit";

    // Find or create a Stripe Customer so the card can be saved for future
    // off-session charges (e.g., damages, late fees).
    let stripeCustomerId;
    try {
      const existingCustomers = await stripe.customers.list({ email, limit: 1 });
      if (existingCustomers.data.length > 0) {
        stripeCustomerId = existingCustomers.data[0].id;
      } else {
        const newCustomer = await stripe.customers.create({
          email,
          name: trimmedName,
          ...(trimmedPhone ? { phone: trimmedPhone } : {}),
        });
        stripeCustomerId = newCustomer.id;
      }
    } catch (custErr) {
      console.error("Stripe Customer create/lookup error:", custErr.message);
      return res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }

    // Generate a stable booking ID that links the PaymentIntent to the booking record.
    const bookingId = "bk-" + crypto.randomBytes(6).toString("hex");
    const normalizedVehicleId = normalizeVehicleId(assignedVehicleId) || assignedVehicleId;

    // ── Pre-write booking to Supabase BEFORE creating Stripe PI ──────────────
    // CRITICAL ORDER: the booking row must exist in the DB BEFORE the
    // PaymentIntent is created.  This guarantees:
    //   1. The webhook can always resolve booking_ref → booking row.
    //   2. An orphan Stripe charge (no matching booking) is impossible.
    //   3. blocked_dates are claimed immediately, preventing double-booking.
    //
    // If the pre-write fails we return 503 — no PI is created, no charge occurs.
    const preWriteRow = {
      booking_ref:       bookingId,
      vehicle_id:        normalizedVehicleId || null,
      pickup_date:       pickup,
      return_date:       returnDate,
      pickup_time:       trimmedPickupTime  || null,
      return_time:       derivedReturnTime  || null,
      status:            "pending",          // PI not yet created; updated to reserved/booked_paid on payment_intent.succeeded
      total_price:       afterTaxFullRental, // always the full rental cost
      deposit_paid:      0,
      remaining_balance: afterTaxFullRental,
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
      console.error("[BOOKING_PREWRITE_FAILED]", {
        bookingId,
        vehicleId: normalizedVehicleId,
        pickup,
        returnDate,
        error: preWriteErr.message,
        code:  preWriteErr.code,
      });
      return res.status(503).json({ error: "Booking could not be saved. Please try again in a moment." });
    }

    console.log("[BOOKING_PREWRITE]", {
      bookingId,
      vehicleId: normalizedVehicleId,
      pickup,
      returnDate,
    });

    const paymentIntentParams = {
      amount: Math.round(totalAmount * 100), // Stripe expects whole cents
      currency: "usd",
      customer: stripeCustomerId,
      // Save the card for future off-session charges (damages, late fees, etc.).
      setup_future_usage: "off_session",
      receipt_email: email,
      description: isCamryDepositMode
            ? `Sly Transportation Services LLC – ${vehicleData.name} Reservation Deposit (Non-Refundable)`
            : `Sly Transportation Services LLC – ${vehicleData.name}`,
      // Automatic payment methods lets Stripe surface Apple Pay, Google Pay, and
      // other wallets in addition to cards — without maintaining an explicit list.
      automatic_payment_methods: { enabled: true },
      // Request 3D Secure authentication automatically for high-risk card payments.
      // Stripe Radar decides when to trigger it; low-risk transactions flow through
      // without extra friction.
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      // Store full booking context so every payment is auditable from the
      // Stripe dashboard and can be reconciled with booked-dates.json if needed.
      // Stripe stores metadata as plain text (not HTML) so no HTML escaping is
      // needed here — values are only rendered in the Stripe dashboard.
      metadata: (() => {
        const vehicleIdForMetadata = canonicalVehicleIdForStripe(assignedVehicleId, vehicleData.name);
        console.log("[VEHICLE_ID_STRIPE]", JSON.stringify({
          vehicleId_raw:       vehicleId,
          vehicleId_assigned:  assignedVehicleId,
          vehicleId_canonical: vehicleIdForMetadata,
          vehicle_name:        vehicleData.name,
        }));
        return {
        booking_id:         bookingId,
        stripe_customer_id: stripeCustomerId,
        renter_name:  trimmedName,
        renter_phone: trimmedPhone,
        vehicle_id:   vehicleIdForMetadata,
        vehicle_name: vehicleData.name,
        pickup_date:  pickup,
        return_date:  returnDate,
        pickup_time:  formatTime12h(trimmedPickupTime),
        return_time:  formatTime12h(derivedReturnTime),
        renter_email: email,
        ...(!isCamryDepositMode ? {
          payment_type:        "full_payment",
          full_rental_amount:  afterTaxFullRental.toFixed(2),
          ...( protectionPlan && tier ? { protection_plan_tier: tier } : {} ),
        } : {}),
        ...(isCamryDepositMode ? {
          payment_type:        "reservation_deposit",
          deposit_refundable:  "false",
          full_rental_amount:  afterTaxFullRental.toFixed(2),
          balance_at_pickup:   (afterTaxFullRental - settings.camry_booking_deposit).toFixed(2),
          ...( protectionPlan && tier ? { protection_plan_tier: tier } : {} ),
        } : {}),
      };
      })(),
    };

    // Create Stripe PaymentIntent — booking row already exists in DB.
    // If PI creation fails, cancel the pre-written booking so the reserved dates
    // are freed and the user can try again.
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);
    } catch (piErr) {
      console.error("[PI_CREATE_FAILED]", {
        bookingId,
        vehicleId: normalizedVehicleId,
        error: piErr.message,
      });
      // Cancel the pre-written booking to release the blocked dates.
      try {
        await sb
          .from("bookings")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("booking_ref", bookingId);
        console.log("[BOOKING_PREWRITE_CANCELLED]", { bookingId, reason: "PI creation failed" });
      } catch (cancelErr) {
        console.error("[BOOKING_PREWRITE_CANCEL_FAILED]", { bookingId, error: cancelErr.message });
      }
      return res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }

    // Link the PaymentIntent ID back to the pre-written booking row so the
    // webhook can also resolve by payment_intent_id when booking_id is absent.
    // Non-fatal — the webhook's upsert on payment_intent.succeeded will set it too.
    try {
      await sb
        .from("bookings")
        .update({ payment_intent_id: paymentIntent.id, updated_at: new Date().toISOString() })
        .eq("booking_ref", bookingId);
    } catch (linkErr) {
      console.warn("[BOOKING_PI_LINK_FAILED]", {
        bookingId,
        piId:  paymentIntent.id,
        error: linkErr.message,
      });
    }

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      bookingId,
      stripeCustomerId,
    });
  } catch (err) {
    console.error("Stripe PaymentIntent error:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
