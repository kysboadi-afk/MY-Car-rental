import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.TEXTMAGIC_USERNAME = "tm_user";
process.env.TEXTMAGIC_API_KEY = "tm_key";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";

const smsCalls = [];
let bookingsData = {};
let savedBookings = null;
let createdPaymentIntent = null;

mock.module("stripe", {
  defaultExport: class FakeStripe {
    constructor() {}
    paymentIntents = {
      create: async (params) => {
        createdPaymentIntent = params;
        return {
          id: "pi_ext_test",
          client_secret: "cs_ext_test",
        };
      },
    };
  },
});

mock.module("./_sms-dispatcher.js", {
  namedExports: {
    dispatchSms: async (payload) => {
      smsCalls.push(payload);
      return true;
    },
  },
});

mock.module("./_sms-templates.js", {
  namedExports: {
    render: (template, vars = {}) =>
      [
        `template:${template}`,
        vars.payment_link ? `link:${vars.payment_link}` : null,
        vars.extra_time ? `extra:${vars.extra_time}` : null,
      ].filter(Boolean).join("|"),
    DEFAULT_LOCATION: "Los Angeles, CA",
    EXTEND_UNAVAILABLE: "EXTEND_UNAVAILABLE",
    EXTEND_LIMITED: "EXTEND_LIMITED",
    EXTEND_FLEXIBLE_PROMPT: "EXTEND_FLEXIBLE_PROMPT",
    EXTEND_INVALID_INPUT: "EXTEND_INVALID_INPUT",
    EXTEND_SELECTED: "EXTEND_SELECTED",
    EXTEND_SELECTED_UPSELL: "EXTEND_SELECTED_UPSELL",
    EXTEND_PAYMENT_PENDING: "EXTEND_PAYMENT_PENDING",
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({
      data: JSON.parse(JSON.stringify(bookingsData)),
      sha: "sha1",
    }),
    saveBookings: async (data) => {
      savedBookings = JSON.parse(JSON.stringify(data));
      bookingsData = JSON.parse(JSON.stringify(data));
    },
    normalizePhone: (phone) => String(phone || "").replace(/[^\d+]/g, ""),
  },
});

mock.module("./_pricing.js", {
  namedExports: {
    CARS: {
      camry: { pricePerDay: 55, weekly: 350, biweekly: 650, monthly: 1300 },
    },
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => null,
  },
});

mock.module("./_link-validator.js", {
  namedExports: {
    PAGE_URLS: {
      balance: "https://www.slytrans.com/balance.html",
      cars: "https://www.slytrans.com/car.html",
    },
    validateLink: async (url) => ({
      ok: true,
      status: 200,
      fallbackUsed: false,
      url,
    }),
  },
});

mock.module("./_final-return-date.js", {
  namedExports: {
    computeFinalReturnDate: async (_sb, _bookingId, returnDate, returnTime) => ({
      date: returnDate,
      time: returnTime,
    }),
  },
});

mock.module("./_time.js", {
  namedExports: {
    formatTime12h: (value) => value,
  },
});

const { default: handler } = await import("./receive-textmagic-sms.js");

function resetState() {
  smsCalls.length = 0;
  bookingsData = {};
  savedBookings = null;
  createdPaymentIntent = null;
}

function makeReq(rawBody, contentType = "application/x-www-form-urlencoded") {
  const req = Readable.from([Buffer.from(rawBody)]);
  req.method = "POST";
  req.headers = { "content-type": contentType };
  return req;
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(key, value) {
      this._headers[key] = value;
      return this;
    },
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    send(body) {
      this._body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

test("receive-textmagic-sms: accepts form-encoded EXTEND reply and sends prompt", async () => {
  resetState();
  bookingsData = {
    camry: [{
      bookingId: "bk_ext_1",
      phone: "+13105550100",
      status: "active_rental",
      vehicleName: "Camry 2012",
      returnDate: "2026-05-20",
      returnTime: "10:00 AM",
    }],
  };

  const res = makeRes();
  await handler(makeReq("from=%2B13105550100&text=extend"), res);

  assert.equal(res._status, 200);
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].templateKey, "extend_flexible_prompt");
  assert.equal(savedBookings.camry[0].extendPending, true);
});

test("receive-textmagic-sms: accepts form-encoded day selection and returns payment link", async () => {
  resetState();
  bookingsData = {
    camry: [{
      bookingId: "bk_ext_2",
      phone: "+13105550100",
      status: "active_rental",
      vehicleName: "Camry 2012",
      returnDate: "2026-05-20",
      returnTime: "10:00 AM",
      extendPending: true,
      extendAvailMinutes: Infinity,
    }],
  };

  const res = makeRes();
  await handler(makeReq("from=%2B13105550100&text=3+days"), res);

  assert.equal(res._status, 200);
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].templateKey, "extend_selected_upsell");
  assert.match(smsCalls[0].body, /https:\/\/www\.slytrans\.com\/balance\.html\?ext=1&cs=cs_ext_test&piId=pi_ext_test/);
  assert.equal(createdPaymentIntent?.metadata?.booking_id, "bk_ext_2");
  assert.equal(savedBookings.camry[0].extendPending, false);
  assert.equal(savedBookings.camry[0].extensionPendingPayment.paymentLink, "https://www.slytrans.com/balance.html?ext=1&cs=cs_ext_test&piId=pi_ext_test");
});
