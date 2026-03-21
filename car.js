// ----- API Base URL -----
// The frontend is served by GitHub Pages (www.slytrans.com).
// The API functions are deployed on Vercel (sly-rides.vercel.app).
// Because they are on different domains, the full Vercel URL must be used here.
const API_BASE = "https://sly-rides.vercel.app";

// ----- Booking Deposit Constants -----
// Non-refundable reservation deposit for Slingshot bookings (charged via Stripe now).
// The full rental balance (rental fee + $150 security deposit) is due at pickup.
// Must mirror SLINGSHOT_BOOKING_DEPOSIT in api/_pricing.js.
const SLINGSHOT_BOOKING_DEPOSIT = 50;

// Non-refundable reservation deposit for Camry "Reserve Now" mode.
// Renters who choose "Reserve Now" pay this upfront; the remaining rental balance is due at pickup.
// Must mirror CAMRY_BOOKING_DEPOSIT in api/_pricing.js.
const CAMRY_BOOKING_DEPOSIT = 50;

// ----- Car Data -----
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports \u2022 2-Seater",
    subtitleKey: "fleet.sports2seater",
    // Slingshot uses hourly tier pricing — no daily/weekly/monthly rates.
    hourlyTiers: [
      { hours: 3,  price: 200, label: "3 Hours" },
      { hours: 6,  price: 250, label: "6 Hours" },
      { hours: 24, price: 350, label: "24 Hours" },
    ],
    deposit: 150,
    bookingDeposit: SLINGSHOT_BOOKING_DEPOSIT,
    images: ["images/car2.jpg","images/car1.jpg","images/car3.jpg"],
    make: "Polaris",
    model: "Slingshot XR",
    year: 2023,
    vin: "57XAARHB8P8156561",
    color: null
  },
  // Second Slingshot unit — same pricing, different photos.
  // TODO: update vin once available.
  slingshot2: {
    name: "Slingshot R",
    subtitle: "Sports \u2022 2-Seater",
    subtitleKey: "fleet.sports2seater",
    hourlyTiers: [
      { hours: 3,  price: 200, label: "3 Hours" },
      { hours: 6,  price: 250, label: "6 Hours" },
      { hours: 24, price: 350, label: "24 Hours" },
    ],
    deposit: 150,
    bookingDeposit: SLINGSHOT_BOOKING_DEPOSIT,
    images: ["images/IMG_1749.jpeg", "images/IMG_1750.jpeg", "images/IMG_1751.jpeg"],
    make: "Polaris",
    model: "Slingshot XR",
    year: 2023,
    vin: "TBD",
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
const PROTECTION_PLAN_WEEKLY   = 85;   // $85/week  (7-day block)
const PROTECTION_PLAN_BIWEEKLY = 150;  // $150/2 weeks (14-day block)
const PROTECTION_PLAN_MONTHLY  = 295;  // $295/month (30-day block)
// Daily rate auto-derived from weekly so it stays proportional
const PROTECTION_PLAN_DAILY    = Math.ceil(PROTECTION_PLAN_WEEKLY / 7); // ≈ $13/day

// ----- Sales Tax — Los Angeles, CA -----
// Business is operated in Los Angeles, California. Tax is always applied at
// the current combined City of Los Angeles rate regardless of the renter's
// home address.
// Combined City of Los Angeles rate: CA state 7.25% + LA county 2.25% + LA city 0.75% = 10.25%
// Note: this constant intentionally mirrors LA_TAX_RATE in api/_pricing.js.
// The api/ directory uses Node.js ES modules that cannot be imported directly
// from browser scripts, so the rate must be declared in both places.
const LA_TAX_RATE = 0.1025;

// ----- Helpers -----
function getVehicleFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("vehicle");
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

// ----- Load Car Data -----
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
  ? carData.hourlyTiers.map(t => `$${t.price} / ${t.hours}${_t("fleet.unitHrs","hrs")}`).join(" \u2022 ")
  : (carData.weekly)
    ? `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")} \u2022 ${_t("fleet.priceFrom","from")} $${carData.weekly} / ${_t("fleet.unitWeek","week")}`
    : `$${carData.pricePerDay} / ${_t("fleet.unitDay","day")}`;

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
      span.textContent = `${tier.hours} ${_t("fleet.hours","Hours")} \u2014 $${tier.price}`;
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
document.getElementById("backBtn").addEventListener("click", ()=>window.location.href="cars.html");

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
let currentTaxRate = LA_TAX_RATE;
let agreementSignature = ""; // typed signature from the inline agreement panel
let insuranceCoverageChoice = null; // 'yes' | 'no' | null
// Payment mode for the current payment attempt: 'deposit' | 'full'.
// Set by reserveBtn before delegating to stripeBtn; reset after each attempt.
// Slingshot always uses 'deposit' (driven by carData.bookingDeposit).
// Camry renters choose via the two-button UI.
let _pendingPaymentMode = null;

// For Slingshot: show deposit notice and reserve button.
// stripeBtn becomes "Book Now" (full payment); reserveBtn is the $50-deposit option.
if (carData.bookingDeposit) {
  const depositNotice = document.getElementById("slingshotDepositNotice");
  if (depositNotice) {
    // Populate deposit amounts dynamically from the constant so HTML stays in sync
    depositNotice.querySelectorAll("[data-deposit-booking]").forEach(el => {
      el.textContent = "$" + carData.bookingDeposit;
    });
    depositNotice.querySelectorAll("[data-deposit-security]").forEach(el => {
      el.textContent = "$" + carData.deposit;
    });
    depositNotice.style.display = "";
  }
  // Show reserve button as the deposit option for Slingshot
  const reserveBtnEl = document.getElementById("reserveBtn");
  if (reserveBtnEl) {
    reserveBtnEl.textContent = `\uD83D\uDD12 Reserve with $${carData.bookingDeposit} Deposit`;
    reserveBtnEl.style.display = "";
  }
  // stripeBtn text will be set to the full amount by updateTotal() once a duration is selected
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

// ----- Pre-fill from Apply Now application (localStorage) -----
// When an approved applicant submits the "Apply Now" form on index.html their
// name, phone, and email are stored in localStorage under "slyApplicant".
// If that data exists we pre-fill the corresponding booking-form fields so
// they don't have to re-type the same information after they are approved.
(function prefillFromApplication() {
  try {
    const stored = localStorage.getItem("slyApplicant");
    if (!stored) return;
    const data = JSON.parse(stored);
    const nameField  = document.getElementById("name");
    const emailField = document.getElementById("email");
    const phoneField = document.getElementById("phone");
    if (data.name && nameField && !nameField.value) {
      nameField.value = data.name;
      // updatePayBtn is hoisted (function declaration) so it is safe to call here
      updatePayBtn();
    }
    if (data.email && emailField && !emailField.value) {
      emailField.value = data.email;
      updatePayBtn();
    }
    if (data.phone && phoneField && !phoneField.value) {
      phoneField.value = data.phone;
      updatePayBtn();
    }
  } catch (_) { /* localStorage may be blocked in private mode */ }
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
  // Clear the uploaded insurance file since it's no longer needed
  clearInsuranceFile();
  updateTotal();
  updatePayBtn();
});

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
const todayStr = new Date().toISOString().split("T")[0];
pickup.setAttribute("min", todayStr);
returnDate.setAttribute("min", todayStr);

agreeCheckbox.addEventListener("change", updatePayBtn);
document.getElementById("name").addEventListener("input", updatePayBtn);
document.getElementById("email").addEventListener("input", updatePayBtn);

// ----- Inline Rental Agreement / Signing -----
// Opens the inline agreement panel pre-filled with the current booking details.
// No external service is used — the customer reads the terms and types their
// full name as an electronic signature.  The typed name is stored in
// agreementSignature and included in the owner confirmation email.
document.getElementById("signAgreementBtn").addEventListener("click", function () {
  const renterName = document.getElementById("name").value.trim();
  const pickupVal  = document.getElementById("pickup").value;
  const returnVal  = document.getElementById("return").value;

  // Populate the agreement intro paragraph with live booking details
  const intro = document.getElementById("agreementIntro");
  if (intro) {
    const namePart   = renterName  ? `<strong>${renterName}</strong>` : "<strong>[Renter]</strong>";
    const carPart    = `<strong>${carData.name}</strong>`;
    const pickPart   = pickupVal  ? `<strong>${pickupVal}</strong>`  : "<strong>[pickup date]</strong>";
    const retPart    = returnVal  ? `<strong>${returnVal}</strong>`  : "<strong>[return date]</strong>";
    const lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
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

  // Update the Security Deposit section to reflect actual vehicle pricing.
  // All vehicles offer DPP. Slingshot always includes a $150 deposit in the rental payment.
  // Camry vehicles have no security deposit.
  const depositHeadingEl = document.getElementById("agreementDepositHeading");
  const depositIntroEl    = document.getElementById("agreementDepositIntro");
  const depositInsEl      = document.getElementById("agreementDepositInsurance");
  const depositDppEl      = document.getElementById("agreementDepositDpp");
  const depositNeitherEl  = document.getElementById("agreementDepositNeither");
  const speedSection      = document.getElementById("slingshotSpeedSection");
  const depositLang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
  if (carData.hourlyTiers) {
    if (depositHeadingEl) depositHeadingEl.style.display = "";
    if (depositLang === "es") {
      if (depositIntroEl) depositIntroEl.innerHTML =
        `Se incluye un <strong>dep\u00F3sito de seguridad reembolsable de $${carData.deposit}</strong> en el pago del alquiler ` +
        `y se devuelve tras la inspecci\u00F3n del veh\u00EDculo al devolverlo (normalmente en 5\u20137 d\u00EDas h\u00E1biles). ` +
        `El dep\u00F3sito cubre da\u00F1os, p\u00E9rdida de uso, limpieza, peajes y combustible.`;
      if (depositDppEl) { depositDppEl.style.display = ""; depositDppEl.innerHTML = "<strong>Plan de Protecci\u00F3n de Da\u00F1os ($13/d\u00EDa &bull; $85/semana &bull; $150/2 sem &bull; $295/mes):</strong> complemento opcional &mdash; reduce tu responsabilidad por da\u00F1os a $1,000"; }
      if (depositNeitherEl) {
        const rateList = carData.hourlyTiers
          ? carData.hourlyTiers.map(t => `$${t.price} / ${t.hours} hrs`).join(" &bull; ")
          : "";
        depositNeitherEl.innerHTML =
          `<strong>Tarifas de Alquiler Slingshot:</strong> ${rateList} &mdash; m\u00E1s dep\u00F3sito de seguridad reembolsable de $${carData.deposit} (incluido en el pago)`;
      }
    } else {
      if (depositIntroEl) depositIntroEl.innerHTML =
        `A <strong>$${carData.deposit} refundable security deposit</strong> is included in the rental payment ` +
        `and returned after the vehicle is inspected upon return (typically within 5&ndash;7 business days). ` +
        `Deposit covers damages, loss of use, cleaning, tolls, and fuel.`;
      if (depositDppEl)     { depositDppEl.style.display = ""; depositDppEl.innerHTML = "<strong>Damage Protection Plan ($13/day &bull; $85/week &bull; $150/2 wks &bull; $295/month):</strong> optional add-on &mdash; reduces your damage liability to $1,000"; }
      if (depositNeitherEl) {
        const rateList = carData.hourlyTiers
          ? carData.hourlyTiers.map(t => `$${t.price} / ${t.hours} hrs`).join(" &bull; ")
          : "";
        depositNeitherEl.innerHTML =
          `<strong>Slingshot Rental Rates:</strong> ${rateList} &mdash; plus $${carData.deposit} refundable security deposit (included in payment)`;
      }
    }
    if (depositInsEl) depositInsEl.style.display = "none";

    // Show Slingshot speed & strike policy
    if (speedSection) speedSection.style.display = "";
  } else {
    // For Camry: show the deposit/DPP section with a heading that accurately reflects no deposit.
    // Removing data-i18n prevents applyTranslations() from overriding the heading text below.
    if (depositHeadingEl) {
      depositHeadingEl.removeAttribute("data-i18n");
      depositHeadingEl.textContent = depositLang === "es"
        ? "DEP\u00D3SITO DE SEGURIDAD Y PLAN DE PROTECCI\u00D3N DE DA\u00D1OS"
        : "SECURITY DEPOSIT & DAMAGE PROTECTION PLAN";
      depositHeadingEl.style.display = "";
    }
    if (depositLang === "es") {
      if (depositIntroEl) depositIntroEl.textContent = "No se requiere dep\u00F3sito de seguridad para este veh\u00EDculo.";
      if (depositDppEl) { depositDppEl.style.display = ""; depositDppEl.innerHTML = "<strong>Plan de Protecci\u00F3n de Da\u00F1os ($13/d\u00EDa &bull; $85/semana &bull; $150/2 sem &bull; $295/mes):</strong> complemento opcional &mdash; reduce tu responsabilidad por da\u00F1os a $1,000"; }
    } else {
      if (depositIntroEl) depositIntroEl.textContent = "No security deposit is required for this vehicle.";
      if (depositDppEl)     { depositDppEl.style.display = ""; depositDppEl.innerHTML = "<strong>Damage Protection Plan ($13/day &bull; $85/week &bull; $150/2 wks &bull; $295/month):</strong> optional add-on &mdash; reduces your damage liability to $1,000"; }
    }
    if (depositInsEl)     depositInsEl.style.display = "none";
    if (depositNeitherEl) depositNeitherEl.style.display = "none";
    // Hide Slingshot speed & strike policy for non-Slingshot vehicles
    if (speedSection) speedSection.style.display = "none";
  }

  // Show/hide the booking deposit policy section (Slingshot only)
  const bookingDepositSection = document.getElementById("slingshotBookingDepositSection");
  if (bookingDepositSection) {
    bookingDepositSection.style.display = carData.hourlyTiers ? "" : "none";
  }

  // Update Payment Terms body to accurately describe when/how payment is collected.
  // Removing data-i18n prevents applyTranslations() from overwriting the corrected text.
  const paymentTermsBodyEl = document.getElementById("agreementPaymentTermsBody");
  if (paymentTermsBodyEl) {
    paymentTermsBodyEl.removeAttribute("data-i18n");
    if (carData.hourlyTiers) {
      // Slingshot: $50 charged online at booking; rest at pickup
      paymentTermsBodyEl.textContent = depositLang === "es"
        ? "Un dep\u00F3sito de reserva no reembolsable de $50 se cobra en l\u00EDnea al momento de la reserva. El saldo restante (tarifa de alquiler + dep\u00F3sito de seguridad de $150) vence al momento de la recogida. Los pagos atrasados acumulan intereses del 1.5% mensual. Cargo por cheque devuelto (NSF): $35."
        : "A $50 non-refundable reservation deposit is charged online at the time of booking. The remaining balance (rental fee + $150 security deposit) is due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.";
    } else {
      // Camry: full payment online, OR $50 deposit if renter chose "Reserve Now"
      paymentTermsBodyEl.textContent = depositLang === "es"
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
let returnTimePicker = null;

// ----- Slingshot: auto-compute return date/time from pickup + duration -----
function applySlingshotDuration() {
  if (!carData.hourlyTiers) return;
  const selectedDuration = document.querySelector('input[name="slingshotDuration"]:checked');
  if (!selectedDuration) return;

  const hours = parseInt(selectedDuration.value, 10);
  currentSlingshotDuration = hours;

  const dateStr = pickup.value; // "YYYY-MM-DD"
  if (!dateStr) { updatePayBtn(); return; }

  // Normalize pickupTime.value to "HH:MM" regardless of Flatpickr's "h:i K" format
  let timeStr = "12:00"; // default noon if no time selected
  const rawTime = pickupTime.value;
  if (rawTime) {
    const nativeTest = new Date("1970-01-01T" + rawTime);
    if (!isNaN(nativeTest)) {
      // Already HH:MM (native input or Flatpickr with 24-hr format)
      timeStr = rawTime.slice(0, 5);
    } else {
      // Flatpickr "h:i K" — e.g. "2:30 PM"
      const m = rawTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (m) {
        let h = parseInt(m[1], 10);
        const mins = m[2];
        const period = m[3].toUpperCase();
        if (period === "PM" && h !== 12) h += 12;
        if (period === "AM" && h === 12) h = 0;
        timeStr = String(h).padStart(2, "0") + ":" + mins;
      }
    }
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

  // Update return time (via Flatpickr API if available, otherwise direct)
  if (returnTimePicker) {
    returnTimePicker.setDate(returnMoment, true);
  } else {
    returnTime.value = retTimeStr;
  }

  // Show the return section so the renter can see their auto-computed return time
  const retSection = document.getElementById("returnDateSection");
  if (retSection) retSection.style.display = "";

  updateTotal();
  updatePayBtn();
}

// Flag set to true inside initDatePickers() once Flatpickr takes over.
// Flatpickr already fires native change events after its own onChange, so
// the native listeners below must skip when Flatpickr is active to avoid
// calling updateTotal() / applySlingshotDuration() twice on every selection.
let flatpickrActive = false;
[pickup, pickupTime, returnDate, returnTime].forEach(function(inp) {
  inp.addEventListener("change", function() {
    if (flatpickrActive) return; // Flatpickr's own onChange handles this
    if (carData.hourlyTiers) {
      applySlingshotDuration();
    } else {
      updateTotal();
    }
  });
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
    }
  } catch (e) { console.error("Failed to load booked dates:", e); }

  // Pre-compile range boundaries to millisecond timestamps once so the
  // disable callback never allocates new Date objects per calendar cell.
  const compiledRanges = bookedRanges.map(function(r) {
    return {
      from: new Date(r.from + "T00:00:00").getTime(),
      to: new Date(r.to + "T23:59:59").getTime()
    };
  });

  function isBooked(date) {
    const t = date.getTime();
    return compiledRanges.some(function(r) { return t >= r.from && t <= r.to; });
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
      if (carData.hourlyTiers) {
        applySlingshotDuration();
      } else {
        updateTotal();
      }
    }
  });

  returnPicker = flatpickr(returnDate, {
    minDate: "today",
    disable: [isBooked],
    onChange: function() {
      if (!carData.hourlyTiers) updateTotal();
    }
  });

  flatpickr(pickupTime, {
    enableTime: true,
    noCalendar: true,
    dateFormat: "h:i K",
    onChange: function(selectedDates, timeStr) {
      if (carData.hourlyTiers) {
        applySlingshotDuration();
      } else {
        if (returnTimePicker) returnTimePicker.setDate(timeStr, true, "h:i K");
      }
    }
  });

  returnTimePicker = flatpickr(returnTime, {
    enableTime: true,
    noCalendar: true,
    dateFormat: "h:i K",
    clickOpens: false
  });

  // Flatpickr is now fully active; native change listeners will defer to it.
  flatpickrActive = true;
}

initDatePickers();

// ----- Fleet Status Check -----
// Fetch the vehicle's availability from fleet-status.json. If the vehicle is
// globally marked unavailable (e.g. already booked or taken offline), show a
// clear notice and disable all booking form fields so the customer cannot
// attempt payment. Fails open on any API error so transient outages do not
// lock out the form.
(async function checkFleetStatus() {
  try {
    const resp = await fetch(`${API_BASE}/api/fleet-status`);
    if (!resp.ok) return;
    const status = await resp.json();
    const entry = status[vehicleId];
    if (entry && entry.available === false) {
      showVehicleUnavailable();
    }
  } catch (err) {
    console.warn("Could not check fleet status:", err);
  }
})();

function showVehicleUnavailable() {
  const bookingSection = document.querySelector(".booking");
  if (!bookingSection) return;

  // Insert an unavailability notice at the top of the booking section
  if (!document.getElementById("vehicleUnavailableNotice")) {
    const notice = document.createElement("div");
    notice.id = "vehicleUnavailableNotice";
    notice.className = "vehicle-unavailable-notice";
    notice.innerHTML = `
      <p>🚫 This vehicle is currently unavailable</p>
      <p>This car is already booked. Please
        <a href="cars.html">browse other available vehicles</a>
        or check back later.</p>`;
    bookingSection.insertBefore(notice, bookingSection.firstChild);
  }

  // Disable all interactive form elements inside the booking section
  bookingSection.querySelectorAll("input, button, select, textarea").forEach(function (el) {
    el.disabled = true;
  });

  // Explicitly hide the pay button and its hint text
  stripeBtn.style.display = "none";
  const hint = document.getElementById("payHint");
  if (hint) hint.style.display = "none";
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
    function fpSet(input, value) {
      if (!value || !input) return;
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
    fpSet(pickupTime, data.pickupTime);
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
      } else {
        if (noInsuranceRadio)  noInsuranceRadio.checked  = true;
        if (insuranceSection)  insuranceSection.style.display  = "none";
        if (protectionSection) protectionSection.style.display = "";
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
  }
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
    _reserveBtnReset.style.display = ""; // shown for all vehicles
    _reserveBtnReset.disabled = true;
  }
  _pendingPaymentMode = null;
  totalEl.textContent = "0";
  document.getElementById("subtotal").textContent = "0";
  document.getElementById("taxLine").style.display = "none";
  const taxNoteReset = document.getElementById("taxNote");
  if (taxNoteReset) taxNoteReset.style.display = "";
  currentSubtotal = 0;
  currentTaxRate = LA_TAX_RATE;
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
  // Insurance readiness: "yes" requires an uploaded file; "no" uses the protection plan (no upload).
  // Also accept pre-filled variables restored from a previous failed-payment attempt.
  const insuranceReady = (insuranceCoverageChoice === "yes" && (insuranceUpload.files.length > 0 || uploadedInsurance !== null)) ||
                          insuranceCoverageChoice === "no";
  const nameValid = isValidName(nameVal);
  // Hourly-tier vehicles need pickup + duration; other vehicles need pickup + return date
  const datesReady = carData.hourlyTiers
    ? pickup.value && currentSlingshotDuration
    : pickup.value && returnDate.value;
  const ready = datesReady && agreeCheckbox.checked && (idUpload.files.length > 0 || uploadedFile !== null) && insuranceReady && nameValid && emailVal;
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
    currentDayCount = 1; // DPP uses 1 day for any slingshot rental

    // Compute the full rental cost for both the breakdown display and the booking payload.
    const dppCost = insuranceCoverageChoice === "no" ? PROTECTION_PLAN_DAILY : 0;
    const fullRentalBase = tier.price + dppCost + carData.deposit;
    const fullRentalTax = fullRentalBase * currentTaxRate;
    const fullRentalGrand = fullRentalBase + fullRentalTax;
    // Store full rental total on carData for the booking payload
    carData._fullRentalCost = fullRentalGrand.toFixed(2);
    carData._balanceAtPickup = (fullRentalGrand - (carData.bookingDeposit || 0)).toFixed(2);

    // Always show the full rental breakdown so renters know the total cost.
    // The two buttons (Reserve $50 / Book Now $X) let them choose how much to pay now.
    const lines = [];
    lines.push({ label: _fmt("booking.tierRentalFmt", { label: `${tier.hours} ${_t("fleet.hours","Hours")}` }, `${tier.label} rental`), amount: tier.price });
    lines.push({ label: _t("booking.securityDepositRef", "Security deposit (refundable)"), amount: carData.deposit });

    // DPP for slingshot is always 1 day ($13) if chosen
    if (insuranceCoverageChoice === "no") {
      lines.push({ label: _fmt("booking.dppSlingshotFmt", { price: PROTECTION_PLAN_DAILY }, `Damage Protection Plan (1 day \u00D7 $${PROTECTION_PLAN_DAILY}/day)`), amount: PROTECTION_PLAN_DAILY });
    }

    currentSubtotal = fullRentalBase;
    const displayTotal = currentTaxRate > 0 ? fullRentalGrand : fullRentalBase;
    if (currentTaxRate > 0) {
      const pct = +((currentTaxRate * 100).toFixed(4));
      lines.push({ label: _fmt("booking.salesTaxFmt", { rate: pct }, `Sales tax (${pct}%)`), amount: fullRentalTax.toFixed(2) });
    } else {
      lines.push({ label: _t("booking.salesTax", "Sales tax"), amount: null });
    }

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
      valueSpan.textContent = l.amount !== null ? "$" + l.amount : _t("booking.calcAtCheckout","Calculated at checkout");
      row.appendChild(labelSpan);
      row.appendChild(valueSpan);
      frag.appendChild(row);
    });
    rowsEl.innerHTML = "";
    rowsEl.appendChild(frag);
    document.getElementById("priceBreakdown").style.display = "";

    document.getElementById("subtotal").textContent = fullRentalBase;
    const taxLineEl = document.getElementById("taxLine");
    const taxNoteEl = document.getElementById("taxNote");
    if (currentTaxRate > 0) {
      document.getElementById("tax").textContent = fullRentalTax.toFixed(2);
      taxLineEl.style.display = "";
      if (taxNoteEl) taxNoteEl.style.display = "none";
      totalEl.textContent = fullRentalGrand.toFixed(2);
    } else {
      taxLineEl.style.display = "none";
      if (taxNoteEl) taxNoteEl.style.display = "";
      totalEl.textContent = fullRentalBase;
    }
    stripeBtn.textContent = window.slyI18n.t("booking.payPrefix") + displayTotal.toFixed(2);
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
  // Add Damage Protection Plan if the renter has no rental coverage (tiered rates).
  if (insuranceCoverageChoice === "no") {
    let protectionCost = 0;
    let protDays = currentDayCount;
    const protLines = [];
    if (protDays >= 30) {
      const months = Math.floor(protDays / 30);
      protectionCost += months * PROTECTION_PLAN_MONTHLY;
      protLines.push(months === 1 ? _fmt("booking.fmtMonth1", { price: PROTECTION_PLAN_MONTHLY }, `1 month \u00D7 $${PROTECTION_PLAN_MONTHLY}/mo`) : _fmt("booking.fmtMonthN", { n: months, price: PROTECTION_PLAN_MONTHLY }, `${months} months \u00D7 $${PROTECTION_PLAN_MONTHLY}/mo`));
      protDays = protDays % 30;
    }
    if (protDays >= 14) {
      const twoWeeks = Math.floor(protDays / 14);
      protectionCost += twoWeeks * PROTECTION_PLAN_BIWEEKLY;
      protLines.push(twoWeeks === 1 ? _fmt("booking.fmtTwoWeeks1", { price: PROTECTION_PLAN_BIWEEKLY }, `1 2-week period \u00D7 $${PROTECTION_PLAN_BIWEEKLY}`) : _fmt("booking.fmtTwoWeeksN", { n: twoWeeks, price: PROTECTION_PLAN_BIWEEKLY }, `${twoWeeks} 2-week periods \u00D7 $${PROTECTION_PLAN_BIWEEKLY}`));
      protDays = protDays % 14;
    }
    if (protDays >= 7) {
      const weeks = Math.floor(protDays / 7);
      protectionCost += weeks * PROTECTION_PLAN_WEEKLY;
      protLines.push(weeks === 1 ? _fmt("booking.fmtWeek1", { price: PROTECTION_PLAN_WEEKLY }, `1 week \u00D7 $${PROTECTION_PLAN_WEEKLY}/wk`) : _fmt("booking.fmtWeekN", { n: weeks, price: PROTECTION_PLAN_WEEKLY }, `${weeks} weeks \u00D7 $${PROTECTION_PLAN_WEEKLY}/wk`));
      protDays = protDays % 7;
    }
    if (protDays > 0) {
      protectionCost += protDays * PROTECTION_PLAN_DAILY;
      protLines.push(protDays === 1 ? _fmt("booking.fmtDay1", { price: PROTECTION_PLAN_DAILY }, `1 day \u00D7 $${PROTECTION_PLAN_DAILY}/day`) : _fmt("booking.fmtDayN", { n: protDays, price: PROTECTION_PLAN_DAILY }, `${protDays} days \u00D7 $${PROTECTION_PLAN_DAILY}/day`));
    }
    cost += protectionCost;
    lines.push({ label: _fmt("booking.dppFmt", { detail: protLines.join(" + ") }, `Damage Protection Plan (${protLines.join(" + ")})`), amount: protectionCost });
  }

  const rentalSubtotal = cost + (carData.deposit || 0);
  currentSubtotal = rentalSubtotal;
  const taxAmount = rentalSubtotal * currentTaxRate;
  const grandTotal = rentalSubtotal + taxAmount;

  // Sales tax breakdown row — show computed amount when ZIP has been resolved,
  // otherwise indicate it will be calculated at checkout.
  if (currentTaxRate > 0) {
    const pct = +((currentTaxRate * 100).toFixed(4));
    lines.push({ label: _fmt("booking.salesTaxFmt", { rate: pct }, `Sales tax (${pct}%)`), amount: taxAmount.toFixed(2) });
  } else {
    lines.push({ label: _t("booking.salesTax", "Sales tax"), amount: null });
  }

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
    valueSpan.textContent = l.amount !== null ? "$" + l.amount : _t("booking.calcAtCheckout","Calculated at checkout");
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
  const displayTotal = currentTaxRate > 0 ? grandTotal : rentalSubtotal;
  if (currentTaxRate > 0) {
    document.getElementById("tax").textContent = taxAmount.toFixed(2);
    taxLineEl.style.display = "";
    if (taxNoteEl) taxNoteEl.style.display = "none";
    totalEl.textContent = grandTotal.toFixed(2);
  } else {
    taxLineEl.style.display = "none";
    if (taxNoteEl) taxNoteEl.style.display = "";
    totalEl.textContent = rentalSubtotal;
  }
  stripeBtn.textContent = window.slyI18n.t("booking.payPrefix") + displayTotal.toFixed(2);
  updatePayBtn();
}

// ----- Pay Now -----
stripeBtn.addEventListener("click", async () => {
  // Resolve payment mode: deposit when reserveBtn was clicked, full when stripeBtn clicked directly.
  // _pendingPaymentMode is set by reserveBtn before it calls stripeBtn.click().
  if (_pendingPaymentMode === null) {
    _pendingPaymentMode = 'full'; // stripeBtn is always "Book Now" for all vehicles
  }
  const paymentMode = _pendingPaymentMode;
  _pendingPaymentMode = null; // consume and reset

  const email = document.getElementById("email").value;
  const nameVal = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  if (!email) { alert(window.slyI18n.t("booking.alertEmail")); return; }
  if (!nameVal) { alert(window.slyI18n.t("booking.alertName")); return; }

  // Determine the amount charged now: deposit = small upfront hold; full = complete rental payment.
  const isDepositMode = paymentMode === 'deposit';
  const depositAmount = carData.bookingDeposit || CAMRY_BOOKING_DEPOSIT;
  // For Slingshot: only $50 booking deposit is charged now; rest at pickup.
  // For Camry reserve mode: only CAMRY_BOOKING_DEPOSIT charged now; rest at pickup.
  // For Camry full mode: full rental amount charged now.
  const displayPayNow = isDepositMode ? depositAmount.toFixed(2) : totalEl.textContent;

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
        pickup: pickup.value,
        returnDate: returnDate.value,
        protectionPlan: insuranceCoverageChoice === "no",
        ...(carData.hourlyTiers ? { slingshotDuration: currentSlingshotDuration } : {}),
        paymentMode,
      })
    });

    const data = await res.json();

    if (!res.ok) {
      // Surface the server's error message so setup issues are visible
      const isDatesError = res.status === 409;
      throw Object.assign(new Error(data.error || "Server error (" + res.status + ")"), { isDatesError });
    }

    const { clientSecret, publishableKey } = data;
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
    const totalCents = isDepositMode
      ? depositAmount * 100
      : Math.round(parseFloat(totalEl.textContent) * 100);
    const paymentReq = stripe.paymentRequest({
      country: "US",
      currency: "usd",
      total: {
        label: isDepositMode
          ? carData.name + " Reservation Deposit (Non-Refundable)"
          : carData.name + " Rental",
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
          total: isDepositMode ? String(depositAmount) : totalEl.textContent,
          ...(isDepositMode ? {
            fullRentalCost: carData._fullRentalCost || totalEl.textContent,
            balanceAtPickup: carData._balanceAtPickup || (parseFloat(totalEl.textContent) - depositAmount).toFixed(2),
          } : {}),
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
          protectionPlan: insuranceCoverageChoice === "no",
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
        total: isDepositMode ? String(depositAmount) : totalEl.textContent,
        ...(isDepositMode ? {
          fullRentalCost: carData._fullRentalCost || totalEl.textContent,
          balanceAtPickup: carData._balanceAtPickup || (parseFloat(totalEl.textContent) - depositAmount).toFixed(2),
        } : {}),
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
        protectionPlan: insuranceCoverageChoice === "no",
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
        // Notify owner of the failed payment attempt (fire-and-forget, non-blocking).
        // Keep booking data in sessionStorage with paymentFailed:true so the form
        // can be pre-filled automatically when the renter returns to try again.
        fetch(API_BASE + "/api/send-reservation-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...bookingPayload,
            paymentStatus: "failed",
            idBase64,
            idFileName,
            idMimeType,
            insuranceBase64,
            insuranceFileName,
            insuranceMimeType,
          }),
        }).catch(function (err) { console.error("Failed to notify owner of payment failure:", err); });
        sessionStorage.setItem("slyRidesBooking", JSON.stringify({
          ...bookingPayload,
          paymentFailed: true,
          insuranceCoverageChoice,
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
      alert(err.message);
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
    alert(userMessage);
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

