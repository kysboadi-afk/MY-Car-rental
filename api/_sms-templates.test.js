// api/_sms-templates.test.js
// Unit tests for the SMS template library.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  DEFAULT_LOCATION,
  APPLICATION_RECEIVED,
  APPLICATION_APPROVED,
  APPLICATION_DENIED,
  WAITLIST_JOINED,
  WAITLIST_APPROVED,
  WAITLIST_DECLINED,
  BOOKING_CONFIRMED,
  UNPAID_REMINDER_24H,
  UNPAID_REMINDER_2H,
  UNPAID_REMINDER_FINAL,
  PICKUP_REMINDER_24H,
  PICKUP_REMINDER_2H,
  PICKUP_REMINDER_30MIN,
  ACTIVE_RENTAL_MID,
  ACTIVE_RENTAL_1H_BEFORE_END,
  ACTIVE_RENTAL_15MIN_BEFORE_END,
  RETURN_REMINDER_24H,
  EXTEND_UNAVAILABLE,
  EXTEND_OPTIONS_ECONOMY,
  EXTEND_FLEXIBLE_PROMPT,
  EXTEND_INVALID_INPUT,
  EXTEND_SELECTED,
  EXTEND_SELECTED_UPSELL,
  LATE_WARNING_30MIN,
  LATE_AT_RETURN_TIME,
  LATE_GRACE_EXPIRED,
  LATE_FEE_APPLIED,
  POST_RENTAL_THANK_YOU,
  RETENTION_DAY_1,
  RETENTION_DAY_7,
  RETENTION_DAY_30,
  TEMPLATES,
} from "./_sms-templates.js";

// ─── render() ─────────────────────────────────────────────────────────────────

test("render: substitutes known variables", () => {
  const result = render("Hi {customer_name}, your {vehicle} is ready.", {
    customer_name: "Alice",
    vehicle:       "Camry 2012",
  });
  assert.equal(result, "Hi Alice, your Camry 2012 is ready.");
});

test("render: leaves unknown placeholders intact", () => {
  const result = render("Link: {booking_link}", {});
  assert.equal(result, "Link: {booking_link}");
});

test("render: handles empty vars object", () => {
  const result = render("No vars here.", {});
  assert.equal(result, "No vars here.");
});

test("render: handles numeric variable values", () => {
  const result = render("Fee: ${late_fee}", { late_fee: 50 });
  assert.equal(result, "Fee: $50");
});

// ─── DEFAULT_LOCATION ─────────────────────────────────────────────────────────

test("DEFAULT_LOCATION contains Los Angeles address", () => {
  assert.ok(DEFAULT_LOCATION.includes("Los Angeles"), `Got: ${DEFAULT_LOCATION}`);
  assert.ok(DEFAULT_LOCATION.includes("1200 S Figueroa"), `Got: ${DEFAULT_LOCATION}`);
});

// ─── Application flow templates ───────────────────────────────────────────────

test("APPLICATION_RECEIVED contains expected phrases", () => {
  assert.ok(APPLICATION_RECEIVED.includes("received your application"));
  assert.ok(APPLICATION_RECEIVED.includes("{customer_name}"));
  assert.ok(APPLICATION_RECEIVED.includes("Reply STOP"));
});

test("APPLICATION_APPROVED contains approval phrasing and variables", () => {
  assert.ok(APPLICATION_APPROVED.includes("{customer_name}"));
  assert.ok(APPLICATION_APPROVED.includes("approved"));
  assert.ok(APPLICATION_APPROVED.includes("{vehicle}"));
  assert.ok(APPLICATION_APPROVED.includes("{waitlist_link}"));
});

test("APPLICATION_DENIED contains denial phrasing", () => {
  assert.ok(APPLICATION_DENIED.includes("{customer_name}"));
  assert.ok(APPLICATION_DENIED.includes("does not meet our current rental requirements"));
});

test("render APPLICATION_RECEIVED replaces customer_name", () => {
  const msg = render(APPLICATION_RECEIVED, { customer_name: "Bob" });
  assert.ok(msg.includes("Bob"));
  assert.ok(!msg.includes("{customer_name}"));
});

test("render APPLICATION_APPROVED fills all variables", () => {
  const msg = render(APPLICATION_APPROVED, {
    customer_name: "Alice",
    vehicle:       "Camry 2012",
    waitlist_link: "https://www.slytrans.com/cars.html",
  });
  assert.ok(msg.includes("Alice"));
  assert.ok(msg.includes("Camry 2012"));
  assert.ok(msg.includes("https://www.slytrans.com/cars"));
  assert.ok(!msg.includes("{"));
});

// ─── Waitlist flow templates ───────────────────────────────────────────────────

