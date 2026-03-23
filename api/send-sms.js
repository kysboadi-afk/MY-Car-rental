// api/send-sms.js
// Vercel serverless function — sends an SMS confirmation to a new lead
// via the TextMagic SMS API immediately after the renter info form is submitted.
//
// Required environment variables (set in Vercel dashboard):
//   TEXTMAGIC_USERNAME — TextMagic account username
//   TEXTMAGIC_API_KEY  — TextMagic API key
import { sendSms } from "./_textmagic.js";

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
    !process.env.TEXTMAGIC_USERNAME ||
    !process.env.TEXTMAGIC_API_KEY
  ) {
    console.error(
      "Missing TextMagic environment variables (TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY)."
    );
    return res
      .status(500)
      .json({ error: "Server configuration error: TextMagic credentials are not set." });
  }

  const { name, phone } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: "Missing required fields: name, phone." });
  }

  try {
    await sendSms(phone, SMS_BODY);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("SMS send failed:", err);
    return res.status(500).json({ error: "Failed to send SMS." });
  }
}
