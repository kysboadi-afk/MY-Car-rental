// api/sms-webhook.js
// Inbound SMS webhook — Oil Check Compliance reply handler.
//
// Customers reply FULL, MID, or LOW (with a photo) to confirm their oil level.
// This endpoint accepts webhooks from:
//   • Twilio  — application/x-www-form-urlencoded with Body/From/NumMedia/MediaUrl0
//   • TextMagic — application/json with from/text and optional mediaUrl
//
// Outbound SMS is sent via the existing TextMagic sendSms helper.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY
//
// Optional:
//   SMS_WEBHOOK_SECRET — if set, incoming requests must include an
//     X-Webhook-Secret header matching this value.
//   OWNER_PHONE — phone number to notify on LOW oil alert
//   SLACK_WEBHOOK_URL — Slack incoming webhook URL for LOW oil admin alert

import { sendSms } from "./_textmagic.js";
import { getSupabaseAdmin } from "./_supabase.js";

// Disable Vercel body parser so we can read both JSON and URL-encoded bodies.
export const config = {
  api: { bodyParser: false },
};

const OWNER_PHONE = process.env.OWNER_PHONE || "+12139166606";
const VALID_LEVELS = new Set(["full", "mid", "low"]);

// ── Reply templates ───────────────────────────────────────────────────────────

const REPLY_FULL = "You're all set. Thank you for confirming.";
const REPLY_MID  = "Thank you. Oil level noted.";
const REPLY_LOW  =
  "Oil is low.\n\n" +
  "Thank you for confirming. Please do not continue driving if level is very low.\n\n" +
  "We will contact you shortly to schedule service.";
const REPLY_NO_PHOTO =
  "Please attach a clear photo of the dipstick and reply FULL, MID, or LOW.";
const REPLY_INVALID =
  "Reply with:\n" +
  "FULL (top line)\n" +
  "MID (between lines)\n" +
  "LOW (below safe line)\n" +
  "and include a photo.";

// ── Body parser ───────────────────────────────────────────────────────────────

/**
 * Buffer the raw request body and detect content type.
 * Returns { from, text, numMedia, mediaUrl } regardless of the source provider.
 */
async function parseWebhookBody(req) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", (c) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });
  const rawBody = Buffer.concat(chunks).toString("utf8");

  const contentType = (req.headers["content-type"] || "").toLowerCase();

  if (contentType.includes("application/x-www-form-urlencoded")) {
    // Twilio-style webhook
    const params = new URLSearchParams(rawBody);
    const numMedia = parseInt(params.get("NumMedia") || "0", 10);
    return {
      from:     params.get("From") || "",
      text:     params.get("Body") || "",
      numMedia,
      mediaUrl: numMedia > 0 ? (params.get("MediaUrl0") || "") : "",
    };
  }

  // Default: JSON (TextMagic or generic)
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch (_) { /* ignore */ }

  const mediaUrl = body.mediaUrl || body.MediaUrl0 || body.media_url || "";
  const numMedia = mediaUrl ? 1 : parseInt(body.NumMedia || "0", 10);
  return {
    from:     body.from || body.From || "",
    text:     body.text || body.Body || "",
    numMedia,
    mediaUrl,
  };
}

// ── LA-timezone helper ────────────────────────────────────────────────────────

function nowLA() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  ).toISOString();
}

// ── Admin alert for LOW oil ───────────────────────────────────────────────────

