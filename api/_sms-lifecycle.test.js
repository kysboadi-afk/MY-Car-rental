import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SMS_LIFECYCLE_EVENT,
  normalizeLifecycleEvent,
  buildLifecycleTemplateSequence,
  shouldSendBalanceCollectionReminder,
} from "./_sms-lifecycle.js";

test("normalizeLifecycleEvent maps reservation deposit to reservation lifecycle", () => {
  const event = normalizeLifecycleEvent({ paymentType: "reservation_deposit" });
  assert.equal(event, SMS_LIFECYCLE_EVENT.RESERVATION_DEPOSIT_PAID);
});

test("normalizeLifecycleEvent maps balance partial payment to partial lifecycle", () => {
  const event = normalizeLifecycleEvent({ paymentType: "balance_payment", isPartialPayment: true });
  assert.equal(event, SMS_LIFECYCLE_EVENT.BALANCE_PARTIAL_PAYMENT);
});

test("buildLifecycleTemplateSequence includes manage-booking and onboarding for deposit flow", () => {
  const seq = buildLifecycleTemplateSequence(SMS_LIFECYCLE_EVENT.RESERVATION_DEPOSIT_PAID);
  assert.deepEqual(seq, ["reservation_deposit_confirmed", "manage_booking_access", "booking_onboarding"]);
});

test("shouldSendBalanceCollectionReminder blocks reservation states", () => {
  assert.equal(shouldSendBalanceCollectionReminder("reserved"), false);
  assert.equal(shouldSendBalanceCollectionReminder("reserved_unpaid"), false);
  assert.equal(shouldSendBalanceCollectionReminder("active_rental"), true);
  assert.equal(shouldSendBalanceCollectionReminder("overdue"), true);
});
