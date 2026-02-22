// api/create-checkout-session.js
// Vercel serverless function — Stripe payment session
import Stripe from "stripe";

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
    const { car, amount, pickup, returnDate, email } = req.body;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: car },
            unit_amount: Math.round(amount * 100), // Stripe expects whole cents
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
