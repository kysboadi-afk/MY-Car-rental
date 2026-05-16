// slingshot-book.js
// Booking page JavaScript for slingshot hourly-package rentals.
// Handles: package selection, Stripe Identity verification, Stripe payment,
// and the "Extend Rental" flow (?extend=1).

"use strict";

// ----- API Base URL -----
const API_BASE = "https://sly-rides.vercel.app";
const SlyLA = window.SlyLA;

// ----- Slingshot package definitions (mirror api/_slingshot-packages.js) -----
// Prices and hours are duplicated here for client-side previews only.
// The server is the authoritative source for all pricing and business-hours checks.
const SLINGSHOT_PACKAGES = {
  "2hr":  { hours: 2,  price: 150, label: "2 Hours" },
  "3hr":  { hours: 3,  price: 200, label: "3 Hours" },
  "6hr":  { hours: 6,  price: 250, label: "6 Hours" },
  "24hr": { hours: 24, price: 350, label: "24 Hours" },
};
const SLINGSHOT_DEPOSIT = 500;
const BUSINESS_CLOSE_HOUR = 20; // 8 PM Los Angeles time

// ----- URL parameters -----
var pageParams = new URLSearchParams(window.location.search);
var vehicleId = pageParams.get("vehicle") || "";
var isExtendMode = /^(true|1)$/i.test(pageParams.get("extend") || "");
var isIdentityReturnMode = /^(return|returned|1|true)$/i.test(pageParams.get("identity") || "")
  || !!(pageParams.get("verification_session") || pageParams.get("verificationSessionId") || pageParams.get("session_id"));

// ----- State -----
var selectedPackage = null; // "2hr" | "3hr" | "6hr" | "24hr"
var extSelectedPackage = null;
var pendingBookingId       = null;  // returned by create-slingshot-booking
var paymentFormSubmitted   = false; // set to true once the Pay button is clicked
var carData = null;                 // vehicle data from API
var agreementSigned = false;        // true once renter signs the rental agreement
var agreementSignature = "";        // typed name used as electronic signature
var verifiedIdentitySessionId = null;
var selectedPaymentOption = "manual";
var SLINGSHOT_IDENTITY_STATE_KEY = "slySlingshotIdentityState";
var SLINGSHOT_BOOKING_DRAFT_KEY = "slySlingshotBookingDraft";