test("WAITLIST_JOINED references vehicle and customer_name", () => {
  assert.ok(WAITLIST_JOINED.includes("{customer_name}"));
  assert.ok(WAITLIST_JOINED.includes("{vehicle}"));
  assert.ok(WAITLIST_JOINED.includes("under review"));
});

test("WAITLIST_APPROVED references booking_link and vehicle", () => {
  assert.ok(WAITLIST_APPROVED.includes("{booking_link}"));
  assert.ok(WAITLIST_APPROVED.includes("{vehicle}"));
  assert.ok(WAITLIST_APPROVED.includes("{customer_name}"));
});

test("WAITLIST_DECLINED mentions refund", () => {
  assert.ok(WAITLIST_DECLINED.includes("{customer_name}"));
  assert.ok(WAITLIST_DECLINED.includes("refunded"));
});

// ─── Booking / payment templates ──────────────────────────────────────────────

test("BOOKING_CONFIRMED references all key variables", () => {
  assert.ok(BOOKING_CONFIRMED.includes("{vehicle}"));
  assert.ok(BOOKING_CONFIRMED.includes("{customer_name}"));
  assert.ok(BOOKING_CONFIRMED.includes("{pickup_date}"));
  assert.ok(BOOKING_CONFIRMED.includes("{pickup_time}"));
  assert.ok(BOOKING_CONFIRMED.includes("{location}"));
});

test("render BOOKING_CONFIRMED fills correctly", () => {
  const msg = render(BOOKING_CONFIRMED, {
    vehicle:       "Camry 2012",
    customer_name: "Carlos",
    pickup_date:   "March 28",
    pickup_time:   "3:00 PM",
    location:      DEFAULT_LOCATION,
  });
  assert.ok(msg.includes("Camry 2012"));
  assert.ok(msg.includes("Carlos"));
  assert.ok(msg.includes("March 28"));
  assert.ok(msg.includes("3:00 PM"));
  assert.ok(msg.includes(DEFAULT_LOCATION));
  assert.ok(!msg.includes("{"));
});

test("UNPAID_REMINDER_24H includes payment_link", () => {
  assert.ok(UNPAID_REMINDER_24H.includes("{payment_link}"));
  assert.ok(UNPAID_REMINDER_24H.includes("{customer_name}"));
});

test("UNPAID_REMINDER_2H includes pickup_time and payment_link", () => {
  assert.ok(UNPAID_REMINDER_2H.includes("{pickup_time}"));
  assert.ok(UNPAID_REMINDER_2H.includes("{payment_link}"));
});

test("UNPAID_REMINDER_FINAL includes payment_link", () => {
  assert.ok(UNPAID_REMINDER_FINAL.includes("{payment_link}"));
});

// ─── Pre-pickup reminder templates ────────────────────────────────────────────

test("PICKUP_REMINDER_24H references pickup_time and vehicle", () => {
  assert.ok(PICKUP_REMINDER_24H.includes("{pickup_time}"));
  assert.ok(PICKUP_REMINDER_24H.includes("{vehicle}"));
  assert.ok(PICKUP_REMINDER_24H.includes("{location}"));
});

test("PICKUP_REMINDER_2H references vehicle and location", () => {
  assert.ok(PICKUP_REMINDER_2H.includes("{vehicle}"));
  assert.ok(PICKUP_REMINDER_2H.includes("{location}"));
  assert.ok(PICKUP_REMINDER_2H.includes("{pickup_time}"));
});

test("PICKUP_REMINDER_30MIN references vehicle and location", () => {
  assert.ok(PICKUP_REMINDER_30MIN.includes("{vehicle}"));
  assert.ok(PICKUP_REMINDER_30MIN.includes("{location}"));
});

// ─── Active rental templates ───────────────────────────────────────────────────

test("ACTIVE_RENTAL_MID mentions EXTEND keyword", () => {
  assert.ok(ACTIVE_RENTAL_MID.includes("EXTEND"));
  assert.ok(ACTIVE_RENTAL_MID.includes("{vehicle}"));
});

test("ACTIVE_RENTAL_1H_BEFORE_END mentions EXTEND", () => {
  assert.ok(ACTIVE_RENTAL_1H_BEFORE_END.includes("EXTEND"));
});

test("ACTIVE_RENTAL_15MIN_BEFORE_END mentions EXTEND", () => {
  assert.ok(ACTIVE_RENTAL_15MIN_BEFORE_END.includes("EXTEND"));
});

test("RETURN_REMINDER_24H references return_time, buffered_time, and vehicle", () => {
  assert.ok(RETURN_REMINDER_24H.includes("{customer_name}"));
  assert.ok(RETURN_REMINDER_24H.includes("{vehicle}"));
  assert.ok(RETURN_REMINDER_24H.includes("{return_time}"));
  assert.ok(RETURN_REMINDER_24H.includes("{buffered_time}"));
  assert.ok(RETURN_REMINDER_24H.includes("EXTEND"));
});

