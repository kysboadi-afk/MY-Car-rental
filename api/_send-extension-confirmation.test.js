import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.TEXTMAGIC_USERNAME = "tm_user";
process.env.TEXTMAGIC_API_KEY = "tm_key";

const bookingsStore = {};
const paymentIntents = {};
const sentSmsCalls = [];
const sentEmailCalls = [];

mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      retrieve: async (id) => {
        if (!paymentIntents[id]) throw new Error(`unknown PI ${id}`);
        return { ...paymentIntents[id] };
      },
    };
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({ data: JSON.parse(JSON.stringify(bookingsStore)), sha: "sha1" }),
    saveBookings: async (data) => {
      for (const key of Object.keys(bookingsStore)) delete bookingsStore[key];
      Object.assign(bookingsStore, JSON.parse(JSON.stringify(data)));
    },
  },
});

mock.module("./_extension-email.js", {
  namedExports: {
    sendExtensionConfirmationEmails: async (payload) => {
      sentEmailCalls.push(payload);
    },
  },
});

mock.module("./_booking-automation.js", {
  namedExports: {
    autoUpsertBooking: async () => {},
    autoCreateBlockedDate: async () => {},
    extendBlockedDateForBooking: async () => {},
    parseTime12h: () => "10:00:00",
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => null,
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save }) => {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha);
    },
  },
});

mock.module("./_time.js", {
  namedExports: {
    normalizeClockTime: (value) => value || "",
    DEFAULT_RETURN_TIME: "10:00 AM",
  },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    EXTEND_CONFIRMED_ECONOMY: "ext-template",
    render: (_template, vars) => `return:${vars.return_date}|time:${vars.return_time || ""}`,
  },
});

mock.module("./_sms-log.js", {
  namedExports: {
    sendDedupedSms: async (payload) => {
      sentSmsCalls.push(payload);
      return true;
    },
  },
});

const { default: handler } = await import("./send-extension-confirmation.js");

function makeReq(paymentIntentId) {
  return {
    method: "POST",
    headers: { origin: "https://slycarrentals.com" },
    body: { paymentIntentId },
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; return this; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function resetState() {
  for (const key of Object.keys(bookingsStore)) delete bookingsStore[key];
  for (const key of Object.keys(paymentIntents)) delete paymentIntents[key];
  sentSmsCalls.length = 0;
  sentEmailCalls.length = 0;
}

test("send-extension-confirmation sends deduped extension SMS for booking in bookings.json", async () => {
  resetState();
  bookingsStore.camry = [{
    bookingId: "bk_ext_1",
    phone: "+13105550100",
    email: "renter@example.com",
    name: "Test Renter",
    pickupDate: "2026-05-01",
    pickupTime: "10:00 AM",
    returnDate: "2026-05-03",
    returnTime: "5:00 PM",
    extensionPendingPayment: {
      newReturnDate: "2026-05-05",
      newReturnTime: "5:00 PM",
      label: "+2 days",
    },
  }];
  paymentIntents.pi_ext_1 = {
    id: "pi_ext_1",
    status: "succeeded",
    metadata: {
      type: "rental_extension",
      booking_id: "bk_ext_1",
      vehicle_id: "camry",
      renter_name: "Test Renter",
      renter_email: "renter@example.com",
      renter_phone: "+13105550100",
      extension_label: "+2 days",
      new_return_date: "2026-05-05",
      previous_return_date: "2026-05-03",
      original_pickup_date: "2026-05-01",
      original_pickup_time: "10:00 AM",
    },
  };

  const res = makeRes();
  await handler(makeReq("pi_ext_1"), res);

  assert.equal(res._status, 200);
  assert.equal(sentEmailCalls.length, 1, "confirmation email should still be sent");
  assert.equal(sentSmsCalls.length, 1, "extension SMS should be sent from client confirmation path");
  assert.deepEqual(sentSmsCalls[0], {
    bookingId: "bk_ext_1",
    templateKey: "extend_confirmed_economy",
    phone: "+13105550100",
    body: "return:2026-05-05|time:5:00 PM",
    returnDateAtSend: "2026-05-05",
  });
});

test("send-extension-confirmation sends deduped extension SMS from metadata when booking is missing", async () => {
  resetState();
  paymentIntents.pi_ext_missing = {
    id: "pi_ext_missing",
    status: "succeeded",
    metadata: {
      payment_type: "rental_extension",
      booking_id: "bk_missing",
      vehicle_id: "camry",
      renter_name: "Missing Booking",
      renter_email: "missing@example.com",
      renter_phone: "+13105550199",
      extension_label: "+1 day",
      new_return_date: "2026-05-07",
      previous_return_date: "2026-05-06",
      original_pickup_date: "2026-05-01",
      original_pickup_time: "10:00 AM",
    },
  };

  const res = makeRes();
  await handler(makeReq("pi_ext_missing"), res);

  assert.equal(res._status, 200);
  assert.equal(sentEmailCalls.length, 1, "fallback email should still be sent");
  assert.equal(sentSmsCalls.length, 1, "fallback SMS should be sent from metadata");
  assert.deepEqual(sentSmsCalls[0], {
    bookingId: "bk_missing",
    templateKey: "extend_confirmed_economy",
    phone: "+13105550199",
    body: "return:2026-05-07|time:10:00 AM",
    returnDateAtSend: "2026-05-07",
  });
});

test("send-extension-confirmation still attempts extension SMS when provider env vars are missing", async () => {
  resetState();
  const priorUser = process.env.TEXTMAGIC_USERNAME;
  const priorKey = process.env.TEXTMAGIC_API_KEY;
  delete process.env.TEXTMAGIC_USERNAME;
  delete process.env.TEXTMAGIC_API_KEY;
  try {
    bookingsStore.camry = [{
      bookingId: "bk_ext_2",
      phone: "+13105550101",
      email: "renter2@example.com",
      name: "Test Renter Two",
      pickupDate: "2026-05-01",
      pickupTime: "10:00 AM",
      returnDate: "2026-05-03",
      returnTime: "5:00 PM",
      extensionPendingPayment: {
        newReturnDate: "2026-05-06",
        newReturnTime: "5:00 PM",
        label: "+3 days",
      },
    }];
    paymentIntents.pi_ext_2 = {
      id: "pi_ext_2",
      status: "succeeded",
      metadata: {
        type: "rental_extension",
        booking_id: "bk_ext_2",
        vehicle_id: "camry",
        renter_name: "Test Renter Two",
        renter_email: "renter2@example.com",
        renter_phone: "+13105550101",
        extension_label: "+3 days",
        new_return_date: "2026-05-06",
        previous_return_date: "2026-05-03",
        original_pickup_date: "2026-05-01",
        original_pickup_time: "10:00 AM",
      },
    };

    const res = makeRes();
    await handler(makeReq("pi_ext_2"), res);

    assert.equal(res._status, 200);
    assert.equal(sentSmsCalls.length, 1, "SMS attempt should still be triggered for visibility/logging");
  } finally {
    process.env.TEXTMAGIC_USERNAME = priorUser;
    process.env.TEXTMAGIC_API_KEY = priorKey;
  }
});
