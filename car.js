// ----- API Base URL -----
// The frontend is served by GitHub Pages (www.slytrans.com).
// The API functions are deployed on Vercel (sly-rides.vercel.app).
// Because they are on different domains, the full Vercel URL must be used here.
const API_BASE = "https://sly-rides.vercel.app";
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;

// Upfront hold amount for Camry "Reserve with Deposit" option ($50 charged now; rest at pickup).
const CAMRY_BOOKING_DEPOSIT = 50;
// Vehicle IDs that support the "Reserve with Deposit" option.
const CAMRY_VEHICLE_IDS = ['camry', 'camry2013'];
// Los Angeles combined sales tax rate — must mirror LA_TAX_RATE in api/_pricing.js.
// Use getTaxRate() in calculations so the admin-configurable value is always used.
const LA_TAX_RATE = 0.1025;
function getTaxRate() { return window._dynamicTaxRate || LA_TAX_RATE; }

// ----- Car Data -----
// Vehicle data is loaded dynamically from /api/v2-vehicles so adding a new
// vehicle in the admin panel automatically makes it bookable — no code change
// needed.  buildCarDataFromAPI() below maps the API response into this object.
const cars = {};

// ----- Insurance / Protection Plan -----
// Economy car protection plan tiers (flat daily rates — must mirror api/_pricing.js).
const PROTECTION_PLAN_BASIC    = 15;   // Basic: $15/day
const PROTECTION_PLAN_STANDARD = 30;   // Standard: $30/day (default)
const PROTECTION_PLAN_PREMIUM  = 50;   // Premium: $50/day

const pageParams = new URLSearchParams(window.location.search);
const ADMIN_OVERRIDE = /^(true|1)$/i.test(pageParams.get("admin_override") || "");
const TEST_MODE = /^(true|1)$/i.test(pageParams.get("test_mode") || "");
const IS_TEST_MODE_OVERRIDE = ADMIN_OVERRIDE && TEST_MODE;

// ----- Helpers -----
function getVehicleFromURL() {
  return pageParams.get("vehicle");
}

// i18n helper — translates a key using lang.js if available, else returns fallback.
function _t(key, fallback) {
  return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t(key) : (fallback || key);
}

// Format helper — replaces {placeholder} tokens in a translated string.
function _fmt(key, vars, fallback) {
  let s = _t(key, fallback || key);
  if (vars) {
    Object.keys(vars).forEach(function(k) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    });
  }
  return s;
}