// ----- Helpers -----
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function showPayError(msg) {
  var el = document.getElementById("payError");
  if (!el) { console.error("Payment error:", msg); return; }
  el.textContent = msg;
  el.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearPayError() {
  var el = document.getElementById("payError");
  if (el) { el.textContent = ""; el.style.display = "none"; }
}

function normalizeIdentityContext(data) {
  return {
    vehicleId: String((data && data.vehicleId) || vehicleId || "").trim().toLowerCase(),
    name: String((data && data.name) || "").trim().replace(/\s+/g, " ").toLowerCase(),
    email: String((data && data.email) || "").trim().toLowerCase(),
    phone: String((data && data.phone) || "").replace(/[^\d+]/g, ""),
  };
}

function readIdentityState() {
  try {
    var raw = sessionStorage.getItem(SLINGSHOT_IDENTITY_STATE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeIdentityState(context, sessionId) {
  try {
    var normalized = normalizeIdentityContext(context || {});
    sessionStorage.setItem(SLINGSHOT_IDENTITY_STATE_KEY, JSON.stringify({
      sessionId: String(sessionId || "").trim(),
      vehicleId: normalized.vehicleId,
      name: normalized.name,
      email: normalized.email,
      phone: normalized.phone,
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

function clearIdentityState() {
  try { sessionStorage.removeItem(SLINGSHOT_IDENTITY_STATE_KEY); } catch (_) {}
}

function syncVerifiedIdentitySession(payload) {
  var stored = readIdentityState();
  if (!stored || !stored.sessionId) return;
  if (!payload) {
    verifiedIdentitySessionId = stored.sessionId;
    return;
  }
  var expected = normalizeIdentityContext(payload);
  if (stored.vehicleId === expected.vehicleId &&
      stored.name === expected.name &&
      stored.email === expected.email &&
      stored.phone === expected.phone) {
    verifiedIdentitySessionId = stored.sessionId;
    return;
  }
  clearIdentityState();
  verifiedIdentitySessionId = null;
}

function readBookingDraft() {
  try {
    var raw = sessionStorage.getItem(SLINGSHOT_BOOKING_DRAFT_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeBookingDraft(draft) {
  try {
    sessionStorage.setItem(SLINGSHOT_BOOKING_DRAFT_KEY, JSON.stringify({
      ...(draft || {}),
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

function clearBookingDraft() {
  try { sessionStorage.removeItem(SLINGSHOT_BOOKING_DRAFT_KEY); } catch (_) {}
}

function clearIdentityReturnParamsFromUrl() {
  try {
    var url = new URL(window.location.href);
    ["identity", "verification_session", "verificationSessionId", "session_id"].forEach(function(key) {
      url.searchParams.delete(key);
    });
    var newSearch = url.searchParams.toString();
    var next = url.pathname + (newSearch ? "?" + newSearch : "") + url.hash;
    window.history.replaceState({}, "", next);
  } catch (_) {}
}

function showSlingshotManualConfirmation(data) {
  var bookingSection = document.getElementById("bookingSection");
  var confirmSection = document.getElementById("slManualConfirmation");
  var bookingIdEl = document.getElementById("slConfirmBookingId");
  var manageEl = document.getElementById("slConfirmManageLink");
  var agreementEl = document.getElementById("slConfirmAgreementLink");
  if (bookingSection) bookingSection.style.display = "none";
  if (confirmSection) confirmSection.style.display = "";
  if (bookingIdEl) bookingIdEl.textContent = data && data.bookingId ? data.bookingId : "—";
  if (manageEl) {
    if (data && data.manageLink) {
      manageEl.href = data.manageLink;
      manageEl.style.display = "";
    } else {
      manageEl.style.display = "none";
    }
  }
  if (agreementEl) {
    if (data && data.agreementPdfUrl) {
      agreementEl.href = data.agreementPdfUrl;
      agreementEl.style.display = "";
    } else {
      agreementEl.style.display = "none";
    }
  }
  if (confirmSection) confirmSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function getSelectedPaymentOption() {
  return "manual";
}

function computePaymentDetails(pkgKey, paymentOption) {
  var pkg = SLINGSHOT_PACKAGES[pkgKey];
  if (!pkg) return null;
  var total = pkg.price + SLINGSHOT_DEPOSIT;
  var option = String(paymentOption || "manual").toLowerCase();
  var chargedToday = option === "manual" ? 0 : (option === "full" ? total : SLINGSHOT_DEPOSIT);
  var balanceAtPickup = Math.max(0, total - chargedToday);
  return {
    packageLabel: pkg.label,
    packagePrice: pkg.price,
    totalAmount: total,
    chargedToday: chargedToday,
    balanceAtPickup: balanceAtPickup,
    paymentType: option === "manual" ? "manual_payment" : (option === "full" ? "full_payment" : "reservation_deposit"),
    paymentLabel: option === "manual" ? "Manual payment" : (option === "full" ? "Full payment" : "Deposit payment"),
  };
}

function updateBookBtnLabel() {
  var btn = document.getElementById("slBookBtn");
  if (!btn) return;
  var details = selectedPackage ? computePaymentDetails(selectedPackage, selectedPaymentOption) : null;
  if (!details) {
    btn.textContent = "Verify Identity & Confirm Reservation";
    return;
  }
  btn.textContent = "Verify Identity & Confirm Reservation";
}

/**
 * Transition the current pending booking (if any) via the public API.
 * Safe to call multiple times — idempotent on the server.
 * Uses sendBeacon when available (page-unload safe), otherwise fetch.
 * @param {boolean} [useBeacon] - true to use sendBeacon (for pagehide)
 */
async function updatePendingBookingLifecycle(targetStatus, reason, options) {
  if (!pendingBookingId) return;
  var bookingIdToCancel = pendingBookingId;
  var useBeacon = !!(options && options.useBeacon);
  var source = options && options.source ? options.source : "slingshot_booking";
  var shouldClearLocal = !(options && options.preservePendingBookingId);
  var url  = API_BASE + "/api/cancel-pending-booking";
  var body = JSON.stringify({ bookingId: bookingIdToCancel, targetStatus: targetStatus, reason: reason, source: source });
  if (useBeacon && navigator.sendBeacon) {
    var blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(url, blob)) {
      if (shouldClearLocal) pendingBookingId = null;
      return true;
    }
    console.warn("cancel-pending-booking sendBeacon failed to queue; falling back to fetch");
  }
  try {
    var fallbackRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
    });
    if (!fallbackRes.ok) throw new Error("HTTP " + fallbackRes.status);
    if (shouldClearLocal) pendingBookingId = null;
    return true;
  } catch (fallbackErr) {
    console.warn("cancel-pending-booking fetch error:", fallbackErr);
    return false;
  }
}

// Cancel the pending booking when the user navigates away without paying.
// paymentFormSubmitted is set to true right before stripe.confirmPayment() so
// a successful Stripe redirect to success.html does NOT trigger a cancel.
window.addEventListener("pagehide", function() {
  if (pendingBookingId && !paymentFormSubmitted) {
    updatePendingBookingLifecycle("abandoned_checkout", "pagehide_before_payment", { useBeacon: true, source: "pagehide" });
  }
});

/**
 * Format a 24-hour "HH:MM" string as "h:MM AM/PM".
 * @param {string} hhmm
 * @returns {string}
 */
function fmt12h(hhmm) {
  if (!hhmm) return "";
  var parts = hhmm.split(":");
  var h = parseInt(parts[0], 10);
  var m = parts[1] || "00";
  var suffix = h < 12 ? "AM" : "PM";
  if (h === 0)  return "12:" + m + " AM";
  if (h > 12)   return (h - 12) + ":" + m + " " + suffix;
  if (h === 12) return "12:" + m + " PM";
  return h + ":" + m + " " + suffix;
}

/**
 * Given a pickup HH:MM and a number of hours, compute the return HH:MM and
 * the number of days added (0 or 1 for a 24hr package).
 * Uses Date arithmetic to handle midnight crossings correctly.
 * Returns { time: "HH:MM", daysAdded: number }.
 */
function computeReturnHHMM(pickupHHMM, hours) {
  if (!pickupHHMM || !hours) return { time: "", daysAdded: 0 };
  var parts = pickupHHMM.split(":");
  var ph = parseInt(parts[0], 10);
  var pm = parseInt(parts[1] || "0", 10);
  var totalMins = ph * 60 + pm + hours * 60;
  var daysAdded = Math.floor(totalMins / (24 * 60));
  totalMins = totalMins % (24 * 60);
  var rh = Math.floor(totalMins / 60);
  var rm = totalMins % 60;
  return {
    time: String(rh).padStart(2, "0") + ":" + String(rm).padStart(2, "0"),
    daysAdded: daysAdded,
  };
}

/**
 * Compute the latest valid pickup hour for a package so that the return is
 * at or before 8:00 PM (20:00).
 * 24hr packages have no restriction (returns 23 so all slots are valid).
 * @param {string} pkgKey
 * @returns {number} maximum start hour (inclusive)
 */
function maxStartHour(pkgKey) {
  if (pkgKey === "24hr") return 23;
  var pkg = SLINGSHOT_PACKAGES[pkgKey];
  if (!pkg) return 20;
  return BUSINESS_CLOSE_HOUR - pkg.hours; // e.g. 20 - 2 = 18
}

/**
 * Generate the list of valid hourly pickup time slots (in HH:MM 24-hour format)
 * for a given package key.  Start: 08:00.  End: maxStartHour for the package.
 * Returns an empty array when no package is selected.
 * @param {string} pkgKey
 * @returns {string[]}
 */
function buildTimeSlots(pkgKey) {
  if (!pkgKey) return [];
  var max = maxStartHour(pkgKey);
  var slots = [];
  for (var h = 8; h <= max; h++) {
    slots.push(String(h).padStart(2, "0") + ":00");
    if (h < max) slots.push(String(h).padStart(2, "0") + ":30");
  }
  return slots;
}

// ----- Vehicle data loading -----
function buildSlider(images, vehicleName) {
  var container = document.getElementById("sliderContainer");
  var dotsEl    = document.getElementById("sliderDots");
  if (!container) return;
  container.innerHTML = "";
  if (dotsEl) dotsEl.innerHTML = "";

  var imgs = images && images.length > 0 ? images : ["/images/slingshot.jpg"];
  imgs.forEach(function(src, i) {
    var img = document.createElement("img");
    img.src = src;
    img.alt = vehicleName;
    img.className = "slide" + (i === 0 ? " active" : "");
    container.appendChild(img);

    if (dotsEl) {
      var dot = document.createElement("span");
      dot.className = "dot" + (i === 0 ? " active" : "");
      dotsEl.appendChild(dot);
    }
  });

  var current = 0;
  function showSlide(n) {
    var slides = container.querySelectorAll(".slide");
    var dots   = dotsEl ? dotsEl.querySelectorAll(".dot") : [];
    slides.forEach(function(s) { s.classList.remove("active"); });
    dots.forEach(function(d) { d.classList.remove("active"); });
    current = ((n % slides.length) + slides.length) % slides.length;
    if (slides[current]) slides[current].classList.add("active");
    if (dots[current])   dots[current].classList.add("active");
  }

  var prevBtn = document.getElementById("prevSlide");
  var nextBtn = document.getElementById("nextSlide");
  if (prevBtn) prevBtn.addEventListener("click", function() { showSlide(current - 1); });
  if (nextBtn) nextBtn.addEventListener("click", function() { showSlide(current + 1); });
}

async function loadVehicleData() {
  try {
    var resp = await fetch(API_BASE + "/api/v2-vehicles");
    if (!resp.ok) return;
    var json = await resp.json();
    var vehicles = json.vehicles || json;
    var v = Array.isArray(vehicles)
      ? vehicles.find(function(x) { return x.vehicle_id === vehicleId || x.id === vehicleId; })
      : vehicles[vehicleId];
    if (!v) return;

    carData = {
      name:   v.vehicle_name || v.name || "Slingshot",
      type:   v.type || v.vehicle_type || "slingshot",
      images: (function() {
        var gallery = Array.isArray(v.gallery_images) ? v.gallery_images : [];
        var cover   = v.cover_image ? [v.cover_image] : [];
        var all     = cover.concat(gallery.filter(function(u) { return u !== v.cover_image; }));
        return all.length > 0 ? all : [];
      })(),
    };

    var nameEl = document.getElementById("carName");
    if (nameEl) nameEl.textContent = carData.name;

    var priceEl = document.getElementById("carPrice");
    if (priceEl) priceEl.textContent = "From $150 · 2hr package";

    buildSlider(carData.images, carData.name);
  } catch (err) {
    console.warn("slingshot-book: could not load vehicle data:", err);
  }
}

// ----- Pickup date: min = today (LA) -----
function initDatePicker() {
  var dateInput = document.getElementById("slPickupDate");
  if (!dateInput) return;
  var today = SlyLA.todayISO();
  dateInput.setAttribute("min", today);
  if (!dateInput.value) dateInput.value = today;
}

// ----- Populate time slots based on selected package -----
function populateTimeSlots() {
  var timeSelect = document.getElementById("slPickupTime");
  var noTimesMsg = document.getElementById("noTimesMsg");
  if (!timeSelect) return;

  var slots = buildTimeSlots(selectedPackage);
  var prevValue = timeSelect.value;

  timeSelect.innerHTML = '<option value="">— Select a pickup time —</option>';
  if (noTimesMsg) noTimesMsg.style.display = "none";

  if (slots.length === 0) {
    updateReturnTimeDisplay();
    updateBookBtn();
    return;
  }

  slots.forEach(function(hhmm) {
    var opt = document.createElement("option");
    opt.value = hhmm;
    opt.textContent = fmt12h(hhmm);
    timeSelect.appendChild(opt);
  });

  // Restore previous selection if still valid
  if (prevValue && slots.indexOf(prevValue) !== -1) {
    timeSelect.value = prevValue;
  } else {
    timeSelect.value = "";
  }

  updateReturnTimeDisplay();
  updateBookBtn();
}

// ----- Return time preview (client-side, LA-aware) -----
function updateReturnTimeDisplay() {
  var box       = document.getElementById("returnTimeBox");
  var displayEl = document.getElementById("returnTimeDisplay");
  var dateInput = document.getElementById("slPickupDate");
  var timeSelect = document.getElementById("slPickupTime");

  if (!box || !displayEl) return;

  if (!selectedPackage || !dateInput || !dateInput.value || !timeSelect || !timeSelect.value) {
    box.style.display = "none";
    return;
  }

  var pkg = SLINGSHOT_PACKAGES[selectedPackage];
  if (!pkg) { box.style.display = "none"; return; }

  var result = computeReturnHHMM(timeSelect.value, pkg.hours);
  if (!result.time) { box.style.display = "none"; return; }

  // Compute the actual return date (may be next day for 24hr)
  var returnDate = result.daysAdded > 0
    ? SlyLA.addDaysToISO(dateInput.value, result.daysAdded)
    : dateInput.value;

  var displayStr = SlyLA.formatLocalDateTime(returnDate, result.time);
  displayEl.textContent = displayStr || "—";
  box.style.display = "";
}

// ----- Total breakdown -----
function updateTotalBreakdown() {
  var breakdownEl  = document.getElementById("totalBreakdown");
  var pkgLabel     = document.getElementById("pkgBreakdownLabel");
  var pkgPrice     = document.getElementById("pkgBreakdownPrice");
  var totalDisplay = document.getElementById("totalAmountDisplay");
  var balanceRow   = document.getElementById("remainingBalanceRow");
  var balanceEl    = document.getElementById("remainingBalanceDisplay");
  var noticeEl     = document.getElementById("paymentOptionNotice");

  if (!breakdownEl) return;

  if (!selectedPackage) {
    breakdownEl.style.display = "none";
    if (noticeEl) {
      noticeEl.textContent = "Rental payment, deposit, and pickup charges are collected in person at pickup.";
    }
    updateBookBtnLabel();
    return;
  }

  var details = computePaymentDetails(selectedPackage, selectedPaymentOption);
  if (!details) { breakdownEl.style.display = "none"; return; }

  if (pkgLabel)     pkgLabel.textContent     = details.packageLabel + " rental";
  if (pkgPrice)     pkgPrice.textContent     = "$" + details.packagePrice.toFixed(2);
  if (totalDisplay) totalDisplay.textContent = details.totalAmount.toFixed(2);
  if (balanceEl)    balanceEl.textContent    = details.balanceAtPickup.toFixed(2);
  if (balanceRow)   balanceRow.style.display = "none";
  if (noticeEl) {
    noticeEl.textContent = "Rental payment, deposit, and pickup charges are collected in person at pickup.";
  }
  breakdownEl.style.display = "";
  updateBookBtnLabel();
}

// ----- Book button enable/disable -----
function updateBookBtn() {
  var btn      = document.getElementById("slBookBtn");
  var hintEl   = document.getElementById("slPayHint");
  var dateInput  = document.getElementById("slPickupDate");
  var timeSelect = document.getElementById("slPickupTime");
  var nameInput  = document.getElementById("slName");
  var emailInput = document.getElementById("slEmail");
  var phoneInput = document.getElementById("slPhone");

  if (!btn) return;

  var pkgOk    = !!selectedPackage;
  var dateOk   = !!(dateInput && dateInput.value);
  var timeOk   = !!(timeSelect && timeSelect.value);
  var nameOk   = !!(nameInput && nameInput.value.trim());
  var emailOk  = !!(emailInput && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim()));
  var phoneOk  = !!(phoneInput && phoneInput.value.trim().length >= 7);
  var agreeEl  = document.getElementById("slAgree");
  var agreeOk  = !!(agreeEl && agreeEl.checked);
  var smsEl    = document.getElementById("smsConsentCheck");
  var smsOk    = !smsEl || smsEl.checked;

  var ready = pkgOk && dateOk && timeOk && nameOk && emailOk && phoneOk && agreeOk && smsOk;
  btn.disabled = !ready;
  if (hintEl) hintEl.style.display = ready ? "none" : "";
}

// ----- Package picker -----
function initPackagePicker(gridId, onSelect) {
  var grid = document.getElementById(gridId);
  if (!grid) return;
  grid.querySelectorAll(".package-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      grid.querySelectorAll(".package-btn").forEach(function(b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      onSelect(btn.dataset.pkg);
    });
  });
}

// =====================================================================
// REGULAR BOOKING FLOW
// =====================================================================

async function ensureSlingshotIdentityVerified(payload) {
  syncVerifiedIdentitySession(payload);
  if (verifiedIdentitySessionId) return verifiedIdentitySessionId;

  var createResp = await fetch(API_BASE + "/api/create-slingshot-booking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vehicleId: payload.vehicleId,
      name: payload.name,
      email: payload.email,
      phone: payload.phone,
      identityOnly: true,
    }),
  });
  var createData = await createResp.json();
  if (!createResp.ok) {
    throw new Error((createData && createData.error) || "Could not start identity verification.");
  }
  if (!createData.identityClientSecret || !createData.publishableKey || !createData.verificationSessionId) {
    throw new Error("Identity verification setup is incomplete. Please try again.");
  }
  writeIdentityState(payload, createData.verificationSessionId);

  var stripe = Stripe(createData.publishableKey);
  var verifyResult = await stripe.verifyIdentity(createData.identityClientSecret);
  if (verifyResult && verifyResult.error) {
    throw new Error(verifyResult.error.message || "Identity verification was not completed.");
  }

  verifiedIdentitySessionId = createData.verificationSessionId;
  return verifiedIdentitySessionId;
}

async function launchSlingshotPayment() {
  clearPayError();

  var dateInput  = document.getElementById("slPickupDate");
  var timeSelect = document.getElementById("slPickupTime");
  var nameInput  = document.getElementById("slName");
  var emailInput = document.getElementById("slEmail");
  var phoneInput = document.getElementById("slPhone");
  var bookBtn    = document.getElementById("slBookBtn");
  if (!selectedPackage) { showPayError("Please select a rental package."); return; }
  if (!dateInput || !dateInput.value) { showPayError("Please select a pickup date."); return; }
  if (!timeSelect || !timeSelect.value) { showPayError("Please select a pickup time."); return; }

  var name  = nameInput  ? nameInput.value.trim()  : "";
  var email = emailInput ? emailInput.value.trim()  : "";
  var phone = phoneInput ? phoneInput.value.trim()  : "";

  if (!name)  { showPayError("Full name is required."); return; }
  if (!email) { showPayError("Email address is required."); return; }
  if (!phone) { showPayError("Phone number is required."); return; }
  if (!agreementSigned)   { showPayError("Please read and sign the Rental Agreement before booking."); return; }
  var agreeEl = document.getElementById("slAgree");
  if (!agreeEl || !agreeEl.checked) { showPayError("Please check the box to confirm you have signed the Rental Agreement."); return; }
  writeBookingDraft({
    vehicleId: vehicleId,
    slingshotPackage: selectedPackage,
    pickupDate: dateInput.value,
    pickupTime: timeSelect.value,
    name: name,
    email: email,
    phone: phone,
    agreementSignature: agreementSignature,
    agreementSigned: agreementSigned,
  });

  if (bookBtn) { bookBtn.disabled = true; bookBtn.textContent = "Verifying identity…"; }

  try {
    var identitySessionId = await ensureSlingshotIdentityVerified({
      vehicleId: vehicleId,
      name: name,
      email: email,
      phone: phone,
    });

    if (bookBtn) bookBtn.textContent = "Finalizing reservation…";

    var resp = await fetch(API_BASE + "/api/create-slingshot-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId,
        slingshotPackage: selectedPackage,
        paymentOption:    "deposit",
        pickupDate:       dateInput.value,
        pickupTime:       timeSelect.value,
        name,
        email,
        phone,
        identitySessionId,
      }),
    });

    var data = await resp.json();
    if (!resp.ok) {
      var isDates = resp.status === 409;
      var err = Object.assign(new Error(data.error || "Server error"), { isDatesError: isDates });
      throw err;
    }

    pendingBookingId    = data.bookingId;

    // Build booking payload for success.html → send-reservation-email
    var details = computePaymentDetails(selectedPackage, "manual");
    if (!details) throw new Error("Invalid package selected. Please choose a package and try again.");
    var pkg = SLINGSHOT_PACKAGES[selectedPackage];
    var returnResult = computeReturnHHMM(timeSelect.value, pkg.hours);
    var returnDate = returnResult.daysAdded > 0
      ? SlyLA.addDaysToISO(dateInput.value, returnResult.daysAdded)
      : dateInput.value;
    var total = details.totalAmount;
    var chargedToday = details.chargedToday;
    var balanceAtPickup = details.balanceAtPickup;

    var bookingPayload = {
      vehicleId:          vehicleId,
      bookingId:          pendingBookingId || null,
      car:                carData ? carData.name : "Slingshot",
      name,
      email,
      phone,
      pickup:             dateInput.value,
      pickupTime:         timeSelect.value,
      returnDate:         returnDate,
      returnTime:         returnResult.time,
      total:              total.toFixed(2),
      chargedToday:       chargedToday.toFixed(2),
      balanceAtPickup:    balanceAtPickup.toFixed(2),
      paymentOption:      "manual",
      paymentType:        details.paymentType,
      slingshotPackage:   selectedPackage,
      packageLabel:       pkg.label,
      packagePrice:       pkg.price,
      depositAmount:      SLINGSHOT_DEPOSIT,
      identitySessionId:  identitySessionId || null,
      agreementSignature: agreementSignature || null,
    };

    sessionStorage.setItem("slyRidesBooking", JSON.stringify(bookingPayload));

    // Sign the rental agreement, save booking docs, and redirect to thank-you.
    // Agreement delivery is triggered by admin after in-person payment is received.
    var signResp = await fetch(API_BASE + "/api/sign-slingshot-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: pendingBookingId,
        signature: agreementSignature,
      }),
    });
    var signData = await signResp.json();
    if (!signResp.ok) {
      throw new Error((signData && signData.error) || "Agreement signing could not be completed.");
    }
    clearIdentityState();
    clearBookingDraft();
    paymentFormSubmitted = true;
    var confirmedBookingId = signData.bookingId || pendingBookingId || "";
    var confirmedManageLink = signData.manageLink || data.manageLink || "";
    var redirectUrl = "thank-you.html?from=slingshot";
    if (confirmedBookingId) {
      redirectUrl += "&bookingId=" + encodeURIComponent(confirmedBookingId);
    }
    if (confirmedManageLink) {
      redirectUrl += "&manageLink=" + encodeURIComponent(confirmedManageLink);
    }
    window.location.href = redirectUrl;
    return;

  } catch (err) {
    console.error("slingshot-book payment error:", err);
    showPayError(err.message || "Reservation could not be completed. Please try again or call (844) 511-4059.");
    if (bookBtn) { bookBtn.disabled = false; updateBookBtnLabel(); }
  }
}

// =====================================================================
// EXTEND RENTAL FLOW
// =====================================================================

function updateExtBtn() {
  var btn          = document.getElementById("extSubmitBtn");
  var hintEl       = document.getElementById("extPayHint");
  var emailInput   = document.getElementById("extEmail");
  var phoneInput   = document.getElementById("extPhone");

  if (!btn) return;

  var emailOk   = !!(emailInput && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim()));
  var phoneOk   = !!(phoneInput && phoneInput.value.trim().length >= 7);
  var contactOk = emailOk || phoneOk;
  var pkgOk     = !!extSelectedPackage;
  var ready     = contactOk && pkgOk;

  btn.disabled = !ready;
  if (hintEl) hintEl.style.display = ready ? "none" : "";
}

async function launchExtendRentalPayment() {
  var extEmail = document.getElementById("extEmail");
  var extPhone = document.getElementById("extPhone");
  var submitBtn = document.getElementById("extSubmitBtn");

  if (!extSelectedPackage) { alert("Please select an extension package."); return; }

  var email = extEmail ? extEmail.value.trim() : "";
  var phone = extPhone ? extPhone.value.trim() : "";
  if (!email && !phone) { alert("Please enter your email or phone number."); return; }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Loading payment…"; }

  try {
    var resp = await fetch(API_BASE + "/api/extend-slingshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId,
        email,
        phone,
        slingshotPackage: extSelectedPackage,
      }),
    });
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Server error");

    var { clientSecret, publishableKey, extensionAmount, extensionLabel,
          newReturnDate, newReturnTime, vehicleName, renterName } = data;
    if (!clientSecret || !publishableKey) throw new Error("Invalid server response.");

    var stripe   = Stripe(publishableKey);
    var elements = stripe.elements({
      clientSecret,
      ...(email ? { defaultValues: { billingDetails: { email } } } : {}),
    });
    var paymentElement = elements.create("payment");

    // Hide form, show payment
    var extForm = document.getElementById("extendRentalForm");
    if (extForm) extForm.style.display = "none";
    var extPayForm = document.getElementById("extPaymentForm");
    if (extPayForm) extPayForm.style.display = "";

    // Summary
    var summaryEl = document.getElementById("ext-rental-summary");
    if (summaryEl) {
      var returnDisplay = SlyLA.formatLocalDateTime(newReturnDate, newReturnTime);
      summaryEl.innerHTML =
        "<strong>⏱️ Slingshot Extension</strong><br>" +
        (vehicleName ? "Vehicle: " + vehicleName + "<br>" : "") +
        (renterName  ? "Renter: "  + renterName  + "<br>" : "") +
        "Extension: " + extensionLabel + "<br>" +
        "<strong>New Return: " + returnDisplay + "</strong><br>" +
        "<strong style='color:#ffb400'>Total: $" + extensionAmount + "</strong><br>" +
        "<small style='color:#888'>No additional deposit</small>";
    }

    var payAmtEl = document.getElementById("extPayAmount");
    if (payAmtEl) payAmtEl.textContent = extensionAmount;

    paymentElement.mount("#ext-payment-element");

    var extSubmitPayBtn = document.getElementById("ext-submit-payment");
    var extCancelBtn    = document.getElementById("ext-cancel-payment");
    var extMsgEl        = document.getElementById("ext-payment-message");
    var extSubmitting   = false;

    var handleExtSubmit = async function() {
      if (extSubmitting) return;
      extSubmitting = true;
      extSubmitPayBtn.disabled  = true;
      extSubmitPayBtn.innerHTML = "Processing…";
      if (extMsgEl) extMsgEl.textContent = "";

      var result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: "https://www.slytrans.com/success.html?ext=1&vehicle=" + encodeURIComponent(vehicleId),
          ...(email ? { receipt_email: email } : {}),
        },
      });

      if (result.error) {
        if (extMsgEl) extMsgEl.textContent = result.error.message;
        extSubmitPayBtn.disabled  = false;
        extSubmitPayBtn.innerHTML = "Pay $" + extensionAmount + " Now 🔒";
        extSubmitting = false;
      }
    };
    extSubmitPayBtn.addEventListener("click", handleExtSubmit);

    extCancelBtn.addEventListener("click", function() {
      extSubmitting = false;
      extSubmitPayBtn.removeEventListener("click", handleExtSubmit);
      paymentElement.unmount();
      if (extMsgEl) extMsgEl.textContent = "";
      if (extPayForm) extPayForm.style.display = "none";
      if (extForm) extForm.style.display = "";
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "⏱️ Extend Rental"; }
    }, { once: true });

  } catch (err) {
    console.error("extend-slingshot payment error:", err);
    alert(err.message || "Failed to create extension. Please try again or call (844) 511-4059.");
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "⏱️ Extend Rental"; }
  }
}