test("render RETURN_REMINDER_24H fills all variables", () => {
  const msg = render(RETURN_REMINDER_24H, {
    customer_name: "Alice",
    vehicle:       "Camry 2012",
    return_time:   "8:00 AM",
    buffered_time: "10:00 AM",
  });
  assert.ok(msg.includes("Alice"));
  assert.ok(msg.includes("Camry 2012"));
  assert.ok(msg.includes("8:00 AM"));
  assert.ok(msg.includes("10:00 AM"));
  assert.ok(!msg.includes("{"));
});

// ─── Extend system templates ───────────────────────────────────────────────────

test("EXTEND_UNAVAILABLE explains the situation", () => {
  assert.ok(EXTEND_UNAVAILABLE.includes("reserved after your current booking"));
  assert.ok(EXTEND_UNAVAILABLE.includes("return the vehicle"));
});

test("EXTEND_OPTIONS_ECONOMY has 3 options", () => {
  assert.ok(EXTEND_OPTIONS_ECONOMY.includes("1 = +1 day"));
  assert.ok(EXTEND_OPTIONS_ECONOMY.includes("3 = +3 days"));
  assert.ok(EXTEND_OPTIONS_ECONOMY.includes("7 = +1 week"));
});

test("EXTEND_SELECTED references extra_time, vehicle, price, and payment_link", () => {
  assert.ok(EXTEND_SELECTED.includes("{extra_time}"));
  assert.ok(EXTEND_SELECTED.includes("{vehicle}"));
  assert.ok(EXTEND_SELECTED.includes("{price}"));
  assert.ok(EXTEND_SELECTED.includes("{payment_link}"));
});

test("render EXTEND_SELECTED fills all variables", () => {
  const msg = render(EXTEND_SELECTED, {
    extra_time:   "+2 hours",
    vehicle:      "Camry 2012",
    price:        "100",
    payment_link: "https://www.slytrans.com/balance.html?test=1",
  });
  assert.ok(msg.includes("+2 hours"));
  assert.ok(msg.includes("Camry 2012"));
  assert.ok(msg.includes("$100"));
  assert.ok(msg.includes("https://www.slytrans.com/balance.html?test=1"));
  assert.ok(!msg.includes("{"));
});

test("EXTEND_FLEXIBLE_PROMPT instructs customer to reply with days", () => {
  assert.ok(EXTEND_FLEXIBLE_PROMPT.includes("days"), "should mention days");
  assert.ok(EXTEND_FLEXIBLE_PROMPT.includes("Reply STOP"), "must include opt-out");
});

test("EXTEND_FLEXIBLE_PROMPT includes pricing reference", () => {
  assert.ok(EXTEND_FLEXIBLE_PROMPT.includes("$55"), "must show daily rate");
  assert.ok(EXTEND_FLEXIBLE_PROMPT.includes("$350"), "must show weekly rate");
});

test("EXTEND_INVALID_INPUT references {options} variable", () => {
  assert.ok(EXTEND_INVALID_INPUT.includes("{options}"));
  assert.ok(EXTEND_INVALID_INPUT.includes("Reply STOP"));
});

test("render EXTEND_INVALID_INPUT fills options variable", () => {
  const msg = render(EXTEND_INVALID_INPUT, { options: "1, 2, or 4" });
  assert.ok(msg.includes("1, 2, or 4"));
  assert.ok(!msg.includes("{options}"));
});

test("EXTEND_SELECTED_UPSELL references all required variables", () => {
  assert.ok(EXTEND_SELECTED_UPSELL.includes("{extra_time}"));
  assert.ok(EXTEND_SELECTED_UPSELL.includes("{vehicle}"));
  assert.ok(EXTEND_SELECTED_UPSELL.includes("{price}"));
  assert.ok(EXTEND_SELECTED_UPSELL.includes("{payment_link}"));
  assert.ok(EXTEND_SELECTED_UPSELL.includes("{weekly_price}"));
  assert.ok(EXTEND_SELECTED_UPSELL.includes("Reply STOP"));
});

test("render EXTEND_SELECTED_UPSELL fills all variables", () => {
  const msg = render(EXTEND_SELECTED_UPSELL, {
    extra_time:   "+3 days",
    vehicle:      "Camry 2012",
    price:        "165",
    payment_link: "https://www.slytrans.com/balance.html?test=1",
    weekly_price: "350",
  });
  assert.ok(msg.includes("+3 days"));
  assert.ok(msg.includes("Camry 2012"));
  assert.ok(msg.includes("$165"));
  assert.ok(msg.includes("$350"));
  assert.ok(msg.includes("https://www.slytrans.com/balance.html?test=1"));
  assert.ok(!msg.includes("{"));
});

