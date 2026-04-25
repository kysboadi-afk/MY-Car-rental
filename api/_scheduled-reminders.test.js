// api/_scheduled-reminders.test.js
// Unit tests for processAutoCompletions — the scheduled-reminders function
// that automatically transitions active_rental bookings to completed_rental
// once they are past their scheduled return time by AUTO_COMPLETE_HOURS (4h).
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment ─────────────────────────────────────────────────────────────
process.env.GITHUB_TOKEN       = "test-github-token";
process.env.GITHUB_REPO        = "kysboadi-afk/SLY-RIDES";

// ─── Mock state ──────────────────────────────────────────────────────────────
const updatedBookings = [];  // records calls to updateBooking
const customerCalls   = [];  // records calls to autoUpsertCustomer
const bookingCalls    = [];  // records calls to autoUpsertBooking
const retryApplies    = [];  // records apply callbacks from updateJsonFileWithRetry
const smsCalls        = [];  // records outbound SMS calls

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings:   async () => ({ data: {}, sha: "sha1" }),
    saveBookings:   async () => {},
    normalizePhone: (p) => p,
    updateBooking:  async (vehicleId, id, updates) => {
      updatedBookings.push({ vehicleId, id, updates });
      return true;
    },
  },
});

mock.module("./_booking-automation.js", {
  namedExports: {
    autoUpsertCustomer:          async (b, countStats) => { customerCalls.push({ ...b, countStats }); },
    autoUpsertBooking:           async (b)             => { bookingCalls.push({ ...b }); },
    autoCreateRevenueRecord:     async () => {},
    autoCreateBlockedDate:       async () => {},
    autoActivateIfPickupArrived: async () => false,
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      retryApplies.push({ message });
      await save(data, sha, message);
    },
  },
});

// Mock everything else that scheduled-reminders.js imports
mock.module("./_textmagic.js", {
  namedExports: {
    sendSms: async (phone, body) => {
      smsCalls.push({ phone, body });
    },
  },
});
mock.module("./_contacts.js", {
  namedExports: { upsertContact: async () => {} },
});
mock.module("./_pricing.js", {
  namedExports: { CARS: {} },
});

mock.module("./_settings.js", {
  namedExports: { loadBooleanSetting: async () => true },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    render: (t) => t,
    DEFAULT_LOCATION:                "Los Angeles, CA",
    UNPAID_REMINDER_24H:             "",
    UNPAID_REMINDER_2H:              "",
    UNPAID_REMINDER_FINAL:           "",
    PICKUP_REMINDER_24H:             "",
    LATE_WARNING_30MIN:              "",
    LATE_AT_RETURN_TIME:             "",
    LATE_GRACE_EXPIRED:              "",
    LATE_FEE_APPLIED:                "",
    POST_RENTAL_THANK_YOU:           "",
    RETENTION_DAY_7:                 "",
    BOOKING_CONFIRMED:               "",
    EXTEND_UNAVAILABLE:              "",
    EXTEND_LIMITED:                  "",
    EXTEND_CONFIRMED:                "",
  },
});

// Stub the stripe-webhook pipeline functions that scheduled-reminders now imports
// for its auto-repair path.  Tests in this file only exercise processAutoCompletions
// which never calls these functions, so plain no-ops are sufficient.
mock.module("./stripe-webhook.js", {
  namedExports: {
    saveWebhookBookingRecord:      async () => {},
    blockBookedDates:              async () => {},
    markVehicleUnavailable:        async () => {},
    sendWebhookNotificationEmails: async () => {},
    mapVehicleId:                  (meta = {}) => meta.vehicle_id || "camry",
  },
});

// Stub Supabase so sms_logs queries are no-ops in tests.
// getSupabaseAdmin returns null → isSmsLogged returns false → smsSentAt gates behaviour.
mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => null,
  },
});

// GitHub API stubs (for booked-dates and fleet-status reads/writes)
global.fetch = async (url, opts) => {
  try {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.hostname === "api.github.com") {
      // Track PUT calls so tests can assert on fleet-status writes
      if (opts && opts.method === "PUT") {
        retryApplies; // already tracked via updateJsonFileWithRetry mock
      }
      return {
        ok: true,
        json: async () => ({
          content: Buffer.from(JSON.stringify({})).toString("base64"),
          sha: "sha1",
        }),
        text: async () => "",
      };
    }
  } catch { /* not a valid URL — fall through */ }
  return { ok: false, text: async () => "not found" };
};

const { processAutoCompletions, processActiveRentals } = await import("./scheduled-reminders.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function reset() {
  updatedBookings.length = 0;
  customerCalls.length   = 0;
  bookingCalls.length    = 0;
  retryApplies.length    = 0;
  smsCalls.length        = 0;
}

/** Returns a Date that is `hoursAgo` hours before `now`. */
function hoursAgo(now, hoursAgo) {
  return new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
}