// Show an inline error near the pay buttons (replaces alert() which Chrome can suppress).
function showPayError(msg) {
  const el = document.getElementById("payError");
  if (!el) { console.error("Payment error:", msg); return; }
  el.textContent = msg;
  el.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearPayError() {
  const el = document.getElementById("payError");
  if (el) { el.textContent = ""; el.style.display = "none"; }
}

// ----- Dynamic Pricing -----
// Fetches live prices from the admin System Settings (Supabase) so that any
// rate change in the admin panel is immediately reflected on the booking page.
// Runs asynchronously after page load — falls back to the hard-coded values
// above if the API is unreachable or returns an error.
(function loadDynamicPricing() {
  fetch(API_BASE + "/api/public-pricing")
    .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
    .then(function(pricing) {
      // ── Economy cars ──────────────────────────────────────────────────────
      var ecDaily   = (pricing.economy && pricing.economy.daily)   ? Number(pricing.economy.daily)   : 0;
      var ecWeekly  = (pricing.economy && pricing.economy.weekly)  ? Number(pricing.economy.weekly)  : 0;
      var ecBiWeek  = (pricing.economy && pricing.economy.biweekly)? Number(pricing.economy.biweekly): 0;
      var ecMonthly = (pricing.economy && pricing.economy.monthly) ? Number(pricing.economy.monthly) : 0;

      // Apply economy-wide pricing ONLY to vehicles that do not have their own
      // per-vehicle rates loaded from the DB (i.e. _hasOwnPricing is false).
      // Vehicles like fusion2017 that have explicit rates in vehicle_pricing must
      // NOT be overwritten with the camry economy rates — that is what caused
      // fusion2017 to flip between $350 (economy) and $400 (its actual rate).
      Object.keys(cars).forEach(function(vid) {
        if (!cars[vid]) return;
        if (cars[vid]._hasOwnPricing) return; // already has authoritative per-vehicle pricing
        if (ecDaily   > 0) cars[vid].pricePerDay = ecDaily;
        if (ecWeekly  > 0) cars[vid].weekly      = ecWeekly;
        if (ecBiWeek  > 0) cars[vid].biweekly    = ecBiWeek;
        if (ecMonthly > 0) cars[vid].monthly     = ecMonthly;
      });

      // ── Tax rate ─────────────────────────────────────────────────────────
      // (already set as a module-level const; we update the global so
      //  any later calculation that references LA_TAX_RATE by closure reads
      //  the updated value — functions that captured it directly are re-called
      //  naturally through user interaction.)
      if (pricing.tax_rate) {
        window._dynamicTaxRate = Number(pricing.tax_rate);
      }

      // Refresh the displayed price for the current vehicle only when economy
      // rates were actually applied (i.e. the vehicle has no own pricing).
      if (carData && !carData._hasOwnPricing) {
        var priceEl = document.getElementById("carPrice");
        if (priceEl) {
          priceEl.textContent = carData.weekly
            ? "$" + carData.pricePerDay + " / " + _t("fleet.unitDay","day") + " \u2022 " + _t("fleet.priceFrom","from") + " $" + carData.weekly + " / " + _t("fleet.unitWeek","week")
            : "$" + carData.pricePerDay + " / " + _t("fleet.unitDay","day");
        }
        // Also refresh the earnings block in case the weekly rate changed.
        updateEarningsBlock();
      }
    })
    .catch(function(err) {
      // Non-fatal — hard-coded values remain in effect
      console.warn("car.js: could not load dynamic pricing, using defaults:", err.message);
    });
}());

const vehicleId = getVehicleFromURL();

// carData is populated asynchronously after fetching from the API.
// All event handlers below reference carData via closure — they are only
// triggered by user interaction, which always happens after initialization.
let carData = null;

// ----- API vehicle normalizer -----
// Maps fields returned by /api/v2-vehicles into the shape car.js expects.
// Handles both admin-created vehicles (daily_price, weekly_price, cover_image)
// and legacy static entries (pricePerDay, weekly, images).
function normalizeApiVehicle(v) {
  function toNum(n) { var x = Number(n); return Number.isFinite(x) && x > 0 ? x : null; }
  return {
    name:          v.vehicle_name || v.name || v.vehicle_id,
    subtitle:      v.subtitle     || "",
    subtitleKey:   v.subtitleKey  || null,
    pricePerDay:   toNum(v.daily_price    !== undefined ? v.daily_price    : v.pricePerDay),
    minRentalDays: Math.max(1, parseInt(v.min_rental_days || v.minRentalDays || 1, 10)),
    weekly:        toNum(v.weekly_price   !== undefined ? v.weekly_price   : v.weekly),
    biweekly:      toNum(v.biweekly_price !== undefined ? v.biweekly_price : v.biweekly),
    monthly:       toNum(v.monthly_price  !== undefined ? v.monthly_price  : v.monthly),
    deposit:       toNum(v.deposit),
    // True when the vehicle has explicit per-vehicle rates from the vehicle_pricing DB table
    // (indicated by daily_price or weekly_price being present in the API response).
    // loadDynamicPricing() skips vehicles with _hasOwnPricing so the economy-wide
    // camry rates never overwrite a vehicle's own authoritative pricing.
    _hasOwnPricing: v.daily_price != null || v.weekly_price != null,
    images:        (function() {
      if (Array.isArray(v.images) && v.images.length) return v.images;
      var imgs = v.cover_image ? [v.cover_image] : [];
      if (Array.isArray(v.gallery_images)) {
        v.gallery_images.forEach(function(u) { if (u && imgs.indexOf(u) === -1) imgs.push(u); });
      }
      return imgs.length ? imgs : [];
    })(),
    make:          v.make  || "",
    model:         v.model || v.vehicle_name || "",
    year:          v.vehicle_year || v.year  || "",
    vin:           v.vin   || "",
    color:         v.color || "",
    scarcity_text: v.scarcity_text || "",
    earnings_tagline: v.earnings_tagline || "",
    earnings_title:   v.earnings_title   || "",
    earnings_row1:    v.earnings_row1    || "",
    earnings_cta:     v.earnings_cta     || "",
  };
}

// Average weekly rideshare earnings range used in the earnings example block.
const EARNINGS_EXAMPLE_LOW  = 1200;  // $1,200 low-end weekly rideshare earnings (Los Angeles)
const EARNINGS_EXAMPLE_HIGH = 1600;  // $1,600 high-end weekly rideshare earnings (Los Angeles)

// ----- Earnings block updater -----
// Updates the earnings block on the booking page with per-vehicle text and
// computed prices.  Called from initCarDisplay() and re-called after every
// language switch so the amounts stay correct.
// Per-vehicle values stored on carData (earnings_tagline, earnings_title,
// earnings_row1, earnings_cta) take priority over lang.js defaults.
function updateEarningsBlock() {
  if (!carData) return;
  const weekly = carData.weekly;

  // Update static text rows with per-vehicle override or fall back to i18n default.
  const taglineEl = document.querySelector("[data-i18n='booking.earningsTagline']");
  if (taglineEl && carData.earnings_tagline) {
    taglineEl.textContent = carData.earnings_tagline;
    taglineEl.removeAttribute("data-i18n");
  }
  const titleEl = document.querySelector("[data-i18n='booking.earningsTitle']");
  if (titleEl && carData.earnings_title) {
    titleEl.textContent = carData.earnings_title;
    titleEl.removeAttribute("data-i18n");
  }
  const row1El = document.querySelector("[data-i18n='booking.earningsRow1']");
  if (row1El && carData.earnings_row1) {
    row1El.textContent = carData.earnings_row1;
    row1El.removeAttribute("data-i18n");
  }
  const ctaEl = document.querySelector("[data-i18n-html='booking.earningsCtaHtml']");
  if (ctaEl && carData.earnings_cta) {
    ctaEl.textContent = carData.earnings_cta;
    ctaEl.removeAttribute("data-i18n-html");
  }

  if (!weekly) return;
  const takeHomeLow  = EARNINGS_EXAMPLE_LOW  - weekly;
  const takeHomeHigh = EARNINGS_EXAMPLE_HIGH - weekly;
  const row2 = document.getElementById("earningsRow2");
  const row3 = document.getElementById("earningsRow3");
  if (row2) {
    // Get translated label ("Weekly rental: …" or "Alquiler semanal: …") and
    // swap the hardcoded amount for the vehicle's actual weekly rate.
    const tmpl2 = _t("booking.earningsRow2Html",
      `Weekly rental: <span class="earnings-yellow">$${weekly}</span>`);
    row2.innerHTML = tmpl2.replace(/\$[\d,]+/, `$${weekly}`);
  }
  if (row3) {
    // Swap the hardcoded take-home range with values computed from this vehicle's rate.
    const tmpl3 = _t("booking.earningsRow3Html",
      `<span class="earnings-green">Estimated take-home:</span> $${takeHomeLow} \u2013 $${takeHomeHigh}`);
    row3.innerHTML = tmpl3.replace(/\$[\d,]+\s*[\u2013\-]\s*\$[\d,]+/,
      `$${takeHomeLow} \u2013 $${takeHomeHigh}`);
  }
}

// Wrap slyI18n.applyTranslations once so the earnings block is refreshed on every
// language switch.  Called once after carData is first loaded.
let _earningsHookInstalled = false;
function installEarningsTranslationHook() {
  if (_earningsHookInstalled) return;
  if (!window.slyI18n || !window.slyI18n.applyTranslations) return;
  const _origApply = window.slyI18n.applyTranslations;
  window.slyI18n.applyTranslations = function() {
    _origApply.call(window.slyI18n);
    updateEarningsBlock();
  };
  _earningsHookInstalled = true;
}

// ----- Page display initializer -----
// Called once carData is ready — sets page title, price, and builds the image slider.
function initCarDisplay() {
  document.getElementById("carName").textContent = carData.name;

  // Point the "Complete Booking" header button to the booking section of this vehicle's page.
  const completeBookingBtn = document.getElementById("completeBookingBtn");
  if (completeBookingBtn) {
    completeBookingBtn.href = `car.html?vehicle=${vehicleId}#booking`;
  }
  document.getElementById("carSubtitle").textContent =
    (carData.subtitleKey && window.slyI18n) ? window.slyI18n.t(carData.subtitleKey) : carData.subtitle;
  document.getElementById("carPrice").textContent = carData.weekly
    ? `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")} \u2022 ${_t("fleet.priceFrom","from")} $${carData.weekly} / ${_t("fleet.unitWeek","week")}`
    : `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")}`;

  // Populate the earnings block with this vehicle's actual weekly rate and install
  // the translation hook so language switches keep it correct.
  updateEarningsBlock();
  installEarningsTranslationHook();

  if (IS_TEST_MODE_OVERRIDE) {
    const bookingSection = document.querySelector(".booking");
    if (bookingSection) {
      const testModeBanner = document.createElement("div");
      testModeBanner.id = "testModeBanner";
      testModeBanner.textContent = "TEST MODE – availability override active";
      testModeBanner.style.cssText = "background:#fff3cd;color:#7a4f01;border:1px solid #ffe69c;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-weight:700;";
      bookingSection.insertBefore(testModeBanner, bookingSection.firstChild);
    }
  }

  const sliderContainer = document.getElementById("sliderContainer");
  const sliderDots = document.getElementById("sliderDots");
  let currentSlide = 0;

  // Load images — fall back to the logo when no images are available.
  const imagesToShow = (carData.images && carData.images.length) ? carData.images : ["images/logo.jpg"];
  imagesToShow.forEach((imgSrc, idx) => {
    const img = document.createElement("img");
    img.src = imgSrc;
    img.classList.add("slide");
    if (idx === 0) img.classList.add("active");
    sliderContainer.appendChild(img);

    const dot = document.createElement("span");
    dot.classList.add("dot");
    if (idx === 0) dot.classList.add("active");
    dot.addEventListener("click", () => goToSlide(idx));
    sliderDots.appendChild(dot);
  });

  function showSlide(index) {
    const slides = sliderContainer.querySelectorAll(".slide");
    const dots = sliderDots.querySelectorAll(".dot");
    slides.forEach((s,i)=>s.classList.toggle("active", i===index));
    dots.forEach((d,i)=>d.classList.toggle("active", i===index));
    currentSlide = index;
  }

  function nextSlide() { showSlide((currentSlide+1) % imagesToShow.length); }
  function prevSlide() { showSlide((currentSlide-1+imagesToShow.length) % imagesToShow.length); }
  document.getElementById("nextSlide").addEventListener("click", nextSlide);
  document.getElementById("prevSlide").addEventListener("click", prevSlide);
  function goToSlide(idx){ showSlide(idx); }
}

// ----- Vehicle lookup -----
// All vehicles are fetched from /api/v2-vehicles (single source of truth).
if (!vehicleId) {
  alert(window.slyI18n ? window.slyI18n.t("booking.alertVehicleNotFound") : "Vehicle not found.");
  window.location.href = "index.html";
} else {
  (async function fetchAndInitVehicle() {
    try {
      const resp = await fetch(API_BASE + "/api/v2-vehicles");
      if (resp.ok) {
        const vehicles = await resp.json();
        const found = Array.isArray(vehicles) && vehicles.find(function(v) {
          return v.vehicle_id === vehicleId && (!v.status || v.status === "active");
        });
        if (found) {
          carData = normalizeApiVehicle(found);
          cars[vehicleId] = carData; // cache so loadDynamicPricing can update it too
          initCarDisplay();
          return;
        }
      }
    } catch (_) { /* fall through */ }
    // Vehicle not found in API — redirect to fleet page
    alert(window.slyI18n ? window.slyI18n.t("booking.alertVehicleNotFound") : "Vehicle not found.");
    window.location.href = "index.html";
  }());
}

// ----- Back Button -----
document.getElementById("backBtn").addEventListener("click", ()=>{
  window.location.href = "cars.html";
});

// ----- Booking Form Automation -----
const pickup = document.getElementById("pickup");
const pickupTime = document.getElementById("pickupTime");
const returnDate = document.getElementById("return");
const returnTime = document.getElementById("returnTime");
const agreeCheckbox = document.getElementById("agree");
const idUpload = document.getElementById("idUpload");
const insuranceUpload = document.getElementById("insuranceUpload");
const totalEl = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");

let uploadedFile = null;
let uploadedInsurance = null;
let currentDayCount = 1;
let currentSubtotal = 0;
let agreementSignature = ""; // typed signature from the inline agreement panel
let insuranceCoverageChoice = null; // 'yes' | 'no' | null
// Payment mode for the current payment attempt: 'deposit' | 'full'.
// Set by reserveBtn before delegating to stripeBtn; reset after each attempt.
let _pendingPaymentMode = null;
// Economy car protection plan tier selected on the booking page: basic | standard | premium
// Defaults to "standard" (pre-populated from Apply Now / Waitlist preference).
let selectedProtectionTier = "standard";


// For Camry vehicles: show the "Reserve with Deposit" button and the deposit notice so renters
// can choose between paying a $50 deposit now (rest at pickup) or paying in full today.
// Only applicable to CAMRY_VEHICLE_IDS — other vehicles (e.g. fusion2017) do not use deposit mode.
if (CAMRY_VEHICLE_IDS.includes(vehicleId)) {
  const reserveBtnEl = document.getElementById("reserveBtn");
  if (reserveBtnEl) {
    reserveBtnEl.textContent = `\uD83D\uDD12 Reserve with $${CAMRY_BOOKING_DEPOSIT} Deposit`;
    reserveBtnEl.style.display = "";
  }
  const camryDepNotice = document.getElementById("camryDepositNotice");
  if (camryDepNotice) camryDepNotice.style.display = "";
}

// ----- Name Field Validation & Auto-correction -----

// Capitalize the first letter after each word boundary (spaces, hyphens, apostrophes)
function toTitleCase(str) {
  return str.replace(/(?:^|[\s'\-])([a-zA-ZÀ-ÖØ-öø-ÿ])/g, function (m) {
    return m.toUpperCase();
  });
}

// Remove any character that is not a letter, space, hyphen, apostrophe, or period.
function sanitizeNameInput(val) {
  return val.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ\s'\-.]/g, '');
}

// Name must contain at least a first and last name (two words)
function isValidName(val) {
  return val.trim().split(/\s+/).filter(Boolean).length >= 2;
}

(function setupNameField() {
  const nameField = document.getElementById('name');
  const nameError = document.getElementById('nameError');

  nameField.addEventListener('input', function () {
    const cleaned = sanitizeNameInput(this.value);
    if (cleaned !== this.value) { this.value = cleaned; }
    // Hide the error while the user is still typing
    if (nameError) { nameError.style.display = 'none'; }
    updatePayBtn();
  });

  nameField.addEventListener('blur', function () {
    if (this.value.trim()) {
      this.value = toTitleCase(this.value.trim().replace(/\s+/g, ' '));
    }
    // Show validation error if the name is present but incomplete
    if (nameError) {
      const val = this.value.trim();
      if (val && !isValidName(val)) {
        nameError.textContent = window.slyI18n ? window.slyI18n.t("booking.nameError") : 'Please enter at least a first and last name.';
        nameError.style.display = '';
      } else {
        nameError.style.display = 'none';
      }
    }
    updatePayBtn();
  });
}());

// ----- Pre-fill from Apply Now application (localStorage) or Waitlist (sessionStorage) -----
// When an applicant submits the "Apply Now" form their name, phone, email, insurance choice,
// and protection plan preference are stored in localStorage under "slyApplicant".
// Waitlist entries store the same fields in sessionStorage under "slyWaitlistEntry".
// If that data exists we pre-fill the booking-form fields so the renter doesn't have to
// re-enter information they already provided. Waitlist data takes precedence over Apply data.
(function prefillFromApplication() {
  try {
    // Prefer the more-recent waitlist entry (sessionStorage) over the apply entry (localStorage).
    let data = null;
    const wlRaw = sessionStorage.getItem("slyWaitlistEntry");
    if (wlRaw) {
      const wl = JSON.parse(wlRaw);
      // Only use waitlist data if it matches the vehicle being booked
      if (!wl.vehicleId || wl.vehicleId === vehicleId) {
        data = wl;
      }
    }
    if (!data) {
      const applyRaw = localStorage.getItem("slyApplicant");
      if (applyRaw) data = JSON.parse(applyRaw);
    }
    if (!data) return;

    const nameField  = document.getElementById("name");
    const emailField = document.getElementById("email");
    const phoneField = document.getElementById("phone");
    if (data.name  && nameField  && !nameField.value)  { nameField.value  = data.name;  updatePayBtn(); }
    if (data.email && emailField && !emailField.value) { emailField.value = data.email; updatePayBtn(); }
    if (data.phone && phoneField && !phoneField.value) { phoneField.value = data.phone; updatePayBtn(); }

    // Pre-select protection plan tier (default to standard if not stored)
    const pref = data.protectionPlanPref || data.protectionPlan;
    if (pref === "basic" || pref === "standard" || pref === "premium") {
      selectedProtectionTier = pref;
    }
    // Pre-select insurance radio and show/hide appropriate sections
    const hasInsurance = data.hasInsurance;
    if (hasInsurance === "yes") {
      insuranceCoverageChoice = "yes";
      const hasInsRadio = document.getElementById("hasInsurance");
      const insSection  = document.getElementById("insuranceUploadSection");
      if (hasInsRadio) hasInsRadio.checked = true;
      if (insSection)  insSection.style.display = "";
      document.getElementById("protectionPlanSection").style.display = "none";
    } else if (hasInsurance === "no") {
      insuranceCoverageChoice = "no";
      const noInsRadio     = document.getElementById("noInsurance");
      const protSection    = document.getElementById("protectionPlanSection");
      const insSection     = document.getElementById("insuranceUploadSection");
      if (noInsRadio)   noInsRadio.checked = true;
      if (insSection)   insSection.style.display = "none";
      if (protSection)  protSection.style.display = "";
      _syncProtectionTierRadio(selectedProtectionTier);
    }
    updatePayBtn();
  } catch (_) { /* storage may be blocked in private mode */ }
}());

// Also sanitize the signature input so it only accepts valid name characters
(function setupSignatureField() {
  const sigInput = document.getElementById('signatureInput');
  if (!sigInput) return;
  sigInput.addEventListener('input', function () {
    const cleaned = sanitizeNameInput(this.value);
    if (cleaned !== this.value) { this.value = cleaned; }
  });
}());

// ----- File Upload Handling -----
function resetFileInfo() {
  const fileInfoEl = document.getElementById("fileInfo");
  fileInfoEl.querySelector(".file-name").textContent = window.slyI18n ? window.slyI18n.t("booking.fileNotSelected") : "No file selected";
  fileInfoEl.querySelector(".file-size").textContent = "";
  fileInfoEl.classList.remove("has-file");
}

function resetInsuranceFileInfo() {
  const el = document.getElementById("insuranceFileInfo");
  el.querySelector(".file-name").textContent = window.slyI18n ? window.slyI18n.t("booking.fileNotSelected") : "No file selected";
  el.querySelector(".file-size").textContent = "";
  el.classList.remove("has-file");
}

function clearInsuranceFile() {
  insuranceUpload.value = "";
  uploadedInsurance = null;
  resetInsuranceFileInfo();
}

// ----- Insurance Coverage Radio Buttons -----
document.getElementById("hasInsurance").addEventListener("change", function() {
  if (!this.checked) return;
  insuranceCoverageChoice = "yes";
  document.getElementById("insuranceUploadSection").style.display = "";
  document.getElementById("protectionPlanSection").style.display = "none";
  // Clear any protection-plan file state if previously "no"
  updateTotal();
  updatePayBtn();
});

document.getElementById("noInsurance").addEventListener("change", function() {
  if (!this.checked) return;
  insuranceCoverageChoice = "no";
  document.getElementById("insuranceUploadSection").style.display = "none";
  document.getElementById("protectionPlanSection").style.display = "";
  // Ensure the pre-selected tier radio is checked in the UI
  _syncProtectionTierRadio(selectedProtectionTier);
  // Clear the uploaded insurance file since it's no longer needed
  clearInsuranceFile();
  updateTotal();
  updatePayBtn();
});


// ----- Economy Car: Protection Plan Tier Selection -----
// Syncs the tier radio buttons in #protectionPlanSection to the given tier value.
function _syncProtectionTierRadio(tier) {
  const radio = document.querySelector('input[name="bookingProtectionPlan"][value="' + tier + '"]');
  if (radio) radio.checked = true;
}

// Attach change handlers to the tier radios.
(function setupProtectionTierListeners() {
  document.querySelectorAll('input[name="bookingProtectionPlan"]').forEach(function(radio) {
    radio.addEventListener("change", function() {
      if (!this.checked) return;
      selectedProtectionTier = this.value;
      updateTotal();
      updatePayBtn();
    });
  });
}());

idUpload.addEventListener("change", function(e) {
  const file = e.target.files[0];

  if (!file) {
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (!allowedTypes.includes(file.type)) {
    alert(window.slyI18n.t("booking.alertIdType"));
    e.target.value = '';
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  // Validate file size (5MB max)
  const maxSize = 5 * 1024 * 1024; // 5MB in bytes
  if (file.size > maxSize) {
    alert(window.slyI18n.t("booking.alertFileSize"));
    e.target.value = '';
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  uploadedFile = file;
  const fileInfoEl = document.getElementById("fileInfo");
  fileInfoEl.querySelector(".file-name").textContent = file.name;
  fileInfoEl.querySelector(".file-size").textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
  fileInfoEl.classList.add("has-file");
  updatePayBtn();
});

insuranceUpload.addEventListener("change", function(e) {
  const file = e.target.files[0];

  if (!file) {
    uploadedInsurance = null;
    resetInsuranceFileInfo();
    updatePayBtn();
    return;
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (!allowedTypes.includes(file.type)) {
    alert(window.slyI18n.t("booking.alertInsuranceType"));
    e.target.value = '';
    uploadedInsurance = null;
    resetInsuranceFileInfo();
    updatePayBtn();
    return;
  }

  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    alert(window.slyI18n.t("booking.alertFileSize"));
    e.target.value = '';
    uploadedInsurance = null;
    resetInsuranceFileInfo();
    updatePayBtn();
    return;
  }

  uploadedInsurance = file;
  const el = document.getElementById("insuranceFileInfo");
  el.querySelector(".file-name").textContent = file.name;
  el.querySelector(".file-size").textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
  el.classList.add("has-file");
  updatePayBtn();
});


// Block past dates — only allow today or future dates
const todayStr = SlyLA.todayISO();
pickup.setAttribute("min", todayStr);
returnDate.setAttribute("min", todayStr);

agreeCheckbox.addEventListener("change", updatePayBtn);
document.getElementById("name").addEventListener("input", updatePayBtn);
document.getElementById("email").addEventListener("input", updatePayBtn);
document.getElementById("phone").addEventListener("input", updatePayBtn);

// ----- Inline Rental Agreement / Signing -----
// Opens the inline agreement panel pre-filled with the current booking details.
// No external service is used — the customer reads the terms and types their
// full name as an electronic signature.  The typed name is stored in
// agreementSignature and included in the owner confirmation email.
document.getElementById("signAgreementBtn").addEventListener("click", function () {
  const renterName = document.getElementById("name").value.trim();
  const pickupVal  = document.getElementById("pickup").value;
  const returnVal  = document.getElementById("return").value;
  // Hoist lang to function scope so it is available throughout the handler
  // (e.g. for the payment terms section below) regardless of element presence.
  const lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";

  // Populate the agreement intro paragraph with live booking details
  const intro = document.getElementById("agreementIntro");
  if (intro) {
    const namePart   = renterName  ? `<strong>${renterName}</strong>` : "<strong>[Renter]</strong>";
    const carPart    = `<strong>${carData.name}</strong>`;
    const pickPart   = pickupVal  ? `<strong>${SlyLA.formatLocalDateTime(pickupVal, pickupTime.value)}</strong>`  : "<strong>[pickup date]</strong>";
    const retPart    = returnVal  ? `<strong>${SlyLA.formatLocalDateTime(returnVal, returnTime.value)}</strong>`  : "<strong>[return date]</strong>";
    if (lang === "es") {
      intro.innerHTML = `Este Contrato de Alquiler es celebrado entre SLY Transportation Services ("Empresa") y ${namePart} ("Arrendatario") para el alquiler de ${carPart} desde ${pickPart} hasta ${retPart}.`;
    } else {
      intro.innerHTML = `This Rental Agreement is entered into between SLY Transportation Services ("Company") and ${namePart} ("Renter") for the rental of a ${carPart} from ${pickPart} to ${retPart}.`;
    }
  }

  // Populate vehicle details section
  const elMake  = document.getElementById("agreementVehicleMake");
  const elModel = document.getElementById("agreementVehicleModel");
  const elYear  = document.getElementById("agreementVehicleYear");
  const elVin   = document.getElementById("agreementVehicleVin");
  const elColor = document.getElementById("agreementVehicleColor");
  const colorRow = document.getElementById("agreementColorRow");
  if (elMake)  elMake.textContent  = carData.make  || "";
  if (elModel) elModel.textContent = carData.model || "";
  if (elYear)  elYear.textContent  = carData.year  || "";
  if (elVin)   elVin.textContent   = carData.vin   || "";
  if (elColor) elColor.textContent = carData.color || "";
  if (colorRow) colorRow.style.display = carData.color ? "" : "none";

  // Update the Security Deposit section.
  // Camry vehicles have no security deposit — the entire section is hidden.
  const depositHeadingEl  = document.getElementById("agreementDepositHeading");
  const depositIntroEl    = document.getElementById("agreementDepositIntro");
  const depositInsEl      = document.getElementById("agreementDepositInsurance");
  const depositDppEl      = document.getElementById("agreementDepositDpp");
  const depositNeitherEl  = document.getElementById("agreementDepositNeither");
  const lateFeeGenericEl  = document.getElementById("lateFeeGeneric");
  // For Camry (economy): no security deposit — hide the entire deposit section.
  if (depositHeadingEl) depositHeadingEl.style.display = "none";
  if (depositIntroEl)   depositIntroEl.style.display   = "none";
  if (depositInsEl)     depositInsEl.style.display     = "none";
  if (depositDppEl)     depositDppEl.style.display     = "none";
  if (depositNeitherEl) depositNeitherEl.style.display = "none";
  // Show generic late fee
  if (lateFeeGenericEl) lateFeeGenericEl.style.display = "";

  // Populate the protection choice summary and update the
  // tier-specific liability cap text in the Insurance & Liability section.
    const protChoiceEl = document.getElementById("agreementProtectionChoice");
    const dppReducesEl = document.getElementById("agreementDppReduces");
    const withPlanEl   = document.getElementById("agreementWithPlanBody");
    // Compute tier info once so it can be reused in both the choice summary
    // and the liability-cap paragraphs below.
    const tierName = selectedProtectionTier === "basic" ? "Basic"
      : selectedProtectionTier === "premium" ? "Premium"
      : "Standard";
    const tierRate = selectedProtectionTier === "basic" ? PROTECTION_PLAN_BASIC
      : selectedProtectionTier === "premium" ? PROTECTION_PLAN_PREMIUM
      : PROTECTION_PLAN_STANDARD;
    const tierCap = selectedProtectionTier === "basic" ? "$2,500"
      : selectedProtectionTier === "premium" ? "$500"
      : "$1,000";
    // Build the all-tiers summary from the same source as the per-tier selection,
    // so the values stay in sync if tier rates/caps are ever updated.
    const allTiersCapsText = `Basic: $2,500 \u2022 Standard: $1,000 \u2022 Premium: $500`;
    if (protChoiceEl) {
      if (insuranceCoverageChoice === "yes") {
        protChoiceEl.innerHTML = "<strong>Your protection choice:</strong> You have provided your own personal auto insurance. Proof of insurance is required at pickup.";
        protChoiceEl.style.display = "";
      } else if (insuranceCoverageChoice === "no") {
        protChoiceEl.innerHTML = `<strong>Your protection choice:</strong> <strong>${tierName} Damage Protection Plan</strong> ($${tierRate}/day) — limits your damage liability to <strong>${tierCap} per incident</strong>.`;
        protChoiceEl.style.display = "";
      } else {
        protChoiceEl.style.display = "none";
      }
    }
    // Update the "reduces" and "with plan" paragraphs to show the correct
    // tier-specific liability cap.
    if (insuranceCoverageChoice === "no") {
      if (dppReducesEl) {
        dppReducesEl.removeAttribute("data-i18n-html");
        dppReducesEl.innerHTML = `This plan reduces the renter\u2019s financial responsibility for covered vehicle damage. Liability cap depends on plan selected (${allTiersCapsText} per incident). Your selected plan (<strong>${tierName}</strong>) limits your liability to <strong>${tierCap} per incident</strong>.`;
      }
      if (withPlanEl) {
        withPlanEl.removeAttribute("data-i18n-html");
        withPlanEl.innerHTML = `<strong>With Protection Plan:</strong> Renter\u2019s maximum liability for covered vehicle damage is limited to <strong>${tierCap} per incident</strong> under the selected plan. Any damage costs exceeding this cap are covered by the plan, provided all terms of this agreement are followed.`;
      }
    } else {
      // Restore generic tier-info text (in case the user switched from "no" to "yes" insurance).
      if (dppReducesEl && !dppReducesEl.hasAttribute("data-i18n-html")) {
        dppReducesEl.setAttribute("data-i18n-html", "agreement.dppReduces");
      }
      if (withPlanEl && !withPlanEl.hasAttribute("data-i18n-html")) {
        withPlanEl.setAttribute("data-i18n-html", "agreement.withPlanBody");
      }
    }

  // Update Payment Terms body to accurately describe when/how payment is collected.
  // Removing data-i18n prevents applyTranslations() from overwriting the corrected text.
  const paymentTermsBodyEl = document.getElementById("agreementPaymentTermsBody");
  if (paymentTermsBodyEl) {
    paymentTermsBodyEl.removeAttribute("data-i18n");
    // Camry: full payment online, OR $50 deposit if renter chose "Reserve Now"
    paymentTermsBodyEl.textContent = lang === "es"
      ? "El pago completo del alquiler se cobra en l\u00EDnea al momento de la reserva. Si el arrendatario elige 'Reservar con dep\u00F3sito', solo se cobran $50 ahora y el saldo restante vence al momento de la recogida. Los pagos atrasados acumulan intereses del 1.5% mensual. Cargo por cheque devuelto (NSF): $35."
      : "Full rental payment is charged online at the time of booking. If the renter chose \u2018Reserve with Deposit\u2019, only $50 is charged now and the remaining balance is due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.";
  }

  // Pre-fill the signature field with the renter's name if already typed
  const sigInput = document.getElementById("signatureInput");
  if (sigInput && renterName && !sigInput.value) {
    sigInput.value = renterName;
    // Programmatic value assignment doesn't fire the 'input' event, so
    // manually sync the confirm button's disabled state to avoid the renter
    // having to delete and retype their name just to enable the button.
    document.getElementById("confirmSignBtn").disabled = false;
  }

  document.getElementById("rentalAgreementBox").style.display = "";
  if (window.slyI18n && typeof window.slyI18n.applyTranslations === "function") {
    window.slyI18n.applyTranslations();
  }
  this.style.display = "none";
  document.getElementById("signAgreementStatus").style.display = "none";
});

// Enable the confirm button only when the signature field has text
document.getElementById("signatureInput").addEventListener("input", function () {
  document.getElementById("confirmSignBtn").disabled = this.value.trim() === "";
  const sigError = document.getElementById("signatureError");
  if (sigError) { sigError.style.display = "none"; sigError.textContent = ""; }
});

// Confirm & Sign
document.getElementById("confirmSignBtn").addEventListener("click", function () {
  const sig = document.getElementById("signatureInput").value.trim();
  if (!sig) return;

  // Ensure the typed signature matches the Full Name entered in the booking form
  const renterName = document.getElementById("name").value.trim();
  const sigError = document.getElementById("signatureError");
  if (renterName && sig.toLowerCase() !== renterName.toLowerCase()) {
    if (sigError) {
      sigError.textContent = window.slyI18n ? window.slyI18n.t("booking.sigError") : "Signature must match the full name entered in the booking form.";
      sigError.style.display = "";
    }
    return;
  }

  agreementSignature = sig;

  document.getElementById("rentalAgreementBox").style.display = "none";
  document.getElementById("signAgreementBtn").style.display  = "";

  const btn    = document.getElementById("signAgreementBtn");
  const status = document.getElementById("signAgreementStatus");
  btn.classList.add("signed");
  btn.textContent = window.slyI18n ? window.slyI18n.t("booking.signedBtn") : "✅ Rental Agreement Signed";

  status.style.display = "";
  status.style.color   = "#4caf50";
  const signedByTpl = window.slyI18n ? window.slyI18n.t("booking.signedByNote") : "Signed by {name}. Check the box below to confirm.";
  status.textContent   = signedByTpl.replace("{name}", sig);

  const checkbox = document.getElementById("agree");
  checkbox.disabled = false;
  updatePayBtn();
});

// Cancel — close the panel and restore the button
document.getElementById("cancelSignBtn").addEventListener("click", function () {
  document.getElementById("rentalAgreementBox").style.display = "none";
  document.getElementById("signAgreementBtn").style.display  = "";
});

let returnPicker = null;

// Fixed time slots available for booking (displayed as options in the pickup time select).
const TIME_SLOTS = ["08:00 AM", "10:00 AM", "12:00 PM", "02:00 PM", "04:00 PM", "06:00 PM"];
// Minimum buffer (hours) between a car's return and the next available pickup slot.
const PICKUP_BUFFER_HOURS = 2;

// Module-level cache of booked ranges used by updatePickupTimeSlots().
// Populated (and refreshed) each time initDatePickers() fetches from the API.
let bookedRangesCache = [];

// Parse any supported time string ("HH:MM" or "h:MM AM/PM") combined with a
// YYYY-MM-DD date into a Unix-millisecond timestamp.  Returns NaN on failure.
function parseAnyTimeToMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return NaN;
  const ampm = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  const h24  = String(timeStr).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  let h, m;
  if (ampm) {
    h = parseInt(ampm[1], 10);
    m = parseInt(ampm[2], 10);
    const p = ampm[3].toUpperCase();
    if (p === "PM" && h !== 12) h += 12;
    if (p === "AM" && h === 12) h = 0;
  } else if (h24) {
    h = parseInt(h24[1], 10);
    m = parseInt(h24[2], 10);
  } else {
    return NaN;
  }
  // Use multi-argument constructor so there is no ISO-string UTC interpretation.
  return new Date(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)), h, m).getTime();
}

// Convert a "h:MM AM/PM" time slot string to "HH:MM" for native <input type="time">.
function timeSlotToHH(slot) {
  const m = String(slot).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  const mins = m[2];
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return String(h).padStart(2, "0") + ":" + mins;
}

// Returns true when the given slot on dateStr is blocked by an existing booking
// (i.e. the car hasn't been returned + buffered yet when this slot starts).
function isSlotBlocked(dateStr, slot, ranges) {
  const slotMs = parseAnyTimeToMs(dateStr, slot);
  if (isNaN(slotMs)) return false;
  for (const r of ranges) {
    if (r.to !== dateStr) continue; // only bookings returning on this date matter
    if (!r.toTime) {
      // Legacy entry without a return time: conservatively block the whole day.
      return true;
    }
    const returnMs = parseAnyTimeToMs(r.to, r.toTime);
    if (isNaN(returnMs)) continue;
    if (returnMs + PICKUP_BUFFER_HOURS * 3600000 > slotMs) return true;
  }
  return false;
}

// Populate the #pickupTime <select> with TIME_SLOTS, disabling any slot that
// falls within PICKUP_BUFFER_HOURS of an existing booking's return on that date.
// Option values are HH:MM (24-hour) for consistent backend transport; labels
// remain AM/PM for display.  Auto-selects the first available slot and syncs returnTime.
function updatePickupTimeSlots(selectedDate) {
  pickupTime.innerHTML = '<option value="">\u2014 Select a pickup time \u2014</option>';
  const noTimesMsg = document.getElementById("noTimesMsg");
  if (!selectedDate) {
    if (noTimesMsg) noTimesMsg.style.display = "none";
    updatePayBtn();
    return;
  }

  TIME_SLOTS.forEach(function(slot) {
    const opt = document.createElement("option");
    // Store the value as HH:MM (24-hour) so the backend always receives a
    // consistent format regardless of AM/PM display label.
    opt.value = timeSlotToHH(slot);
    opt.textContent = slot; // AM/PM label for the user

    if (IS_TEST_MODE_OVERRIDE) {
      opt.disabled = false;
    } else {
      opt.disabled = isSlotBlocked(selectedDate, slot, bookedRangesCache);
    }

    pickupTime.appendChild(opt);
  });

  // Auto-select the first non-disabled slot, or show "no times" warning.
  const firstAvail = pickupTime.querySelector("option:not([disabled]):not([value=''])");
  if (firstAvail) {
    firstAvail.selected = true;
    // Value is already HH:MM — assign directly without conversion.
    returnTime.value = firstAvail.value;
    if (noTimesMsg) noTimesMsg.style.display = "none";
  } else {
    returnTime.value = "";
    if (noTimesMsg) noTimesMsg.style.display = "";
  }

  updateTotal();
  updatePayBtn();
}

// Flag set to true inside initDatePickers() once Flatpickr takes over.
// Flatpickr already fires native change events after its own onChange, so
// the native listeners below must skip when Flatpickr is active to avoid
// calling updateTotal() twice on every selection.
// pickupTime is now a <select> and is handled by its own dedicated listener below.
let flatpickrActive = false;
[pickup, returnDate, returnTime].forEach(function(inp) {
  inp.addEventListener("change", function() {
    if (flatpickrActive) return; // Flatpickr's own onChange handles this
    updateTotal();
  });
});

// Dedicated change listener for the pickupTime <select>.
// Values are already HH:MM so returnTime is assigned directly.
pickupTime.addEventListener("change", function() {
  const slot = this.value; // HH:MM
  returnTime.value = slot || "";
  updateTotal();
  updatePayBtn();
});

// Tamper-prevention: returnTime must always equal pickupTime.
// These listeners fire if anyone manually edits the hidden input via DevTools.
returnTime.addEventListener("input", function() {
  this.value = pickupTime.value || "";
  updatePayBtn();
});
returnTime.addEventListener("change", function() {
  if (flatpickrActive) return; // let Flatpickr's onChange handle the returnDate sibling
  this.value = pickupTime.value || "";
  updatePayBtn();
});

  // ----- Date Pickers (Flatpickr) -----
async function initDatePickers() {
  if (typeof flatpickr === "undefined") return; // fallback to native inputs

  let bookedRanges = [];
  try {
    // Fetch from the Vercel API endpoint instead of the GitHub Pages static file.
    // GitHub Pages CDN caches files for several minutes after a commit, so the
    // static file often shows stale (empty) data even after a booking is saved.
    // The /api/booked-dates endpoint reads directly from the GitHub Contents API
    // with Cache-Control: no-store, so new bookings appear immediately.
    const resp = await fetch(`${API_BASE}/api/booked-dates`);
    if (resp.ok) {
      const data = await resp.json();
      bookedRanges = data[vehicleId] || [];
      bookedRangesCache = bookedRanges;
    }
  } catch (e) { console.error("Failed to load booked dates:", e); }

  // Pre-compile range boundaries to millisecond timestamps once so the
  // disable callback never allocates new Date objects per calendar cell.
  // End date is exclusive: the return date is not blocked in the calendar.
  const compiledRanges = bookedRanges.map(function(r) {
    return {
      from: new Date(r.from + "T00:00:00").getTime(),
      to:   new Date(r.to   + "T00:00:00").getTime()
    };
  });

  function isBooked(date) {
    if (IS_TEST_MODE_OVERRIDE) return false;
    const t = date.getTime();
    return compiledRanges.some(function(r) { return t >= r.from && t < r.to; });
  }

  const pickupPicker = flatpickr(pickup, {
    minDate: "today",
    disable: [isBooked],
    onChange: function(selectedDates) {
      if (selectedDates[0]) {
        if (carData.minRentalDays > 1) {
          const minReturn = new Date(selectedDates[0]);
          minReturn.setDate(minReturn.getDate() + carData.minRentalDays);
          if (returnPicker) returnPicker.set("minDate", minReturn);
        } else {
          if (returnPicker) returnPicker.set("minDate", selectedDates[0]);
        }
      }
      // Populate/refresh time slots for the newly selected pickup date.
      let dateStr = "";
      if (selectedDates[0]) {
        dateStr = window.SlyLA
          ? window.SlyLA.isoDateInLA(selectedDates[0])
          : selectedDates[0].toISOString().slice(0, 10);
      }
      updatePickupTimeSlots(dateStr);
    }
  });

  returnPicker = flatpickr(returnDate, {
    minDate: "today",
    disable: [isBooked],
    onChange: function() {
      updateTotal();
    }
  });

  // pickupTime is now a <select> — no Flatpickr needed.
  // returnTime mirrors pickupTime and is set programmatically; no Flatpickr needed.

  // Flatpickr is now fully active; native change listeners will defer to it.
  flatpickrActive = true;
}

initDatePickers();

// ----- Fleet Status Check -----
// Fetch the vehicle's availability from the fleet-status API.  If the vehicle
// is unavailable (active booking exists), replace the booking form with the
// Extend Rental section.
// Fails open on any API error so transient outages do not lock out the form.

// When ?extend=1 is present the user came from the "Extend Rental" button on
// cars.html — show the extend section immediately without waiting for fleet-status.
if (/^(true|1)$/i.test(pageParams.get("extend") || "")) {
  showVehicleUnavailable(null, null);
}

(async function checkFleetStatus() {
  if (IS_TEST_MODE_OVERRIDE) return;
  try {
    const fleetResp = await fetch(`${API_BASE}/api/fleet-status`);
    if (!fleetResp.ok) return;
    const status = await fleetResp.json();

    const entry = status[vehicleId];
    const isUnavailable = !!(entry && entry.available === false);

    if (isUnavailable) {
      const idsToCheck = [vehicleId]; // single vehicle for Camry

      let availableAt = null;
      let nextAvailableDisplay = null;
      for (const id of idsToCheck) {
        const entry = status[id];
        if (entry && entry.available === false) {
          if (entry.available_at) {
            if (!availableAt || entry.available_at < availableAt) {
              availableAt = entry.available_at;
              nextAvailableDisplay = entry.next_available_display || null;
            }
          } else if (!nextAvailableDisplay && entry.next_available_display) {
            // Date-only block (no end_time): capture display string for date-only unavailability.
            nextAvailableDisplay = entry.next_available_display;
          }
        }
      }

      showVehicleUnavailable(availableAt, nextAvailableDisplay);
    }
  } catch (err) {
    console.warn("Could not check fleet status:", err);
  }
})();

function showVehicleUnavailable(nextAvailableISO, nextAvailableDisplay) {
  const bookingSection = document.querySelector(".booking");
  if (!bookingSection) return;

  if (nextAvailableISO) {
    // Set minimum new return date in the extend form to the current return date
    // (i.e. the date the vehicle becomes available) so the customer cannot pick
    // a date before the active rental ends.
    const extReturn = document.getElementById("extNewReturn");
    if (extReturn) {
      let minDate = SlyLA.todayISO();
      const d2 = new Date(nextAvailableISO);
      if (Number.isFinite(d2.getTime())) {
        // Compare LA-timezone date strings to avoid timezone/DST edge cases.
        const returnDateISO = SlyLA.isoDateInLA(d2);
        if (returnDateISO > minDate) minDate = returnDateISO;
      }
      extReturn.setAttribute("min", minDate);
    }
  }

  // ── Hide the regular booking form elements ────────────────────────────
  // Hide the heading and all regular form inputs/sections.  The extend rental
  // section is shown below instead so there are no duplicate "reserve" CTAs.
  const bookingHeading = bookingSection.querySelector("h2");
  if (bookingHeading) bookingHeading.style.display = "none";

  const regularIds = [
    "paymentRetryBanner",
    "pickup", "pickupTime", "returnDateSection",
    "name", "email", "phone",
    "nameError",
    "idSection", "idUpload", "fileInfo",
    "insuranceSection",
    "hasInsurance", "noInsurance",
    "insuranceUploadSection", "protectionPlanSection",
    "signAgreementBtn", "signAgreementStatus", "rentalAgreementBox",
    "camryDepositNotice",
    "priceBreakdown", "subtotal", "taxLine", "taxNote",
    "payHint", "reserveBtn", "stripePay",
    "payment-request-button", "payment-form",
    "smsConsent",
  ];
  regularIds.forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  // Also hide labels and blocks that only have for= attributes, using a broader selector
  bookingSection.querySelectorAll(
    'label[for="pickup"], label[for="pickupTime"], label[for="return"], label[for="returnTime"], ' +
    'label[for="name"], label[for="email"], label[for="phone"], label[for="idUpload"], ' +
    'label[for="insuranceUpload"], ' +
    '.sms-consent, .total, .pay-hint, .insurance-question, .insurance-options, ' +
    '.id-section, .insurance-upload-section, .protection-plan-section, ' +
    '#insuranceCoverage, .insurance-label'
  ).forEach(function(el) { el.style.display = "none"; });

  // Disable all remaining interactive elements so they cannot be submitted
  bookingSection.querySelectorAll("input, button, select, textarea").forEach(function(el) {
    if (!el.closest("#extendRentalSection")) el.disabled = true;
  });

  // ── Show the Extend Rental section ────────────────────────────────────
  const extendSection = document.getElementById("extendRentalSection");
  if (extendSection) {
    extendSection.style.display = "";
    // Fallback: ensure min is set to at least today if not already set above.
    const extReturn = document.getElementById("extNewReturn");
    if (extReturn && !extReturn.getAttribute("min")) {
      extReturn.setAttribute("min", SlyLA.todayISO());
    }
    // Update subtitle to show when the car is next available, if known.
    const subtitle = extendSection.querySelector(".waitlist-subtitle");
    if (subtitle) {
      if (nextAvailableDisplay) {
        subtitle.innerHTML =
          `This vehicle is currently rented \u2014 next available pickup: <strong style="color:#fbbf24;">${nextAvailableDisplay}</strong>.` +
          ` If you are the current renter, enter your contact info below to extend your rental period.` +
          `<span class="waitlist-queue-note" style="display:block;margin-top:8px;">` +
          `\u23F1 This time reflects a 2-hour preparation window added after the current rental\u2019s confirmed return time.` +
          `</span>`;
      } else {
        subtitle.textContent = "This vehicle is currently rented. If you are the current renter, enter your contact info below to extend your rental period.";
      }
    }
    // Initialize the extend rental form interactions
    initExtendRentalForm();
  }
}

// ----- Extend Rental Form -----
// Manages the "Extend Rental" form that is shown when the vehicle is currently
// rented.  The current renter enters their email/phone and new return date,
// then pays the extension charge via Stripe.
function initExtendRentalForm() {
  var extEmail      = document.getElementById("extEmail");
  var extPhone      = document.getElementById("extPhone");
  var extNewReturn  = document.getElementById("extNewReturn");
  var extSubmitBtn  = document.getElementById("extSubmitBtn");
  var extPayHint    = document.getElementById("extPayHint");
  var extPriceDisplay = document.getElementById("extPriceDisplay");
  var extPriceAmount  = document.getElementById("extPriceAmount");

  // Set today as the minimum new return date
  var todayISO = SlyLA.todayISO();
  if (extNewReturn && !extNewReturn.getAttribute("min")) {
    extNewReturn.setAttribute("min", todayISO);
  }

  function isValidEmailFmt(val) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  }

  // Compute and display a client-side extension price estimate.
  // The server will recompute the authoritative amount; this is just a preview.
  function updatePriceEstimate() {
    if (!extNewReturn || !extNewReturn.value) {
      if (extPriceDisplay) extPriceDisplay.style.display = "none";
      return;
    }

    var today = SlyLA.todayISO();
    var newReturn = extNewReturn.value;
    if (newReturn <= today) {
      if (extPriceDisplay) extPriceDisplay.style.display = "none";
      return;
    }

    if (!carData) {
      if (extPriceDisplay) extPriceDisplay.style.display = "none";
      return;
    }

    // Base date for computing extra days: use the current booking's return date
    // (stored as the min attribute on the date input) so the estimate matches
    // what the server charges.  Falls back to today if min is not set or is in
    // the past (e.g. overdue rentals).
    var minDate = extNewReturn.getAttribute("min") || today;
    var baseDate = minDate > today ? minDate : today;

    // Use the same tiered pricing as the main booking flow
    var extraDays = Math.max(1, Math.ceil((new Date(newReturn) - new Date(baseDate)) / (1000 * 3600 * 24)));
    var daily   = carData.pricePerDay  || 55;
    var weekly  = carData.weekly       || 350;
    var biweek  = carData.biweekly     || 650;
    var monthly = carData.monthly      || 1300;

    var cost2 = 0;
    var rem   = extraDays;
    if (rem >= 30) { cost2 += Math.floor(rem / 30) * monthly;  rem = rem % 30; }
    if (rem >= 14) { cost2 += Math.floor(rem / 14) * biweek;   rem = rem % 14; }
    if (rem >= 7)  { cost2 += Math.floor(rem / 7)  * weekly;   rem = rem % 7;  }
    cost2 += rem * daily;

    if (extPriceAmount) extPriceAmount.textContent = cost2.toFixed(0);

    if (extPriceDisplay) extPriceDisplay.style.display = "";
  }

  function updateExtBtn() {
    var emailOk  = extEmail && isValidEmailFmt(extEmail.value.trim());
    var phoneOk  = extPhone && extPhone.value.trim().length >= 7;
    var dateOk   = extNewReturn && extNewReturn.value;
    var contactOk = emailOk || phoneOk;
    var ready    = contactOk && dateOk;
    if (extSubmitBtn) extSubmitBtn.disabled = !ready;
    if (extPayHint) extPayHint.style.display = ready ? "none" : "";
  }

  [extEmail, extPhone].forEach(function(el) {
    if (el) el.addEventListener("input", updateExtBtn);
  });

  if (extNewReturn) {
    extNewReturn.addEventListener("change", function() {
      updateExtBtn();
      updatePriceEstimate();
    });
  }
  updateExtBtn();

  if (extSubmitBtn) {
    extSubmitBtn.addEventListener("click", launchExtendRentalPayment);
  }
}

async function launchExtendRentalPayment() {
  var extEmail      = document.getElementById("extEmail").value.trim();
  var extPhone      = (document.getElementById("extPhone") || {}).value || "";
  var newReturnDate = document.getElementById("extNewReturn").value;

  var submitBtn = document.getElementById("extSubmitBtn");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = _t("booking.loadingPayment", "Loading payment…"); }

  try {
    var resp = await fetch(API_BASE + "/api/extend-rental", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId,
        email:         extEmail,
        phone:         extPhone.trim(),
        newReturnDate,
      }),
    });
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Server error");

    var { clientSecret, publishableKey, extensionAmount, extensionLabel, lateFeeIncluded, deferredLateFee, newReturnDate: confirmedDate, newReturnTime: confirmedTime, vehicleName, renterName } = data;
    if (!clientSecret || !publishableKey) throw new Error("Invalid server response");

    var stripe   = Stripe(publishableKey);
    var elements = stripe.elements({
      clientSecret,
      locale: (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en",
      ...(extEmail ? { defaultValues: { billingDetails: { email: extEmail } } } : {}),
    });

    var paymentElement = elements.create("payment");

    // Show the Stripe payment form; hide the sign-up form
    var extForm = document.getElementById("extendRentalForm");
    if (extForm) extForm.style.display = "none";
    var extPayForm = document.getElementById("extPaymentForm");
    if (extPayForm) extPayForm.style.display = "";

    // Populate the summary box
    var summaryEl = document.getElementById("ext-rental-summary");
    if (summaryEl) {
      var displayReturn = SlyLA.formatLocalDateTime(confirmedDate, confirmedTime);
      var lateFeeHtml = "";
      if (lateFeeIncluded && Number(lateFeeIncluded) > 0) {
        lateFeeHtml += "Late return fee: $" + Number(lateFeeIncluded).toFixed(2) + "<br>";
      }
      if (deferredLateFee && Number(deferredLateFee) > 0) {
        lateFeeHtml += "Previously deferred late fee: $" + Number(deferredLateFee).toFixed(2) + "<br>";
      }
      summaryEl.innerHTML =
        "<strong>⏱️ Rental Extension</strong><br>" +
        (vehicleName ? "Vehicle: " + vehicleName + "<br>" : "") +
        (renterName  ? "Renter: "  + renterName  + "<br>" : "") +
        "Extension: " + extensionLabel + "<br>" +
        lateFeeHtml +
        "<strong>New Return: " + displayReturn + "</strong><br>" +
        "<strong style='color:#ffb400'>Total: $" + extensionAmount + "</strong>";
    }

    // Update the pay button label
    var extPayAmount = document.getElementById("extPayAmount");
    if (extPayAmount) extPayAmount.textContent = extensionAmount;

    paymentElement.mount("#ext-payment-element");

    var submitPayBtn = document.getElementById("ext-submit-payment");
    var cancelPayBtn = document.getElementById("ext-cancel-payment");
    var msgEl        = document.getElementById("ext-payment-message");

    var submitting = false;

    var handleExtSubmit = async function() {
      if (submitting) return;
      submitting = true;
      submitPayBtn.disabled    = true;
      submitPayBtn.innerHTML   = _t("booking.processingPayment", "Processing…");
      if (msgEl) msgEl.textContent = "";

      var result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: "https://www.slytrans.com/success.html?ext=1&vehicle=" + encodeURIComponent(vehicleId),
          ...(extEmail ? { receipt_email: extEmail } : {}),
        },
      });

      if (result.error) {
        if (msgEl) msgEl.textContent = result.error.message;
        submitPayBtn.disabled  = false;
        submitPayBtn.innerHTML = "Pay $" + extensionAmount + " Now 🔒";
        submitting = false;
      }
      // On success Stripe redirects — no cleanup needed here
    };
    submitPayBtn.addEventListener("click", handleExtSubmit);

    var handleExtCancel = function() {
      submitting = false;
      submitPayBtn.removeEventListener("click", handleExtSubmit);
      cancelPayBtn.removeEventListener("click", handleExtCancel);
      paymentElement.unmount();
      if (msgEl) msgEl.textContent = "";
      if (extPayForm) extPayForm.style.display = "none";
      if (extForm) extForm.style.display = "";
      // Re-enable the extend button
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "⏱️ Extend Rental";
      }
    };
    cancelPayBtn.addEventListener("click", handleExtCancel);

  } catch (err) {
    console.error("Extend rental payment error:", err);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "⏱️ Extend Rental";
    }
    alert(err.message || _t("booking.loadError", "Could not launch payment. Please try again."));
  }
}


