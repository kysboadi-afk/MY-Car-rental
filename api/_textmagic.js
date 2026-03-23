// api/_textmagic.js
// Thin wrapper around the TextMagic REST API v2 for sending SMS messages.
//
// Required environment variables (set in Vercel dashboard):
//   TEXTMAGIC_USERNAME — TextMagic account username
//   TEXTMAGIC_API_KEY  — TextMagic API key

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

  // TextMagic REST API v2: `phones` is a comma-separated string of recipients.
  const response = await fetch(TEXTMAGIC_API_URL, {
    method: "POST",
    headers: {
      "X-TM-Username": username,
      "X-TM-Key":      apiKey,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ text, phones: to }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`TextMagic API error ${response.status}: ${detail}`);
  }

  return response.json();
}