// ─── Late return templates ────────────────────────────────────────────────────

test("LATE_WARNING_30MIN references return_time and buffered_time", () => {
  assert.ok(LATE_WARNING_30MIN.includes("{return_time}"));
  assert.ok(LATE_WARNING_30MIN.includes("{buffered_time}"));
  assert.ok(LATE_WARNING_30MIN.includes("additional charges"));
});

test("LATE_AT_RETURN_TIME mentions EXTEND and buffered_time", () => {
  assert.ok(LATE_AT_RETURN_TIME.includes("{customer_name}"));
  assert.ok(LATE_AT_RETURN_TIME.includes("{return_time}"));
  assert.ok(LATE_AT_RETURN_TIME.includes("{buffered_time}"));
  assert.ok(LATE_AT_RETURN_TIME.includes("EXTEND"));
});

test("LATE_GRACE_EXPIRED mentions late fees and buffered_time", () => {
  assert.ok(LATE_GRACE_EXPIRED.includes("{customer_name}"));
  assert.ok(LATE_GRACE_EXPIRED.includes("{return_time}"));
  assert.ok(LATE_GRACE_EXPIRED.includes("{buffered_time}"));
  assert.ok(LATE_GRACE_EXPIRED.includes("Late fees"));
});

test("LATE_FEE_APPLIED references late_fee amount", () => {
  assert.ok(LATE_FEE_APPLIED.includes("{late_fee}"));
  assert.ok(LATE_FEE_APPLIED.includes("late fee"));
});

test("render LATE_FEE_APPLIED fills late_fee", () => {
  const msg = render(LATE_FEE_APPLIED, { late_fee: "50" });
  assert.ok(msg.includes("$50"));
  assert.ok(!msg.includes("{late_fee}"));
});

// ─── Post-rental / retention templates ───────────────────────────────────────

test("POST_RENTAL_THANK_YOU mentions customer_name", () => {
  assert.ok(POST_RENTAL_THANK_YOU.includes("{customer_name}"));
  assert.ok(POST_RENTAL_THANK_YOU.includes("enjoyed"));
});

test("RETENTION_DAY_1 has expected copy", () => {
  assert.ok(RETENTION_DAY_1.includes("smoothly"));
});

test("RETENTION_DAY_7 invites return visit", () => {
  assert.ok(RETENTION_DAY_7.includes("another ride"));
});

test("RETENTION_DAY_30 invites return visit", () => {
  assert.ok(RETENTION_DAY_30.includes("ready again"));
});

// ─── TEMPLATES map ────────────────────────────────────────────────────────────

test("TEMPLATES map contains all expected keys", () => {
  const expectedKeys = [
    "application_received", "application_approved", "application_denied",
    "waitlist_joined", "waitlist_approved", "waitlist_booking_reminder", "waitlist_declined",
    "booking_confirmed",
    "unpaid_reminder_24h", "unpaid_reminder_2h", "unpaid_reminder_final",
    "pickup_reminder_24h", "pickup_reminder_2h", "pickup_reminder_30min",
    "active_rental_mid", "active_rental_1h_before_end", "active_rental_15min_before_end",
    "extend_unavailable", "extend_limited", "extend_options_economy",
    "extend_flexible_prompt", "extend_invalid_input",
    "extend_selected", "extend_selected_upsell",
    "extend_confirmed_economy", "extend_payment_pending",
    "late_warning_30min", "late_at_return_time", "late_grace_expired", "late_fee_applied",
    "post_rental_thank_you",
    "retention_day_1", "retention_day_3", "retention_day_7", "retention_day_14", "retention_day_30",
  ];
  for (const key of expectedKeys) {
    assert.ok(key in TEMPLATES, `Missing TEMPLATES key: ${key}`);
    assert.equal(typeof TEMPLATES[key], "string", `TEMPLATES.${key} should be a string`);
    assert.ok(TEMPLATES[key].length > 0, `TEMPLATES.${key} should not be empty`);
  }
});

test("all TEMPLATES values are non-empty strings", () => {
  for (const [key, val] of Object.entries(TEMPLATES)) {
    assert.equal(typeof val, "string", `TEMPLATES.${key} should be a string`);
    assert.ok(val.trim().length > 0, `TEMPLATES.${key} should not be blank`);
  }
});

test("all TEMPLATES values include Reply STOP opt-out", () => {
  for (const [key, val] of Object.entries(TEMPLATES)) {
    assert.ok(val.includes("Reply STOP"), `TEMPLATES.${key} missing opt-out instruction`);
  }
});
