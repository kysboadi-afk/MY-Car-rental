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
    pricePerDay: 300,
    deposit: 150,
    images: ["images/car2.jpg","images/car1.jpg","images/car3.jpg"],
    make: "Polaris",
    model: "Slingshot XR",
    year: 2023,
    vin: "57XAARHB8P8156561",
    color: null
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    pricePerDay: 50,
    weekly: 320,
    biweekly: 600,
    monthly: 1250,
    images: ["images/car5.jpg","images/car4.jpg"],
    make: "Toyota",
    model: "Camry",
    year: 2012,
    vin: "4T1BF1FK5CU063142",
    color: "Grey"
  },
  camry2013: {
    name: "Camry 2013 SE",
    subtitle: "Sedan • 5-Seater",
    pricePerDay: 55,
    weekly: 350,
    biweekly: 650,
    monthly: 1300,
    images: ["images/IMG_5139.jpeg", "images/IMG_5140.jpeg", "images/IMG_5144.png", "images/IMG_5145.png"],
    make: "Toyota",
    model: "Camry SE",
    year: 2013,
    vin: "",
    color: ""
  }
};

// ----- Helpers -----
function getVehicleFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("vehicle");
}

// ----- Load Car Data -----
const vehicleId = getVehicleFromURL();
if (!vehicleId || !cars[vehicleId]) {
  alert("Vehicle not found.");
  window.location.href = "index.html";
}

const carData = cars[vehicleId];
document.getElementById("carName").textContent = carData.name;
document.getElementById("carSubtitle").textContent = carData.subtitle;
document.getElementById("carPrice").textContent = `$${carData.pricePerDay} / day`;

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
const totalEl = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");

let uploadedFile = null;
let currentDayCount = 1;
let agreementSignature = ""; // typed signature from the inline agreement panel

// ----- Pre-fill booking form from renter modal (cars.html) -----
// If the customer already entered their contact info in the "Before You Browse"
// modal, read it from sessionStorage and populate the booking fields so they
// don't have to type the same details again.
(function prefillFromLead() {
  try {
    const raw = sessionStorage.getItem('slyRidesLead');
    if (!raw) return;
    const lead = JSON.parse(raw);
    const nameField  = document.getElementById('name');
    const emailField = document.getElementById('email');
    const phoneField = document.getElementById('phone');
    if (nameField  && !nameField.value  && lead.name)  nameField.value  = lead.name;
    if (emailField && !emailField.value && lead.email) emailField.value = lead.email;
    if (phoneField && !phoneField.value && lead.phone) phoneField.value = lead.phone;
    // Re-evaluate the Pay button now that fields may be populated
    updatePayBtn();
  } catch (e) {
    // Non-fatal — silently ignore parse errors so the form still works
  }
}());

// ----- File Upload Handling -----
function resetFileInfo() {
  const fileInfoEl = document.getElementById("fileInfo");
  fileInfoEl.querySelector(".file-name").textContent = "No file selected";
  fileInfoEl.querySelector(".file-size").textContent = "";
  fileInfoEl.classList.remove("has-file");
}


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
    alert("Please upload a valid ID document (JPG, PNG, or PDF)");
    e.target.value = '';
    uploadedFile = null;
    resetFileInfo();
    updatePayBtn();
    return;
  }

  // Validate file size (5MB max)
  const maxSize = 5 * 1024 * 1024; // 5MB in bytes
  if (file.size > maxSize) {
    alert("File size must be less than 5MB");
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
    intro.innerHTML  = `This Rental Agreement is entered into between SLY Transportation Services ("Company") and ${namePart} ("Renter") for the rental of a ${carPart} from ${pickPart} to ${retPart}.`;
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

  // Pre-fill the signature field with the renter's name if already typed
  const sigInput = document.getElementById("signatureInput");
  if (sigInput && renterName && !sigInput.value) sigInput.value = renterName;

  document.getElementById("rentalAgreementBox").style.display = "";
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

// Native change listeners as fallback (Flatpickr also fires native change events)
[pickup, pickupTime, returnDate, returnTime].forEach(function(inp) {
  inp.addEventListener("change", updateTotal);
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

  function isBooked(date) {
    return bookedRanges.some(function(r) {
      const from = new Date(r.from + "T00:00:00");
      const to = new Date(r.to + "T23:59:59");
      return date >= from && date <= to;
    });
  }

  const pickupPicker = flatpickr(pickup, {
    minDate: "today",
    disable: [isBooked],
    onChange: function(selectedDates) {
      if (selectedDates[0]) {
        returnPicker.set("minDate", selectedDates[0]);
      }
      updateTotal();
    }
  });

  const returnPicker = flatpickr(returnDate, {
    minDate: "today",
    disable: [isBooked],
    onChange: function() { updateTotal(); }
  });

  let returnTimePicker;

  flatpickr(pickupTime, {
    enableTime: true,
    noCalendar: true,
    dateFormat: "h:i K",
    onChange: function(_, timeStr) {
      if (returnTimePicker) returnTimePicker.setDate(timeStr, true, "h:i K");
    }
  });

  returnTimePicker = flatpickr(returnTime, {
    enableTime: true,
    noCalendar: true,
    dateFormat: "h:i K",
    clickOpens: false
  });
}

initDatePickers();

// ----- Reset form on back-navigation (bfcache restore) -----
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
  stripeBtn.textContent = "💳 Pay Now";
  totalEl.textContent = "0";
  document.getElementById("priceBreakdown").style.display = "none";
  updatePayBtn();
  }
});

