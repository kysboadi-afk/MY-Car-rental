// api/extension-config.js
// Vercel serverless function — retrieves Stripe PaymentIntent details for a
// rental extension, so balance.html can display the amount and context to the
// customer before they pay.
//
// Called via GET by balance.html when ext=1 is present in the URL.
//
// Query parameters:
//   piId — Stripe PaymentIntent ID (e.g. pi_3xxxxxxxxxxxxx)
//
// Returns JSON:
//   { publishableKey, amount, extensionLabel, vehicleName, vehicleId, renterName }
//
// Required environment variables:
//   STRIPE_SECRET_KEY      — used server-side to retrieve the PaymentIntent
//   STRIPE_PUBLISHABLE_KEY — returned to the client so Stripe.js can be initialized

import Stripe from "stripe";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("extension-config: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("extension-config: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  const { piId } = req.query;
  if (!piId || !piId.startsWith("pi_")) {
    return res.status(400).json({ error: "Invalid or missing payment intent ID." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const pi = await stripe.paymentIntents.retrieve(piId);

    if ((pi.metadata || {}).payment_type !== "rental_extension" && (pi.metadata || {}).type !== "rental_extension") {
      return res.status(400).json({ error: "This link is not valid for a rental extension." });
    }

    if (pi.status === "succeeded") {
      return res.status(400).json({ error: "This extension has already been paid. Your rental time has been updated." });
    }

    if (pi.status === "canceled") {
      return res.status(400).json({ error: "This extension request has expired. Please reply EXTEND to start a new one." });
    }

    return res.status(200).json({
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      amount:         (pi.amount / 100).toFixed(2),
      extensionLabel: pi.metadata.extension_label || "",
      vehicleName:    pi.metadata.vehicle_name    || pi.metadata.vehicle_id || "",
      vehicleId:      pi.metadata.vehicle_id      || "",
      renterName:     pi.metadata.renter_name     || "",
    });
  } catch (err) {
    console.error("extension-config: Stripe error:", err.message);
    return res.status(500).json({ error: "Failed to load extension details. Please try again or call us at (833) 252-1093." });
  }
}
