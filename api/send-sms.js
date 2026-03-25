// api/send-sms.js
// Vercel serverless function — sends a template-based SMS via the TextMagic API.
// Looks up a named template from the _sms-templates.js library, renders it with
// the supplied variables, then dispatches via TextMagic.
//
// POST /api/send-sms
//   Body: { phone, templateKey, variables? }
//     phone       – E.164 or 10/11-digit US number
//     templateKey – key from the TEMPLATES map in _sms-templates.js
//     variables   – optional { key: "value" } pairs for placeholder substitution
//
// Required environment variables (set in Vercel dashboard):
//   TEXTMAGIC_USERNAME — TextMagic account username
//   TEXTMAGIC_API_KEY  — TextMagic API key
import { sendSms } from "./_textmagic.js";
import { render, TEMPLATES } from "./_sms-templates.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Accept E.164 (+1XXXXXXXXXX) or a 10–11 digit US number (digits only).
// Normalises to E.164 before sending so TextMagic accepts the number.
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

  const { phone, templateKey, variables } = req.body || {};

  // Validate phone
  const e164 = normalizePhoneNumber(phone);
  if (!e164) {
    return res.status(400).json({ error: "A valid phone number is required." });
  }

  // Validate templateKey
  if (!templateKey || typeof templateKey !== "string") {
    return res.status(400).json({ error: "templateKey is required." });
  }
  if (!Object.prototype.hasOwnProperty.call(TEMPLATES, templateKey)) {
    return res.status(400).json({ error: `Unknown templateKey: ${templateKey}` });
  }

  // Validate variables — must be a plain object if provided; only string/number values allowed
  if (variables !== undefined && (typeof variables !== "object" || Array.isArray(variables))) {
    return res.status(400).json({ error: "variables must be a plain object." });
  }
  const safeVars = {};
  if (variables) {
    for (const [k, v] of Object.entries(variables)) {
      if (typeof v === "string" || typeof v === "number") {
        safeVars[k] = v;
      }
    }
  }

  const message = render(TEMPLATES[templateKey], safeVars);

  try {
    await sendSms(e164, message);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("SMS send failed:", err);
    return res.status(500).json({ error: "Failed to send SMS." });
  }
}