/** Formats a Date as YYYY-MM-DD. */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Formats a Date as "H:MM AM/PM". */
function fmtTime(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function makeBooking(overrides = {}) {
  return {
    bookingId:  "bk-test-001",
    vehicleId:  "camry",
    name:       "Test Renter",
    phone:      "+13105550001",
    email:      "test@example.com",
    status:     "active_rental",
    pickupDate: "2026-03-20",
    pickupTime: "10:00 AM",
    returnDate: "2026-03-22",
    returnTime: "10:00 AM",
    amountPaid: 150,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

test("processAutoCompletions: does not touch bookings whose return time has not passed", async () => {
  reset();
  const now = new Date("2026-03-22T09:00:00"); // before 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "No booking should be auto-completed");
});

test("processAutoCompletions: does not touch bookings that are only 1 hour overdue", async () => {
  reset();
  const now = new Date("2026-03-22T11:00:00"); // 1h past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "Not yet 4 hours overdue — should not auto-complete");
});

test("processAutoCompletions: does not touch bookings that are 3.9 hours overdue", async () => {
  reset();
  const now = new Date("2026-03-22T13:54:00"); // 3h54m past return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "3.9 hours overdue — still below 4h threshold");
});

test("processAutoCompletions: respects 24-hour return times with seconds", async () => {
  reset();
  const now = new Date("2026-03-22T04:30:00"); // before 10:00:00 return
  const allBookings = { camry: [makeBooking({ returnTime: "10:00:00" })] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "HH:MM:SS return times must not default to midnight");
});

test("processAutoCompletions: auto-completes booking that is 4+ hours past return time", async () => {
  reset();
  const now = new Date("2026-03-22T14:05:00"); // 4h5m past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 1, "Booking should be auto-completed");
  const update = updatedBookings[0];
  assert.equal(update.vehicleId, "camry");
  assert.equal(update.id, "bk-test-001");
  assert.equal(update.updates.status, "completed_rental");
  assert.ok(update.updates.completedAt, "completedAt must be set");
  assert.ok(update.updates.updatedAt, "updatedAt must be set");
});

test("processAutoCompletions: sets completedAt to now.toISOString()", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings[0].updates.completedAt, now.toISOString());
});

test("processAutoCompletions: calls autoUpsertCustomer with countStats=true", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(customerCalls.length, 1);
  assert.equal(customerCalls[0].countStats, true, "countStats must be true to increment totals");
});

test("processAutoCompletions: calls autoUpsertBooking", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  assert.equal(bookingCalls.length, 1);
  assert.equal(bookingCalls[0].status, "completed_rental");
});

test("processAutoCompletions: skips already-completed bookings", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = {
    camry: [makeBooking({ status: "completed_rental", completedAt: "2026-03-22T12:00:00.000Z" })],
  };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0, "Already completed bookings must be skipped");
});

test("processAutoCompletions: skips cancelled bookings", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = { camry: [makeBooking({ status: "cancelled_rental" })] };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 0);
});

test("processAutoCompletions: handles multiple vehicles independently", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00"); // 5h past 10:00 AM return
  const allBookings = {
    camry:     [makeBooking({ bookingId: "bk-camry",     vehicleId: "camry" })],
    slingshot: [makeBooking({ bookingId: "bk-slingshot", vehicleId: "slingshot",
                              returnDate: "2026-03-22", returnTime: "1:00 PM" })], // only 2h overdue
  };

  await processAutoCompletions(allBookings, now);

  assert.equal(updatedBookings.length, 1, "Only camry should be auto-completed");
  assert.equal(updatedBookings[0].vehicleId, "camry");
});

test("processAutoCompletions: removes booking from booked-dates.json", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  const unblockCall = retryApplies.find((c) => c.message && c.message.includes("unblock"));
  assert.ok(unblockCall, "booked-dates.json unblock must be attempted");
});

test("processAutoCompletions: no-ops when GITHUB_TOKEN is absent", async () => {
  reset();
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const now = new Date("2026-03-22T15:00:00");
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  process.env.GITHUB_TOKEN = saved;
  assert.equal(updatedBookings.length, 0, "Without GITHUB_TOKEN, nothing should be updated");
});

test("processAutoCompletions: availability is now bookings-driven — no fleet-status.json write needed", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00"); // 5h past 10:00 AM return
  const allBookings = { camry: [makeBooking()] };

  await processAutoCompletions(allBookings, now);

  // The booking status update to "completed_rental" is the availability signal —
  // fleet-status.json is no longer written.  markVehicleAvailable is a no-op.
  const restoreCall = retryApplies.find((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCall, undefined, "fleet-status.json must NOT be written — availability is now bookings-driven");
});

