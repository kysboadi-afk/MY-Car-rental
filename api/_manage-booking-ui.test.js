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

async function bootDashboard({ bookingPayload, ledgerPayload, agreementPayload }) {
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
  </body></html>`, {
    url: "https://slycarrentals.com/manage-booking.html?t=test-token",
    runScripts: "outside-only",
  });

  const { window } = dom;
  window.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/v2-vehicles")) {
      return makeJsonResponse(200, [{ id: "camry", name: "Camry 2012" }]);
    }
    if (String(url).includes("/api/renter-ledger-summary")) {
      return makeJsonResponse(200, ledgerPayload);
    }
    if (String(url).includes("/api/manage-booking")) {
      const body = JSON.parse(options.body || "{}");
      if (body.action === "get") return makeJsonResponse(200, bookingPayload);
      if (body.action === "get_agreement_url") return makeJsonResponse(200, agreementPayload || {});
      return makeJsonResponse(400, { error: "unexpected action" });
    }
    return makeJsonResponse(404, { error: "unexpected URL" });
  };
  window.scrollTo = () => {};

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
  assert.equal(document.getElementById("progress-paid-label").textContent, "$50.00 paid");
  assert.equal(document.getElementById("progress-pct-label").textContent, "13% complete");
  assert.equal(document.getElementById("hero-payment-chip").textContent, "$335.88 still due");
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
  assert.equal(document.getElementById("progress-paid-label").textContent, "$200.00 paid");
  assert.equal(document.getElementById("progress-pct-label").textContent, "52% complete");
  assert.equal(document.getElementById("hero-payment-chip").textContent, "$185.88 still due");
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
  assert.equal(document.getElementById("hero-payment-chip").textContent, "$300.00 still due");
  assert.equal(document.getElementById("pay-balance-section").style.display, "block");
});
