// api/join-waitlist.js
// Creates a Stripe PaymentIntent for a $50 non-refundable waitlist deposit.
// Called when a customer wants to reserve the next available slot for a
// currently-booked vehicle.  The $50 goes toward the full rental at pickup.
//
// Required environment variables:
//   STRIPE_SECRET_KEY
//   STRIPE_PUBLISHABLE_KEY
import Stripe from "stripe";
import { CARS } from "./_pricing.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const WAITLIST_DEPOSIT = 50;

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
    console.error("STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error" });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vehicleId, name, email, phone, preferredPickup, preferredReturn } = req.body;

    if (!vehicleId || !CARS[vehicleId]) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }

    const carData = CARS[vehicleId];
    const trimmedName = name.trim();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: WAITLIST_DEPOSIT * 100, // $50 in cents
      currency: "usd",
      receipt_email: email,
      description: `Sly Transportation Services LLC – ${carData.name} Waitlist Deposit (Non-Refundable)`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      metadata: {
        type:             "waitlist_deposit",
        renter_name:      trimmedName,
        vehicle_id:       vehicleId,
        vehicle_name:     carData.name,
        preferred_pickup: preferredPickup || "",
        preferred_return: preferredReturn || "",
        phone:            phone || "",
        email,
        deposit_refundable: "false",
      },
    });

    res.status(200).json({
      clientSecret:   paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("join-waitlist PaymentIntent error:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
