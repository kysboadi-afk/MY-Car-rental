// api/_sms-templates.js
// Centralized SMS template library for the SLY RIDES rental management system.
//
// All customer-facing SMS messages are defined here as functions that accept
// a variables object and return the rendered message string.  Templates use
// named placeholders matching the spec ({customer_name}, {vehicle}, etc.).
//
// Variables reference:
//   customer_name      – renter's first name (or full name)
//   vehicle            – vehicle display name  (e.g. "Slingshot R")
//   pickup_date        – human-readable date   (e.g. "March 28")
//   pickup_time        – human-readable time   (e.g. "3:00 PM")
//   return_time        – human-readable time   (e.g. "5:00 PM")
//   return_date        – human-readable date   (e.g. "April 4")
//   location           – pickup address
//   extra_time         – extension duration    (e.g. "+1 hour" or "+1 day")
//   price              – total extension cost  (e.g. "50")
//   payment_link       – URL for completing payment
//   booking_link       – URL for completing the booking
//   waitlist_link      – URL for joining the waitlist
//   max_available_time – maximum extension window (e.g. "2 hours" or "3 days")
//   late_fee           – late fee amount in dollars (e.g. "50")

export const DEFAULT_LOCATION = "1200 S Figueroa St, Los Angeles, CA 90015";

/**
 * Render a template string by substituting {variable} placeholders.
 * Unknown placeholders are left as-is to avoid silent data loss.
 * @param {string} template
 * @param {Record<string, string|number>} vars
 * @returns {string}
 */
