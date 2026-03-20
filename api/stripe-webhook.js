// api/stripe-webhook.js
// Vercel serverless function — Stripe webhook handler.
//
// Handles the checkout.session.completed event and verifies that
// payment_status === "paid" before treating a booking as confirmed.
// This is the server-side authoritative source of truth for payment
// confirmation — redirect-based methods (Cash App Pay, etc.) should
// NOT be relied upon alone.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY      — starts with sk_live_ or sk_test_
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe dashboard
//     (Stripe CLI for local testing: stripe listen --forward-to localhost:3000/api/stripe-webhook)
//
// Register this endpoint in the Stripe dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://sly-rides.vercel.app/api/stripe-webhook
//   Events: checkout.session.completed

import Stripe from "stripe";

// Disable Vercel's built-in body parser so we can pass the raw request body
// to stripe.webhooks.constructEvent() for signature verification.
export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";

/**
 * Read booked-dates.json from GitHub and block the given date range.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function blockBookedDates(vehicleId, from, to) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping date blocking");
    return;
  }
  if (!vehicleId || !from || !to) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getResp = await fetch(apiUrl, { headers });
  if (!getResp.ok) {
    console.error(`stripe-webhook: GitHub GET failed: ${getResp.status} ${await getResp.text()}`);
    return;
  }
  const fileData = await getResp.json();
  const current = JSON.parse(
    Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
  );

  if (!current[vehicleId]) current[vehicleId] = [];

  // Skip if this exact range is already recorded (idempotency guard)
  const alreadyBlocked = current[vehicleId].some(
    (r) => r.from === from && r.to === to
  );
  if (alreadyBlocked) return;

  current[vehicleId].push({ from, to });

  const updatedContent = Buffer.from(
    JSON.stringify(current, null, 2) + "\n"
  ).toString("base64");

  const putResp = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Block dates for ${vehicleId}: ${from} to ${to} (webhook)`,
      content: updatedContent,
      sha: fileData.sha,
    }),
  });

  if (!putResp.ok) {
    console.error(`stripe-webhook: GitHub PUT failed: ${putResp.status} ${await putResp.text()}`);
  }
}

/**
 * Read the raw request body from a Node.js IncomingMessage stream.
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).send("Server configuration error");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET environment variable is not set");
    return res.status(500).send("Server configuration error");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Only treat the booking as confirmed when payment is actually paid.
    // Redirect-based methods (Cash App Pay, etc.) may fire this event before
    // payment settles — payment_status will be "unpaid" in that case.
    if (session.payment_status !== "paid") {
      console.log(
        `stripe-webhook: checkout.session.completed for session ${session.id} ` +
        `but payment_status=${session.payment_status} — skipping confirmation`
      );
      return res.status(200).json({ received: true });
    }

    const { vehicle_id, pickup_date, return_date } = session.metadata || {};

    console.log(
      `stripe-webhook: confirmed paid booking — vehicle=${vehicle_id} ` +
      `pickup=${pickup_date} return=${return_date} session=${session.id}`
    );

    // Block the booked dates so the vehicle shows as unavailable.
    if (vehicle_id && pickup_date && return_date) {
      try {
        await blockBookedDates(vehicle_id, pickup_date, return_date);
      } catch (err) {
        // Log but don't fail — date-blocking failure should not prevent a 200 ack
        console.error("stripe-webhook: blockBookedDates error:", err);
      }
    }
  }

  return res.status(200).json({ received: true });
}
