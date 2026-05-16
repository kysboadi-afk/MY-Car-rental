import { normalizePhone } from "./_bookings.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";

export const SMS_LOGS_NO_RETURN_DATE = "1970-01-01";

export async function isSmsLogged(bookingId, templateKey, returnDateAtSend = SMS_LOGS_NO_RETURN_DATE) {
  const sb = getSupabaseAdmin();
  if (!sb || !bookingId || !templateKey) return false;
  try {
    const { data, error } = await sb
      .from("sms_logs")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("template_key", templateKey)
      .eq("return_date_at_send", returnDateAtSend)
      .maybeSingle();
    if (error) {
      console.warn("_sms-log: sms_logs read error (non-fatal):", error.message);
      return false;
    }
    return !!data;
  } catch (err) {
    console.warn("_sms-log: sms_logs check failed (non-fatal):", err.message);
    return false;
  }
}

export async function logSmsToSupabase(bookingId, templateKey, returnDateAtSend = SMS_LOGS_NO_RETURN_DATE, metadata = null) {
  const sb = getSupabaseAdmin();
  if (!sb || !bookingId || !templateKey) return;
  try {
    const row = {
      booking_id: bookingId,
      template_key: templateKey,
      return_date_at_send: returnDateAtSend,
    };
    if (metadata && typeof metadata === "object") row.metadata = metadata;
    const { error } = await sb
      .from("sms_logs")
      .upsert(row, { onConflict: "booking_id,template_key,return_date_at_send" });
    if (error) {
      console.warn("_sms-log: sms_logs write error (non-fatal):", error.message);
    }
  } catch (err) {
    console.warn("_sms-log: sms_logs write failed (non-fatal):", err.message);
  }
}

export async function logSmsDeliveryToSupabase({
  booking_ref = null,
  vehicle_id = null,
  renter_phone = null,
  message_type = null,
  message_body = null,
  status,
  error = null,
  provider_id = null,
}) {
  const sb = getSupabaseAdmin();
  if (!sb || !status) return;
  try {
    await sb.from("sms_delivery_logs").insert({
      booking_ref: booking_ref || null,
      vehicle_id: vehicle_id || null,
      renter_phone: renter_phone || null,
      message_type: message_type || null,
      message_body: message_body || null,
      status,
      error,
      provider_id,
    });
  } catch (deliveryErr) {
    console.warn("_sms-log: sms_delivery_logs write failed (non-fatal):", deliveryErr.message);
  }
}

export async function sendDedupedSms({ bookingId, templateKey, phone, body, returnDateAtSend, metadata, forceSend = false }) {
  const normalizedPhone = normalizePhone(phone || "");
  if (!normalizedPhone || !body) return false;
  if (!bookingId) {
    console.warn(`_sms-log: sendDedupedSms called without bookingId for template "${templateKey}"`);
  }
  const logDelivery = async ({ status, error = null, provider_id = null }) => {
    await logSmsDeliveryToSupabase({
      booking_ref: bookingId || null,
      vehicle_id: null,
      renter_phone: normalizedPhone || null,
      message_type: templateKey || null,
      message_body: body,
      status,
      error,
      provider_id,
    });
  };
  const alreadyLogged = !forceSend && bookingId
    ? await isSmsLogged(bookingId, templateKey, returnDateAtSend || SMS_LOGS_NO_RETURN_DATE)
    : false;
  if (alreadyLogged) {
    console.log(`[SMS_SKIP] ${bookingId} ${templateKey}: already logged`);
    await logDelivery({ status: "skipped", error: "dedup_already_logged" });
    return false;
  }
  let tmResult = null;
  try {
    tmResult = await sendSms(normalizedPhone, body);
  } catch (err) {
    await logDelivery({ status: "failed", error: err.message || String(err) });
    throw err;
  }
  const providerId = tmResult && tmResult.id != null ? String(tmResult.id) : null;
  await logDelivery({ status: "sent", provider_id: providerId });
  if (bookingId) {
    await logSmsToSupabase(bookingId, templateKey, returnDateAtSend || SMS_LOGS_NO_RETURN_DATE, metadata);
  }
  return true;
}
