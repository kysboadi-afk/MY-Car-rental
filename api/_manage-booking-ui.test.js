import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const scriptPath = path.join(process.cwd(), "manage-booking.js");

function makeJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function bootDashboard({ bookingPayload, ledgerPayload, agreementPayload, createIntentPayload, setupWindow, vehiclesPayload }) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="verify-state"></div>
    <input id="verify-identifier" />
    <div id="verify-msg"></div>
    <button id="btn-verify"></button>
    <div id="loading-state"></div>
    <div id="error-state"></div>
    <div id="error-msg"></div>
    <div id="main-content"></div>
    <div id="hero-payment-chip"></div>
    <div id="s-balance"></div>
    <div id="progress-paid-label"></div>
    <div id="progress-pct-label"></div>
    <div id="payment-progress-fill"></div>
    <div id="pay-balance-section" style="display:none"></div>
    <button id="btn-init-balance">Pay Balance</button>
    <button id="btn-open-partial" style="display:none"></button>
    <div id="paid-in-full-notice" style="display:none"></div>
    <div id="stat-balance-note"></div>
    <div id="action-msg-finance"></div>
    <div id="balance-payment-wrap" style="display:none"></div>
    <div id="balance-express-wrap" style="display:none"></div>
    <div id="balance-express-checkout"></div>
    <div id="balance-stripe-element"></div>
    <div id="balance-error" style="display:none"></div>
    <button id="btn-confirm-balance">Confirm Balance</button>
    <div id="partial-payment-section" style="display:none"></div>
    <input id="partial-amount-input" />
    <button id="partial-max-btn">Pay Max</button>
    <div id="partial-amount-preview"></div>
    <button id="btn-init-partial">Init Partial</button>
    <div id="partial-express-wrap" style="display:none"></div>
    <div id="partial-express-checkout"></div>
    <div id="partial-stripe-element" style="display:none"></div>
    <div id="partial-error" style="display:none"></div>
    <button id="btn-confirm-partial" style="display:none">Confirm Partial</button>
    <a id="extension-cta" href="#"></a>
    <div id="extension-status-pill"></div>
    <div id="extension-balance"></div>
    <div id="extension-overdue"></div>
    <div id="extension-balance-note"></div>
    <div id="extension-overdue-note"></div>
    <div id="extension-cta-note"></div>
    <div id="payment-balance-banner"></div>
  </body></html>`, {
    url: "https://slycarrentals.com/manage-booking.html?t=test-token",
    runScripts: "outside-only",
  });

  const { window } = dom;
  window.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/v2-vehicles")) {
      return makeJsonResponse(200, vehiclesPayload || [{ id: "camry", name: "Camry 2012" }]);
    }
    if (String(url).includes("/api/renter-ledger-summary")) {
      return makeJsonResponse(200, ledgerPayload);
    }
    if (String(url).includes("/api/manage-booking")) {
      const body = JSON.parse(options.body || "{}");
      if (body.action === "get") return makeJsonResponse(200, bookingPayload);
      if (body.action === "get_agreement_url") return makeJsonResponse(200, agreementPayload || {});
      if (body.action === "create_balance_payment_intent") {
        if (createIntentPayload) return makeJsonResponse(200, createIntentPayload);
        return makeJsonResponse(400, { error: "missing createIntentPayload" });
      }
      return makeJsonResponse(400, { error: "unexpected action" });
    }
    return makeJsonResponse(404, { error: "unexpected URL" });
  };
  window.scrollTo = () => {};
  if (typeof setupWindow === "function") setupWindow(window);

  const source = await fs.readFile(scriptPath, "utf8");
  window.eval(source);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  return window.document;
}

function baseBooking(overrides = {}) {
  return {
    bookingId: "bk-ui-001",
    vehicleId: "camry",
    vehicleName: "Camry 2012",
    pickupDate: "2026-06-01",
    returnDate: "2026-06-07",
    pickupTime: "10:00 AM",
    returnTime: "10:00 AM",
    status: "reserved",
    paymentStatus: "partial",
    category: "car",
    totalPrice: 385.88,
    depositPaid: 50,
    balanceDue: 335.88,
    customerName: "Test Renter",
    customerEmail: "test@example.com",
    customerPhone: "3105550100",
    changeCount: 0,
    paymentPlan: null,
    ...overrides,
  };
}

function getExtensionQuery(document) {
  const href = document.getElementById("extension-cta").href;
  return new URL(href).searchParams;
}

test("deposit-only booking keeps DB remaining balance when ledger is empty", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 0,
        remaining_balance: 0,
        transaction_count: 0,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$335.88");
  assert.equal(document.getElementById("progress-paid-label").textContent, "Reservation Deposit Paid ✅");
  assert.equal(document.getElementById("progress-pct-label").textContent, "$335.88 remaining");
  assert.match(document.getElementById("hero-payment-chip").textContent, /\$335\.88.*remaining/);
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
  assert.equal(document.getElementById("paid-in-full-notice").style.display, "none");
});

test("partial-balance ledger summary updates remaining amount and payment progress", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        remaining_balance: 185.88,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$185.88");
  assert.equal(document.getElementById("progress-paid-label").textContent, "Reservation Deposit Paid ✅");
  assert.equal(document.getElementById("progress-pct-label").textContent, "$185.88 remaining");
  assert.match(document.getElementById("hero-payment-chip").textContent, /\$185\.88.*remaining/);
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
});

test("full-payment transition shows paid-in-full and hides pay-balance CTA", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "booked_paid",
      paymentStatus: "paid",
      depositPaid: 385.88,
      balanceDue: 0,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 385.88,
        remaining_balance: 0,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("hero-payment-chip").textContent, "Paid in full");
  assert.equal(document.getElementById("pay-balance-section").style.display, "none");
  assert.equal(document.getElementById("paid-in-full-notice").style.display, "block");
});

test("active-rental flow still shows actionable balance when DB balance is outstanding", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      totalPrice: 500,
      depositPaid: 200,
      balanceDue: 300,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 0,
        remaining_balance: 0,
        transaction_count: 0,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  assert.equal(document.getElementById("s-balance").textContent, "$300.00");
  assert.equal(document.getElementById("hero-payment-chip").textContent, "$300.00 currently due");
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
});

test("payment init mounts express checkout for balance and partial flows", async () => {
  const createCalls = [];
  const stripeFactory = () => ({
    elements() {
      return {
        create(type) {
          createCalls.push(type);
          const handlers = {};
          return {
            on(eventName, cb) { handlers[eventName] = cb; },
            mount() {
              if (type === "expressCheckout" && typeof handlers.ready === "function") {
                handlers.ready({ availablePaymentMethods: { applePay: true, googlePay: true, cashApp: true } });
              }
            },
            unmount() {},
          };
        },
      };
    },
    async confirmPayment() {
      return { paymentIntent: { status: "requires_payment_method" } };
    },
  });

  const document = await bootDashboard({
    bookingPayload: baseBooking(),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        remaining_balance: 335.88,
        transaction_count: 1,
      },
      transactions: [],
    },
    agreementPayload: {},
    createIntentPayload: {
      clientSecret: "cs_test_123",
      publishableKey: "pk_test_123",
      balanceAmount: 335.88,
      paymentAmount: 335.88,
    },
    setupWindow(window) {
      window.Stripe = stripeFactory;
    },
  });

  document.getElementById("btn-init-balance").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  document.getElementById("btn-open-partial").click();
  document.getElementById("btn-init-partial").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const expressCalls = createCalls.filter((type) => type === "expressCheckout").length;
  assert.ok(expressCalls >= 2, "express checkout should be mounted for both balance and partial payment flows");
  assert.equal(document.getElementById("balance-express-wrap").style.display, "block");
  assert.equal(document.getElementById("partial-express-wrap").style.display, "block");
});

test("extension CTA stays active for active rental with overdue payment-plan balance and carries token context", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      totalPrice: 500,
      depositPaid: 200,
      balanceDue: 300,
      paymentPlan: {
        status: "past_due",
        isOverdue: true,
      },
    }),
    ledgerPayload: {
      summary: {
        total_paid: 200,
        remaining_balance: 300,
        transaction_count: 4,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
      { id: "camry2013", name: "Camry 2013 SE" },
    ],
  });

  const extensionCta = document.getElementById("extension-cta");
  const query = getExtensionQuery(document);
  assert.match(extensionCta.textContent, /Open Extension Flow/);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
  assert.equal(query.get("vehicle"), "camry");
});

test("extension CTA keeps canonical vehicle ID for active rental", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "camry2013",
      vehicleName: "Camry 2013 SE",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 55,
        remaining_balance: 110,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
      { id: "camry2013", name: "Camry 2013 SE" },
    ],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("vehicle"), "camry2013");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
});

test("extension CTA normalizes legacy vehicle ID for active rental", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "camry2012",
      vehicleName: "Camry 2012",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 50,
        remaining_balance: 150,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
      { id: "camry2013", name: "Camry 2013 SE" },
    ],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("vehicle"), "camry");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
});

test("extension CTA remains available for overdue active booking", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "overdue",
      paymentStatus: "partial",
      balanceDue: 420,
      paymentPlan: { status: "active", isOverdue: true },
    }),
    ledgerPayload: {
      summary: {
        total_paid: 120,
        remaining_balance: 420,
        transaction_count: 5,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  const extensionCta = document.getElementById("extension-cta");
  const query = getExtensionQuery(document);
  assert.match(extensionCta.textContent, /Open Extension Flow/);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
  assert.equal(query.get("vehicle"), "camry");
});

test("extension CTA remains available for active partial-payment state", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      paymentStatus: "partial",
      totalPrice: 600,
      depositPaid: 250,
      balanceDue: 350,
    }),
    ledgerPayload: {
      summary: {
        total_paid: 250,
        remaining_balance: 350,
        transaction_count: 3,
      },
      transactions: [],
    },
    agreementPayload: {},
  });

  const extensionCta = document.getElementById("extension-cta");
  const query = getExtensionQuery(document);
  assert.match(extensionCta.textContent, /Open Extension Flow/);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("vehicle"), "camry");
});

test("extension CTA keeps booking vehicle when inventory listing is unavailable/empty", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "legacy-manual-car-001",
      vehicleName: "Legacy Manual Car",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 0,
        remaining_balance: 275,
        transaction_count: 0,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
  assert.equal(query.get("vehicle"), "legacy-manual-car-001");
});

test("extension CTA resolves renamed vehicle ID from booking vehicle name", async () => {
  const document = await bootDashboard({
    bookingPayload: baseBooking({
      status: "active_rental",
      vehicleId: "old-camry-id",
      vehicleName: "Camry 2012",
    }),
    ledgerPayload: {
      summary: {
        total_paid: 100,
        remaining_balance: 200,
        transaction_count: 2,
      },
      transactions: [],
    },
    agreementPayload: {},
    vehiclesPayload: [
      { id: "camry", name: "Camry 2012" },
    ],
  });

  const query = getExtensionQuery(document);
  assert.equal(query.get("vehicle"), "camry");
  assert.equal(query.get("extend"), "1");
  assert.equal(query.get("t"), "test-token");
});
