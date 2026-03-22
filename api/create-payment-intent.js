// api/create-payment-intent.js
// Vercel serverless function — creates a Stripe PaymentIntent so the
// embedded Stripe Payment Element can be mounted on the booking page.
//
// Required environment variables (set in Vercel dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_
import Stripe from "stripe";
import { CARS, computeAmount, computeProtectionPlanCost, computeRentalDays, computeSlingshotAmount, SLINGSHOT_BOOKING_DEPOSIT, CAMRY_BOOKING_DEPOSIT, SLINGSHOT_DEPOSIT_WITH_INSURANCE, SLINGSHOT_DEPOSIT_WITHOUT_INSURANCE, LA_TAX_RATE } from "./_pricing.js";
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
    const { vehicleId, name, email, pickup, returnDate, protectionPlan, slingshotDuration, paymentMode, insuranceCoverageChoice } = req.body;

    // Validate vehicleId against the server-side allowlist
    if (!vehicleId || !CARS[vehicleId]) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }

    // For hourly-tier vehicles (Slingshot), validate the hourly duration selection
    if (CARS[vehicleId].hourlyTiers) {
      if (!slingshotDuration || ![3, 6, 24].includes(Number(slingshotDuration))) {
        return res.status(400).json({ error: "Invalid rental duration for Slingshot. Please select 3, 6, or 24 hours." });
      }
      // Slingshot now requires the renter to make an insurance/deposit choice
      if (!insuranceCoverageChoice || !["yes", "no"].includes(insuranceCoverageChoice)) {
        return res.status(400).json({ error: "Please select an insurance or damage protection option." });
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

    // Compute amount server-side — never trust a client-supplied amount.
    const isSlingshotVehicle = !!CARS[vehicleId].hourlyTiers;
    const computedFullRental = isSlingshotVehicle
      ? computeSlingshotAmount(Number(slingshotDuration), vehicleId)
      : computeAmount(vehicleId, pickup, returnDate);
    const carData = CARS[vehicleId];

    // Add Damage Protection Plan cost when the renter opted in.
    // Hourly-tier rentals are treated as 1 day for DPP purposes.
    const days = isSlingshotVehicle ? 1 : computeRentalDays(pickup, returnDate);
    const protectionCost = protectionPlan ? computeProtectionPlanCost(days) : 0;

    // For Slingshot: charge the full rental amount (rental + $150 security deposit + DPP + tax)
    // upfront as a single automatic payment. No split payment or auth hold — everything is
    // collected online at booking. The $150 security deposit is included in the total and
    // will be refunded after the vehicle is returned and inspected with no issues.
    // For Camry with paymentMode:'deposit': charge only CAMRY_BOOKING_DEPOSIT now; rest at pickup.
    // For all other Camry modes: charge the after-tax total.
    const preTaxFullRental = computedFullRental + protectionCost;
    const afterTaxFullRental = Math.round(preTaxFullRental * (1 + LA_TAX_RATE) * 100) / 100;

    let totalAmount;

    if (isSlingshotVehicle) {
      // Full payment upfront — rental fee + $150 security deposit + DPP (if Option B) + tax
      totalAmount = afterTaxFullRental;
    } else if (paymentMode === "deposit") {
      totalAmount = CAMRY_BOOKING_DEPOSIT;
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
        vehicle_id:   vehicleId,
        vehicle_name: carData.name,
        pickup_date:  pickup,
        return_date:  returnDate,
        ...(isSlingshotVehicle ? { rental_duration: `${slingshotDuration} hours` } : {}),
        email,
        ...(isSlingshotVehicle ? {
          payment_type:       "full_payment",
          insurance_status:   insuranceCoverageChoice === "yes" ? "own_insurance_provided" : "no_insurance_dpp_included",
          protection_plan:    insuranceCoverageChoice === "no" ? "included" : "not_included",
          full_rental_amount: afterTaxFullRental.toFixed(2),
        } : {}),
        ...(isCamryDepositMode ? {
          payment_type:        "reservation_deposit",
          deposit_refundable:  "false",
          full_rental_amount:  afterTaxFullRental.toFixed(2),
          balance_at_pickup:   (afterTaxFullRental - CAMRY_BOOKING_DEPOSIT).toFixed(2),
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
