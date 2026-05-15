// api/system-health-ack-sms.js
// Admin endpoint to acknowledge manually-sent critical SMS without resending.
// This clears false-positive SMS Delivery Health misses by writing dedup rows
// into sms_logs (and visibility rows into sms_delivery_logs).

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSmsPriority } from "./_sms-priority.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const CRITICAL_KEYS = ["late_warning_30min", "late_at_return", "late_grace_expired"];
const MANUAL_ACK_MESSAGE_BODY = "[Manual Admin Acknowledgement] Marked as handled outside automated SMS sender.";

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret, bookingRef, returnDate, templateKeys } = req.body || {};
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const normalizedBookingRef = String(bookingRef || "").trim();
  if (!/^bk-/i.test(normalizedBookingRef)) {
    return res.status(400).json({ error: "bookingRef is required." });
  }

  const requestedKeys = Array.isArray(templateKeys)
    ? templateKeys.map((k) => String(k || "").trim()).filter(Boolean)
    : [];
  const keys = (requestedKeys.length > 0 ? requestedKeys : CRITICAL_KEYS)
    .filter((k) => CRITICAL_KEYS.includes(k));
  if (keys.length === 0) {
    return res.status(400).json({ error: "No valid critical template keys provided." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: "Supabase not configured." });

  const { data: booking, error: bookingErr } = await sb
    .from("bookings")
    .select("booking_ref, return_date, vehicle_id, renter_phone, customer_phone")
    .eq("booking_ref", normalizedBookingRef)
    .maybeSingle();

  if (bookingErr) {
    console.error("[system-health-ack-sms] booking query error:", bookingErr.message);
    return res.status(500).json({ error: "Could not load booking: " + bookingErr.message });
  }
  if (!booking) {
    return res.status(404).json({ error: `Booking not found: ${normalizedBookingRef}` });
  }

  const normalizedReturnDate = String(returnDate || booking.return_date || "").split("T")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedReturnDate)) {
    return res.status(400).json({ error: "A valid returnDate is required (YYYY-MM-DD)." });
  }

  const metadataBase = {
    source: "admin_manual_sms_ack",
    acknowledged_manually: true,
    acknowledged_at: new Date().toISOString(),
  };

  const smsRows = keys.map((key) => ({
    booking_id: normalizedBookingRef,
    template_key: key,
    return_date_at_send: normalizedReturnDate,
    metadata: {
      ...metadataBase,
      priority: getSmsPriority(key),
    },
  }));
  const { error: smsErr } = await sb
    .from("sms_logs")
    .upsert(smsRows, { onConflict: "booking_id,template_key,return_date_at_send" });
  if (smsErr) {
    console.error("[system-health-ack-sms] sms_logs upsert error:", smsErr.message);
    return res.status(500).json({ error: "Could not acknowledge SMS logs: " + smsErr.message });
  }

  const visibilityRows = keys.map((key) => ({
    booking_ref: normalizedBookingRef,
    vehicle_id: booking.vehicle_id || null,
    renter_phone: booking.renter_phone || booking.customer_phone || null,
    message_type: key,
    message_body: MANUAL_ACK_MESSAGE_BODY,
    status: "sent",
    provider_id: "manual_ack",
    error: null,
  }));

  const { error: visErr } = await sb
    .from("sms_delivery_logs")
    .insert(visibilityRows);
  if (visErr) {
    console.warn("[system-health-ack-sms] sms_delivery_logs write error (non-fatal):", visErr.message);
  }

  return res.status(200).json({
    ok: true,
    bookingRef: normalizedBookingRef,
    returnDate: normalizedReturnDate,
    acknowledged: keys,
    inserted: keys.length,
    message: `Acknowledged ${keys.length} critical SMS key${keys.length !== 1 ? "s" : ""} for ${normalizedBookingRef}.`,
  });
}
