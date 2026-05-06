// api/store-booking-docs.js
// Vercel serverless function — stores pre-payment booking documents in Supabase
// so the Stripe webhook can retrieve and attach them to the owner notification email.
//
// Called from car.js immediately before stripe.confirmPayment() is invoked.
// If this call fails (network error, Supabase down, etc.) the payment still
// proceeds normally — this is a best-effort reliability enhancement, not a
// gate.  The existing sessionStorage/IndexedDB fallback in success.html
// continues to work as before.
//
// POST /api/store-booking-docs
// Body: {
//   bookingId, signature,
//   idBase64, idFileName, idMimeType,
//   idBackBase64, idBackFileName, idBackMimeType,
//   insuranceBase64, insuranceFileName, insuranceMimeType,
//   insuranceCoverageChoice
// }
// Returns: { ok: true, stored: boolean }

import { getSupabaseAdmin } from "./_supabase.js";

// Allow large bodies (ID front + back + insurance doc can be several MB base64-encoded).
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "30mb",
    },
  },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    bookingId,
    signature,
    idBase64, idFileName, idMimeType,
    idBackBase64, idBackFileName, idBackMimeType,
    insuranceBase64, insuranceFileName, insuranceMimeType,
    insuranceCoverageChoice,
  } = req.body || {};

  if (!bookingId || typeof bookingId !== "string" || !bookingId.trim()) {
    return res.status(400).json({ error: "bookingId is required." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    // Supabase not configured — return ok so the caller is not blocked.
    console.warn("store-booking-docs: Supabase not configured — docs not stored");
    return res.status(200).json({ ok: true, stored: false });
  }

  try {
    const { error } = await sb.from("pending_booking_docs").upsert(
      {
        booking_id:               bookingId.trim(),
        signature:                signature || null,
        id_base64:                idBase64 || null,
        id_filename:              idFileName || null,
        id_mimetype:              idMimeType || null,
        id_back_base64:           idBackBase64 || null,
        id_back_filename:         idBackFileName || null,
        id_back_mimetype:         idBackMimeType || null,
        insurance_base64:         insuranceBase64 || null,
        insurance_filename:       insuranceFileName || null,
        insurance_mimetype:       insuranceMimeType || null,
        insurance_coverage_choice: insuranceCoverageChoice || null,
        email_sent:               false,
      },
      { onConflict: "booking_id" }
    );

    if (error) {
      console.error("store-booking-docs: Supabase upsert error:", error.message);
      // Return ok so the caller is not blocked from proceeding with payment.
      return res.status(200).json({ ok: true, stored: false });
    }

    console.log(`store-booking-docs: stored docs for booking ${bookingId.trim()}`);
    return res.status(200).json({ ok: true, stored: true });
  } catch (err) {
    console.error("store-booking-docs: unexpected error:", err.message);
    return res.status(200).json({ ok: true, stored: false });
  }
}
