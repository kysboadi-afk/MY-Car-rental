// api/_extension-helpers.test.js
// Unit tests for parseDaysFromMessage and computeEconomyExtensionPriceDays
// exported from receive-textmagic-sms.js.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Module mocks (satisfy all imports of receive-textmagic-sms.js) ─────────
mock.module("./stripe-webhook.js", { namedExports: {
  saveWebhookBookingRecord:      async () => {},
  blockBookedDates:              async () => {},
  markVehicleUnavailable:        async () => {},
  sendWebhookNotificationEmails: async () => {},
  mapVehicleId:                  (m = {}) => m.vehicle_id || "camry",
}});
mock.module("./_supabase.js",   { namedExports: { getSupabaseAdmin: () => null } });
mock.module("./_textmagic.js",  { namedExports: { sendSms: async () => true } });
mock.module("./_bookings.js",   { namedExports: {
  loadBookings:   async () => ({ data: {}, sha: null }),
  saveBookings:   async () => {},
  normalizePhone: (p) => p,
}});
mock.module("./_sms-templates.js", { namedExports: {
  render:               (t) => t,
  DEFAULT_LOCATION:     "Los Angeles, CA",
  EXTEND_UNAVAILABLE:   "",
  EXTEND_LIMITED:       "",
  EXTEND_OPTIONS_SLINGSHOT: "",
  EXTEND_FLEXIBLE_PROMPT:   "",
  EXTEND_INVALID_INPUT:     "",
  EXTEND_SELECTED:          "",
  EXTEND_SELECTED_UPSELL:   "",
  EXTEND_PAYMENT_PENDING:   "",
}});

const { parseDaysFromMessage, computeEconomyExtensionPriceDays } =
  await import("./receive-textmagic-sms.js");

// ── parseDaysFromMessage ──────────────────────────────────────────────────────

test("parseDaysFromMessage: plain integer", () => {
  assert.equal(parseDaysFromMessage("3"),  3);
  assert.equal(parseDaysFromMessage("7"),  7);
  assert.equal(parseDaysFromMessage("14"), 14);
  assert.equal(parseDaysFromMessage("30"), 30);
});

test("parseDaysFromMessage: N days", () => {
  assert.equal(parseDaysFromMessage("3 days"),  3);
  assert.equal(parseDaysFromMessage("3 day"),   3);
  assert.equal(parseDaysFromMessage("14 days"), 14);
  assert.equal(parseDaysFromMessage("1 day"),   1);
});

test("parseDaysFromMessage: N weeks", () => {
  assert.equal(parseDaysFromMessage("1 week"),  7);
  assert.equal(parseDaysFromMessage("2 weeks"), 14);
  assert.equal(parseDaysFromMessage("4 weeks"), 28);
});

test("parseDaysFromMessage: bare 'week'", () => {
  assert.equal(parseDaysFromMessage("week"), 7);
});

test("parseDaysFromMessage: N months", () => {
  assert.equal(parseDaysFromMessage("1 month"),  30);
  assert.equal(parseDaysFromMessage("2 months"), 60);
});

test("parseDaysFromMessage: bare 'month'", () => {
  assert.equal(parseDaysFromMessage("month"), 30);
});

test("parseDaysFromMessage: case insensitive", () => {
  assert.equal(parseDaysFromMessage("MONTH"),   30);
  assert.equal(parseDaysFromMessage("2 WEEKS"), 14);
  assert.equal(parseDaysFromMessage("3 Days"),  3);
});

test("parseDaysFromMessage: invalid input → null", () => {
  assert.equal(parseDaysFromMessage("hello"),   null);
  assert.equal(parseDaysFromMessage("extend"),  null);
  assert.equal(parseDaysFromMessage("0"),       null);
  assert.equal(parseDaysFromMessage("0 days"),  null);
  assert.equal(parseDaysFromMessage(""),        null);
  assert.equal(parseDaysFromMessage(null),      null);
  assert.equal(parseDaysFromMessage(undefined), null);
  assert.equal(parseDaysFromMessage("-3"),      null);
});

test("parseDaysFromMessage: leading/trailing whitespace is trimmed", () => {
  assert.equal(parseDaysFromMessage("  7  "),        7);
  assert.equal(parseDaysFromMessage("  2 weeks  "),  14);
});

// ── computeEconomyExtensionPriceDays ─────────────────────────────────────────

const camryCar = { pricePerDay: 55, weekly: 350, biweekly: 650, monthly: 1300 };

test("computeEconomyExtensionPriceDays: 1–6 days → $55/day", () => {
  assert.equal(computeEconomyExtensionPriceDays(1, camryCar),  55);
  assert.equal(computeEconomyExtensionPriceDays(3, camryCar),  165);
  assert.equal(computeEconomyExtensionPriceDays(6, camryCar),  330);
});

test("computeEconomyExtensionPriceDays: 7 days → $350 (weekly rate)", () => {
  assert.equal(computeEconomyExtensionPriceDays(7, camryCar), 350);
});

test("computeEconomyExtensionPriceDays: 14 days → $650 (biweekly rate)", () => {
  assert.equal(computeEconomyExtensionPriceDays(14, camryCar), 650);
});

test("computeEconomyExtensionPriceDays: 30 days → $1300 (monthly rate)", () => {
  assert.equal(computeEconomyExtensionPriceDays(30, camryCar), 1300);
});

test("computeEconomyExtensionPriceDays: 8 days → weekly + 1 day", () => {
  // 7 days = $350, +1 day = $55 → $405
  assert.equal(computeEconomyExtensionPriceDays(8, camryCar), 405);
});

test("computeEconomyExtensionPriceDays: 10 days → weekly + 3 days", () => {
  // 7 days = $350, +3 days = $165 → $515
  assert.equal(computeEconomyExtensionPriceDays(10, camryCar), 515);
});

test("computeEconomyExtensionPriceDays: 21 days → biweekly + 1 week", () => {
  // 14 days = $650, 7 days = $350 → $1000
  assert.equal(computeEconomyExtensionPriceDays(21, camryCar), 1000);
});

test("computeEconomyExtensionPriceDays: 60 days → 2 monthly periods", () => {
  // 2 × $1300 → $2600
  assert.equal(computeEconomyExtensionPriceDays(60, camryCar), 2600);
});

test("computeEconomyExtensionPriceDays: defaults to camry rates when no car given", () => {
  // camry defaults: pricePerDay:55, weekly:350, biweekly:650, monthly:1300
  assert.equal(computeEconomyExtensionPriceDays(7),  350);
  assert.equal(computeEconomyExtensionPriceDays(14), 650);
  assert.equal(computeEconomyExtensionPriceDays(30), 1300);
});

test("computeEconomyExtensionPriceDays: minimum 1 day (days=0 clamps to 1)", () => {
  assert.equal(computeEconomyExtensionPriceDays(0, camryCar), 55);
});
