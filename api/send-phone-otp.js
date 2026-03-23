// api/send-phone-otp.js
// Vercel serverless function — sends a 6-digit OTP to the supplied phone number
// via TextMagic SMS so the booking form can verify the renter controls that number
// before the payment flow begins.
//
// Required environment variables (set in Vercel dashboard):
//   TEXTMAGIC_USERNAME — TextMagic account username
//   TEXTMAGIC_API_KEY  — TextMagic API key
//   OTP_SECRET         — long random string used to sign OTP tokens
//
// POST /api/send-phone-otp
//   Body:    { phone }   ← E.164 or US 10-digit format
//   Returns: { token }   ← opaque signed token; client passes it back on submit
import { sendSms } from "./_textmagic.js";
import { generateOtp, createPhoneOtpToken } from "./_otp.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Accept E.164 (+1XXXXXXXXXX) or a 10–11 digit US number (digits only).
// Normalises to E.164 before sending so TextMagic is happy.
function normalizePhoneNumber(raw) {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (raw.startsWith("+") && digits.length >= 7 && digits.length <= 15) return "+" + digits;
  return null;
}

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

  const { phone } = req.body || {};
  const e164 = normalizePhoneNumber(phone);

  if (!e164) {
    return res.status(400).json({ error: "A valid US phone number is required." });
  }

  const otp = generateOtp();
  const token = createPhoneOtpToken(e164, otp);

  try {
    await sendSms(e164, `Your Sly Transportation verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`);

    return res.status(200).json({ token });
  } catch (err) {
    console.error("Phone OTP SMS failed:", err);
    return res.status(500).json({ error: "Failed to send verification SMS." });
  }
}