// =====================================================================
// INITIALIZATION
// =====================================================================

document.addEventListener("DOMContentLoaded", function() {
  // Back button
  var backBtn = document.getElementById("backBtn");
  if (backBtn) {
    backBtn.addEventListener("click", function() {
      window.location.href = "slingshots.html" + (vehicleId ? "?vehicle=" + encodeURIComponent(vehicleId) : "");
    });
  }

  // Load vehicle data
  if (vehicleId) {
    loadVehicleData();
  }

  // Check fleet status to decide whether to show extend form
  if (isExtendMode) {
    showExtendSection();
  } else {
    initBookingForm();
    checkFleetStatus();
  }
});

function initBookingForm() {
  initDatePicker();
  selectedPaymentOption = getSelectedPaymentOption();

  // Package picker
  initPackagePicker("packageGrid", function(pkg) {
    selectedPackage = pkg;
    populateTimeSlots();
    updateReturnTimeDisplay();
    updateTotalBreakdown();
    updateBookBtn();
    // Highlight business-hours note for non-24hr
    var pkgNote = document.getElementById("pkgNote");
    if (pkgNote) pkgNote.style.display = "none";
  });

  // Date change
  var dateInput = document.getElementById("slPickupDate");
  if (dateInput) {
    dateInput.addEventListener("change", function() {
      updateReturnTimeDisplay();
      updateBookBtn();
    });
  }

  // Time change
  var timeSelect = document.getElementById("slPickupTime");
  if (timeSelect) {
    timeSelect.addEventListener("change", function() {
      updateReturnTimeDisplay();
      updateBookBtn();
    });
  }

  // Contact inputs
  ["slName", "slEmail", "slPhone"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", function() {
      verifiedIdentitySessionId = null;
      clearIdentityState();
      updateBookBtn();
    });
  });

  // Rental agreement signing
  var slSignBtn       = document.getElementById("slSignAgreementBtn");
  var slAgreementBox  = document.getElementById("slRentalAgreementBox");
  var slSigInput      = document.getElementById("slSignatureInput");
  var slConfirmBtn    = document.getElementById("slConfirmSignBtn");
  var slCancelSignBtn = document.getElementById("slCancelSignBtn");
  var slAgreeCheck    = document.getElementById("slAgree");
  var slSignStatus    = document.getElementById("slSignAgreementStatus");

  if (slSignBtn) {
    slSignBtn.addEventListener("click", function() {
      // Pre-fill signature field with renter name if already typed
      var renterName = (document.getElementById("slName") || {}).value || "";
      renterName = renterName.trim();
      if (slSigInput && renterName && !slSigInput.value) {
        slSigInput.value = renterName;
        if (slConfirmBtn) slConfirmBtn.disabled = false;
      }
      // Populate agreement intro with booking details
      var introEl = document.getElementById("slAgreementIntro");
      if (introEl) {
        var dateInput  = document.getElementById("slPickupDate");
        var timeSelect = document.getElementById("slPickupTime");
        var namePart   = renterName ? "<strong>" + escHtml(renterName) + "</strong>" : "<strong>[Renter]</strong>";
        var pickPart   = (dateInput && timeSelect && dateInput.value && timeSelect.value)
          ? "<strong>" + escHtml(SlyLA.formatLocalDateTime(dateInput.value, timeSelect.value)) + "</strong>"
          : "<strong>[pickup date/time]</strong>";
        introEl.innerHTML = "This Rental Agreement is entered into between SLY Slingshot Rentals (\"Company\") and " + namePart + " (\"Renter\") for the rental of a <strong>Polaris Slingshot</strong> starting " + pickPart + ".";
      }
      if (slAgreementBox) slAgreementBox.style.display = "";
      slSignBtn.style.display = "none";
      if (slSignStatus) slSignStatus.textContent = "";
    });
  }

  if (slSigInput) {
    slSigInput.addEventListener("input", function() {
      if (slConfirmBtn) slConfirmBtn.disabled = slSigInput.value.trim() === "";
      var sigErr = document.getElementById("slSignatureError");
      if (sigErr) { sigErr.style.display = "none"; sigErr.textContent = ""; }
    });
  }

  if (slConfirmBtn) {
    slConfirmBtn.addEventListener("click", function() {
      var sig = slSigInput ? slSigInput.value.trim() : "";
      if (!sig) return;
      // Signature must match the full name in the booking form
      var renterName = (document.getElementById("slName") || {}).value || "";
      renterName = renterName.trim();
      var sigErr = document.getElementById("slSignatureError");
      if (renterName && sig.toLowerCase() !== renterName.toLowerCase()) {
        if (sigErr) {
          sigErr.textContent = "Signature must match the full name entered in the booking form.";
          sigErr.style.display = "";
        }
        return;
      }
      agreementSigned   = true;
      agreementSignature = sig;
      if (slAgreementBox) slAgreementBox.style.display = "none";
      if (slSignBtn) {
        slSignBtn.style.display = "";
        slSignBtn.classList.add("signed");
        slSignBtn.textContent = "✅ Rental Agreement Signed";
      }
      if (slSignStatus) {
        slSignStatus.style.color   = "#4caf50";
        slSignStatus.textContent   = "Signed by " + sig + ". Check the box below to confirm.";
      }
      if (slAgreeCheck) slAgreeCheck.disabled = false;
      updateBookBtn();
    });
  }

  if (slCancelSignBtn) {
    slCancelSignBtn.addEventListener("click", function() {
      if (slAgreementBox) slAgreementBox.style.display = "none";
      if (slSignBtn) slSignBtn.style.display = "";
    });
  }

  if (slAgreeCheck) {
    slAgreeCheck.addEventListener("change", updateBookBtn);
  }

  var slSmsConsent = document.getElementById("smsConsentCheck");
  if (slSmsConsent) {
    slSmsConsent.addEventListener("change", updateBookBtn);
  }

  // Book button
  var bookBtn = document.getElementById("slBookBtn");
  if (bookBtn) {
    bookBtn.addEventListener("click", launchSlingshotPayment);
  }

  (function maybeResumeFromIdentityReturn() {
    if (!isIdentityReturnMode) return;
    var draft = readBookingDraft();
    if (!draft || String(draft.vehicleId || "") !== String(vehicleId || "")) return;
    var dateInput = document.getElementById("slPickupDate");
    var timeSelect = document.getElementById("slPickupTime");
    var nameInput = document.getElementById("slName");
    var emailInput = document.getElementById("slEmail");
    var phoneInput = document.getElementById("slPhone");
    var signInput = document.getElementById("slSignatureInput");
    var agreeCheck = document.getElementById("slAgree");

    if (nameInput) nameInput.value = draft.name || "";
    if (emailInput) emailInput.value = draft.email || "";
    if (phoneInput) phoneInput.value = draft.phone || "";
    if (dateInput) dateInput.value = draft.pickupDate || "";
    if (draft.slingshotPackage) {
      var pkgBtn = document.querySelector('#packageGrid .package-btn[data-pkg="' + draft.slingshotPackage + '"]');
      if (pkgBtn) pkgBtn.click();
      selectedPackage = draft.slingshotPackage;
    }

    populateTimeSlots();
    if (timeSelect && draft.pickupTime) timeSelect.value = draft.pickupTime;
    if (signInput && draft.agreementSignature) signInput.value = draft.agreementSignature;
    agreementSignature = draft.agreementSignature || agreementSignature;
    agreementSigned = !!draft.agreementSigned;
    if (agreeCheck && agreementSigned) {
      agreeCheck.checked = true;
      agreeCheck.disabled = false;
    }

    syncVerifiedIdentitySession({
      vehicleId: vehicleId,
      name: draft.name || "",
      email: draft.email || "",
      phone: draft.phone || "",
    });

    updateReturnTimeDisplay();
    updateTotalBreakdown();
    updateBookBtn();
    clearIdentityReturnParamsFromUrl();

    if (verifiedIdentitySessionId) {
      setTimeout(function() { launchSlingshotPayment(); }, 0);
    }
  }());

  updateBookBtn();
  updateTotalBreakdown();
}