// ----- Payment Retry Pre-fill -----
// Converts a Base64 string (stored in IndexedDB) back into a Blob.
function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// Restores all form fields, insurance choice, signature, and uploaded files
// from a previous payment attempt that ended in failure.  Called on every
// pageshow so it works for both fresh page loads and bfcache restores.
function restoreFailedBooking() {
  try {
    const stored = sessionStorage.getItem("slyRidesBooking");
    if (!stored) return;
    const data = JSON.parse(stored);
    if (!data.paymentFailed) return;

    // Helper: set a date/time input respecting Flatpickr when active.
    // For native <input type="time"> fallback, converts "h:i K" (e.g. "2:30 PM")
    // to "HH:MM" which is the format the native input requires.
    // For <select> elements (pickupTime), just sets the value directly.
    function fpSet(input, value) {
      if (!value || !input) return;
      if (input.tagName === "SELECT") {
        input.value = value;
        return;
      }
      if (flatpickrActive && input._flatpickr) {
        input._flatpickr.setDate(value, true);
      } else {
        // Normalize Flatpickr "h:i K" time format → "HH:MM" for native time inputs
        const ampm = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (ampm) {
          let h = parseInt(ampm[1], 10);
          const mins = ampm[2];
          const period = ampm[3].toUpperCase();
          if (period === "PM" && h !== 12) h += 12;
          if (period === "AM" && h === 12) h = 0;
          input.value = String(h).padStart(2, "0") + ":" + mins;
        } else {
          input.value = value;
        }
      }
    }

    // Restore personal details
    const nameField  = document.getElementById("name");
    const emailField = document.getElementById("email");
    const phoneField = document.getElementById("phone");
    if (data.name  && nameField)  nameField.value  = data.name;
    if (data.email && emailField) emailField.value = data.email;
    if (data.phone && phoneField) phoneField.value = data.phone;

    // Restore dates / times
    fpSet(pickup, data.pickup);
    // Populate time slots for the restored pickup date before restoring the selected time.
    if (data.pickup) updatePickupTimeSlots(data.pickup.slice(0, 10));
    fpSet(pickupTime, data.pickupTime);
    // Sync returnTime to match restored pickupTime
    // pickupTime.value is HH:MM; if legacy stored value is AM/PM, convert it.
    if (data.pickupTime) returnTime.value = timeSlotToHH(data.pickupTime) || data.pickupTime;
    fpSet(returnDate, data.returnDate);

    // Restore insurance / protection-plan choice.
    // insuranceCoverageChoice is saved explicitly in the failed-payment entry
    // since v2 of this feature.  The legacy fallback (from protectionPlan /
    // insuranceFileName) handles entries persisted by an earlier release.
    const choice = data.insuranceCoverageChoice ||
      (data.protectionPlan === true ? "no" : (data.insuranceFileName ? "yes" : null));
    if (choice) {
      insuranceCoverageChoice = choice;
      const hasInsuranceRadio   = document.getElementById("hasInsurance");
      const noInsuranceRadio    = document.getElementById("noInsurance");
      const insuranceSection    = document.getElementById("insuranceUploadSection");
      const protectionSection   = document.getElementById("protectionPlanSection");
      if (choice === "yes") {
        if (hasInsuranceRadio) hasInsuranceRadio.checked = true;
        if (insuranceSection)  insuranceSection.style.display  = "";
        if (protectionSection) protectionSection.style.display = "none";
      } else {
        if (noInsuranceRadio)  noInsuranceRadio.checked  = true;
        if (insuranceSection)  insuranceSection.style.display  = "none";
        // Restore the protection plan tier
        if (data.protectionPlanTier) {
          selectedProtectionTier = data.protectionPlanTier;
        }
        if (protectionSection) protectionSection.style.display = "";
        _syncProtectionTierRadio(selectedProtectionTier);
      }
    }

    // Restore signed-agreement state
    if (data.signature) {
      agreementSignature = data.signature;
      const signBtn    = document.getElementById("signAgreementBtn");
      const signStatus = document.getElementById("signAgreementStatus");
      if (signBtn) {
        signBtn.classList.add("signed");
        signBtn.textContent = window.slyI18n ? window.slyI18n.t("booking.signedBtn") : "✅ Rental Agreement Signed";
        signBtn.style.display = "";
      }
      if (signStatus) {
        signStatus.style.display = "";
        signStatus.style.color   = "#4caf50";
        const tpl = window.slyI18n ? window.slyI18n.t("booking.signedByNote") : "Signed by {name}. Check the box below to confirm.";
        signStatus.textContent   = tpl.replace("{name}", data.signature);
      }
      agreeCheckbox.disabled = false;
      agreeCheckbox.checked  = true;
    }

    // Show the retry banner so the renter knows the form was pre-filled
    const retryBanner = document.getElementById("paymentRetryBanner");
    if (retryBanner) retryBanner.style.display = "";

    updateTotal();
    // Defer updatePayBtn until after the async IndexedDB file restoration
    // finishes so it only runs once with a complete picture of the form state.

    // Restore uploaded files from IndexedDB (async, finishes with updatePayBtn)
    try {
      const idbReq = indexedDB.open("slyRidesDB", 1);
      idbReq.onupgradeneeded = function(e) { e.target.result.createObjectStore("files"); };
      idbReq.onsuccess = function(e) {
        const db = e.target.result;
        try {
          const tx  = db.transaction("files", "readonly");
          const req = tx.objectStore("files").get("pendingId");
          req.onsuccess = function(ev) {
            const fileData = ev.target.result;
            db.close();
            if (!fileData) { updatePayBtn(); return; }

            if (fileData.idBase64 && fileData.idFileName && fileData.idMimeType) {
              const blob = base64ToBlob(fileData.idBase64, fileData.idMimeType);
              uploadedFile = new File([blob], fileData.idFileName, { type: fileData.idMimeType });
              const fileInfoEl = document.getElementById("fileInfo");
              if (fileInfoEl) {
                fileInfoEl.querySelector(".file-name").textContent = fileData.idFileName;
                fileInfoEl.querySelector(".file-size").textContent = `(${(blob.size / 1024).toFixed(1)} KB)`;
                fileInfoEl.classList.add("has-file");
              }
            }

            if (choice === "yes" && fileData.insuranceBase64 && fileData.insuranceFileName && fileData.insuranceMimeType) {
              const blob = base64ToBlob(fileData.insuranceBase64, fileData.insuranceMimeType);
              uploadedInsurance = new File([blob], fileData.insuranceFileName, { type: fileData.insuranceMimeType });
              const insEl = document.getElementById("insuranceFileInfo");
              if (insEl) {
                insEl.querySelector(".file-name").textContent = fileData.insuranceFileName;
                insEl.querySelector(".file-size").textContent = `(${(blob.size / 1024).toFixed(1)} KB)`;
                insEl.classList.add("has-file");
              }
            }

            updatePayBtn();
          };
          req.onerror = function() { db.close(); updatePayBtn(); };
        } catch (idbErr) { console.warn("restoreFailedBooking: IDB transaction error:", idbErr); db.close(); updatePayBtn(); }
      };
      idbReq.onerror = function() { console.warn("restoreFailedBooking: IDB open error"); updatePayBtn(); };
    } catch (idbErr) { console.warn("restoreFailedBooking: IDB unavailable:", idbErr); updatePayBtn(); }
  } catch (err) { console.warn("restoreFailedBooking: could not restore booking data:", err); }
}

