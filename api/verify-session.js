// api/verify-session.js
// Vercel serverless function — verifies a Stripe Checkout Session's payment
// status server-side so that success.html can confirm the payment is truly
// paid before displaying a confirmation to the customer.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY — starts with sk_live_ or sk_test_
//
// GET /api/verify-session?session_id=cs_...
// Response: { payment_status: "paid" | "unpaid" | "no_payment_required" }
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

  const { session_id } = req.query;

  // Validate that a Checkout Session ID was provided (they always start with "cs_")
  if (!session_id || typeof session_id !== "string" || !session_id.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid or missing session_id" });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    return res.status(200).json({ payment_status: session.payment_status });
  } catch (err) {
    console.error("verify-session error:", err);
    return res.status(500).json({ error: "Could not verify session" });
  }
}