async function triggerLowOilAlert(bookingId, phone, vehicleId) {
  const msg = `LOW OIL ALERT: ${bookingId} / ${phone} / ${vehicleId}`;
  console.error(msg);

  // Slack alert (non-fatal)
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      await fetch(slackUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: msg }),
      });
    } catch (err) {
      console.error("sms-webhook: Slack alert failed (non-fatal):", err.message);
    }
  }

  // Owner SMS alert (non-fatal)
  if (OWNER_PHONE) {
    try {
      await sendSms(OWNER_PHONE, msg);
    } catch (err) {
      console.error("sms-webhook: owner SMS alert failed (non-fatal):", err.message);
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Optional shared secret validation
  const webhookSecret = process.env.SMS_WEBHOOK_SECRET;
  if (webhookSecret) {
    const provided = req.headers["x-webhook-secret"] || "";
    if (provided !== webhookSecret) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  let parsed;
  try {
    parsed = await parseWebhookBody(req);
  } catch (err) {
    console.error("sms-webhook: failed to read body:", err.message);
    return res.status(400).json({ error: "Failed to read request body" });
  }

  const { from: fromRaw, text: textRaw, numMedia, mediaUrl } = parsed;

  if (!fromRaw) {
    return res.status(200).json({ ok: true }); // nothing to do
  }

  const fromPhone = fromRaw.trim();
  const keyword   = (textRaw || "").trim().toLowerCase();

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("sms-webhook: Supabase not configured");
    return res.status(200).json({ ok: true });
  }

  // ── Find the active booking for this phone number ─────────────────────────
  const { data: booking, error: bookingErr } = await sb
    .from("bookings")
    .select("id, booking_ref, vehicle_id, customer_phone, status")
    .eq("customer_phone", fromPhone)
    .eq("status", "active")
    .maybeSingle();

  if (bookingErr) {
    console.error("sms-webhook: booking lookup error:", bookingErr.message);
    return res.status(200).json({ ok: true });
  }

  if (!booking) {
    // No active booking for this phone — silently acknowledge
    return res.status(200).json({ ok: true });
  }

  const { id: bookingId, booking_ref: bookingRef, vehicle_id: vehicleId } = booking;

  // ── Validate reply ────────────────────────────────────────────────────────
  const hasPhoto = numMedia > 0 && !!mediaUrl;

  if (!VALID_LEVELS.has(keyword)) {
    // Unrecognised reply
    try {
      await sendSms(fromPhone, REPLY_INVALID);
    } catch (smsErr) {
      console.error("sms-webhook: sendSms failed:", smsErr.message);
    }
    return res.status(200).json({ ok: true });
  }

  if (!hasPhoto) {
    // Valid keyword but no photo attached
    try {
      await sendSms(fromPhone, REPLY_NO_PHOTO);
    } catch (smsErr) {
      console.error("sms-webhook: sendSms failed:", smsErr.message);
    }
    return res.status(200).json({ ok: true });
  }

  // ── Valid reply with photo — update DB ────────────────────────────────────
  const nowTs = nowLA();

  const bookingUpdate = {
    last_oil_check_at:      nowTs,
    oil_status:             keyword,
    oil_check_required:     false,
    oil_check_missed_count: 0,
    oil_check_photo_url:    mediaUrl,
    updated_at:             new Date().toISOString(),
  };

  const { error: updateErr } = await sb
    .from("bookings")
    .update(bookingUpdate)
    .eq("id", bookingId);

  if (updateErr) {
    console.error("sms-webhook: booking update error:", updateErr.message);
  }

  // ── Update vehicle_state ──────────────────────────────────────────────────
  // Read current_mileage from vehicle_state (may be null for new vehicles).
  const { data: vState } = await sb
    .from("vehicle_state")
    .select("current_mileage")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();

  const { error: vsErr } = await sb
    .from("vehicle_state")
    .upsert(
      {
        vehicle_id:               vehicleId,
        last_oil_check_at:        nowTs,
        last_oil_status:          keyword,
        last_oil_check_photo_url: mediaUrl,
        last_oil_check_mileage:   vState?.current_mileage ?? null,
        updated_at:               new Date().toISOString(),
      },
      { onConflict: "vehicle_id" }
    );

  if (vsErr) {
    console.error("sms-webhook: vehicle_state upsert error:", vsErr.message);
  }

  // ── Send reply SMS ────────────────────────────────────────────────────────
  let replyText;
  if (keyword === "full") {
    replyText = REPLY_FULL;
  } else if (keyword === "mid") {
    replyText = REPLY_MID;
  } else {
    replyText = REPLY_LOW;
  }

  try {
    await sendSms(fromPhone, replyText);
  } catch (smsErr) {
    console.error("sms-webhook: sendSms reply failed:", smsErr.message);
  }

  // ── LOW oil — trigger admin alert ─────────────────────────────────────────
  if (keyword === "low") {
    await triggerLowOilAlert(bookingRef || bookingId, fromPhone, vehicleId);
  }

  return res.status(200).json({ ok: true, level: keyword });
}
