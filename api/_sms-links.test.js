import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDashboardExtendLink,
  buildRenterPortalLinks,
} from "./_sms-links.js";
import { verifyManageToken } from "./_manage-booking-token.js";

test("buildRenterPortalLinks creates a tokenized manage link when only bookingId is provided", () => {
  const links = buildRenterPortalLinks({ bookingId: "bk-dashboard-001", vehicleId: "camry" });

  assert.match(links.manageLink, /^https:\/\/slycarrentals\.com\/manage-booking\.html\?t=/);
  const token = new URL(links.manageLink).searchParams.get("t");
  assert.equal(verifyManageToken(token), "bk-dashboard-001");
  assert.equal(links.primaryLink, links.manageLink);
});

test("buildDashboardExtendLink routes extension entry through manage-booking when bookingId is present", () => {
  const link = buildDashboardExtendLink({ bookingId: "bk-extend-001", vehicleId: "camry" });

  assert.match(link, /^https:\/\/slycarrentals\.com\/manage-booking\.html\?t=/);
  const token = new URL(link).searchParams.get("t");
  assert.equal(verifyManageToken(token), "bk-extend-001");
});

test("buildDashboardExtendLink falls back to the legacy vehicle link without booking context", () => {
  const link = buildDashboardExtendLink({ vehicleId: "camry" });

  assert.equal(link, "https://slycarrentals.com/car.html?vehicle=camry&extend=1");
});

test("buildRenterPortalLinks exposes a tokenized secondary manage link for dual-domain rollout", () => {
  const links = buildRenterPortalLinks({ bookingId: "bk-dashboard-002", vehicleId: "camry" });

  assert.match(links.manageLinkSecondary, /^https:\/\/slytrans\.com\/manage-booking\.html\?t=/);
  const secondaryToken = new URL(links.manageLinkSecondary).searchParams.get("t");
  assert.equal(verifyManageToken(secondaryToken), "bk-dashboard-002");
});

test("buildRenterPortalLinks honors SMS_LINK_BASE_ORIGIN override", () => {
  process.env.SMS_LINK_BASE_ORIGIN = "https://slytrans.com";
  try {
    const links = buildRenterPortalLinks({ bookingId: "bk-dashboard-003", vehicleId: "camry" });
    assert.match(links.manageLink, /^https:\/\/slytrans\.com\/manage-booking\.html\?t=/);
    assert.match(links.manageLinkSecondary, /^https:\/\/slycarrentals\.com\/manage-booking\.html\?t=/);
  } finally {
    delete process.env.SMS_LINK_BASE_ORIGIN;
  }
});
