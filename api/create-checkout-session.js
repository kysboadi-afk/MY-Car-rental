// api/create-checkout-session.js
// Vercel serverless function — Stripe payment session
import Stripe from "stripe";
import { CARS, computeAmount } from "./_pricing.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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

  try {
    const { vehicleId, pickup, returnDate, email } = req.body;

    // Validate vehicleId against the server-side allowlist
    if (!vehicleId || !CARS[vehicleId]) {
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

    // Compute amount server-side — never trust a client-supplied amount
    const computedAmount = computeAmount(vehicleId, pickup, returnDate);
    const carData = CARS[vehicleId];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: carData.name },
            unit_amount: Math.round(computedAmount * 100), // Stripe expects whole cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: email,
      success_url: "https://www.slytrans.com/success.html",
      cancel_url: "https://www.slytrans.com/cancel.html",
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stripe session failed" });
  }
}
