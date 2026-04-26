// api/test-sms.js
// Admin endpoint to fire a real SMS via TextMagic and confirm the provider works.
//
// Use this to diagnose whether the issue is "trigger not firing" vs.
// "SMS provider not sending" — a successful response here means the provider
// is reachable and credentials are valid.
//
// POST /api/test-sms
// Headers: Authorization: Bearer <ADMIN_SECRET>  OR  X-Admin-Key: <ADMIN_SECRET>
// Body (JSON): { "to": "+12125550100", "message": "optional custom text" }
//
// Response 200: { success: true,  provider: "textmagic", to, messageId }
// Response 502: { success: false, provider: "textmagic", to, error: "..." }
//
// Required env vars:
//   ADMIN_SECRET         — guards the endpoint
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY — TextMagic credentials

import { sendSms } from "./_textmagic.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const MAX_SMS_LENGTH = 160;
const DEFAULT_MESSAGE = "SLY RIDES test message — your SMS provider is working correctly.";

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // Auth: Bearer token or X-Admin-Key header
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.warn("test-sms: ADMIN_SECRET is not configured — endpoint disabled");
    return res.status(503).json({ error: "ADMIN_SECRET is not configured" });
  }

  const authHeader  = req.headers.authorization || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
  const xAdminKey   = req.headers["x-admin-key"] || "";

  if (bearerToken !== adminSecret && xAdminKey !== adminSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { to, message } = req.body || {};
  if (!to || typeof to !== "string") {
    return res.status(400).json({ error: "Field 'to' (E.164 phone number, e.g. +12125550100) is required" });
  }

  const body = message && typeof message === "string"
    ? message.slice(0, MAX_SMS_LENGTH)
    : DEFAULT_MESSAGE;

  console.log(`test-sms: sending test SMS to ${to}`);

  try {
    const result  = await sendSms(to, body);
    // TextMagic v2 returns { id, href } for a single message
    const messageId = result?.id ?? result?.ids?.[0] ?? null;
    console.log(`test-sms: send OK — to=${to} messageId=${messageId}`);
    return res.status(200).json({
      success:   true,
      provider:  "textmagic",
      to,
      messageId,
    });
  } catch (err) {
    console.error(`test-sms: send FAILED — to=${to} error=${err.message}`);
    return res.status(502).json({
      success:  false,
      provider: "textmagic",
      to,
      error:    err.message,
    });
  }
}
