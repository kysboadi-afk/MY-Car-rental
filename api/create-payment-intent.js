// api/create-payment-intent.js
// Vercel serverless function — creates a Stripe PaymentIntent so the
// embedded Stripe Payment Element can be mounted on the booking page.
//
// Required environment variables (set in Vercel dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_
import Stripe from "stripe";
import { CARS, computeRentalDays, SLINGSHOT_DEPOSIT_WITH_INSURANCE, SLINGSHOT_DEPOSIT_WITHOUT_INSURANCE } from "./_pricing.js";
import { loadPricingSettings, computeCamryAmountFromSettings, computeSlingshotAmountFromSettings, computeDppCostFromSettings, applyTax } from "./_settings.js";
import { isDatesAvailable, isVehicleAvailable } from "./_availability.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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
    const { vehicleId, name, email, phone, pickup, returnDate, protectionPlan, protectionPlanTier, slingshotDuration, paymentMode, insuranceCoverageChoice, pickupTime, returnTime } = req.body;

    // Validate vehicleId against the server-side allowlist
    if (!vehicleId || !CARS[vehicleId]) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }

    // For hourly-tier vehicles (Slingshot), validate the hourly duration selection
    if (CARS[vehicleId].hourlyTiers) {
      if (!slingshotDuration || ![3, 6, 24, 48, 72].includes(Number(slingshotDuration))) {
        return res.status(400).json({ error: "Invalid rental duration for Slingshot. Please select 3 hours, 6 hours, 24 hours, 2 days, or 3 days." });
      }
    }

    // Validate dates
    const pickupD = new Date(pickup + "T00:00:00");
    const returnD = new Date(returnDate + "T00:00:00");
    if (isNaN(pickupD.getTime()) || isNaN(returnD.getTime()) || returnD < pickupD) {
      return res.status(400).json({ error: "Invalid dates" });
    }

    // Check availability — reject if the requested dates overlap an existing booking
    const available = await isDatesAvailable(vehicleId, pickup, returnDate);
    if (!available) {
      return res.status(409).json({ error: "These dates are no longer available. Please select different dates." });
    }

    // Check vehicle-level availability — reject if the vehicle is globally marked unavailable
    const vehicleAvailable = await isVehicleAvailable(vehicleId);
    if (!vehicleAvailable) {
      return res.status(409).json({ error: "This vehicle is currently unavailable for booking. Please browse other available vehicles." });
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

    // Load live pricing from Supabase system_settings (admin-configurable).
    // Falls back to hardcoded _pricing.js defaults when Supabase is unavailable.
    const settings = await loadPricingSettings();

    // Compute amount server-side — never trust a client-supplied amount.
    const isSlingshotVehicle = !!CARS[vehicleId].hourlyTiers;
    const computedFullRental = isSlingshotVehicle
      ? computeSlingshotAmountFromSettings(Number(slingshotDuration), settings)
      : computeCamryAmountFromSettings(vehicleId, pickup, returnDate, settings);
    const carData = CARS[vehicleId];

    // Slingshot: no Damage Protection Plan — DPP has been removed for Slingshot.
    // Economy cars: add DPP cost when the renter opted in.
    const days = isSlingshotVehicle ? Math.max(1, Math.ceil(Number(slingshotDuration) / 24)) : computeRentalDays(pickup, returnDate);
    const tier = isSlingshotVehicle ? null : (protectionPlanTier || null);
    const protectionCost = (!isSlingshotVehicle && protectionPlan) ? computeDppCostFromSettings(days, tier) : 0;

    // For Slingshot: charge full rental upfront (tier price × 2 — rental + refundable deposit) + tax.
    // For Camry with paymentMode:'deposit': charge only the booking deposit now; rest at pickup.
    // For all other Camry modes: charge the after-tax total.
    const preTaxFullRental = computedFullRental + protectionCost;
    const afterTaxFullRental = applyTax(preTaxFullRental, settings);

    let totalAmount;

    if (isSlingshotVehicle) {
      // Full payment upfront — rental fee + security deposit (= rental fee) + tax
      totalAmount = afterTaxFullRental;
    } else if (paymentMode === "deposit") {
      totalAmount = settings.camry_booking_deposit;
    } else {
      totalAmount = afterTaxFullRental;
    }

    const isCamryDepositMode = !isSlingshotVehicle && paymentMode === "deposit";

    const paymentIntentParams = {
      amount: Math.round(totalAmount * 100), // Stripe expects whole cents
      currency: "usd",
      receipt_email: email,
      description: isSlingshotVehicle
        ? `Sly Transportation Services LLC – ${carData.name} Rental`
        : (isCamryDepositMode
            ? `Sly Transportation Services LLC – ${carData.name} Reservation Deposit (Non-Refundable)`
            : `Sly Transportation Services LLC – ${carData.name}`),
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
      metadata: {
        renter_name:  trimmedName,
        renter_phone: phone && String(phone).trim() ? String(phone).trim() : "",
        vehicle_id:   vehicleId,
        vehicle_name: carData.name,
        pickup_date:  pickup,
        return_date:  returnDate,
        pickup_time:  pickupTime  ? String(pickupTime).trim()  : "",
        return_time:  returnTime  ? String(returnTime).trim()  : "",
        email,
        ...(isSlingshotVehicle ? {
          rental_duration: Number(slingshotDuration) >= 48
            ? `${Number(slingshotDuration) / 24} days`
            : `${slingshotDuration} hours`,
        } : {}),
        ...(isSlingshotVehicle ? {
          payment_type:       "full_payment",
          insurance_status:   insuranceCoverageChoice === "yes" ? "own_insurance_provided" : "no_insurance_dpp_included",
          protection_plan:    insuranceCoverageChoice === "no" ? "included" : "not_included",
          full_rental_amount: afterTaxFullRental.toFixed(2),
        } : {}),
        ...(!isSlingshotVehicle && !isCamryDepositMode ? {
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
      },
    };

    // All payments use automatic capture
    const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("Stripe PaymentIntent error:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