export function render(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. APPLICATION FLOW
// ─────────────────────────────────────────────────────────────────────────────

/** Sent immediately when an application is submitted (before auto-decision). */
export const APPLICATION_RECEIVED =
  "Hi {customer_name},\n\n" +
  "We\u2019ve received your application.\n\n" +
  "Your application is currently under review.\n" +
  "We\u2019ll notify you shortly.\n\n" +
  "Reply STOP to opt out.";

/** Sent when the application is auto-approved. */
export const APPLICATION_APPROVED =
  "Hi {customer_name},\n\n" +
  "You\u2019ve been approved.\n\n" +
  "You can now join the waitlist to reserve your {vehicle}:\n" +
  "{waitlist_link}\n\n" +
  "Reply STOP to opt out.";

/** Sent when the application is auto-denied. */
export const APPLICATION_DENIED =
  "Hi {customer_name},\n\n" +
  "Your application does not meet our current rental requirements.\n\n" +
  "If you have any questions, feel free to contact us.\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 2. WAITLIST FLOW
// ─────────────────────────────────────────────────────────────────────────────

/** Sent when a customer joins the waitlist (deposit paid, pending owner review). */
export const WAITLIST_JOINED =
  "Hi {customer_name},\n\n" +
  "We\u2019ve received your request for the {vehicle}.\n\n" +
  "Your request is currently under review.\n" +
  "We\u2019ll notify you shortly once it\u2019s approved.\n\n" +
  "Reply STOP to opt out.";

/** Sent when the owner approves the waitlist entry. */
export const WAITLIST_APPROVED =
  "Good news, {customer_name} \u2014 you\u2019ve been approved.\n\n" +
  "You can now reserve your {vehicle}:\n" +
  "{booking_link}\n\n" +
  "You may pay now or complete payment before pickup.\n\n" +
  "Availability is not guaranteed until payment is completed.\n\n" +
  "Reply STOP to opt out.";

/** Sent as a reminder if the customer was approved but hasn\u2019t booked yet. */
export const WAITLIST_BOOKING_REMINDER =
  "Hi {customer_name},\n\n" +
  "Your approval is still active.\n\n" +
  "Complete your booking here:\n" +
  "{booking_link}\n\n" +
  "Reply STOP to opt out.";

/** Sent when the owner declines the waitlist entry. */
export const WAITLIST_DECLINED =
  "Hi {customer_name},\n\n" +
  "We were unable to approve your request.\n\n" +
  "Your deposit will be refunded.\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 3. BOOKING / PAYMENT FLOW
// ─────────────────────────────────────────────────────────────────────────────

/** Sent when the customer pays in full. */
export const BOOKING_CONFIRMED =
  "Your {vehicle} is confirmed, {customer_name}.\n\n" +
  "Pickup: {pickup_date} at {pickup_time}\n" +
  "\uD83D\uDCCD {location}\n\n" +
  "We\u2019ll have everything ready for you.\n\n" +
  "Reply STOP to opt out.";

/** Sent 24 hours before pickup when payment is still pending (reserved_unpaid). */
export const UNPAID_REMINDER_24H =
  "Hi {customer_name},\n\n" +
  "Your booking is reserved, but payment is still pending.\n\n" +
  "Please complete payment before pickup:\n" +
  "{payment_link}\n\n" +
  "Reply STOP to opt out.";

/** Sent 2 hours before pickup when payment is still pending (reserved_unpaid). */
export const UNPAID_REMINDER_2H =
  "Reminder: your rental is at {pickup_time}.\n\n" +
  "Payment is required before pickup:\n" +
  "{payment_link}\n\n" +
  "Reply STOP to opt out.";

/** Final reminder sent 30 minutes before pickup when payment is still pending. */
export const UNPAID_REMINDER_FINAL =
  "Hi {customer_name},\n\n" +
  "Your pickup is approaching.\n\n" +
  "Please complete payment to avoid delays:\n" +
  "{payment_link}\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 4. PRE-PICKUP REMINDERS (paid bookings only)
// ─────────────────────────────────────────────────────────────────────────────

/** Sent 24 hours before pickup for a paid booking. */
export const PICKUP_REMINDER_24H =
  "Just a reminder of your rental tomorrow at {pickup_time}.\n\n" +
  "\uD83D\uDCCD {location}\n\n" +
  "Your {vehicle} will be ready.\n\n" +
  "Reply STOP to opt out.";

/** Sent 2 hours before pickup for a paid booking. */
export const PICKUP_REMINDER_2H =
  "Your {vehicle} will be ready in 2 hours.\n\n" +
  "Pickup time: {pickup_time}\n" +
  "\uD83D\uDCCD {location}\n\n" +
  "See you soon.\n\n" +
  "Reply STOP to opt out.";

/** Sent 30 minutes before pickup for a paid booking. */
export const PICKUP_REMINDER_30MIN =
  "We\u2019re preparing your {vehicle} for pickup.\n\n" +
  "See you shortly at:\n" +
  "\uD83D\uDCCD {location}\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 5. ACTIVE RENTAL
// ─────────────────────────────────────────────────────────────────────────────

/** Sent mid-rental (e.g. roughly halfway through). */
export const ACTIVE_RENTAL_MID =
  "Hope you\u2019re enjoying your {vehicle}.\n\n" +
  "If you need more time, reply EXTEND anytime.\n\n" +
  "Reply STOP to opt out.";

/** Sent 1 hour before rental end. */
export const ACTIVE_RENTAL_1H_BEFORE_END =
  "Your rental ends in about 1 hour.\n\n" +
  "Reply EXTEND if you\u2019d like more time.\n\n" +
  "Reply STOP to opt out.";

/** Sent 15 minutes before rental end. */
export const ACTIVE_RENTAL_15MIN_BEFORE_END =
  "Your rental is ending shortly.\n\n" +
  "Reply EXTEND if needed.\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 6. EXTEND SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** Sent when the vehicle is not available for extension (next booking conflict). */
export const EXTEND_UNAVAILABLE =
  "Thanks for checking.\n\n" +
  "This vehicle is reserved after your current booking, so we\u2019re unable to extend at this time.\n\n" +
  "Please return the vehicle at your scheduled time.\n\n" +
  "Reply STOP to opt out.";

/** Sent when extension is possible but time is limited. */
export const EXTEND_LIMITED =
  "You can extend your {vehicle} for up to {max_available_time}.\n\n" +
  "Reply with available option(s).\n\n" +
  "Reply STOP to opt out.";

/** Sent when a Slingshot extension is available with full options. */
export const EXTEND_OPTIONS_SLINGSHOT =
  "How much extra time would you like?\n\n" +
  "1 = +1 hour\n" +
  "2 = +2 hours\n" +
  "4 = +4 hours\n\n" +
  "Reply STOP to opt out.";

/** Sent when a Camry / economy extension is available with full options. */
export const EXTEND_OPTIONS_ECONOMY =
  "How would you like to extend your rental?\n\n" +
  "1 = +1 day\n" +
  "3 = +3 days\n" +
  "7 = +1 week\n\n" +
  "Reply STOP to opt out.";

/** Sent after the customer selects an extension option (before payment). */
export const EXTEND_SELECTED =
  "+{extra_time} added to your {vehicle}\n\n" +
  "Total: \${price}\n\n" +
  "Complete here:\n" +
  "{payment_link}\n\n" +
  "Reply STOP to opt out.";

/** Sent after a Slingshot extension payment succeeds. */
export const EXTEND_CONFIRMED_SLINGSHOT =
  "Your new return time:\n" +
  "{return_time}\n\n" +
  "Reply STOP to opt out.";

/** Sent after an economy extension payment succeeds. */
export const EXTEND_CONFIRMED_ECONOMY =
  "Your new return date:\n" +
  "{return_date}\n\n" +
  "Reply STOP to opt out.";

/** Sent when an extension payment is not completed. */
export const EXTEND_PAYMENT_PENDING =
  "Your extension request is still pending.\n\n" +
  "Complete here:\n" +
  "{payment_link}\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 7. LATE RETURN / OVERTIME SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** Sent 30 minutes before scheduled return. */
export const LATE_WARNING_30MIN =
  "Your rental is ending soon at {return_time}.\n\n" +
  "Please return on time to avoid additional charges.\n\n" +
  "Reply STOP to opt out.";

/** Sent exactly at the scheduled return time. */
export const LATE_AT_RETURN_TIME =
  "Hi {customer_name},\n\n" +
  "Your rental time has ended.\n\n" +
  "Reply EXTEND if you need more time.\n\n" +
  "Reply STOP to opt out.";

/** Sent after the grace period has expired. */
export const LATE_GRACE_EXPIRED =
  "Hi {customer_name},\n\n" +
  "Your rental is now past the grace period.\n\n" +
  "Late fees may apply.\n\n" +
  "Reply STOP to opt out.";

/** Sent when a late fee is applied. */
export const LATE_FEE_APPLIED =
  "A late fee has been applied.\n\n" +
  "Amount: \${late_fee}\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 8. POST-RENTAL
// ─────────────────────────────────────────────────────────────────────────────

/** Sent immediately after the vehicle is returned / rental is marked complete. */
export const POST_RENTAL_THANK_YOU =
  "Thanks again, {customer_name}.\n\n" +
  "We hope you enjoyed your experience.\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// 9. PAST RENTAL — RETENTION SEQUENCE
// ─────────────────────────────────────────────────────────────────────────────

/** Day 1 after return. */
export const RETENTION_DAY_1 =
  "We hope everything went smoothly with your rental.\n\n" +
  "Reply STOP to opt out.";

/** Day 3 after return. */
export const RETENTION_DAY_3 =
  "We\u2019d appreciate your feedback when you have a moment.\n\n" +
  "Reply STOP to opt out.";

/** Day 7 after return. */
export const RETENTION_DAY_7 =
  "Ready for another ride?\n\n" +
  "Reply STOP to opt out.";

/** Day 14 after return. */
export const RETENTION_DAY_14 =
  "Returning customers receive priority booking.\n\n" +
  "Reply STOP to opt out.";

/** Day 30 after return. */
export const RETENTION_DAY_30 =
  "Whenever you\u2019re ready again, we\u2019re here.\n\n" +
  "Reply STOP to opt out.";

// ─────────────────────────────────────────────────────────────────────────────
// Convenience map keyed by template name — useful for admin tooling
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATES = {
  application_received:      APPLICATION_RECEIVED,
  application_approved:      APPLICATION_APPROVED,
  application_denied:        APPLICATION_DENIED,
  waitlist_joined:           WAITLIST_JOINED,
  waitlist_approved:         WAITLIST_APPROVED,
  waitlist_booking_reminder: WAITLIST_BOOKING_REMINDER,
  waitlist_declined:         WAITLIST_DECLINED,
  booking_confirmed:         BOOKING_CONFIRMED,
  unpaid_reminder_24h:       UNPAID_REMINDER_24H,
  unpaid_reminder_2h:        UNPAID_REMINDER_2H,
  unpaid_reminder_final:     UNPAID_REMINDER_FINAL,
  pickup_reminder_24h:       PICKUP_REMINDER_24H,
  pickup_reminder_2h:        PICKUP_REMINDER_2H,
  pickup_reminder_30min:     PICKUP_REMINDER_30MIN,
  active_rental_mid:         ACTIVE_RENTAL_MID,
  active_rental_1h_before_end:   ACTIVE_RENTAL_1H_BEFORE_END,
  active_rental_15min_before_end: ACTIVE_RENTAL_15MIN_BEFORE_END,
  extend_unavailable:        EXTEND_UNAVAILABLE,
  extend_limited:            EXTEND_LIMITED,
  extend_options_slingshot:  EXTEND_OPTIONS_SLINGSHOT,
  extend_options_economy:    EXTEND_OPTIONS_ECONOMY,
  extend_selected:           EXTEND_SELECTED,
  extend_confirmed_slingshot: EXTEND_CONFIRMED_SLINGSHOT,
  extend_confirmed_economy:  EXTEND_CONFIRMED_ECONOMY,
  extend_payment_pending:    EXTEND_PAYMENT_PENDING,
  late_warning_30min:        LATE_WARNING_30MIN,
  late_at_return_time:       LATE_AT_RETURN_TIME,
  late_grace_expired:        LATE_GRACE_EXPIRED,
  late_fee_applied:          LATE_FEE_APPLIED,
  post_rental_thank_you:     POST_RENTAL_THANK_YOU,
  retention_day_1:           RETENTION_DAY_1,
  retention_day_3:           RETENTION_DAY_3,
  retention_day_7:           RETENTION_DAY_7,
  retention_day_14:          RETENTION_DAY_14,
  retention_day_30:          RETENTION_DAY_30,
};
