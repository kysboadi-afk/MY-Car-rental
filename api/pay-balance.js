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
  computeRentalDays,
  getVehiclePricing,
  computeAmountFromPricing,
} from "./_pricing.js";
import {
  loadPricingSettings,
  computeDppCostFromSettings,
} from "./_settings.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getVehicleById } from "./_vehicles.js";

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
    const {
      vehicleId, name, email, pickup, returnDate, protectionPlan,
      bookingId, originalPaymentIntentId, depositPaymentIntentId,
    } = req.body;

    // Validate vehicleId against the live vehicle database (CARS → Supabase → vehicles.json)
    const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
    if (!vehicleData) {
      return res.status(400).json({ error: "Invalid vehicle" });
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
    const protectionCost = protectionPlan ? computeDppCostFromSettings(days, null) : 0;

    const depositPaid = settings.camry_booking_deposit;
    const preTaxAmount = computedFullRental + protectionCost;
    // Balance = pre-tax rental amount minus the deposit already paid.
    // Tax is calculated by Stripe automatically at checkout.
    const balanceAmount = preTaxAmount - depositPaid;

    if (balanceAmount <= 0) {
      return res.status(400).json({ error: "No balance due for this booking." });
    }

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
        });
        stripeCustomerId = newCustomer.id;
      }
    } catch (custErr) {
      console.error("pay-balance: Stripe Customer create/lookup error:", custErr.message);
      return res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(balanceAmount * 100), // Stripe expects whole cents (pre-tax)
      currency: "usd",
      customer: stripeCustomerId,
      // Save the card for future off-session charges (damages, late fees, etc.).
      setup_future_usage: "off_session",
      receipt_email: email,
      description: `Sly Transportation Services LLC – ${vehicleData.name} Balance Payment`,
      automatic_payment_methods: { enabled: true },
      // Stripe Tax calculates and adds the correct tax on top of the pre-tax balance
      // based on the customer's billing address collected by the Payment Element.
      automatic_tax: { enabled: true },
      metadata: {
        booking_id:            bookingId || "",
        original_booking_id:   bookingId || "",
        renter_name:           trimmedName,
        vehicle_id:            vehicleId,
        vehicle_name:          vehicleData.name,
        pickup_date:           pickup,
        return_date:           returnDate,
        email,
        payment_type:          "balance_payment",
        stripe_customer_id:    stripeCustomerId,
        original_payment_intent_id: originalPaymentIntentId || depositPaymentIntentId || "",
        deposit_payment_intent_id:  depositPaymentIntentId || originalPaymentIntentId || "",
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
