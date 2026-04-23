// ----- API Base URL -----
// The frontend is served by GitHub Pages (www.slytrans.com).
// The API functions are deployed on Vercel (sly-rides.vercel.app).
// Because they are on different domains, the full Vercel URL must be used here.
const API_BASE = "https://sly-rides.vercel.app";
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;

// Non-refundable reservation deposit for Slingshot bookings (charged via Stripe now).
// Must mirror SLINGSHOT_BOOKING_DEPOSIT in api/_pricing.js.
const SLINGSHOT_BOOKING_DEPOSIT = 50;
// Upfront hold amount for Camry "Reserve with Deposit" option ($50 charged now; rest at pickup).
const CAMRY_BOOKING_DEPOSIT = 50;
// Slingshot authorization hold amounts — kept for reference but no longer used for payment.
// Slingshot now charges the full rental amount online; these constants are retained for
// any legacy references.
const SLINGSHOT_DEPOSIT_WITH_INSURANCE    = 500;
const SLINGSHOT_DEPOSIT_WITHOUT_INSURANCE = 300;
// Los Angeles combined sales tax rate — must mirror LA_TAX_RATE in api/_pricing.js.
// Use getTaxRate() in calculations so the admin-configurable value is always used.
const LA_TAX_RATE = 0.1025;
function getTaxRate() { return window._dynamicTaxRate || LA_TAX_RATE; }

// ----- Car Data -----
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports \u2022 2-Seater",
    subtitleKey: "fleet.sports2seater",
    // Sub-day tiers (3 hr, 6 hr) and daily tiers (1–3 days at $350/day, max 3 days).
    // Multi-day durations are stored as hours (days × 24) to stay consistent with
    // the existing applySlingshotDuration() auto-return-date logic.
    hourlyTiers: [
      { hours: 3,  price: 200,  label: "3 Hours" },
      { hours: 6,  price: 250,  label: "6 Hours" },
      { hours: 24, price: 350,  label: "1 Day" },
      { hours: 48, price: 700,  label: "2 Days" },
      { hours: 72, price: 1050, label: "3 Days" },
    ],
    // Security deposit = rental tier price (charged at booking, refundable after return).
    // No fixed deposit — computed dynamically from the selected tier.
    bookingDeposit: SLINGSHOT_BOOKING_DEPOSIT,
    images: ["images/slingshot.jpg"],
    make: "Polaris",
    model: "Slingshot XR",
    year: 2023,
    vin: "57XAARHB8P8156561",
    color: null
  },
  slingshot2: {
    name: "Slingshot R",
    subtitle: "Sports \u2022 2-Seater",
    subtitleKey: "fleet.sports2seater",
    hourlyTiers: [
      { hours: 3,  price: 200,  label: "3 Hours" },
      { hours: 6,  price: 250,  label: "6 Hours" },
      { hours: 24, price: 350,  label: "1 Day" },
      { hours: 48, price: 700,  label: "2 Days" },
      { hours: 72, price: 1050, label: "3 Days" },
    ],
    bookingDeposit: SLINGSHOT_BOOKING_DEPOSIT,
    images: ["images/slingshot.jpg"],
    make: "Polaris",
    model: "Slingshot XR",
    year: 2023,
    vin: null,
    color: null
  },
  slingshot3: {
    name: "Slingshot R",
    subtitle: "Sports \u2022 2-Seater",
    subtitleKey: "fleet.sports2seater",
    hourlyTiers: [
      { hours: 3,  price: 200,  label: "3 Hours" },
      { hours: 6,  price: 250,  label: "6 Hours" },
      { hours: 24, price: 350,  label: "1 Day" },
      { hours: 48, price: 700,  label: "2 Days" },
      { hours: 72, price: 1050, label: "3 Days" },
    ],
    bookingDeposit: SLINGSHOT_BOOKING_DEPOSIT,
    images: ["images/slingshot.jpg"],
    make: "Polaris",
    model: "Slingshot XR",
    year: 2023,
    vin: null,
    color: null
  },
  camry: {
    name: "Camry 2012",
    subtitle: "",
    subtitleKey: "fleet.sedan5seater",
    pricePerDay: 55,
    minRentalDays: 1,
    weekly: 350,
    biweekly: 650,
    monthly: 1300,
    images: ["images/IMG_0046.png","images/IMG_4486.jpeg"],
    make: "Toyota",
    model: "Camry",
    year: 2012,
    vin: "4T1BF1FK5CU063142",
    color: "Grey"
  },
  camry2013: {
    name: "Camry 2013 SE",
    subtitle: "",
    subtitleKey: "fleet.sedan5seater",
    pricePerDay: 55,
    minRentalDays: 1,
    weekly: 350,
    biweekly: 650,
    monthly: 1300,
    images: ["images/IMG_5144.png", "images/IMG_5139.jpeg", "images/IMG_5140.jpeg", "images/IMG_5145.png"],
    make: "Toyota",
    model: "Camry SE",
    year: 2013,
    vin: "4T1BF1FK9DU678911",
    color: "Charcoal Grey"
  }
};

