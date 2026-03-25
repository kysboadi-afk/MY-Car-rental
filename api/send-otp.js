// api/send-otp.js
// Vercel serverless function — generates a 6-digit TOTP code using OTP_SECRET
// and delivers it via SMS to the business phone through the TextMagic REST API.
//
// This route is intended for internal/admin use: calling it triggers an OTP
// to be sent to the fixed business number so the recipient can authenticate.
//
// Required environment variables (set in Vercel dashboard):
//   OTP_SECRET           — base32-encoded TOTP secret (shared with authenticator)
//   TEXTMAGIC_USERNAME   — TextMagic account username
//   TEXTMAGIC_API_KEY    — TextMagic API key
//
// POST /api/send-otp
//   Body:    (none required)
//   Returns: { success: true, message: "OTP sent" }
//
// Installation (if not already in package.json):
//   npm install speakeasy axios
import speakeasy from "speakeasy";
import axios from "axios";

// Destination phone number in E.164 format (TextMagic requirement)
const BUSINESS_PHONE = "+18332521093";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ── Environment variable validation ───────────────────────────────────────
  const otpSecret          = process.env.OTP_SECRET;
  const textmagicUsername  = process.env.TEXTMAGIC_USERNAME;
  const textmagicApiKey    = process.env.TEXTMAGIC_API_KEY;

  if (!otpSecret || !textmagicUsername || !textmagicApiKey) {
    console.error(
      "send-otp: Missing required environment variables " +
      "(OTP_SECRET, TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY)."
    );
    return res.status(500).json({ error: "Server configuration error: required environment variables are not set." });
  }

  // ── Generate TOTP code ────────────────────────────────────────────────────
  // speakeasy generates a time-based 6-digit code from the base32 OTP_SECRET.
  const otp = speakeasy.totp({
    secret:   otpSecret,
    encoding: "base32",
  });

  // ── Send OTP via TextMagic SMS (basic auth) ───────────────────────────────
  try {
    await axios.post(
      "https://rest.textmagic.com/api/v2/messages",
      {
        phones: BUSINESS_PHONE,
        text:   `Your OTP code is: ${otp}`,
      },
      {
        // TextMagic REST API v2 supports HTTP Basic Auth with username + API key
        auth: {
          username: textmagicUsername,
          password: textmagicApiKey,
        },
      }
    );

    // Do NOT include the OTP value in the response in production
    return res.status(200).json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error(
      "send-otp: Failed to send SMS via TextMagic:",
      err.response ? err.response.data : err.message
    );
    return res.status(500).json({
      error:   "Failed to send OTP",
      details: err.response ? err.response.data : err.message,
    });
  }
}
