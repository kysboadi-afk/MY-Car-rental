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

test("buildDashboardExtendLink normalizes legacy/display vehicle references", () => {
  const legacyLink = buildDashboardExtendLink({ vehicleId: "Camry 2013 SE" });
  const slugLink = buildDashboardExtendLink({ vehicleId: "camry-2013-se" });

  assert.equal(legacyLink, "https://slycarrentals.com/car.html?vehicle=camry2013&extend=1");
  assert.equal(slugLink, "https://slycarrentals.com/car.html?vehicle=camry2013&extend=1");
});
