const POSTGRES_UNDEFINED_TABLE_ERROR = "42P01";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function truncate(value, maxLen = 280) {
  return normalizeText(value).slice(0, maxLen);
}

export function normalizeExtensionReason(value) {
  return truncate(value, 120);
}

export function normalizeExtensionNotes(value) {
  return truncate(value, 1000);
}

export function deriveExtensionLifecycleStatus({
  paymentStatus = "pending",
  signatureStatus = "pending",
  signatureRequired = false,
  lifecycleStatus = null,
}) {
  const explicit = normalizeText(lifecycleStatus).toLowerCase();
  if (explicit) return explicit;

  const payment = normalizeText(paymentStatus).toLowerCase() || "pending";
  const signature = normalizeText(signatureStatus).toLowerCase() || "pending";

  if (payment === "failed") return "payment_failed";
  if (signature === "failed") return "signature_failed";
  if (payment === "completed" && (!signatureRequired || signature === "completed" || signature === "waived")) {
    return "ready_for_booking_update";
  }
  if (payment === "completed") return "signature_pending";
  if (payment === "pending") return "payment_pending";
  return "requested";
}

export function canApplyBookingUpdateFromLifecycle({
  paymentStatus = "pending",
  signatureStatus = "pending",
  signatureRequired = false,
  lifecycleStatus = "",
} = {}) {
  const lifecycle = deriveExtensionLifecycleStatus({
    paymentStatus,
    signatureStatus,
    signatureRequired,
    lifecycleStatus,
  });
  return lifecycle === "ready_for_booking_update" || lifecycle === "applied";
}

export async function upsertExtensionLifecycleRecord({
  sb,
  bookingRef,
  paymentIntentId,
  requestedReturnDate,
  requestedReturnTime = null,
  extensionReason = "",
  extensionNotes = "",
  paymentStatus = "pending",
  signatureStatus = "pending",
  signatureRequired = false,
  lifecycleStatus = null,
  requestedBy = "renter",
}) {
  if (!sb || !bookingRef || !requestedReturnDate) return null;
  try {
    const normalizedReason = normalizeExtensionReason(extensionReason);
    const normalizedNotes = normalizeExtensionNotes(extensionNotes);
    const resolvedLifecycle = deriveExtensionLifecycleStatus({
      paymentStatus,
      signatureStatus,
      signatureRequired,
      lifecycleStatus,
    });
    const payload = {
      booking_ref: bookingRef,
      payment_intent_id: paymentIntentId || null,
      requested_return_date: requestedReturnDate,
      requested_return_time: requestedReturnTime || null,
      extension_reason: normalizedReason || null,
      extension_notes: normalizedNotes || null,
      payment_status: paymentStatus,
      signature_status: signatureStatus,
      signature_required: !!signatureRequired,
      lifecycle_status: resolvedLifecycle,
      requested_by: requestedBy,
      updated_at: nowIso(),
    };
    if (!paymentIntentId) {
      payload.created_at = nowIso();
      const { error } = await sb.from("booking_extension_requests").upsert(payload);
      if (error) throw error;
      return payload;
    }

    const { error } = await sb
      .from("booking_extension_requests")
      .upsert(payload, { onConflict: "payment_intent_id" });
    if (error) throw error;
    return payload;
  } catch (err) {
    if (err?.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
    console.warn("[extension-lifecycle] upsert skipped:", err?.message || err);
    return null;
  }
}

export async function appendBookingTimelineEvent({
  sb,
  bookingRef,
  eventType,
  actor = "system",
  eventKey = null,
  occurredAt = null,
  payload = {},
}) {
  if (!sb || !bookingRef || !eventType) return null;
  try {
    const resolvedOccurredAt = occurredAt || nowIso();
    const row = {
      booking_ref: bookingRef,
      event_type: eventType,
      event_key: eventKey || `${bookingRef}:${eventType}:${Date.now()}`,
      actor,
      payload: payload && typeof payload === "object" ? payload : {},
      occurred_at: resolvedOccurredAt,
      created_at: nowIso(),
    };
    const { error } = await sb
      .from("booking_event_timeline")
      .upsert(row, { onConflict: "event_key", ignoreDuplicates: true });
    if (error) throw error;
    return row;
  } catch (err) {
    if (err?.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
    console.warn("[extension-lifecycle] timeline append skipped:", err?.message || err);
    return null;
  }
}
