// api/create-payment-intent.js
// Vercel serverless function — creates a Stripe PaymentIntent so the
// embedded Stripe Payment Element can be mounted on the booking page.
//
// Required environment variables (set in Vercel dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_
import Stripe from "stripe";
import { CARS, LA_TAX_RATE, computeAmount, computeProtectionPlanCost, computeRentalDays, computeSlingshotAmount, SLINGSHOT_BOOKING_DEPOSIT } from "./_pricing.js";
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
    const { vehicleId, name, email, pickup, returnDate, protectionPlan, slingshotDuration } = req.body;

    // Validate vehicleId against the server-side allowlist
    if (!vehicleId || !CARS[vehicleId]) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }

    // For hourly-tier vehicles (Slingshot), validate the hourly duration selection
    if (CARS[vehicleId].hourlyTiers) {
      if (!slingshotDuration || ![3, 6, 24].includes(Number(slingshotDuration))) {
        return res.status(400).json({ error: "Invalid rental duration for Slingshot. Please select 3, 6, or 24 hours." });
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
    // The security deposit is always charged regardless of insurance choice.
    // Hourly-tier vehicles (Slingshot) use computeSlingshotAmount; all others use daily/weekly/etc.
    const isSlingshotVehicle = !!CARS[vehicleId].hourlyTiers;
    const computedFullRental = isSlingshotVehicle
      ? computeSlingshotAmount(Number(slingshotDuration), vehicleId)
      : computeAmount(vehicleId, pickup, returnDate);
    const carData = CARS[vehicleId];

    // Add Damage Protection Plan cost when the renter opted in.
    // Hourly-tier rentals are treated as 1 day for DPP purposes.
    const days = isSlingshotVehicle ? 1 : computeRentalDays(pickup, returnDate);
    const protectionCost = protectionPlan ? computeProtectionPlanCost(days) : 0;

    // For Slingshot: charge only the $50 non-refundable reservation deposit now.
    // The full rental balance (rental fee + $150 security deposit – $50) is due at pickup.
    // For all other vehicles: charge the full rental amount including LA sales tax.
    let totalAmount;
    let taxAmount;
    if (isSlingshotVehicle) {
      totalAmount = SLINGSHOT_BOOKING_DEPOSIT;
      taxAmount = 0;
    } else {
      const preTaxAmount = computedFullRental + protectionCost;
      taxAmount = preTaxAmount * LA_TAX_RATE;
      totalAmount = preTaxAmount + taxAmount;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100), // Stripe expects whole cents
      currency: "usd",
      receipt_email: email,
      description: isSlingshotVehicle
        ? `Sly Transportation Services LLC – ${carData.name} Reservation Deposit (Non-Refundable)`
        : `Sly Transportation Services LLC – ${carData.name}`,
      // Automatic payment methods lets Stripe surface Apple Pay, Google Pay, and
      // other wallets in addition to cards — without maintaining an explicit list.
      automatic_payment_methods: { enabled: true },
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
        tax_jurisdiction: "Los Angeles, CA",
        tax_rate:     isSlingshotVehicle ? "0% (deposit only)" : (LA_TAX_RATE * 100).toFixed(2) + "%",
        tax_amount:   taxAmount.toFixed(2),
        ...(isSlingshotVehicle ? {
          payment_type:        "reservation_deposit",
          deposit_refundable:  "false",
          full_rental_amount:  (computedFullRental + protectionCost).toFixed(2),
          balance_at_pickup:   (computedFullRental + protectionCost - SLINGSHOT_BOOKING_DEPOSIT).toFixed(2),
        } : {}),
      },
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("Stripe PaymentIntent error:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