// When the browser restores this page from bfcache (e.g. user hits "back"
// after the Stripe redirect), all field values and UI state from the previous
// renter's session would still be visible.  Resetting here ensures each new
// visitor starts with a completely blank form.
window.addEventListener("pageshow", function(e) {
  if (e.persisted) {
  document.getElementById("name").value = "";
  document.getElementById("email").value = "";
  document.getElementById("phone").value = "";
  pickup.value = "";
  returnDate.value = "";
  pickupTime.innerHTML = '<option value="">\u2014 Select a pickup time \u2014</option>';
  pickupTime.value = "";
  returnTime.value = "";
  idUpload.value = "";
  uploadedFile = null;
  resetFileInfo();
  clearInsuranceFile();
  // Reset insurance coverage radio buttons
  const hasInsuranceRadio = document.getElementById("hasInsurance");
  const noInsuranceRadio = document.getElementById("noInsurance");
  if (hasInsuranceRadio) hasInsuranceRadio.checked = false;
  if (noInsuranceRadio) noInsuranceRadio.checked = false;
  insuranceCoverageChoice = null;
  const insuranceUploadSection = document.getElementById("insuranceUploadSection");
  const protectionPlanSection = document.getElementById("protectionPlanSection");
  if (insuranceUploadSection) insuranceUploadSection.style.display = "none";
  if (protectionPlanSection) protectionPlanSection.style.display = "none";
  const signBtn = document.getElementById("signAgreementBtn");
  signBtn.classList.remove("signed");
  signBtn.textContent = window.slyI18n ? window.slyI18n.t("booking.signAgreementBtn") : "✍ Review & Sign Rental Agreement";
  signBtn.style.display = "";
  const agreementBox = document.getElementById("rentalAgreementBox");
  if (agreementBox) agreementBox.style.display = "none";
  const sigInput = document.getElementById("signatureInput");
  if (sigInput) sigInput.value = "";
  const confirmBtn = document.getElementById("confirmSignBtn");
  if (confirmBtn) confirmBtn.disabled = true;
  agreementSignature = "";
  const status = document.getElementById("signAgreementStatus");
  status.style.display = "none";
  status.textContent = "";
  agreeCheckbox.disabled = true;
  agreeCheckbox.checked = false;
  const paymentForm = document.getElementById("payment-form");
  paymentForm.style.display = "none";
  const prBtnContainer = document.getElementById("payment-request-button");
  if (prBtnContainer) prBtnContainer.style.display = "none";
  document.getElementById("payment-message").textContent = "";
  stripeBtn.style.display = "";
  stripeBtn.textContent = window.slyI18n.t("booking.payNow");
  const _reserveBtnReset = document.getElementById("reserveBtn");
  if (_reserveBtnReset) {
    _reserveBtnReset.style.display = "";
    _reserveBtnReset.disabled = true;
  }
  _pendingPaymentMode = null;
  totalEl.textContent = "0";
  document.getElementById("subtotal").textContent = "0";
  document.getElementById("taxLine").style.display = "none";
  const taxNoteReset = document.getElementById("taxNote");
  if (taxNoteReset) taxNoteReset.style.display = "";
  currentSubtotal = 0;
  document.getElementById("priceBreakdown").style.display = "none";
  updatePayBtn();
  // Re-initialize Flatpickr so the calendar shows fresh state (no lingering
  // selected dates from the previous session) and fetches the latest booked
  // ranges from the API.
  initDatePickers();
  }
  // After any page restoration (bfcache or fresh load), check whether a
  // previous payment attempt failed and pre-fill the form if so.
  restoreFailedBooking();
});

