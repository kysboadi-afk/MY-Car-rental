// api/_sms-lifecycle.js
// Centralized SMS lifecycle routing by booking/payment event state.

export const SMS_LIFECYCLE_EVENT = Object.freeze({
  RESERVATION_DEPOSIT_PAID: "reservation_deposit_paid",
  BOOKING_PAID_IN_FULL: "booking_paid_in_full",
  BALANCE_PARTIAL_PAYMENT: "balance_partial_payment",
  NONE: "none",
});

export function normalizeLifecycleEvent({ paymentType = "", isPartialPayment = false } = {}) {
  const type = String(paymentType || "").trim().toLowerCase();
  if (type === "reservation_deposit") return SMS_LIFECYCLE_EVENT.RESERVATION_DEPOSIT_PAID;
  if (type === "full_payment") return SMS_LIFECYCLE_EVENT.BOOKING_PAID_IN_FULL;
  if (type === "balance_payment" || type === "rental_balance") {
    return isPartialPayment
      ? SMS_LIFECYCLE_EVENT.BALANCE_PARTIAL_PAYMENT
      : SMS_LIFECYCLE_EVENT.BOOKING_PAID_IN_FULL;
  }
  return SMS_LIFECYCLE_EVENT.NONE;
}

export function buildLifecycleTemplateSequence(eventType) {
  switch (eventType) {
    case SMS_LIFECYCLE_EVENT.RESERVATION_DEPOSIT_PAID:
      return ["reservation_deposit_confirmed", "manage_booking_access", "booking_onboarding"];
    case SMS_LIFECYCLE_EVENT.BOOKING_PAID_IN_FULL:
      return ["booking_confirmed", "manage_booking_access", "booking_onboarding"];
    case SMS_LIFECYCLE_EVENT.BALANCE_PARTIAL_PAYMENT:
      return ["payment_education"];
    default:
      return [];
  }
}

export function shouldSendBalanceCollectionReminder(bookingStatus = "") {
  const status = String(bookingStatus || "").trim().toLowerCase();
  return status === "active_rental" || status === "active" || status === "overdue";
}
