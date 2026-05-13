import { normalizePhone } from "./_bookings.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";

export const SMS_LOGS_SENTINEL_DATE = "1970-01-01";

export async function isSmsLogged(bookingId, templateKey, returnDateAtSend = SMS_LOGS_SENTINEL_DATE) {
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

export async function logSmsToSupabase(bookingId, templateKey, returnDateAtSend = SMS_LOGS_SENTINEL_DATE, metadata = null) {
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

export async function sendDedupedSms({ bookingId, templateKey, phone, body, returnDateAtSend, metadata }) {
  const normalizedPhone = normalizePhone(phone || "");
  if (!normalizedPhone || !body) return false;
  const alreadyLogged = bookingId
    ? await isSmsLogged(bookingId, templateKey, returnDateAtSend || SMS_LOGS_SENTINEL_DATE)
    : false;
  if (alreadyLogged) {
    console.log(`[SMS_SKIP] ${bookingId} ${templateKey}: already logged`);
    return false;
  }
  await sendSms(normalizedPhone, body);
  if (bookingId) {
    await logSmsToSupabase(bookingId, templateKey, returnDateAtSend || SMS_LOGS_SENTINEL_DATE, metadata);
  }
  return true;
}