function updatePayBtn() {
  const nameVal = document.getElementById("name").value.trim();
  const emailVal = document.getElementById("email").value.trim();
  // Insurance readiness:
  //   "yes"  → requires an uploaded file (own insurance)
  //   "no"   → requires a valid tier selection (basic/standard/premium)
  const tierReady = selectedProtectionTier === "basic" || selectedProtectionTier === "standard" || selectedProtectionTier === "premium";
  const insuranceReady = (insuranceCoverageChoice === "yes" && (insuranceUpload.files.length > 0 || uploadedInsurance !== null)) ||
                          (insuranceCoverageChoice === "no" && tierReady);
  const nameValid = isValidName(nameVal);
  const phoneVal = document.getElementById("phone").value.trim();
  // Requires pickup + return date + pickup time.
  // Pickup time is required: it anchors the rental window and
  // is used as the return time (return_time = pickup_time) for overlap prevention.
  const hasTimeWindow = returnDate.value && pickupTime.value && returnTime.value;
  const datesReady = pickup.value && hasTimeWindow;
  const ready = datesReady && agreeCheckbox.checked && (idUpload.files.length > 0 || uploadedFile !== null) && insuranceReady && nameValid && emailVal && phoneVal;
  stripeBtn.disabled = !ready;
  const _reserveBtnPayBtn = document.getElementById("reserveBtn");
  if (_reserveBtnPayBtn) _reserveBtnPayBtn.disabled = !ready;
  const hint = document.getElementById("payHint");
  if (hint) hint.style.display = ready ? "none" : "block";
}

