// ----- API Base URL -----
// The frontend is served by GitHub Pages (www.slytrans.com).
// The API functions are deployed on Vercel (sly-rides.vercel.app).
// Because they are on different domains, the full Vercel URL must be used here.
const API_BASE = "https://sly-rides.vercel.app";

// ----- Car Data -----
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    // Slingshot uses hourly tier pricing — no daily/weekly/monthly rates.
    hourlyTiers: [
      { hours: 3,  price: 200, label: "3 Hours" },
      { hours: 6,  price: 250, label: "6 Hours" },
      { hours: 24, price: 350, label: "24 Hours" },
    ],
    deposit: 150,
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
    subtitle: "Sports • 2-Seater",
    hourlyTiers: [
      { hours: 3,  price: 200, label: "3 Hours" },
      { hours: 6,  price: 250, label: "6 Hours" },
      { hours: 24, price: 350, label: "24 Hours" },
    ],
    deposit: 150,
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
    pricePerDay: 50,
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

// ----- Load Car Data -----
const vehicleId = getVehicleFromURL();
if (!vehicleId || !cars[vehicleId]) {
  alert(window.slyI18n ? window.slyI18n.t("booking.alertVehicleNotFound") : "Vehicle not found.");
  window.location.href = "index.html";
}

const carData = cars[vehicleId];
document.getElementById("carName").textContent = carData.name;
document.getElementById("carSubtitle").textContent = carData.subtitle;
document.getElementById("carPrice").textContent = (carData.hourlyTiers)
  ? carData.hourlyTiers.map(t => `$${t.price} / ${t.hours}hrs`).join(" \u2022 ")
  : (carData.weekly)
    ? `$${carData.pricePerDay} / day \u2022 from $${carData.weekly} / week`
    : `$${carData.pricePerDay} / day`;

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
        nameError.textContent = 'Please enter at least a first and last name.';
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
  fileInfoEl.querySelector(".file-name").textContent = "No file selected";
  fileInfoEl.querySelector(".file-size").textContent = "";
  fileInfoEl.classList.remove("has-file");
}

function resetInsuranceFileInfo() {
  const el = document.getElementById("insuranceFileInfo");
  el.querySelector(".file-name").textContent = "No file selected";
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
  } else {
    if (depositHeadingEl) depositHeadingEl.style.display = "none";
    if (depositLang === "es") {
      if (depositIntroEl) depositIntroEl.textContent = "No se requiere dep\u00F3sito de seguridad para este veh\u00EDculo.";
      if (depositDppEl) { depositDppEl.style.display = ""; depositDppEl.innerHTML = "<strong>Plan de Protecci\u00F3n de Da\u00F1os ($13/d\u00EDa &bull; $85/semana &bull; $150/2 sem &bull; $295/mes):</strong> complemento opcional &mdash; reduce tu responsabilidad por da\u00F1os a $1,000"; }
    } else {
      if (depositIntroEl) depositIntroEl.textContent = "No security deposit is required for this vehicle.";
      if (depositDppEl)     { depositDppEl.style.display = ""; depositDppEl.innerHTML = "<strong>Damage Protection Plan ($13/day &bull; $85/week &bull; $150/2 wks &bull; $295/month):</strong> optional add-on &mdash; reduces your damage liability to $1,000"; }
    }
    if (depositInsEl)     depositInsEl.style.display = "none";
    if (depositNeitherEl) depositNeitherEl.style.display = "none";
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
      sigError.textContent = "Signature must match the full name entered in the booking form.";
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
  btn.textContent = "✅ Rental Agreement Signed";

  status.style.display = "";
  status.style.color   = "#4caf50";
  status.textContent   = `Signed by ${sig}. Check the box below to confirm.`;

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
  signBtn.textContent = "✍ Review & Sign Rental Agreement";
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
  document.getElementById("payment-message").textContent = "";
  stripeBtn.style.display = "";
  stripeBtn.textContent = window.slyI18n.t("booking.payNow");
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
});

