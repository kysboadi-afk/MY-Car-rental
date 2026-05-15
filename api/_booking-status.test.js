import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isIncompleteCheckoutAppStatus,
  toAppBookingStatus,
  toDbBookingStatus,
} from "./_booking-status.js";

test("toDbBookingStatus maps reserved_unpaid to reserved", () => {
  assert.equal(toDbBookingStatus("reserved_unpaid"), "reserved");
});

test("toAppBookingStatus keeps explicit checkout lifecycle states separate", () => {
  assert.equal(toAppBookingStatus("pending_checkout"), "pending_checkout");
  assert.equal(toAppBookingStatus("upload_failed"), "upload_failed");
  assert.equal(toAppBookingStatus("payment_failed"), "payment_failed");
  assert.equal(toAppBookingStatus("abandoned_checkout"), "abandoned_checkout");
});

test("legacy pending rows map to pending_checkout in the app layer", () => {
  assert.equal(toAppBookingStatus("pending"), "pending_checkout");
});

test("isIncompleteCheckoutAppStatus only flags incomplete checkout lifecycle states", () => {
  assert.equal(isIncompleteCheckoutAppStatus("pending_checkout"), true);
  assert.equal(isIncompleteCheckoutAppStatus("upload_failed"), true);
  assert.equal(isIncompleteCheckoutAppStatus("payment_failed"), true);
  assert.equal(isIncompleteCheckoutAppStatus("abandoned_checkout"), true);
  assert.equal(isIncompleteCheckoutAppStatus("reserved_unpaid"), false);
  assert.equal(isIncompleteCheckoutAppStatus("booked_paid"), false);
});