function updateTotal() {
  // ----- Daily/weekly vehicles -----
  if (!carData) return; // vehicle data not yet loaded (async init path)
  if(!pickup.value || !returnDate.value) return;
  const minDays = carData.minRentalDays || 1;
  // Use explicit UTC arithmetic to count whole calendar days without any
  // ISO-string UTC-vs-local ambiguity.  Date.UTC() always gives midnight UTC.
  const [puY, puM, puD]   = pickup.value.split("-").map(Number);
  const [retY, retM, retD] = returnDate.value.split("-").map(Number);
  currentDayCount = Math.max(minDays, Math.ceil(
    (Date.UTC(retY, retM - 1, retD) - Date.UTC(puY, puM - 1, puD)) / (1000 * 3600 * 24)
  ));

  // Calculate cost using the best applicable discount tier (greedy: largest period first).
  // "Monthly" is defined as every 30-day block; this is intentional for a rental business
  // where rates are fixed regardless of calendar month lengths.
  let cost = 0;
  let remaining = currentDayCount;
  const lines = [];

  if (carData.monthly && remaining >= 30) {
    const months = Math.floor(remaining / 30);
    const subtotal = months * carData.monthly;
    cost += subtotal;
    remaining = remaining % 30;
    lines.push({ label: months === 1 ? _fmt("booking.fmtMonth1", { price: carData.monthly }, `1 month \u00D7 $${carData.monthly}/mo`) : _fmt("booking.fmtMonthN", { n: months, price: carData.monthly }, `${months} months \u00D7 $${carData.monthly}/mo`), amount: subtotal });
  }
  if (carData.biweekly && remaining >= 14) {
    const twoWeekPeriods = Math.floor(remaining / 14);
    const subtotal = twoWeekPeriods * carData.biweekly;
    cost += subtotal;
    remaining = remaining % 14;
    lines.push({ label: twoWeekPeriods === 1 ? _fmt("booking.fmtTwoWeeks1", { price: carData.biweekly }, `1 2-week period \u00D7 $${carData.biweekly}`) : _fmt("booking.fmtTwoWeeksN", { n: twoWeekPeriods, price: carData.biweekly }, `${twoWeekPeriods} 2-week periods \u00D7 $${carData.biweekly}`), amount: subtotal });
  }
  if (carData.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    const subtotal = weeks * carData.weekly;
    cost += subtotal;
    remaining = remaining % 7;
    lines.push({ label: weeks === 1 ? _fmt("booking.fmtWeek1", { price: carData.weekly }, `1 week \u00D7 $${carData.weekly}/wk`) : _fmt("booking.fmtWeekN", { n: weeks, price: carData.weekly }, `${weeks} weeks \u00D7 $${carData.weekly}/wk`), amount: subtotal });
  }
  if (remaining > 0) {
    const subtotal = remaining * carData.pricePerDay;
    cost += subtotal;
    lines.push({ label: remaining === 1 ? _fmt("booking.fmtDay1", { price: carData.pricePerDay }, `1 day \u00D7 $${carData.pricePerDay}/day`) : _fmt("booking.fmtDayN", { n: remaining, price: carData.pricePerDay }, `${remaining} days \u00D7 $${carData.pricePerDay}/day`), amount: subtotal });
  }
  // Security deposit is always charged (never waived)
  if (carData.deposit) {
    lines.push({ label: _t("booking.securityDeposit", "Security deposit"), amount: carData.deposit });
  }
  // Add Damage Protection Plan if the renter has no rental coverage.
  // Economy cars use flat tier rates (basic $15/day · standard $30/day · premium $50/day).
  if (insuranceCoverageChoice === "no") {
    const tierRate = selectedProtectionTier === "basic" ? PROTECTION_PLAN_BASIC
      : selectedProtectionTier === "premium" ? PROTECTION_PLAN_PREMIUM
      : PROTECTION_PLAN_STANDARD;
    const tierName = selectedProtectionTier === "basic" ? "Basic"
      : selectedProtectionTier === "premium" ? "Premium"
      : "Standard";
    const protectionCost = tierRate * currentDayCount;
    const dppLabel = currentDayCount === 1
      ? `${tierName} Protection (1 day \u00D7 $${tierRate}/day)`
      : `${tierName} Protection (${currentDayCount} days \u00D7 $${tierRate}/day)`;
    cost += protectionCost;
    lines.push({ label: dppLabel, amount: protectionCost });
  }

  const rentalSubtotal = cost + (carData.deposit || 0);
  currentSubtotal = rentalSubtotal;

  // Compute LA sales tax (10.25%) on the pre-tax total and include it in the charge.
  const taxAmount = Math.round(rentalSubtotal * getTaxRate() * 100) / 100;
  const afterTaxTotal = Math.round((rentalSubtotal + taxAmount) * 100) / 100;
  lines.push({ label: _fmt("booking.salesTaxFmt", { rate: (getTaxRate() * 100).toFixed(2) }, `Sales tax (${(getTaxRate() * 100).toFixed(2)}%)`), amount: taxAmount.toFixed(2) });

  const rowsEl = document.getElementById("breakdownRows");
  const frag = document.createDocumentFragment();
  lines.forEach(function(l) {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    const labelSpan = document.createElement("span");
    labelSpan.className = "breakdown-label";
    labelSpan.textContent = l.label;
    const valueSpan = document.createElement("span");
    valueSpan.className = "breakdown-value";
    valueSpan.textContent = "$" + l.amount;
    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    frag.appendChild(row);
  });
  rowsEl.innerHTML = "";
  rowsEl.appendChild(frag);
  document.getElementById("priceBreakdown").style.display = "";

  // Update the subtotal / tax / total display rows
  document.getElementById("subtotal").textContent = rentalSubtotal;
  const taxLineEl = document.getElementById("taxLine");
  const taxNoteEl = document.getElementById("taxNote");
  document.getElementById("tax").textContent = taxAmount.toFixed(2);
  taxLineEl.style.display = "";
  if (taxNoteEl) taxNoteEl.style.display = "none";
  totalEl.textContent = afterTaxTotal.toFixed(2);
  stripeBtn.textContent = window.slyI18n.t("booking.payPrefix") + afterTaxTotal.toFixed(2);
  updatePayBtn();
}

