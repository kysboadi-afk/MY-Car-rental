// api/stripe-webhook.js
// Vercel serverless function — Stripe webhook handler.
//
// Handles the payment_intent.succeeded event fired when a PaymentIntent
// (created by create-payment-intent.js or pay-balance.js) is confirmed.
// This is the server-side authoritative fallback for availability updates —
// it runs even if the user closes the browser before success.html completes.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY      — starts with sk_live_ or sk_test_
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe dashboard
//     (Stripe CLI for local testing: stripe listen --forward-to localhost:3000/api/stripe-webhook)
//
// Register this endpoint in the Stripe dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://sly-rides.vercel.app/api/stripe-webhook
//   Events: payment_intent.succeeded

import Stripe from "stripe";

// Disable Vercel's built-in body parser so we can pass the raw request body
// to stripe.webhooks.constructEvent() for signature verification.
export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const FLEET_STATUS_PATH = "fleet-status.json";

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
 * Mark a vehicle as unavailable in fleet-status.json on GitHub.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function markVehicleUnavailable(vehicleId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping fleet-status update");
    return;
  }
  if (!vehicleId) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getResp = await fetch(apiUrl, { headers });
  let current = {};
  let sha = null;
  if (getResp.ok) {
    const fileData = await getResp.json();
    sha = fileData.sha;
    try {
      current = JSON.parse(
        Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
      );
    } catch (parseErr) {
      console.error("stripe-webhook: malformed JSON in fleet-status.json, resetting:", parseErr);
      current = {};
    }
  }

  if (!current[vehicleId]) current[vehicleId] = {};
  if (current[vehicleId].available === false) return; // Already marked — idempotent
  current[vehicleId].available = false;

  const updatedContent = Buffer.from(
    JSON.stringify(current, null, 2) + "\n"
  ).toString("base64");

  const putBody = {
    message: `Mark ${vehicleId} unavailable after confirmed booking (webhook)`,
    content: updatedContent,
  };
  if (sha) putBody.sha = sha;

  const putResp = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });

  if (!putResp.ok) {
    console.error(`stripe-webhook: GitHub PUT (fleet-status) failed: ${putResp.status} ${await putResp.text()}`);
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

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;

    // Skip balance payments — dates were already blocked when the deposit was paid.
    if ((paymentIntent.metadata || {}).payment_type === "balance_payment") {
      console.log(
        `stripe-webhook: balance_payment for PaymentIntent ${paymentIntent.id} — skipping date blocking`
      );
      return res.status(200).json({ received: true });
    }

    const { vehicle_id, pickup_date, return_date } = paymentIntent.metadata || {};

    console.log(
      `stripe-webhook: payment_intent.succeeded — vehicle=${vehicle_id} ` +
      `pickup=${pickup_date} return=${return_date} pi=${paymentIntent.id}`
    );

    // Block the booked dates and mark the vehicle unavailable.
    if (vehicle_id && pickup_date && return_date) {
      try {
        await blockBookedDates(vehicle_id, pickup_date, return_date);
      } catch (err) {
        console.error("stripe-webhook: blockBookedDates error:", err);
      }
      try {
        await markVehicleUnavailable(vehicle_id);
      } catch (err) {
        console.error("stripe-webhook: markVehicleUnavailable error:", err);
      }
    }
  }

  return res.status(200).json({ received: true });
}
