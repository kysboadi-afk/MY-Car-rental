// api/pay-balance.js
// Vercel serverless function — creates a Stripe PaymentIntent for the
// remaining rental balance after a reservation deposit has already been paid.
//
// The balance is computed server-side (full amount + tax – deposit paid).
// The client never supplies an amount; it is always derived from vehicleId,
// dates, and the protectionPlan flag so it cannot be tampered with.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_
import Stripe from "stripe";
import {
  CARS,
  computeAmount,
  computeProtectionPlanCost,
  computeRentalDays,
  computeSlingshotAmount,
  SLINGSHOT_BOOKING_DEPOSIT,
  CAMRY_BOOKING_DEPOSIT,
} from "./_pricing.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is missing." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("STRIPE_PUBLISHABLE_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_PUBLISHABLE_KEY is missing." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vehicleId, name, email, pickup, returnDate, protectionPlan, slingshotDuration } = req.body;

    // Validate vehicleId against the server-side allowlist
    if (!vehicleId || !CARS[vehicleId]) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }

    const isSlingshotVehicle = !!CARS[vehicleId].hourlyTiers;

    // For hourly-tier vehicles (Slingshot), validate the hourly duration selection
    if (isSlingshotVehicle) {
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

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Validate name
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }
    const trimmedName = name.trim();

    // Compute amounts server-side — never trust a client-supplied amount.
    const computedFullRental = isSlingshotVehicle
      ? computeSlingshotAmount(Number(slingshotDuration), vehicleId)
      : computeAmount(vehicleId, pickup, returnDate);

    const days = isSlingshotVehicle ? 1 : computeRentalDays(pickup, returnDate);
    const protectionCost = protectionPlan ? computeProtectionPlanCost(days) : 0;

    const depositPaid = isSlingshotVehicle ? SLINGSHOT_BOOKING_DEPOSIT : CAMRY_BOOKING_DEPOSIT;
    const preTaxAmount = computedFullRental + protectionCost;
    // Balance = pre-tax rental amount minus the deposit already paid.
    // Tax is calculated by Stripe automatically at checkout.
    const balanceAmount = preTaxAmount - depositPaid;

    if (balanceAmount <= 0) {
      return res.status(400).json({ error: "No balance due for this booking." });
    }

    const carData = CARS[vehicleId];
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(balanceAmount * 100), // Stripe expects whole cents (pre-tax)
      currency: "usd",
      receipt_email: email,
      description: `Sly Transportation Services LLC – ${carData.name} Balance Payment`,
      automatic_payment_methods: { enabled: true },
      // Stripe Tax calculates and adds the correct tax on top of the pre-tax balance
      // based on the customer's billing address collected by the Payment Element.
      automatic_tax: { enabled: true },
      metadata: {
        renter_name:           trimmedName,
        vehicle_id:            vehicleId,
        vehicle_name:          carData.name,
        pickup_date:           pickup,
        return_date:           returnDate,
        ...(isSlingshotVehicle ? { rental_duration: `${slingshotDuration} hours` } : {}),
        email,
        payment_type:          "balance_payment",
        deposit_already_paid:  depositPaid.toFixed(2),
        full_rental_amount:    (computedFullRental + protectionCost).toFixed(2),
        balance_paid:          balanceAmount.toFixed(2),
      },
    });

    res.status(200).json({
      clientSecret:   paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      balanceAmount:  balanceAmount.toFixed(2),
      preTaxAmount:   preTaxAmount.toFixed(2),
      depositPaid:    depositPaid.toFixed(2),
    });
  } catch (err) {
    console.error("Stripe PaymentIntent (balance) error:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