// ----- Pay Now -----
stripeBtn.addEventListener("click", async () => {
  // Resolve payment mode: _pendingPaymentMode is set by reserveBtn before it calls stripeBtn.click().
  if (_pendingPaymentMode === null) {
    _pendingPaymentMode = 'full';
  }
  const paymentMode = _pendingPaymentMode;
  _pendingPaymentMode = null; // consume and reset

  const email = document.getElementById("email").value;
  const nameVal = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  clearPayError();
  if (!email) { showPayError(window.slyI18n.t("booking.alertEmail")); return; }
  if (!nameVal) { showPayError(window.slyI18n.t("booking.alertName")); return; }
  if (!phone) { showPayError(window.slyI18n.t("booking.alertPhone")); return; }
  if (!pickup.value) { showPayError(window.slyI18n.t("booking.alertPickupDate") || "Please select a pickup date."); return; }
  if (!returnDate.value) { showPayError(window.slyI18n.t("booking.alertReturnDate")); return; }
  if (!pickupTime.value) { showPayError(window.slyI18n.t("booking.alertPickupTime")); return; }

  // Force returnTime to match pickupTime — no user-visible message needed here because
  // returnTime is a readonly input; this branch only fires if DevTools was used to edit it.
  // The server always derives return_time = pickup_time anyway, so this is a belt-and-suspenders sync.
  returnTime.value = pickupTime.value;
  if (!returnTime.value) { showPayError(window.slyI18n.t("booking.alertReturnTime")); return; }

  // Re-validate all required booking fields — guards against DevTools button enablement.
  // These checks mirror updatePayBtn() so bypassing the button state has no effect.
  if (!agreeCheckbox.checked) {
    showPayError("Please read and accept the Rental Agreement before proceeding.");
    return;
  }
  if (!isValidName(nameVal)) {
    showPayError(window.slyI18n.t("booking.alertName") || "Please enter your full first and last name.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showPayError(window.slyI18n.t("booking.alertEmail") || "Please enter a valid email address.");
    return;
  }
  if (uploadedFile === null && idUpload.files.length === 0) {
    showPayError("Please upload your Driver's License or government-issued ID before proceeding.");
    return;
  }
  if (insuranceCoverageChoice !== "yes" && insuranceCoverageChoice !== "no") {
    showPayError("Please indicate whether you have personal auto insurance or would like a Damage Protection Plan.");
    return;
  }
  if (insuranceCoverageChoice === "yes" && uploadedInsurance === null && insuranceUpload.files.length === 0) {
    showPayError("Please upload proof of insurance before proceeding.");
    return;
  }
  if (insuranceCoverageChoice === "no" &&
      selectedProtectionTier !== "basic" && selectedProtectionTier !== "standard" && selectedProtectionTier !== "premium") {
    showPayError("Please select a Damage Protection Plan tier (Basic, Standard, or Premium).");
    return;
  }
  const isCamryDepositMode = paymentMode === 'deposit';
  const camryDepositAmount = CAMRY_BOOKING_DEPOSIT;
  // totalEl already reflects the correct amount for the selected mode (set by updateTotal).
  const displayPayNow = isCamryDepositMode ? camryDepositAmount.toFixed(2) : totalEl.textContent;
  // For Camry deposit mode, compute the balance the renter still owes at pickup so
  // the confirmation email can display the exact amount (full after-tax total minus deposit).
  if (isCamryDepositMode) {
    const fullAmtFloat = parseFloat(totalEl.textContent);
    if (isFinite(fullAmtFloat) && fullAmtFloat > camryDepositAmount) {
      carData._balanceAtPickup = (fullAmtFloat - camryDepositAmount).toFixed(2);
    }
  }

  // Meta Pixel — track checkout initiation with the amount being charged
  if (typeof fbq === "function") {
    var _pixelCheckoutValue = parseFloat(String(displayPayNow).replace(/[^0-9.]/g, ""));
    fbq("track", "InitiateCheckout", {
      value: isFinite(_pixelCheckoutValue) ? _pixelCheckoutValue : 0,
      currency: "USD",
    });
  }

  stripeBtn.disabled = true;
  stripeBtn.textContent = window.slyI18n.t("booking.loadingPayment");
  const _reserveBtnLoading = document.getElementById("reserveBtn");
  if (_reserveBtnLoading) _reserveBtnLoading.disabled = true;

  // Pre-encode the ID file so it's ready when the user submits payment
  let idBase64 = null;
  let idFileName = null;
  let idMimeType = null;
  if (uploadedFile) {
    try {
      idBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(uploadedFile);
      });
      idFileName = uploadedFile.name;
      idMimeType = uploadedFile.type;
    } catch (err) {
      console.error("ID encoding error:", err);
      stripeBtn.disabled = false;
      stripeBtn.textContent = window.slyI18n.t("booking.payNow");
      const reserveBtn = document.getElementById("reserveBtn");
      if (reserveBtn) reserveBtn.disabled = false;
      _pendingPaymentMode = null;
      showPayError("Could not read your ID file. Please try re-uploading it and try again.");
      return;
    }
  }

  // Pre-encode the insurance file
  let insuranceBase64 = null;
  let insuranceFileName = null;
  let insuranceMimeType = null;
  if (uploadedInsurance) {
    try {
      insuranceBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(uploadedInsurance);
      });
      insuranceFileName = uploadedInsurance.name;
      insuranceMimeType = uploadedInsurance.type;
    } catch (err) {
      console.error("Insurance encoding error:", err);
    }
  }

  try {
    const res = await fetch(`${API_BASE}/api/create-payment-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId: vehicleId,
        name: nameVal,
        car: carData.name,
        email: email,
        phone: phone,
        pickup: pickup.value,
        pickupTime: pickupTime.value,
        returnDate: returnDate.value,
        returnTime: returnTime.value,
        protectionPlan: insuranceCoverageChoice === "no",
        // Pass the selected tier so the server uses the correct flat rate.
        ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        // Pass insurance choice for all vehicles so the server can enforce coverage requirements.
        insuranceCoverageChoice,
        // Pass file names so the server can enforce upload requirements as a server-side gate.
        idFileName: idFileName || null,
        insuranceFileName: insuranceCoverageChoice === "yes" ? (insuranceFileName || null) : null,
        paymentMode,
        adminOverride: ADMIN_OVERRIDE,
        testMode: TEST_MODE,
      })
    });

    const data = await res.json();

    if (!res.ok) {
      // Surface the server's error message so setup issues are visible
      const isDatesError = res.status === 409;
      throw Object.assign(new Error(data.error || "Server error (" + res.status + ")"), { isDatesError });
    }

    const { clientSecret, publishableKey, bookingId: pendingBookingId } = data;
    if (!clientSecret) {
      throw new Error("No clientSecret returned from server. Check that STRIPE_SECRET_KEY is set in your Vercel environment variables.");
    }
    if (!publishableKey) {
      throw new Error("No publishableKey returned from server. Check that STRIPE_PUBLISHABLE_KEY is set in your Vercel environment variables.");
    }

    // Persist the publishable key and client secret so success.html can
    // initialize Stripe.js and call stripe.retrievePaymentIntent() to verify
    // the actual payment status for ALL payment methods — including Apple Pay,
    // Google Pay, card, and Cash App — regardless of whether the redirect URL
    // contains payment_intent_client_secret.
    sessionStorage.setItem("slyStripePublishable", publishableKey);
    sessionStorage.setItem("slyPiSecret", clientSecret);

    // Initialize Stripe and mount the Payment Element
    const stripe = Stripe(publishableKey);
    const elements = stripe.elements({
      clientSecret,
      // Pass the user's selected language so the Payment Element (including
      // the Apple Pay sheet and Google Pay button) renders in the right locale.
      locale: (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en",
      defaultValues: {
        billingDetails: {
          name: nameVal,
          email: email,
        },
      },
    });

    // ----- Payment Request Button (Apple Pay / Google Pay) -----
    // Build a paymentRequest with a valid country ('US'), currency ('usd'), and
    // the confirmed total in whole cents.  canMakePayment() returns null when
    // the browser / device does not support any express wallet, so we guard
    // before mounting the button — this is what prevents the "Unable to show
    // Apple Pay" error that occurs when Apple Pay is displayed on unsupported
    // browsers or when the domain association file has not yet been verified.
    const totalCents = isCamryDepositMode
        ? Math.round(camryDepositAmount * 100)
        : Math.round(parseFloat(totalEl.textContent) * 100);
    const paymentReq = stripe.paymentRequest({
      country: "US",
      currency: "usd",
      total: {
        label: isCamryDepositMode ? carData.name + " Reservation Deposit" : carData.name + " Rental",
        amount: totalCents,
      },
      requestPayerName: true,
      requestPayerEmail: true,
    });

    const prContainer = document.getElementById("payment-request-button");
    let prButton = null;

    const canPay = await paymentReq.canMakePayment();
    if (canPay && prContainer) {
      prButton = elements.create("paymentRequestButton", { paymentRequest: paymentReq });
      prButton.mount("#payment-request-button");
      prContainer.style.display = "block";

      // Handle the payment authorization from Apple Pay / Google Pay.
      // We use handleActions:false so that Stripe does not attempt to render
      // its own confirmation UI inside the native wallet sheet.
      paymentReq.on("paymentmethod", async (ev) => {
        const prBookingPayload = {
          vehicleId,
          bookingId: pendingBookingId || null,
          car: carData.name,
          vehicleMake: carData.make || null,
          vehicleModel: carData.model || null,
          vehicleYear: carData.year || null,
          vehicleVin: carData.vin || null,
          vehicleColor: carData.color || null,
          name: nameVal,
          pickup: pickup.value,
          pickupTime: pickupTime.value,
          returnDate: returnDate.value,
          returnTime: returnTime.value,
          email,
          phone,
          total: displayPayNow,
          fullRentalCost: carData._fullRentalCost || totalEl.textContent,
          balanceAtPickup: carData._balanceAtPickup || null,
          pricePerDay: carData.pricePerDay || null,
          pricePerWeek: carData.weekly || null,
          pricePerBiWeekly: carData.biweekly || null,
          pricePerMonthly: carData.monthly || null,
          deposit: carData.deposit || 0,
          days: currentDayCount,
          idFileName,
          idMimeType,
          insuranceFileName,
          insuranceMimeType,
          insuranceCoverageChoice,
          protectionPlan: insuranceCoverageChoice === "no",
          ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
          signature: agreementSignature || null,
        };
        sessionStorage.setItem("slyRidesBooking", JSON.stringify(prBookingPayload));

        if ((idBase64 && idFileName) || (insuranceBase64 && insuranceFileName)) {
          try {
            await new Promise((resolve) => {
              const idbReq = indexedDB.open("slyRidesDB", 1);
              idbReq.onupgradeneeded = e => e.target.result.createObjectStore("files");
              idbReq.onsuccess = e => {
                const db = e.target.result;
                try {
                  const tx = db.transaction("files", "readwrite");
                  tx.objectStore("files").put({ idBase64, idFileName, idMimeType, insuranceBase64, insuranceFileName, insuranceMimeType }, "pendingId");
                  tx.oncomplete = () => { db.close(); resolve(); };
                  tx.onerror = () => { db.close(); resolve(); };
                } catch (idbErr) { db.close(); resolve(); }
              };
              idbReq.onerror = () => resolve();
            });
          } catch (idbErr) {
            console.warn("Could not save ID to IndexedDB:", idbErr);
          }
        }

        // Upload booking docs server-side so the Stripe webhook can send the
        // owner the full email (agreement PDF + ID + insurance) reliably,
        // even if the customer's browser does not reach success.html.
        if (pendingBookingId) {
          try {
            await Promise.race([
              fetch(API_BASE + "/api/store-booking-docs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  bookingId: pendingBookingId,
                  signature: agreementSignature || null,
                  idBase64: idBase64 || null,
                  idFileName: idFileName || null,
                  idMimeType: idMimeType || null,
                  insuranceBase64: insuranceBase64 || null,
                  insuranceFileName: insuranceFileName || null,
                  insuranceMimeType: insuranceMimeType || null,
                  insuranceCoverageChoice,
                }),
              }),
              new Promise(resolve => setTimeout(resolve, 5000)),
            ]);
          } catch (e) {
            console.warn("Could not upload booking docs:", e);
          }
        }

        const { paymentIntent, error: confirmError } = await stripe.confirmCardPayment(
          clientSecret,
          { payment_method: ev.paymentMethod.id },
          { handleActions: false }
        );

        if (confirmError) {
          ev.complete("fail");
          sessionStorage.setItem("slyRidesBooking", JSON.stringify({
            ...prBookingPayload,
            paymentFailed: true,
            insuranceCoverageChoice,
          }));
          document.getElementById("payment-message").textContent = confirmError.message;
        } else {
          ev.complete("success");
          if (paymentIntent.status === "requires_action") {
            // The payment requires additional action (e.g. 3D Secure).
            const { error: actionError } = await stripe.confirmCardPayment(clientSecret, {
              payment_method: ev.paymentMethod.id,
            });
            if (actionError) {
              sessionStorage.setItem("slyRidesBooking", JSON.stringify({
                ...prBookingPayload,
                paymentFailed: true,
                insuranceCoverageChoice,
              }));
              document.getElementById("payment-message").textContent = actionError.message;
            } else {
              window.location.href = "https://www.slytrans.com/success.html?vehicle=" + encodeURIComponent(vehicleId);
            }
          } else {
            window.location.href = "https://www.slytrans.com/success.html?vehicle=" + encodeURIComponent(vehicleId);
          }
        }
      });
    }

    // Collect the cardholder name from our booking form (already validated).
    // Hide the duplicate name field inside the Stripe Payment Element so the
    // customer cannot accidentally clear or override it.
    const paymentElement = elements.create("payment", {
      fields: {
        billingDetails: { name: "never" },
      },
    });

    const paymentForm = document.getElementById("payment-form");
    document.getElementById("payAmount").textContent = displayPayNow;
    document.getElementById("submit-payment").textContent = window.slyI18n.t("booking.payPrefix") + displayPayNow;
    paymentForm.style.display = "block";
    stripeBtn.style.display = "none";
    const payHint = document.getElementById("payHint");
    if (payHint) payHint.style.display = "none";

    paymentElement.mount("#payment-element");
    paymentForm.scrollIntoView({ behavior: "smooth", block: "start" });

    // Handle cancel — go back to booking form.
    // { once: true } is intentional: each "Pay Now" click registers a fresh cancel
    // listener inside its own closure, so once-per-showing is exactly what we want.
    let paymentSubmitting = false;

    const submitHandler = async () => {
      if (paymentSubmitting) return;
      paymentSubmitting = true;
      const submitBtn = document.getElementById("submit-payment");
      const msgEl = document.getElementById("payment-message");
      submitBtn.disabled = true;
      submitBtn.textContent = window.slyI18n.t("booking.processingPayment");
      msgEl.textContent = "";

      // Store booking data in sessionStorage so success.html can send the
      // confirmation email AFTER the payment redirect completes.
      // (A fire-and-forget fetch here is cancelled by the browser redirect.)
      const bookingPayload = {
        vehicleId,
        bookingId: pendingBookingId || null,
        car: carData.name,
        vehicleMake: carData.make || null,
        vehicleModel: carData.model || null,
        vehicleYear: carData.year || null,
        vehicleVin: carData.vin || null,
        vehicleColor: carData.color || null,
        name: nameVal,
        pickup: pickup.value,
        pickupTime: pickupTime.value,
        returnDate: returnDate.value,
        returnTime: returnTime.value,
        email,
        phone,
        total: displayPayNow,
        fullRentalCost: carData._fullRentalCost || totalEl.textContent,
        balanceAtPickup: carData._balanceAtPickup || null,
        pricePerDay: carData.pricePerDay || null,
        pricePerWeek: carData.weekly || null,
        pricePerBiWeekly: carData.biweekly || null,
        pricePerMonthly: carData.monthly || null,
        deposit: carData.deposit || 0,
        days: currentDayCount,
        idFileName,
        idMimeType,
        insuranceFileName,
        insuranceMimeType,
        insuranceCoverageChoice,
        protectionPlan: insuranceCoverageChoice === "no",
        ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        signature: agreementSignature || null,
      };
      // Store booking metadata in sessionStorage and the large ID binary in
      // IndexedDB (no size cap) so both survive the Stripe redirect reliably.
      sessionStorage.setItem("slyRidesBooking", JSON.stringify(bookingPayload));

      if ((idBase64 && idFileName) || (insuranceBase64 && insuranceFileName)) {
        const idbReq = indexedDB.open("slyRidesDB", 1);
        idbReq.onupgradeneeded = e => e.target.result.createObjectStore("files");
        idbReq.onsuccess = e => {
          const db = e.target.result;
          try {
            const tx = db.transaction("files", "readwrite");
            tx.objectStore("files").put({ idBase64, idFileName, idMimeType, insuranceBase64, insuranceFileName, insuranceMimeType }, "pendingId");
            tx.oncomplete = () => db.close();
            tx.onerror = () => db.close();
          } catch (idbErr) { db.close(); }
        };
        idbReq.onerror = () => {};
      }

      // Upload booking docs server-side so the Stripe webhook can send the
      // owner the full email (agreement PDF + ID + insurance) reliably,
      // even if the customer's browser does not reach success.html.
      if (pendingBookingId) {
        try {
          await Promise.race([
            fetch(API_BASE + "/api/store-booking-docs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bookingId: pendingBookingId,
                signature: agreementSignature || null,
                idBase64: idBase64 || null,
                idFileName: idFileName || null,
                idMimeType: idMimeType || null,
                insuranceBase64: insuranceBase64 || null,
                insuranceFileName: insuranceFileName || null,
                insuranceMimeType: insuranceMimeType || null,
                insuranceCoverageChoice,
              }),
            }),
            new Promise(resolve => setTimeout(resolve, 5000)),
          ]);
        } catch (docsErr) {
          console.warn("store-booking-docs: non-critical upload failed:", docsErr);
        }
      }

      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: "https://www.slytrans.com/success.html?vehicle=" + encodeURIComponent(vehicleId),
          receipt_email: email,
          payment_method_data: {
            billing_details: {
              name: nameVal,
              email: email,
            },
          },
        },
      });

      if (error) {
        // Keep booking data in sessionStorage with paymentFailed:true so the form
        // can be pre-filled automatically when the renter returns to try again.
        sessionStorage.setItem("slyRidesBooking", JSON.stringify({
          ...bookingPayload,
          paymentFailed: true,
          insuranceCoverageChoice,
          ...(insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        }));
        msgEl.textContent = error.message;
        submitBtn.disabled = false;
        submitBtn.textContent = window.slyI18n.t("booking.payPrefix") + displayPayNow;
        paymentSubmitting = false;
      }
    };

    document.getElementById("submit-payment").addEventListener("click", submitHandler);

    document.getElementById("cancel-payment").addEventListener("click", () => {
      paymentSubmitting = false; // reset in case cancelled mid-processing
      document.getElementById("submit-payment").removeEventListener("click", submitHandler);
      paymentElement.unmount();
      if (prButton) {
        prButton.unmount();
        prButton = null;
      }
      if (prContainer) prContainer.style.display = "none";
      document.getElementById("payment-form").style.display = "none";
      document.getElementById("payment-message").textContent = "";
      stripeBtn.style.display = "";
      stripeBtn.textContent = window.slyI18n.t("booking.payNow");
      const _reserveBtnCancel = document.getElementById("reserveBtn");
      if (_reserveBtnCancel) _reserveBtnCancel.disabled = false;
      _pendingPaymentMode = null;
      updatePayBtn();
    }, { once: true });

  } catch (err) {
    console.error("Stripe error:", err);
    stripeBtn.disabled = false;
    stripeBtn.textContent = window.slyI18n.t("booking.payNow");
    const _reserveBtnErr = document.getElementById("reserveBtn");
    if (_reserveBtnErr) _reserveBtnErr.disabled = false;
    _pendingPaymentMode = null;
    if (err.isDatesError) {
      // Dates were booked by someone else — refresh the calendar and tell the user
      showPayError(err.message);
      initDatePickers(); // reload availability so the calendar reflects the new booking
      return;
    }
    // Always surface the server's error message so the issue is diagnosable.
    // Fall back to the generic i18n string only when no specific message is available.
    const userMessage = (err && err.message)
      ? err.message
      : window.slyI18n.t("booking.loadError");
    showPayError(userMessage);
  }
});

// ----- Camry "Reserve with Deposit" button -----
// Sets deposit payment mode then delegates to the main stripeBtn handler.
(function setupReserveBtn() {
  const reserveBtnEl = document.getElementById("reserveBtn");
  if (!reserveBtnEl) return;
  reserveBtnEl.addEventListener("click", function () {
    _pendingPaymentMode = 'deposit';
    stripeBtn.click();
  });
}());