function updatePayBtn() {
  const nameVal = document.getElementById("name").value.trim();
  const emailVal = document.getElementById("email").value.trim();
  // Insurance readiness: "yes" requires an uploaded file; "no" uses the protection plan (no upload)
  const insuranceReady = (insuranceCoverageChoice === "yes" && insuranceUpload.files.length > 0) ||
                          insuranceCoverageChoice === "no";
  const nameValid = isValidName(nameVal);
  // Hourly-tier vehicles need pickup + duration; other vehicles need pickup + return date
  const datesReady = carData.hourlyTiers
    ? pickup.value && currentSlingshotDuration
    : pickup.value && returnDate.value;
  const ready = datesReady && agreeCheckbox.checked && idUpload.files.length > 0 && insuranceReady && nameValid && emailVal;
  stripeBtn.disabled = !ready;
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

    const lines = [];
    lines.push({ label: `${tier.label} rental`, amount: tier.price });
    lines.push({ label: "Security deposit (refundable)", amount: carData.deposit });

    // DPP for slingshot is always 1 day ($13) if chosen
    if (insuranceCoverageChoice === "no") {
      lines.push({ label: `Damage Protection Plan (1 day × $${PROTECTION_PLAN_DAILY}/day)`, amount: PROTECTION_PLAN_DAILY });
    }

    let cost = tier.price + (insuranceCoverageChoice === "no" ? PROTECTION_PLAN_DAILY : 0);
    const rentalSubtotal = cost + carData.deposit;
    currentSubtotal = rentalSubtotal;
    const taxAmount = rentalSubtotal * currentTaxRate;
    const grandTotal = rentalSubtotal + taxAmount;

    if (currentTaxRate > 0) {
      const pct = +((currentTaxRate * 100).toFixed(4));
      lines.push({ label: `Sales tax (${pct}%)`, amount: taxAmount.toFixed(2) });
    } else {
      lines.push({ label: "Sales tax", amount: null });
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
      valueSpan.textContent = l.amount !== null ? "$" + l.amount : "Calculated at checkout";
      row.appendChild(labelSpan);
      row.appendChild(valueSpan);
      frag.appendChild(row);
    });
    rowsEl.innerHTML = "";
    rowsEl.appendChild(frag);
    document.getElementById("priceBreakdown").style.display = "";

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
    lines.push({ label: `${months} month${months > 1 ? "s" : ""} × $${carData.monthly}/mo`, amount: subtotal });
  }
  if (carData.biweekly && remaining >= 14) {
    const twoWeekPeriods = Math.floor(remaining / 14);
    const subtotal = twoWeekPeriods * carData.biweekly;
    cost += subtotal;
    remaining = remaining % 14;
    lines.push({ label: `${twoWeekPeriods} 2-week period${twoWeekPeriods > 1 ? "s" : ""} × $${carData.biweekly}`, amount: subtotal });
  }
  if (carData.weekly && remaining >= 7) {
    const weeks = Math.floor(remaining / 7);
    const subtotal = weeks * carData.weekly;
    cost += subtotal;
    remaining = remaining % 7;
    lines.push({ label: `${weeks} week${weeks > 1 ? "s" : ""} × $${carData.weekly}/wk`, amount: subtotal });
  }
  if (remaining > 0) {
    const subtotal = remaining * carData.pricePerDay;
    cost += subtotal;
    lines.push({ label: `${remaining} day${remaining > 1 ? "s" : ""} × $${carData.pricePerDay}/day`, amount: subtotal });
  }
  // Security deposit is always charged (never waived)
  if (carData.deposit) {
    lines.push({ label: "Security deposit", amount: carData.deposit });
  }
  // Add Damage Protection Plan if the renter has no rental coverage (tiered rates).
  if (insuranceCoverageChoice === "no") {
    let protectionCost = 0;
    let protDays = currentDayCount;
    const protLines = [];
    if (protDays >= 30) {
      const months = Math.floor(protDays / 30);
      protectionCost += months * PROTECTION_PLAN_MONTHLY;
      protLines.push(`${months} month${months > 1 ? "s" : ""} × $${PROTECTION_PLAN_MONTHLY}/mo`);
      protDays = protDays % 30;
    }
    if (protDays >= 14) {
      const twoWeeks = Math.floor(protDays / 14);
      protectionCost += twoWeeks * PROTECTION_PLAN_BIWEEKLY;
      protLines.push(`${twoWeeks} 2-week period${twoWeeks > 1 ? "s" : ""} × $${PROTECTION_PLAN_BIWEEKLY}`);
      protDays = protDays % 14;
    }
    if (protDays >= 7) {
      const weeks = Math.floor(protDays / 7);
      protectionCost += weeks * PROTECTION_PLAN_WEEKLY;
      protLines.push(`${weeks} week${weeks > 1 ? "s" : ""} × $${PROTECTION_PLAN_WEEKLY}/wk`);
      protDays = protDays % 7;
    }
    if (protDays > 0) {
      protectionCost += protDays * PROTECTION_PLAN_DAILY;
      protLines.push(`${protDays} day${protDays > 1 ? "s" : ""} × $${PROTECTION_PLAN_DAILY}/day`);
    }
    cost += protectionCost;
    lines.push({ label: `Damage Protection Plan (${protLines.join(" + ")})`, amount: protectionCost });
  }

  const rentalSubtotal = cost + (carData.deposit || 0);
  currentSubtotal = rentalSubtotal;
  const taxAmount = rentalSubtotal * currentTaxRate;
  const grandTotal = rentalSubtotal + taxAmount;

  // Sales tax breakdown row — show computed amount when ZIP has been resolved,
  // otherwise indicate it will be calculated at checkout.
  if (currentTaxRate > 0) {
    const pct = +((currentTaxRate * 100).toFixed(4));
    lines.push({ label: `Sales tax (${pct}%)`, amount: taxAmount.toFixed(2) });
  } else {
    lines.push({ label: "Sales tax", amount: null });
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
    valueSpan.textContent = l.amount !== null ? "$" + l.amount : "Calculated at checkout";
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
  const email = document.getElementById("email").value;
  const nameVal = document.getElementById("name").value.trim();
  if (!email) { alert(window.slyI18n.t("booking.alertEmail")); return; }
  if (!nameVal) { alert(window.slyI18n.t("booking.alertName")); return; }

  stripeBtn.disabled = true;
  stripeBtn.textContent = window.slyI18n.t("booking.loadingPayment");

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
    // Collect the cardholder name from our booking form (already validated).
    // Hide the duplicate name field inside the Stripe Payment Element so the
    // customer cannot accidentally clear or override it.
    const paymentElement = elements.create("payment", {
      fields: {
        billingDetails: { name: "never" },
      },
    });

    const paymentForm = document.getElementById("payment-form");
    document.getElementById("payAmount").textContent = totalEl.textContent;
    document.getElementById("submit-payment").textContent = window.slyI18n.t("booking.payPrefix") + totalEl.textContent;
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
      const phone = document.getElementById("phone").value.trim();
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
        total: totalEl.textContent,
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
              } catch (e) { db.close(); resolve(); }
            };
            idbReq.onerror = () => resolve();
          });
        } catch (e) {
          console.warn("Could not save ID to IndexedDB:", e);
        }
      }

      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: "https://www.slytrans.com/success.html",
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
        // Clear staged sessionStorage so stale data is not re-sent on retry or
        // accidentally picked up by success.html.
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
        sessionStorage.removeItem("slyRidesBooking");
        msgEl.textContent = error.message;
        submitBtn.disabled = false;
        submitBtn.textContent = window.slyI18n.t("booking.payPrefix") + totalEl.textContent;
        paymentSubmitting = false;
      }
    };

    document.getElementById("submit-payment").addEventListener("click", submitHandler);

    document.getElementById("cancel-payment").addEventListener("click", () => {
      paymentSubmitting = false; // reset in case cancelled mid-processing
      document.getElementById("submit-payment").removeEventListener("click", submitHandler);
      paymentElement.unmount();
      document.getElementById("payment-form").style.display = "none";
      document.getElementById("payment-message").textContent = "";
      stripeBtn.style.display = "";
      stripeBtn.textContent = window.slyI18n.t("booking.payNow");
      updatePayBtn();
    }, { once: true });

  } catch (err) {
    console.error("Stripe error:", err);
    stripeBtn.disabled = false;
    stripeBtn.textContent = window.slyI18n.t("booking.payNow");
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