function showExtendSection() {
  var bookingSec = document.getElementById("bookingSection");
  var extSec     = document.getElementById("extendSection");
  if (bookingSec) bookingSec.style.display = "none";
  if (extSec)     extSec.style.display     = "";
  initExtendForm();
}

function initExtendForm() {
  // Show business hours note
  var bHoursNote = document.getElementById("extBusinessHoursNote");
  if (bHoursNote) bHoursNote.style.display = "";

  initPackagePicker("extPackageGrid", function(pkg) {
    extSelectedPackage = pkg;
    updateExtBtn();
  });

  var emailInput = document.getElementById("extEmail");
  var phoneInput = document.getElementById("extPhone");
  if (emailInput) emailInput.addEventListener("input", updateExtBtn);
  if (phoneInput) phoneInput.addEventListener("input", updateExtBtn);

  var submitBtn = document.getElementById("extSubmitBtn");
  if (submitBtn) submitBtn.addEventListener("click", launchExtendRentalPayment);

  updateExtBtn();
}

async function checkFleetStatus() {
  if (!vehicleId) return;
  try {
    var resp = await fetch(API_BASE + "/api/fleet-status");
    if (!resp.ok) return;
    var status = await resp.json();
    var entry = status[vehicleId];
    if (entry && entry.available === false) {
      showExtendSection();
      var subtitle = document.getElementById("extSubtitle");
      if (subtitle) {
        var display = entry.next_available_display || "";
        subtitle.textContent = display
          ? "This slingshot is currently rented — available again: " + display + ". If you are the current renter, enter your contact info below to extend your rental."
          : "This slingshot is currently rented. If you are the current renter, enter your contact info below to extend your rental.";
      }
    }
  } catch (err) {
    console.warn("slingshot-book: could not check fleet status:", err);
  }
}
