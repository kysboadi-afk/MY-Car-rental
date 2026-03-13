// api/send-sms.js
// Vercel serverless function — sends an SMS confirmation to a new lead
// via the Twilio SMS API immediately after the renter info form is submitted.
//
// Required environment variables (set in Vercel dashboard):
//   TWILIO_ACCOUNT_SID   — Twilio Account SID
//   TWILIO_AUTH_TOKEN    — Twilio Auth Token
//   TWILIO_PHONE_NUMBER  — Twilio sending phone number (E.164, e.g. +18773155034)
import twilio from "twilio";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const SMS_BODY =
  "Hello, thanks for contacting SLY Services. We received your request for vehicle rentals. " +
  "A team member will reach out shortly with available vehicles. Reply STOP to opt out.";

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_PHONE_NUMBER
  ) {
    console.error(
      "Missing Twilio environment variables (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)."
    );
    return res
      .status(500)
      .json({ error: "Server configuration error: Twilio credentials are not set." });
  }

  const { name, phone } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: "Missing required fields: name, phone." });
  }

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    await client.messages.create({
      body: SMS_BODY,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("SMS send failed:", err);
    return res.status(500).json({ error: "Failed to send SMS." });
  }
}
