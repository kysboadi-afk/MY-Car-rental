// api/_textmagic.js
// Thin wrapper around the TextMagic REST API v2 for sending SMS messages.
//
// Required environment variables (set in Vercel dashboard):
//   TEXTMAGIC_USERNAME — TextMagic account username
//   TEXTMAGIC_API_KEY  — TextMagic API key
//
// Optional environment variables:
//   TEXTMAGIC_FROM     — Registered sender number or alphanumeric sender ID.
//                        When set, it is forwarded to TextMagic as the `from` field
//                        so US carriers deliver the message from a consistent sender.
//                        When omitted, TextMagic uses the account's default sender,
//                        which is the safest option if no dedicated number is configured.

const TEXTMAGIC_API_URL = "https://rest.textmagic.com/api/v2/messages";

/**
 * Send an SMS via the TextMagic REST API.
 * @param {string} to   – Recipient phone number in E.164 format (e.g. +12125550000)
 * @param {string} text – SMS body
 * @returns {Promise<object>} TextMagic API response JSON
 */
export async function sendSms(to, text) {
  const username = process.env.TEXTMAGIC_USERNAME;
  const apiKey   = process.env.TEXTMAGIC_API_KEY;

  if (!username || !apiKey) {
    throw new Error("Missing TextMagic environment variables (TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY).");
  }

  // TextMagic REST API v2: `phones` accepts a single E.164 number or a
  // comma-separated string of multiple numbers.
  // Only include `from` when explicitly configured; sending an unregistered
  // sender ID causes TextMagic to reject the request with a 4xx error.
  const from = process.env.TEXTMAGIC_FROM;
  const payload = { text, phones: to };
  if (from) payload.from = from;

  const response = await fetch(TEXTMAGIC_API_URL, {
    method: "POST",
    headers: {
      "X-TM-Username": username,
      "X-TM-Key":      apiKey,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`TextMagic API error ${response.status}: ${detail}`);
  }

  return response.json();
}
