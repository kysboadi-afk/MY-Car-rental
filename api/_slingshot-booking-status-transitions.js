import { toDbBookingStatus } from "./_booking-status.js";
import { writeAuditLog } from "./_booking-automation.js";

const ALLOWED_TRANSITIONS = {
  inquiry_received: new Set(["identity_pending", "identity_verified", "agreement_pending", "cancelled_rental"]),
  identity_pending: new Set(["identity_verified", "agreement_pending", "cancelled_rental"]),
  identity_verified: new Set(["agreement_pending", "agreement_signed", "pending_manual_payment", "cancelled_rental"]),
  agreement_pending: new Set(["agreement_signed", "pending_manual_payment", "cancelled_rental"]),
  agreement_signed: new Set(["pending_manual_payment", "ready_for_pickup", "cancelled_rental"]),
  pending_manual_payment: new Set(["ready_for_pickup", "cancelled_rental"]),
  ready_for_pickup: new Set(["active_rental", "completed_rental", "cancelled_rental"]),
};

export function canTransitionSlingshotStatus(currentStatus, nextStatus) {
  const current = String(currentStatus || "").trim();
  const next = String(nextStatus || "").trim();
  if (!current || !next) return false;
  if (current === next) return true;
  return !!ALLOWED_TRANSITIONS[current]?.has(next);
}

export async function applySlingshotBookingStatusTransition(sb, booking, nextStatus, options = {}) {
  if (!sb) throw new Error("Database not configured");
  if (!booking?.booking_ref) throw new Error("Booking reference is required");

  const currentStatus = String(booking.status || "").trim();
  const targetStatus = String(nextStatus || "").trim();
  if (!targetStatus) throw new Error("Target status is required");
  if (!canTransitionSlingshotStatus(currentStatus, targetStatus)) {
    throw new Error(`Invalid slingshot status transition: ${currentStatus || "unknown"} -> ${targetStatus}`);
  }

  const payload = {
    status: toDbBookingStatus(targetStatus),
    updated_at: options.updatedAt || new Date().toISOString(),
    ...(options.extraFields || {}),
  };

  const { error } = await sb
    .from("bookings")
    .update(payload)
    .eq("booking_ref", booking.booking_ref);

  if (error) throw error;

  const auditChanges = [
    { field: "status", oldValue: currentStatus || null, newValue: targetStatus },
    ...Object.entries(options.auditFields || {}).map(([field, value]) => ({
      field,
      oldValue: booking[field] != null ? booking[field] : null,
      newValue: value != null ? value : null,
    })),
  ];
  await writeAuditLog(booking.booking_ref, auditChanges, options.changedBy || "slingshot-workflow");

  return { ...booking, ...payload, status: targetStatus };
}
