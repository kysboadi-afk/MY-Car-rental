import { normalizePhone } from "./_bookings.js";
import { sendSms } from "./_textmagic.js";
import { isFeatureEnabled } from "./_sms-rollout.js";
import { logSmsDeliveryToSupabase, sendDedupedSms } from "./_sms-log.js";

function mergeMetadata(metadata, extra) {
  const base = metadata && typeof metadata === "object" ? metadata : {};
  return { ...base, ...extra };
}

export async function dispatchSms({
  bookingId = null,
  vehicleId = null,
  templateKey = null,
  phone,
  body,
  returnDateAtSend = undefined,
  metadata = null,
  forceSend = false,
  dedupe = false,
  source = "unknown",
  throwOnError = true,
}) {
  const normalizedPhone = normalizePhone(phone || "");
  const text = typeof body === "string" ? body.trim() : "";
  const dispatcherEnabled = isFeatureEnabled("SMS_DISPATCHER_ENABLED", true);
  const dedupeDefault = isFeatureEnabled("SMS_DISPATCHER_DEDUPE_DEFAULT", true);
  const useDedupe = dedupe || (dedupe === false && dedupeDefault && !!bookingId && !!templateKey);
  const commonMeta = mergeMetadata(metadata, {
    source,
    dispatcher_enabled: dispatcherEnabled,
    dispatcher_dedupe: useDedupe,
  });

  if (!normalizedPhone || !text) {
    await logSmsDeliveryToSupabase({
      booking_ref: bookingId || null,
      vehicle_id: vehicleId || null,
      renter_phone: normalizedPhone || null,
      message_type: templateKey || null,
      message_body: text || String(body || ""),
      status: "skipped",
      error: !normalizedPhone ? "missing_phone" : "missing_body",
    });
    return {
      sent: false,
      skipped: true,
      reason: !normalizedPhone ? "missing_phone" : "missing_body",
    };
  }

  if (useDedupe && bookingId && templateKey) {
    const sent = await sendDedupedSms({
      bookingId,
      templateKey,
      phone: normalizedPhone,
      body: text,
      returnDateAtSend,
      metadata: commonMeta,
      forceSend,
    });
    return {
      sent: !!sent,
      skipped: !sent,
      deduped: true,
      dedupSkipped: !sent,
    };
  }

  try {
    const result = await sendSms(normalizedPhone, text);
    const providerId = result && result.id != null ? String(result.id) : null;
    await logSmsDeliveryToSupabase({
      booking_ref: bookingId || null,
      vehicle_id: vehicleId || null,
      renter_phone: normalizedPhone,
      message_type: templateKey || null,
      message_body: text,
      status: "sent",
      provider_id: providerId,
    });
    return {
      sent: true,
      skipped: false,
      deduped: false,
      providerId,
    };
  } catch (err) {
    await logSmsDeliveryToSupabase({
      booking_ref: bookingId || null,
      vehicle_id: vehicleId || null,
      renter_phone: normalizedPhone,
      message_type: templateKey || null,
      message_body: text,
      status: "failed",
      error: err.message || String(err),
    });
    if (throwOnError) throw err;
    return {
      sent: false,
      skipped: false,
      deduped: false,
      error: err.message || String(err),
    };
  }
}