test("processAutoCompletions: does NOT restore fleet-status when another active_rental remains", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = {
    camry: [
      makeBooking({ bookingId: "bk-001", returnDate: "2026-03-22", returnTime: "10:00 AM" }),
      makeBooking({ bookingId: "bk-002", status: "active_rental" }), // still active
    ],
  };

  await processAutoCompletions(allBookings, now);

  const restoreCall = retryApplies.find((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCall, undefined, "Must NOT write fleet-status.json — availability is now bookings-driven");
});

test("processAutoCompletions: fleet-status not written even when completing the only active_rental", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  // One active_rental overdue, one completed_rental (already done)
  const allBookings = {
    camry: [
      makeBooking({ bookingId: "bk-current", status: "active_rental" }),
      makeBooking({ bookingId: "bk-old",     status: "completed_rental" }),
    ],
  };

  await processAutoCompletions(allBookings, now);

  // fleet-status.json is not involved — the booking status change drives availability
  const restoreCall = retryApplies.find((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCall, undefined, "fleet-status.json must NOT be written — availability is now bookings-driven");
});

test("processAutoCompletions: fleet-status not written independently per vehicle (no-op)", async () => {
  reset();
  const now = new Date("2026-03-22T15:00:00");
  const allBookings = {
    camry:     [makeBooking({ bookingId: "bk-camry",     vehicleId: "camry" })],
    camry2013: [makeBooking({ bookingId: "bk-c2013",     vehicleId: "camry2013" })],
  };

  await processAutoCompletions(allBookings, now);

  // Both completions drive availability via the bookings table, not fleet-status.json
  const restoreCalls = retryApplies.filter((c) => c.message && c.message.includes("mark") && c.message.includes("available"));
  assert.equal(restoreCalls.length, 0, "fleet-status.json must NOT be written for any vehicle");
});

test("processActiveRentals: sends ended at return_datetime", async () => {
  reset();
  const now = new Date("2026-06-15T08:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_at_return"), true, "ended should be sent at 08:00 for 08:00 return");
});

test("processActiveRentals: sends grace at return_datetime +1h", async () => {
  reset();
  const now = new Date("2026-06-15T09:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_grace_expired"), true, "grace should be sent at 09:00 for 08:00 return");
});

test("processActiveRentals: sends late fee at return_datetime +2h", async () => {
  reset();
  const now = new Date("2026-06-15T10:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_fee_pending"), true, "late-fee flow should start at 10:00 for 08:00 return");
});

test("processActiveRentals: sends 30-min warning before return", async () => {
  reset();
  // 8:00 AM return — cron fires at 7:40 AM (20 min before, inside 15–30 min window)
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_warning_30min"), true,
    "30-min warning should fire when minutesUntilReturn is between 15 and 30");
});

test("processActiveRentals: does NOT send 30-min warning outside window", async () => {
  reset();
  // 8:00 AM return — cron fires at 7:00 AM (60 min before, outside 15–30 min window)
  const now = new Date("2026-06-15T07:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_warning_30min"), false,
    "30-min warning must NOT fire 60 min before return");
});

test("processActiveRentals: does NOT send 30-min warning when already sent (smsSentAt flag)", async () => {
  reset();
  const now = new Date("2026-06-15T07:40:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      returnDate: "2026-06-15",
      returnTime: "8:00 AM",
      smsSentAt:  { late_warning_30min: "2026-06-15T07:35:00.000Z" },
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_warning_30min"), false,
    "30-min warning must not be resent when smsSentAt flag is already set");
});

test("processActiveRentals: does not send mid-rental EXTEND invitation", async () => {
  reset();
  // Simulate cron running 6 hours before return — old active_mid trigger point
  const now = new Date("2026-06-15T02:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({ returnDate: "2026-06-15", returnTime: "8:00 AM" })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "active_mid"), false,
    "mid-rental EXTEND SMS must no longer be sent (removed to reduce noise)");
  assert.equal(smsCalls.length, 0, "No SMS should be sent 6 hours before return");
});

test("processActiveRentals: extension awareness — fires return-time SMS for new return_date after extension", async () => {
  reset();
  // Booking was extended: new returnDate is 2026-06-16 (one day later).
  // smsSentAt has late_at_return set from the OLD return date (2026-06-15),
  // but because the key is the same string it would normally block the send.
  // With sms_logs disabled (null Supabase) the smsSentAt flag still blocks —
  // but this test verifies that clearing smsSentAt (simulating a fresh booking
  // after extension) allows the new return-time SMS to fire correctly.
  const now = new Date("2026-06-16T08:00:00-07:00");
  const allBookings = {
    camry: [makeBooking({
      returnDate: "2026-06-16",
      returnTime: "8:00 AM",
      // smsSentAt does NOT have late_at_return set (extension cleared it)
      smsSentAt:  {},
    })],
  };
  const sentMarks = [];

  await processActiveRentals(allBookings, now, sentMarks);

  assert.equal(sentMarks.some((m) => m.key === "late_at_return"), true,
    "late_at_return should fire for the new return_date after extension");
});