// ----- Insurance / Protection Plan -----
// Slingshot Option B: DPP rate — kept for backward compat with Slingshot Option B info display.
const PROTECTION_PLAN_DAILY    = 13;   // $13/day (Slingshot Option B only)
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

      ["camry","camry2013"].forEach(function(vid) {
        if (!cars[vid]) return;
        if (ecDaily   > 0) cars[vid].pricePerDay = ecDaily;
        if (ecWeekly  > 0) cars[vid].weekly      = ecWeekly;
        if (ecBiWeek  > 0) cars[vid].biweekly    = ecBiWeek;
        if (ecMonthly > 0) cars[vid].monthly     = ecMonthly;
      });

      // ── Slingshot tiers ───────────────────────────────────────────────────
      var slTiers = [
        { hours: 3,  key: "3hr"  },
        { hours: 6,  key: "6hr"  },
        { hours: 24, key: "24hr" },
        { hours: 48, key: "48hr" },
        { hours: 72, key: "72hr" },
      ];
      ["slingshot","slingshot2","slingshot3"].forEach(function(vid) {
        if (!cars[vid] || !cars[vid].hourlyTiers) return;
        cars[vid].hourlyTiers.forEach(function(tier) {
          var match = slTiers.find(function(t) { return t.hours === tier.hours; });
          if (match && pricing.slingshot && pricing.slingshot[match.key] > 0) {
            tier.price = Number(pricing.slingshot[match.key]);
          }
        });
      });

      // ── Tax rate ─────────────────────────────────────────────────────────
      // (already set as a module-level const; we update the global so
      //  any later calculation that references LA_TAX_RATE by closure reads
      //  the updated value — functions that captured it directly are re-called
      //  naturally through user interaction.)
      if (pricing.tax_rate) {
        window._dynamicTaxRate = Number(pricing.tax_rate);
      }

      // Refresh the displayed price for the current vehicle
      if (carData) {
        var priceEl = document.getElementById("carPrice");
        if (priceEl) {
          priceEl.textContent = carData.hourlyTiers
            ? carData.hourlyTiers.map(function(t) { return "$" + t.price + " / " + t.label; }).join(" \u2022 ")
            : (carData.weekly
                ? "$" + carData.pricePerDay + " / " + _t("fleet.unitDay","day") + " \u2022 " + _t("fleet.priceFrom","from") + " $" + carData.weekly + " / " + _t("fleet.unitWeek","week")
                : "$" + carData.pricePerDay + " / " + _t("fleet.unitDay","day"));
        }
        // Refresh Slingshot duration radio labels
        if (carData.hourlyTiers) {
          document.querySelectorAll('input[name="slingshotDuration"]').forEach(function(radio) {
            var hours = Number(radio.value);
            var tier  = carData.hourlyTiers.find(function(t) { return t.hours === hours; });
            if (tier && radio.parentElement) {
              var spans = radio.parentElement.querySelectorAll("span");
              if (spans.length > 0) spans[spans.length - 1].textContent = tier.label + " \u2014 $" + tier.price;
            }
          });
        }
      }
    })
    .catch(function(err) {
      // Non-fatal — hard-coded values remain in effect
      console.warn("car.js: could not load dynamic pricing, using defaults:", err.message);
    });
}());

const vehicleId = getVehicleFromURL();
if (!vehicleId || !cars[vehicleId]) {
  alert(window.slyI18n ? window.slyI18n.t("booking.alertVehicleNotFound") : "Vehicle not found.");
  window.location.href = "index.html";
}

const carData = cars[vehicleId];
document.getElementById("carName").textContent = carData.name;
document.getElementById("carSubtitle").textContent =
  (carData.subtitleKey && window.slyI18n) ? window.slyI18n.t(carData.subtitleKey) : carData.subtitle;
document.getElementById("carPrice").textContent = (carData.hourlyTiers)
  ? carData.hourlyTiers.map(t => `$${t.price} / ${t.label}`).join(" \u2022 ")
  : (carData.weekly)
    ? `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")} \u2022 ${_t("fleet.priceFrom","from")} $${carData.weekly} / ${_t("fleet.unitWeek","week")}`
    : `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")}`;

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

// Hide the nav bar entirely for slingshot booking pages (slingshot has its own landing page)
if (vehicleId.startsWith("slingshot")) {
  const siteNav = document.querySelector(".site-nav");
  if (siteNav) siteNav.style.display = "none";
  const logoLink = document.querySelector(".logo-link");
  if (logoLink) logoLink.href = "slingshot.html";
}

// Show the Slingshot fun description instead of the Uber/Lyft earnings block
if (carData.hourlyTiers) {
  document.getElementById("earningsBlock").style.display = "none";
  document.getElementById("slingshotDesc").style.display = "block";
  // Populate duration options dynamically from hourlyTiers (single source of truth)
  const optionsContainer = document.getElementById("durationOptions");
  if (optionsContainer && carData.hourlyTiers) {
    carData.hourlyTiers.forEach(function(tier) {
      const lbl = document.createElement("label");
      lbl.className = "duration-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "slingshotDuration";
      radio.value = String(tier.hours);
      const span = document.createElement("span");
      span.textContent = `${tier.label} \u2014 $${tier.price}`;
      lbl.appendChild(radio);
      lbl.appendChild(span);
      optionsContainer.appendChild(lbl);
      radio.addEventListener("change", applySlingshotDuration);
    });
  }
  // Show the hourly duration selector and hide the manual return-date picker
  document.getElementById("slingshotDurationSection").style.display = "";
  document.getElementById("returnDateSection").style.display = "none";
  // Return date/time will be auto-computed once pickup date/time + duration are set
}

const sliderContainer = document.getElementById("sliderContainer");
const sliderDots = document.getElementById("sliderDots");
let currentSlide = 0;

