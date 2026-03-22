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
      // Omitting payment_method_types (and using automatic_payment_methods instead)
      // lets Stripe surface Apple Pay, Google Pay, and other wallets on compatible
      // devices in addition to card — without maintaining a manual allowlist.
      automatic_payment_methods: { enabled: true },
      // Stripe calculates and collects the correct tax for the customer's billing
      // address dynamically during checkout. Requires Stripe Tax to be enabled in
      // the Stripe dashboard (Tax → Settings → Activate).
      automatic_tax: { enabled: true },
      // Collect billing address so Stripe Tax can determine the correct tax rate.
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: carData.name,
            },
            unit_amount: Math.round(computedAmount * 100), // Stripe expects whole cents (pre-tax)
            // tax_behavior must be set so Stripe Tax knows whether tax is included
            // or added on top. "exclusive" means tax is added on top of the price.
            tax_behavior: "exclusive",
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      customer_email: email,
      // {CHECKOUT_SESSION_ID} is replaced by Stripe with the actual session ID so
      // success.html can retrieve the session and verify payment_status server-side.
      success_url: `https://www.slytrans.com/success.html?session_id={CHECKOUT_SESSION_ID}&vehicle=${encodeURIComponent(vehicleId)}`,
      cancel_url: `https://www.slytrans.com/cancel.html?vehicle=${encodeURIComponent(vehicleId)}`,
      // Store booking metadata so the Stripe dashboard is auditable and the
      // stripe-webhook handler can identify the booking.
      metadata: {
        vehicle_id:   vehicleId,
        vehicle_name: carData.name,
        pickup_date:  pickup,
        return_date:  returnDate,
        email,
      },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stripe session failed" });
  }
}