function updatePayBtn() {
  const nameVal = document.getElementById("name").value.trim();
  const emailVal = document.getElementById("email").value.trim();
  const ready = pickup.value && returnDate.value && agreeCheckbox.checked && idUpload.files.length > 0 && nameVal && emailVal;
  stripeBtn.disabled = !ready;
  const hint = document.getElementById("payHint");
  if (hint) hint.style.display = ready ? "none" : "block";
}

function updateTotal() {
  if(!pickup.value || !returnDate.value) return;
  currentDayCount = Math.max(1, Math.ceil((new Date(returnDate.value) - new Date(pickup.value))/(1000*3600*24)));

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
  if (carData.deposit) {
    lines.push({ label: "Security deposit", amount: carData.deposit });
  }
  // Tax is calculated by Stripe at checkout based on the customer's billing address.
  lines.push({ label: "Sales tax", amount: null });

  const subtotal = cost + (carData.deposit || 0);

  const rowsEl = document.getElementById("breakdownRows");
  rowsEl.innerHTML = "";
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
    rowsEl.appendChild(row);
  });
  document.getElementById("priceBreakdown").style.display = "";

  totalEl.textContent = subtotal;
  updatePayBtn();
}

// ----- Pay Now -----
stripeBtn.addEventListener("click", async () => {
  const email = document.getElementById("email").value;
  const nameVal = document.getElementById("name").value.trim();
  if (!email) { alert("Please enter your email address."); return; }
  if (!nameVal) { alert("Please enter your full name."); return; }

  stripeBtn.disabled = true;
  stripeBtn.textContent = "Loading payment form…";

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
        returnDate: returnDate.value
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
      submitBtn.textContent = "Processing…";
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
        pricePerDay: carData.pricePerDay,
        pricePerWeek: carData.weekly || null,
        pricePerBiWeekly: carData.biweekly || null,
        pricePerMonthly: carData.monthly || null,
        deposit: carData.deposit || 0,
        days: currentDayCount,
        idFileName,
        idMimeType,
        signature: agreementSignature || null,
      };
      // Store booking metadata in sessionStorage and the ID binary in
      // IndexedDB (no size cap) so both survive the Stripe redirect reliably.
      sessionStorage.setItem("slyRidesBooking", JSON.stringify(bookingPayload));

      if (idBase64 && idFileName) {
        try {
          await new Promise((resolve) => {
            const idbReq = indexedDB.open("slyRidesDB", 1);
            idbReq.onupgradeneeded = e => e.target.result.createObjectStore("files");
            idbReq.onsuccess = e => {
              const db = e.target.result;
              try {
                const tx = db.transaction("files", "readwrite");
                tx.objectStore("files").put({ idBase64, idFileName, idMimeType }, "pendingId");
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
          }),
        }).catch(function (err) { console.error("Failed to notify owner of payment failure:", err); });
        sessionStorage.removeItem("slyRidesBooking");
        msgEl.textContent = error.message;
        submitBtn.disabled = false;
        submitBtn.textContent = "Pay $" + totalEl.textContent;
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
      stripeBtn.textContent = "💳 Pay Now";
      updatePayBtn();
    }, { once: true });

  } catch (err) {
    console.error("Stripe error:", err);
    stripeBtn.disabled = false;
    stripeBtn.textContent = "💳 Pay Now";
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
      : "Could not load the payment form. Please refresh the page and try again, or contact support.";
    alert(userMessage);
  }
});