// Load images
carData.images.forEach((imgSrc, idx) => {
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

function nextSlide() { showSlide((currentSlide+1)%carData.images.length); }
function prevSlide() { showSlide((currentSlide-1+carData.images.length)%carData.images.length); }
document.getElementById("nextSlide").addEventListener("click", nextSlide);
document.getElementById("prevSlide").addEventListener("click", prevSlide);
function goToSlide(idx){ showSlide(idx); }

// ----- Back Button -----
document.getElementById("backBtn").addEventListener("click", ()=>{
  window.location.href = vehicleId.startsWith("slingshot") ? "slingshot.html" : "index.html";
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
let currentSlingshotDuration = null; // selected hourly tier in hours (3 | 6 | 24) for Slingshot
let currentSubtotal = 0;
let agreementSignature = ""; // typed signature from the inline agreement panel
let insuranceCoverageChoice = null; // 'yes' | 'no' | null
// Payment mode for the current payment attempt: 'deposit' | 'full'.
// Set by reserveBtn before delegating to stripeBtn; reset after each attempt.
// Slingshot always uses 'deposit' (driven by carData.bookingDeposit).
// Camry renters choose via the two-button UI.
let _pendingPaymentMode = null;
// Economy car protection plan tier selected on the booking page: basic | standard | premium
// Defaults to "standard" (pre-populated from Apply Now / Waitlist preference).
let selectedProtectionTier = "standard";
// Slingshot payment mode — 'full' (rental + deposit) or 'deposit' (security deposit only).
// Updated by the payment option radio buttons shown for Slingshot vehicles.
let slingshotPaymentMode = 'full';

// ----- Slingshot: set up the insurance/protection UI -----
// For Slingshot: simplify the insurance question — no Damage Protection Plan offered.
if (carData.hourlyTiers) {
  // Update the question heading
  const qEl = document.getElementById("insuranceQuestionText");
  if (qEl) {
    qEl.removeAttribute("data-i18n");
    qEl.textContent = "\uD83D\uDEE1\uFE0F Do you have personal auto insurance?";
  }
  // Update "Yes" label — upload required
  const hasInsTextEl = document.getElementById("hasInsuranceText");
  if (hasInsTextEl) {
    hasInsTextEl.removeAttribute("data-i18n");
    hasInsTextEl.innerHTML = `<strong>Yes</strong> \u2014 I have valid personal auto insurance<br><small style='color:#ffb400'>Upload required before checkout</small>`;
  }
  // Update "No" label — no DPP; renter assumes full liability
  const noInsTextEl = document.getElementById("noInsuranceText");
  if (noInsTextEl) {
    noInsTextEl.removeAttribute("data-i18n");
    noInsTextEl.innerHTML = `<strong>No</strong> \u2014 I do not have personal auto insurance<br><small style='color:#aaa'>No Damage Protection Plan \u2014 renter assumes full liability for damages</small>`;
  }
  // Show the Slingshot payment options selector and hide the old deposit notice
  const payOptSection = document.getElementById("slingshotPaymentOptions");
  if (payOptSection) payOptSection.style.display = "";
  const oldDepositNotice = document.getElementById("slingshotDepositNotice");
  if (oldDepositNotice) oldDepositNotice.style.display = "none";
  const reserveBtnEl = document.getElementById("reserveBtn");
  if (reserveBtnEl) reserveBtnEl.style.display = "none";

  // Wire up payment option radio buttons
  const payFullRadio = document.getElementById("slingshotPayFull");
  const payDepositRadio = document.getElementById("slingshotPayDeposit");
  const depositOnlyNotice = document.getElementById("slingshotDepositOnlyNotice");
  function onSlingshotPaymentModeChange() {
    const checked = document.querySelector('input[name="slingshotPaymentMode"]:checked');
    slingshotPaymentMode = checked ? checked.value : 'full';
    if (depositOnlyNotice) {
      depositOnlyNotice.style.display = slingshotPaymentMode === 'deposit' ? "" : "none";
    }
    updateTotal();
    updatePayBtn();
  }
  if (payFullRadio) payFullRadio.addEventListener("change", onSlingshotPaymentModeChange);
  if (payDepositRadio) payDepositRadio.addEventListener("change", onSlingshotPaymentModeChange);
}

// For Camry vehicles: show the "Reserve with Deposit" button and the deposit notice so renters
// can choose between paying a $50 deposit now (rest at pickup) or paying in full today.
if (!carData.hourlyTiers) {
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

    // For Economy cars only: pre-select insurance choice and protection plan tier.
    // Slingshot uses its own Option A / Option B UI (set up separately).
    if (!carData.hourlyTiers) {
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
    }
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
  // For Slingshot: hide generic DPP notice, show auth-hold info box instead
  if (carData.hourlyTiers) {
    document.getElementById("protectionPlanSection").style.display = "none";
    _updateSlingshotInsuranceInfo("yes");
  } else {
    document.getElementById("protectionPlanSection").style.display = "none";
  }
  // Clear any protection-plan file state if previously "no"
  updateTotal();
  updatePayBtn();
});

document.getElementById("noInsurance").addEventListener("change", function() {
  if (!this.checked) return;
  insuranceCoverageChoice = "no";
  document.getElementById("insuranceUploadSection").style.display = "none";
  // For Slingshot: show auth-hold info box; for Camry: show tier-selection DPP notice
  if (carData.hourlyTiers) {
    document.getElementById("protectionPlanSection").style.display = "none";
    _updateSlingshotInsuranceInfo("no");
  } else {
    document.getElementById("protectionPlanSection").style.display = "";
    // Ensure the pre-selected tier radio is checked in the UI
    _syncProtectionTierRadio(selectedProtectionTier);
  }
  // Clear the uploaded insurance file since it's no longer needed
  clearInsuranceFile();
  updateTotal();
  updatePayBtn();
});

// Update the Slingshot insurance info box (shown below the radio buttons)
// to reflect the selected option. No DPP is offered for Slingshot.
function _updateSlingshotInsuranceInfo(choice) {
  const infoEl = document.getElementById("slingshotInsuranceInfo");
  if (!infoEl) return;
  // Determine the security deposit for the currently selected tier (= rental fee)
  const selectedTier = carData.hourlyTiers && currentSlingshotDuration
    ? carData.hourlyTiers.find(t => t.hours === currentSlingshotDuration)
    : null;
  const depositAmt = selectedTier ? `$${selectedTier.price}` : "equal to your rental fee";
  if (choice === "yes") {
    infoEl.innerHTML = `
      <div class="deposit-notice" style="margin-top:10px">
        <strong>✅ Insurance confirmed</strong>
        <ul>
          <li>Upload your proof of insurance below (required before checkout).</li>
          <li>A <strong>${depositAmt} refundable security deposit</strong> is included in your total and will be released after the vehicle is returned and inspected with no issues.</li>
        </ul>
      </div>`;
    infoEl.style.display = "";
  } else if (choice === "no") {
    infoEl.innerHTML = `
      <div class="deposit-notice" style="margin-top:10px">
        <strong>⚠️ No personal insurance on file</strong>
        <ul>
          <li>No Damage Protection Plan is available for Slingshot rentals.</li>
          <li>Renter assumes <strong>full financial liability</strong> for any damage to the vehicle.</li>
          <li>A <strong>${depositAmt} refundable security deposit</strong> is included in your total and will be released after the vehicle is returned and inspected with no issues.</li>
        </ul>
      </div>`;
    infoEl.style.display = "";
  } else {
    infoEl.innerHTML = "";
    infoEl.style.display = "none";
  }
}

// ----- Economy Car: Protection Plan Tier Selection -----
// Syncs the tier radio buttons in #protectionPlanSection to the given tier value.
function _syncProtectionTierRadio(tier) {
  const radio = document.querySelector('input[name="bookingProtectionPlan"][value="' + tier + '"]');
  if (radio) radio.checked = true;
}

// Attach change handlers to the tier radios (Economy cars only).
// Slingshot vehicles never show #protectionPlanSection, so this is safe for all vehicles.
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
    const pickPart   = pickupVal  ? `<strong>${pickupVal}</strong>`  : "<strong>[pickup date]</strong>";
    const retPart    = returnVal  ? `<strong>${returnVal}</strong>`  : "<strong>[return date]</strong>";
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
  // Slingshot: deposit = rental tier price (dynamic), charged at booking, refundable.
  // Camry vehicles have no security deposit — the entire section is hidden for economy cars.
  const depositHeadingEl  = document.getElementById("agreementDepositHeading");
  const depositIntroEl    = document.getElementById("agreementDepositIntro");
  const depositInsEl      = document.getElementById("agreementDepositInsurance");
  const depositDppEl      = document.getElementById("agreementDepositDpp");
  const depositNeitherEl  = document.getElementById("agreementDepositNeither");
  const speedSection      = document.getElementById("slingshotSpeedSection");
  const lateFeeGenericEl  = document.getElementById("lateFeeGeneric");
  const slingshotLateFeeEl = document.getElementById("slingshotLateFeeBody");
  if (carData.hourlyTiers) {
    // Compute the deposit for the currently selected tier (= rental fee)
    const currentTier = currentSlingshotDuration
      ? carData.hourlyTiers.find(t => t.hours === currentSlingshotDuration)
      : null;
    const depositDisplay = currentTier ? `$${currentTier.price}` : "an amount equal to your rental fee";

    // Slingshot: full payment (including security deposit) charged at booking
    if (depositHeadingEl) {
      depositHeadingEl.removeAttribute("data-i18n");
      depositHeadingEl.textContent = "SECURITY DEPOSIT (Refundable)";
      depositHeadingEl.style.display = "";
    }
    if (depositIntroEl) {
      depositIntroEl.innerHTML =
        `A <strong>${depositDisplay} refundable security deposit</strong> (equal to your rental fee) is included in your total payment. ` +
        `It will be released after the vehicle is returned and inspected with no issues (typically within 5&ndash;7 business days). ` +
        `The deposit may be fully or partially retained to cover damages, loss of use, cleaning, tolls, or fuel.`;
    }
    // No DPP for Slingshot — hide DPP element
    if (depositDppEl) depositDppEl.style.display = "none";
    if (depositInsEl) depositInsEl.style.display = "none";
    if (depositNeitherEl) depositNeitherEl.style.display = "none";

    // Show Slingshot speed & strike policy
    if (speedSection) speedSection.style.display = "";

    // Show Slingshot-specific late fee, hide generic late fee
    if (lateFeeGenericEl)   lateFeeGenericEl.style.display   = "none";
    if (slingshotLateFeeEl) slingshotLateFeeEl.style.display = "";
  } else {
    // For Camry (economy): no security deposit — hide the entire deposit section.
    if (depositHeadingEl) depositHeadingEl.style.display = "none";
    if (depositIntroEl)   depositIntroEl.style.display   = "none";
    if (depositInsEl)     depositInsEl.style.display     = "none";
    if (depositDppEl)     depositDppEl.style.display     = "none";
    if (depositNeitherEl) depositNeitherEl.style.display = "none";
    // Hide Slingshot speed & strike policy for non-Slingshot vehicles
    if (speedSection) speedSection.style.display = "none";

    // Show generic late fee, hide Slingshot-specific late fee
    if (lateFeeGenericEl)   lateFeeGenericEl.style.display   = "";
    if (slingshotLateFeeEl) slingshotLateFeeEl.style.display = "none";

    // For economy cars: populate the protection choice summary and update the
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
  } // end economy (non-hourly) branch

  // Show/hide the booking deposit policy section (Slingshot only)
  const bookingDepositSection = document.getElementById("slingshotBookingDepositSection");
  if (bookingDepositSection) {
    bookingDepositSection.style.display = carData.hourlyTiers ? "" : "none";
    if (carData.hourlyTiers) {
      // Dynamically populate the deposit body text with the tier-specific amount
      const slingshotDepBodyEl = document.getElementById("slingshotDepositAgreementBody");
      if (slingshotDepBodyEl) {
        const currentTierForDep = currentSlingshotDuration
          ? carData.hourlyTiers.find(t => t.hours === currentSlingshotDuration)
          : null;
        const depositDisplayDep = currentTierForDep ? `$${currentTierForDep.price}` : "an amount equal to your rental fee";
        slingshotDepBodyEl.innerHTML =
          `A <strong>${depositDisplayDep} refundable security deposit</strong> (equal to your rental fee) is included in your total payment. ` +
          `It will be released after the vehicle is returned and inspected with no issues (typically within 5&ndash;7 business days).`;
      }
      // Update option A / option B bullet visibility in the agreement section
      const optAEl = document.getElementById("slingshotDepositAgreementOptionA");
      const optBEl = document.getElementById("slingshotDepositAgreementOptionB");
      if (optAEl) optAEl.style.display = insuranceCoverageChoice === "yes" ? "" : "none";
      if (optBEl) optBEl.style.display = insuranceCoverageChoice === "no"  ? "" : "none";
    }
  }

  // Update Payment Terms body to accurately describe when/how payment is collected.
  // Removing data-i18n prevents applyTranslations() from overwriting the corrected text.
  const paymentTermsBodyEl = document.getElementById("agreementPaymentTermsBody");
  if (paymentTermsBodyEl) {
    paymentTermsBodyEl.removeAttribute("data-i18n");
    if (carData.hourlyTiers) {
      // Slingshot: full payment (rental + refundable security deposit equal to rental fee) charged online
      const currentTierForTerms = currentSlingshotDuration
        ? carData.hourlyTiers.find(t => t.hours === currentSlingshotDuration)
        : null;
      const depositForTerms = currentTierForTerms ? `$${currentTierForTerms.price}` : "an amount equal to your rental fee";
      paymentTermsBodyEl.textContent = `Full payment (including a ${depositForTerms} refundable security deposit equal to your rental fee) is charged online at the time of booking. The security deposit will be released within 5–7 business days after the vehicle is returned and inspected with no issues. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.`;
    } else {
      // Camry: full payment online, OR $50 deposit if renter chose "Reserve Now"
      paymentTermsBodyEl.textContent = lang === "es"
        ? "El pago completo del alquiler se cobra en l\u00EDnea al momento de la reserva. Si el arrendatario elige 'Reservar con dep\u00F3sito', solo se cobran $50 ahora y el saldo restante vence al momento de la recogida. Los pagos atrasados acumulan intereses del 1.5% mensual. Cargo por cheque devuelto (NSF): $35."
        : "Full rental payment is charged online at the time of booking. If the renter chose \u2018Reserve with Deposit\u2019, only $50 is charged now and the remaining balance is due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.";
    }
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

// Promote return pickers to module scope so applySlingshotDuration() can update them
let returnPicker = null;

// ----- Slingshot: auto-compute return date/time from pickup + duration -----
function applySlingshotDuration() {
  if (!carData.hourlyTiers) return;
  const selectedDuration = document.querySelector('input[name="slingshotDuration"]:checked');
  if (!selectedDuration) return;

  const hours = parseInt(selectedDuration.value, 10);
  currentSlingshotDuration = hours;

  const dateStr = pickup.value; // "YYYY-MM-DD"
  if (!dateStr) { updatePayBtn(); return; }
  if (!pickupTime.value) {
    if (returnPicker) {
      returnPicker.clear();
    } else {
      returnDate.value = "";
    }
    returnTime.value = "";
    updatePayBtn();
    return;
  }

  // pickupTime is a <select> whose option values are stored as HH:MM (24-hour).
  // The AM/PM display label is separate from the value sent here.
  // timeSlotToHH handles legacy AM/PM values that may be present in memory;
  // the fallback treats a valid HH:MM string directly.
  let timeStr = timeSlotToHH(pickupTime.value);
  if (!timeStr) {
    // Fallback: value is already HH:MM
    const nativeTest = new Date("1970-01-01T" + pickupTime.value);
    if (!isNaN(nativeTest)) timeStr = pickupTime.value.slice(0, 5);
  }

  // Build pickup moment and add duration
  const pickupMoment = new Date(dateStr + "T" + timeStr);
  if (isNaN(pickupMoment.getTime())) { updatePayBtn(); return; }
  const returnMoment = new Date(pickupMoment.getTime() + hours * 60 * 60 * 1000);

  // Format return date as "YYYY-MM-DD"
  const y  = returnMoment.getFullYear();
  const mo = String(returnMoment.getMonth() + 1).padStart(2, "0");
  const dd = String(returnMoment.getDate()).padStart(2, "0");
  const retDateStr = `${y}-${mo}-${dd}`;

  // Format return time as "HH:MM"
  const retH = String(returnMoment.getHours()).padStart(2, "0");
  const retM = String(returnMoment.getMinutes()).padStart(2, "0");
  const retTimeStr = `${retH}:${retM}`;

  // Update return date (via Flatpickr API if available, otherwise direct)
  if (returnPicker) {
    returnPicker.setDate(retDateStr, true);
  } else {
    returnDate.value = retDateStr;
  }

  // returnTime is always set directly (no Flatpickr for returnTime)
  returnTime.value = retTimeStr;

  // Show the return section so the renter can see their auto-computed return time
  const retSection = document.getElementById("returnDateSection");
  if (retSection) retSection.style.display = "";

  updateTotal();
  updatePayBtn();
}

// Fixed time slots available for booking (displayed as options in the pickup time select).
const TIME_SLOTS = ["08:00 AM", "10:00 AM", "12:00 PM", "02:00 PM", "04:00 PM", "06:00 PM"];
// Minimum buffer (hours) between a car's return and the next available pickup slot.
const PICKUP_BUFFER_HOURS = 2;

// Module-level cache of booked ranges used by updatePickupTimeSlots().
// Populated (and refreshed) each time initDatePickers() fetches from the API.
let bookedRangesCache = [];
let allUnitRangesCache = []; // one array of raw ranges per Slingshot unit

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
  return new Date(dateStr + "T" + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":00").getTime();
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

  const isSlingshot = vehicleId.startsWith("slingshot");

  TIME_SLOTS.forEach(function(slot) {
    const opt = document.createElement("option");
    // Store the value as HH:MM (24-hour) so the backend always receives a
    // consistent format regardless of AM/PM display label.
    opt.value = timeSlotToHH(slot);
    opt.textContent = slot; // AM/PM label for the user

    if (IS_TEST_MODE_OVERRIDE) {
      opt.disabled = false;
    } else if (isSlingshot) {
      // Slot is available for Slingshot when at least one unit is free.
      // Disable only when EVERY unit is blocked.
      const allBlocked = allUnitRangesCache.every(function(unitRanges) {
        return isSlotBlocked(selectedDate, slot, unitRanges);
      });
      opt.disabled = allBlocked;
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

  if (carData.hourlyTiers) {
    applySlingshotDuration();
  } else {
    updateTotal();
  }
  updatePayBtn();
}

// Flag set to true inside initDatePickers() once Flatpickr takes over.
// Flatpickr already fires native change events after its own onChange, so
// the native listeners below must skip when Flatpickr is active to avoid
// calling updateTotal() / applySlingshotDuration() twice on every selection.
// pickupTime is now a <select> and is handled by its own dedicated listener below.
let flatpickrActive = false;
[pickup, returnDate, returnTime].forEach(function(inp) {
  inp.addEventListener("change", function() {
    if (flatpickrActive) return; // Flatpickr's own onChange handles this
    if (carData.hourlyTiers) {
      applySlingshotDuration();
    } else {
      updateTotal();
    }
  });
});

// Dedicated change listener for the pickupTime <select>.
// Values are already HH:MM so returnTime is assigned directly.
pickupTime.addEventListener("change", function() {
  const slot = this.value; // HH:MM
  returnTime.value = slot || "";
  if (carData.hourlyTiers) {
    applySlingshotDuration();
  } else {
    updateTotal();
  }
  updatePayBtn();
});

  // ----- Date Pickers (Flatpickr) -----
async function initDatePickers() {
  if (typeof flatpickr === "undefined") return; // fallback to native inputs

  // For Slingshot: a date is only truly blocked when ALL units are booked on
  // that date.  Customers book a generic Slingshot; we assign whichever unit
  // is free at payment time.
  const SLINGSHOT_IDS = ["slingshot", "slingshot2", "slingshot3"];
  const isSlingshot = vehicleId.startsWith("slingshot");

  // allUnitRanges: array-of-arrays (one per slingshot unit) for the combined
  // disable check; unused for non-slingshot vehicles (uses bookedRanges instead).
  let allUnitRanges = [];
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
      if (isSlingshot) {
        // Collect each unit's ranges; missing unit = no bookings (empty array).
        // Keep raw ranges (with fromTime/toTime) for the time-slot buffer check.
        allUnitRanges = SLINGSHOT_IDS.map(function(id) {
          return (data[id] || []).map(function(r) {
            return {
              // Exclusive end: the return date itself is NOT blocked in the
              // calendar — time slots on that day handle granularity.
              from: new Date(r.from + "T00:00:00").getTime(),
              to:   new Date(r.to   + "T00:00:00").getTime(),
            };
          });
        });
        // Store raw ranges per unit for the time-slot availability check.
        allUnitRangesCache = SLINGSHOT_IDS.map(function(id) { return data[id] || []; });
      } else {
        bookedRanges = data[vehicleId] || [];
        bookedRangesCache = bookedRanges;
      }
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
    if (isSlingshot) {
      // Date is blocked only when EVERY Slingshot unit is booked on that day.
      // Uses exclusive end so the return date itself can accept new pickups.
      return allUnitRanges.every(function(unitRanges) {
        return unitRanges.some(function(r) { return t >= r.from && t < r.to; });
      });
    }
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
      const dateStr = selectedDates[0]
        ? selectedDates[0].toISOString().slice(0, 10)
        : "";
      updatePickupTimeSlots(dateStr);
    }
  });

  returnPicker = flatpickr(returnDate, {
    minDate: "today",
    disable: [isBooked],
    onChange: function() {
      if (!carData.hourlyTiers) updateTotal();
    }
  });

  // pickupTime is now a <select> — no Flatpickr needed.
  // returnTime mirrors pickupTime and is set programmatically; no Flatpickr needed.

  // Flatpickr is now fully active; native change listeners will defer to it.
  flatpickrActive = true;
}

initDatePickers();

// ----- Fleet Status Check -----
// Fetch the vehicle's availability from fleet-status.json. If the vehicle is
// globally marked unavailable (e.g. already rented or taken offline), show a
// clear "Currently Rented" notice and replace the booking form with the
// Extend Rental section.  Fails open on any API error so transient outages
// do not lock out the form.
//
// For Slingshot: multiple interchangeable units exist (slingshot, slingshot2,
// slingshot3).  The notice is shown only when ALL units are simultaneously
// unavailable; the "next available" date is the earliest return date across all
// currently-booked units.
(async function checkFleetStatus() {
  if (IS_TEST_MODE_OVERRIDE) return;
  try {
    const SLINGSHOT_IDS = ["slingshot", "slingshot2", "slingshot3"];
    const isSlingshot = vehicleId.startsWith("slingshot");

    const [fleetResp, datesResp] = await Promise.all([
      fetch(`${API_BASE}/api/fleet-status`),
      fetch(`${API_BASE}/api/booked-dates`),
    ]);
    if (!fleetResp.ok) return;
    const status      = await fleetResp.json();
    const bookedDates = datesResp.ok ? await datesResp.json() : {};

    let isUnavailable;
    if (isSlingshot) {
      // Unavailable only when every Slingshot unit is marked unavailable.
      isUnavailable = SLINGSHOT_IDS.every(function(id) {
        return status[id] && status[id].available === false;
      });
    } else {
      const entry = status[vehicleId];
      isUnavailable = !!(entry && entry.available === false);
    }

    if (isUnavailable) {
      const today = SlyLA.todayISO();
      // For Slingshot: the next available date is the earliest date when ANY
      // unit's current booking ends (that unit then becomes free).
      const idsToCheck = isSlingshot ? SLINGSHOT_IDS : [vehicleId];
      let nextAvail = null;

      for (const id of idsToCheck) {
        const ranges = ((bookedDates[id] || []).slice().sort(function(a, b) {
          return a.from < b.from ? -1 : 1;
        }));
        // 1. Preferred: find a range that covers today
        for (const r of ranges) {
          if (r.from <= today && today <= r.to) {
            const candidate = SlyLA.addDaysToISO(r.to, 1);
            // Keep the earliest "next available" across all units
            if (!nextAvail || candidate < nextAvail) nextAvail = candidate;
            break;
          }
        }
        // 2. Fallback: vehicle is unavailable but recorded range already expired
        //    (rental extended past original return date). Use most recently ended range.
        if (!nextAvail) {
          let latestExpired = null;
          for (const r of ranges) {
            if (r.to < today) {
              if (!latestExpired || r.to > latestExpired.to) latestExpired = r;
            }
          }
          if (latestExpired) {
            const candidate = SlyLA.addDaysToISO(latestExpired.to, 1);
            if (!nextAvail || candidate < nextAvail) nextAvail = candidate;
          }
        }
      }

      showVehicleUnavailable(nextAvail);
    }
  } catch (err) {
    console.warn("Could not check fleet status:", err);
  }
})();

function showVehicleUnavailable(nextAvailableISO) {
  const bookingSection = document.querySelector(".booking");
  if (!bookingSection) return;

  // ── 1. Insert / update the "Currently Rented" notice at the top ──────────
  let notice = document.getElementById("vehicleUnavailableNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "vehicleUnavailableNotice";
    notice.className = "vehicle-unavailable-notice";
    bookingSection.insertBefore(notice, bookingSection.firstChild);
  }

  let nextLine = "";
  if (nextAvailableISO) {
    const d = new Date(nextAvailableISO + "T00:00:00");
    const formatted = d.toLocaleDateString("en-US", { timeZone: SlyLA.tz, month: "long", day: "numeric", year: "numeric" });
    nextLine = `<p>📅 Next available: <strong>${formatted}</strong></p>`;

    // Set minimum new return date in the extend form
    const extReturn = document.getElementById("extNewReturn");
    if (extReturn) extReturn.setAttribute("min", SlyLA.todayISO());
  }

  notice.innerHTML = `
    <p>🔴 <strong>${_t("fleet.currentlyBooked", "Currently Rented")}</strong></p>
    ${nextLine}
    <p><a href="${vehicleId.startsWith('slingshot') ? 'slingshot.html' : 'cars.html'}">${_t("booking.browseOther", "Browse other available vehicles")}</a></p>`;

  // ── 2. Hide the regular booking form elements ────────────────────────────
  // Hide the heading and all regular form inputs/sections.  The extend rental
  // section is shown below instead so there are no duplicate "reserve" CTAs.
  const bookingHeading = bookingSection.querySelector("h2");
  if (bookingHeading) bookingHeading.style.display = "none";

  const regularIds = [
    "paymentRetryBanner",
    "pickup", "pickupTime", "slingshotDurationSection", "returnDateSection",
    "name", "email", "phone",
    "nameError",
    "idSection", "idUpload", "fileInfo",
    "insuranceSection",
    "hasInsurance", "noInsurance",
    "insuranceUploadSection", "protectionPlanSection",
    "signAgreementBtn", "signAgreementStatus", "rentalAgreementBox",
    "slingshotDepositNotice", "camryDepositNotice",
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

  // ── 3. Show the Extend Rental section ────────────────────────────────────
  const extendSection = document.getElementById("extendRentalSection");
  if (extendSection) {
    extendSection.style.display = "";
    // Set minimum new return date to today
    const extReturn = document.getElementById("extNewReturn");
    if (extReturn && !extReturn.getAttribute("min")) {
      extReturn.setAttribute("min", SlyLA.todayISO());
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

    var isSlingshot = carData.hourlyTiers;

    if (isSlingshot) {
      // For Slingshot: rough estimate based on current return date being today
      var extraDays = Math.max(1, Math.ceil((new Date(newReturn) - new Date(today)) / (1000 * 3600 * 24)));
      var dailyRate = (carData.hourlyTiers && carData.hourlyTiers.find(function(t){ return t.hours === 24; }));
      var estCost = extraDays * (dailyRate ? dailyRate.price : 350);
      if (extPriceAmount) extPriceAmount.textContent = estCost.toFixed(0);
    } else {
      // Economy cars: use the same tiered pricing as the main booking flow
      var extraDays2 = Math.max(1, Math.ceil((new Date(newReturn) - new Date(today)) / (1000 * 3600 * 24)));
      var daily   = carData.pricePerDay  || 55;
      var weekly  = carData.weekly       || 350;
      var biweek  = carData.biweekly     || 650;
      var monthly = carData.monthly      || 1300;

      var cost2 = 0;
      var rem   = extraDays2;
      if (rem >= 30) { cost2 += Math.floor(rem / 30) * monthly;  rem = rem % 30; }
      if (rem >= 14) { cost2 += Math.floor(rem / 14) * biweek;   rem = rem % 14; }
      if (rem >= 7)  { cost2 += Math.floor(rem / 7)  * weekly;   rem = rem % 7;  }
      cost2 += rem * daily;

      if (extPriceAmount) extPriceAmount.textContent = cost2.toFixed(0);
    }

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

    var { clientSecret, publishableKey, extensionAmount, extensionLabel, newReturnDate: confirmedDate, newReturnTime: confirmedTime, vehicleName, renterName } = data;
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
      var displayReturn = confirmedDate + (confirmedTime ? " at " + confirmedTime : "");
      summaryEl.innerHTML =
        "<strong>⏱️ Rental Extension</strong><br>" +
        (vehicleName ? "Vehicle: " + vehicleName + "<br>" : "") +
        (renterName  ? "Renter: "  + renterName  + "<br>" : "") +
        "Extension: " + extensionLabel + "<br>" +
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
    if (!carData.hourlyTiers) {
      fpSet(returnDate, data.returnDate);
    }

    // Restore Slingshot hourly-duration selection
    if (data.slingshotDuration && carData.hourlyTiers) {
      currentSlingshotDuration = data.slingshotDuration;
      const radio = document.querySelector(`input[name="slingshotDuration"][value="${data.slingshotDuration}"]`);
      if (radio) radio.checked = true;
      applySlingshotDuration();
    }

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
        // For Slingshot: restore info box instead of generic DPP section
        if (carData.hourlyTiers) {
          if (protectionSection) protectionSection.style.display = "none";
          _updateSlingshotInsuranceInfo("yes");
        }
      } else {
        if (noInsuranceRadio)  noInsuranceRadio.checked  = true;
        if (insuranceSection)  insuranceSection.style.display  = "none";
        if (carData.hourlyTiers) {
          if (protectionSection) protectionSection.style.display = "none";
          _updateSlingshotInsuranceInfo("no");
        } else {
          // Restore the protection plan tier for economy cars
          if (data.protectionPlanTier) {
            selectedProtectionTier = data.protectionPlanTier;
          }
          if (protectionSection) protectionSection.style.display = "";
          _syncProtectionTierRadio(selectedProtectionTier);
        }
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
  // Reset hourly-tier duration selection (Slingshot vehicles)
  if (carData.hourlyTiers) {
    currentSlingshotDuration = null;
    document.querySelectorAll('input[name="slingshotDuration"]').forEach(function(r) { r.checked = false; });
    const retSection = document.getElementById("returnDateSection");
    if (retSection) retSection.style.display = "none";
    // Reset Slingshot payment mode to 'full' and hide deposit-only notice
    slingshotPaymentMode = 'full';
    const payFullRadioReset = document.getElementById("slingshotPayFull");
    if (payFullRadioReset) payFullRadioReset.checked = true;
    const depositOnlyNoticeReset = document.getElementById("slingshotDepositOnlyNotice");
    if (depositOnlyNoticeReset) depositOnlyNoticeReset.style.display = "none";
  }
  const insuranceUploadSection = document.getElementById("insuranceUploadSection");
  const protectionPlanSection = document.getElementById("protectionPlanSection");
  if (insuranceUploadSection) insuranceUploadSection.style.display = "none";
  if (protectionPlanSection) protectionPlanSection.style.display = "none";
  // Reset Slingshot insurance info box
  if (carData.hourlyTiers) { _updateSlingshotInsuranceInfo(null); }
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
    // reserveBtn is only shown for Camry (not Slingshot — Slingshot uses auth-hold system)
    _reserveBtnReset.style.display = carData.hourlyTiers ? "none" : "";
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
  //   "no"   → for Slingshot: DPP auto-included (always ready)
  //           → for Economy: requires a valid tier selection (basic/standard/premium)
  const isEconomy = !carData.hourlyTiers;
  const tierReady = selectedProtectionTier === "basic" || selectedProtectionTier === "standard" || selectedProtectionTier === "premium";
  const insuranceReady = (insuranceCoverageChoice === "yes" && (insuranceUpload.files.length > 0 || uploadedInsurance !== null)) ||
                          (insuranceCoverageChoice === "no" && (!isEconomy || tierReady));
  const nameValid = isValidName(nameVal);
  const phoneVal = document.getElementById("phone").value.trim();
  // Hourly-tier vehicles need pickup + duration + pickup time;
  // other vehicles need pickup + return date + pickup time.
  // Pickup time is required for all vehicles: it anchors the rental window and
  // is used as the return time (return_time = pickup_time) for overlap prevention.
  const hasTimeWindow = returnDate.value && pickupTime.value && returnTime.value;
  const datesReady = carData.hourlyTiers
    ? pickup.value && currentSlingshotDuration && hasTimeWindow
    : pickup.value && hasTimeWindow;
  const ready = datesReady && agreeCheckbox.checked && (idUpload.files.length > 0 || uploadedFile !== null) && insuranceReady && nameValid && emailVal && phoneVal;
  stripeBtn.disabled = !ready;
  const _reserveBtnPayBtn = document.getElementById("reserveBtn");
  if (_reserveBtnPayBtn) _reserveBtnPayBtn.disabled = !ready;
  const hint = document.getElementById("payHint");
  if (hint) hint.style.display = ready ? "none" : "block";
}

function updateTotal() {
  // ----- Hourly-tier vehicles (Slingshot) -----
  if (carData.hourlyTiers) {
    if (!pickup.value || !currentSlingshotDuration) return;
    const tier = carData.hourlyTiers.find(t => t.hours === currentSlingshotDuration);
    if (!tier) return;
    // For day-count purposes: 3hr/6hr = 1 day; 24hr = 1 day; 48hr = 2 days; 72hr = 3 days.
    const slingshotDays = Math.max(1, Math.ceil(currentSlingshotDuration / 24));
    currentDayCount = slingshotDays;

    // Security deposit = rental tier price (refundable after return).
    // No DPP for Slingshot. No tax — total is rental fee + security deposit only.
    const securityDeposit = tier.price;
    const fullTotal = tier.price + securityDeposit; // rental + deposit, no tax

    // Determine the payment amount based on the selected payment mode.
    // 'full': charge rental + security deposit; 'deposit': charge security deposit only.
    const isDepositMode = slingshotPaymentMode === 'deposit';
    const chargeNow = isDepositMode ? securityDeposit : fullTotal;

    // Show the rental breakdown so renters know exactly what they're paying.
    const lines = [];
    if (!isDepositMode) {
      lines.push({ label: _fmt("booking.tierRentalFmt", { label: tier.label }, `${tier.label} rental`), amount: tier.price });
      lines.push({ label: `\uD83D\uDCB0 Security Deposit (refundable \u2014 equals rental fee)`, amount: securityDeposit });
    } else {
      lines.push({ label: `\uD83D\uDCB0 Security Deposit (refundable \u2014 reserves your dates)`, amount: securityDeposit });
      lines.push({ label: `\u23F3 Remaining rental fee (due before pickup \u2014 NOT charged now)`, amount: tier.price });
    }

    currentSubtotal = chargeNow;
    carData._fullRentalCost = fullTotal.toFixed(2);
    carData._rentalPrice = tier.price;
    carData._securityDeposit = securityDeposit;

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

    // Hide tax line — no tax on Slingshot bookings
    document.getElementById("subtotal").textContent = chargeNow;
    const taxLineEl = document.getElementById("taxLine");
    const taxNoteEl = document.getElementById("taxNote");
    taxLineEl.style.display = "none";
    if (taxNoteEl) taxNoteEl.style.display = "none";
    // Total reflects only what is charged now
    totalEl.textContent = chargeNow.toFixed(2);
    // Pay button text reflects the selected mode
    if (isDepositMode) {
      stripeBtn.textContent = `\uD83D\uDD12 Reserve with $${chargeNow.toFixed(2)} Deposit`;
    } else {
      stripeBtn.textContent = window.slyI18n.t("booking.payNow");
    }
    updatePayBtn();
    return;
  }

  // ----- Daily/weekly vehicles -----
  if(!pickup.value || !returnDate.value) return;
  const minDays = carData.minRentalDays || 1;
  currentDayCount = Math.max(minDays, Math.ceil((new Date(returnDate.value) - new Date(pickup.value))/(1000*3600*24)));

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
  // Resolve payment mode:
  // - For Slingshot: use slingshotPaymentMode ('full' or 'deposit') set by the radio buttons.
  // - For Camry: _pendingPaymentMode is set by reserveBtn before it calls stripeBtn.click().
  if (_pendingPaymentMode === null) {
    _pendingPaymentMode = carData.hourlyTiers ? slingshotPaymentMode : 'full';
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
  if (!returnDate.value) { showPayError(window.slyI18n.t("booking.alertReturnDate")); return; }
  if (!pickupTime.value) { showPayError(window.slyI18n.t("booking.alertPickupTime")); return; }
  if (!returnTime.value) { showPayError(window.slyI18n.t("booking.alertReturnTime")); return; }
  const isSlingshotDepositMode = carData.hourlyTiers && paymentMode === 'deposit';
  const isCamryDepositMode = !carData.hourlyTiers && paymentMode === 'deposit';
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
        // For Economy cars: pass the selected tier so the server uses the correct flat rate.
        ...(!carData.hourlyTiers && insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
        ...(carData.hourlyTiers ? { slingshotDuration: currentSlingshotDuration } : {}),
        // Pass insurance choice for all vehicles so the server can enforce coverage requirements.
        insuranceCoverageChoice,
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
          // For Slingshot, fullRentalCost and balanceAtPickup are not applicable (full payment online).
          fullRentalCost: carData.hourlyTiers ? null : (carData._fullRentalCost || totalEl.textContent),
          balanceAtPickup: carData.hourlyTiers ? null : (carData._balanceAtPickup || null),
          pricePerDay: carData.pricePerDay || null,
          pricePerWeek: carData.weekly || null,
          pricePerBiWeekly: carData.biweekly || null,
          pricePerMonthly: carData.monthly || null,
          deposit: carData.deposit || 0,
          days: currentDayCount,
          ...(carData.hourlyTiers ? { slingshotDuration: currentSlingshotDuration } : {}),
          idFileName,
          idMimeType,
          insuranceFileName,
          insuranceMimeType,
          insuranceCoverageChoice,
          protectionPlan: insuranceCoverageChoice === "no",
          ...(!carData.hourlyTiers && insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
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
        // For Slingshot, fullRentalCost and balanceAtPickup are not applicable (full payment online).
        fullRentalCost: carData.hourlyTiers ? null : (carData._fullRentalCost || totalEl.textContent),
        balanceAtPickup: carData.hourlyTiers ? null : (carData._balanceAtPickup || null),
        pricePerDay: carData.pricePerDay || null,
        pricePerWeek: carData.weekly || null,
        pricePerBiWeekly: carData.biweekly || null,
        pricePerMonthly: carData.monthly || null,
        deposit: carData.deposit || 0,
        days: currentDayCount,
        ...(carData.hourlyTiers ? { slingshotDuration: currentSlingshotDuration } : {}),
        idFileName,
        idMimeType,
        insuranceFileName,
        insuranceMimeType,
        insuranceCoverageChoice,
        protectionPlan: insuranceCoverageChoice === "no",
        ...(!carData.hourlyTiers && insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
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
          ...(!carData.hourlyTiers && insuranceCoverageChoice === "no" ? { protectionPlanTier: selectedProtectionTier } : {}),
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
      // Restore the correct button text for Slingshot vs Camry
      stripeBtn.textContent = window.slyI18n.t("booking.payNow");
      const _reserveBtnCancel = document.getElementById("reserveBtn");
      if (_reserveBtnCancel) _reserveBtnCancel.disabled = false;
      _pendingPaymentMode = null;
      updatePayBtn();
    }, { once: true });

  } catch (err) {
    console.error("Stripe error:", err);
    stripeBtn.disabled = false;
    // Restore the correct button text
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
    // Show detailed message only for known setup/config errors; generic message otherwise
    const isSetupError = err.message && (
      err.message.includes("STRIPE_SECRET_KEY") ||
      err.message.includes("STRIPE_PUBLISHABLE_KEY") ||
      err.message.includes("clientSecret") ||
      err.message.includes("publishableKey")
    );
    const userMessage = isSetupError
      ? "Payment setup error:\n\n" + err.message
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
