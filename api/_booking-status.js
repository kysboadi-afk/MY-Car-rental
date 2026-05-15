export const APP_TO_DB_STATUS = {
  pending_checkout:   "pending_checkout",
  upload_failed:      "upload_failed",
  payment_failed:     "payment_failed",
  abandoned_checkout: "abandoned_checkout",
  reserved_unpaid:    "reserved",
  booked_paid:        "booked_paid",
  active_rental:      "active_rental",
  overdue:            "overdue",
  completed_rental:   "completed_rental",
  cancelled_rental:   "cancelled_rental",
};

export const DB_TO_APP_STATUS = {
  pending:              "pending_checkout",
  pending_checkout:     "pending_checkout",
  upload_failed:        "upload_failed",
  payment_failed:       "payment_failed",
  abandoned_checkout:   "abandoned_checkout",
  reserved:             "reserved_unpaid",
  pending_verification: "reserved_unpaid",
  approved:             "booked_paid",
  booked_paid:          "booked_paid",
  active:               "active_rental",
  active_rental:        "active_rental",
  overdue:              "overdue",
  completed:            "completed_rental",
  completed_rental:     "completed_rental",
  cancelled:            "cancelled_rental",
  cancelled_rental:     "cancelled_rental",
};

export const INCOMPLETE_CHECKOUT_DB_STATUSES = new Set([
  "pending",
  "pending_checkout",
  "upload_failed",
  "payment_failed",
  "abandoned_checkout",
]);

export const CHECKOUT_PENDING_PREPAY_DB_STATUSES = new Set([
  "pending",
  "pending_checkout",
]);

export const INCOMPLETE_CHECKOUT_APP_STATUSES = new Set([
  "pending_checkout",
  "upload_failed",
  "payment_failed",
  "abandoned_checkout",
]);

/**
 * Convert an app-layer booking status into the canonical DB status.
 * Falls back to pending_checkout for empty input and passes through unknown
 * non-empty values so older environments remain debuggable instead of masking data.
 */
export function toDbBookingStatus(status) {
  const normalized = String(status || "").trim();
  return APP_TO_DB_STATUS[normalized] || normalized || "pending_checkout";
}

/**
 * Convert a DB booking status into the admin/app-layer status label.
 * Falls back to pending_checkout for empty input and passes through unknown
 * non-empty values so the UI still surfaces unexpected lifecycle values.
 */
export function toAppBookingStatus(status) {
  const normalized = String(status || "").trim();
  return DB_TO_APP_STATUS[normalized] || normalized || "pending_checkout";
}

export function isIncompleteCheckoutAppStatus(status) {
  return INCOMPLETE_CHECKOUT_APP_STATUSES.has(String(status || "").trim());
}
