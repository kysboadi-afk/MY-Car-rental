// ----- API Base URL -----
// The backend runs as a separate Vercel project; always use the absolute URL
// so that fetch calls work correctly from the GitHub Pages frontend.
const API_BASE = "https://slyservices-stripe-backend-ipeq.vercel.app";

// ----- Car Data -----
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    pricePerDay: 300,
    deposit: 150,
    images: ["images/car2.jpg","images/car1.jpg","images/car3.jpg"]
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    pricePerDay: 50,
    weekly: 300,
    images: ["images/car5.jpg","images/car4.jpg"]
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
document.getElementById("backBtn").addEventListener("click", ()=>window.location.href="index.html");

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

// ----- Send ID Document via Email -----
async function sendIDViaEmail() {
  if (!uploadedFile) {
    return false;
  }
  
  try {
    // Using FormSubmit service for email delivery
    const formData = new FormData();
    formData.append('_to', 'slyservices@supports-info.com');
    formData.append('_subject', `New Car Rental Booking - ${carData.name}`);
    formData.append('Car', carData.name);
    formData.append('Customer Email', document.getElementById("email").value);
    formData.append('Pickup Date', pickup.value);
    formData.append('Return Date', returnDate.value);
    formData.append('Total Amount', '$' + totalEl.textContent);
    formData.append('ID Document', uploadedFile);
    
    const response = await fetch('https://formsubmit.co/ajax/slyservices@supports-info.com', {
      method: 'POST',
      body: formData
    });
    
    return response.ok;
  } catch (error) {
    console.error('Error sending ID document:', error);
    return false;
  }
}

// Block past dates — only allow today or future dates
const todayStr = new Date().toISOString().split("T")[0];
pickup.setAttribute("min", todayStr);
returnDate.setAttribute("min", todayStr);

// Pre-fill dates from URL query params (e.g. when coming from "Check Now")
(function prefillDatesFromURL() {
  const params = new URLSearchParams(window.location.search);
  const prePickup = params.get("pickup");
  const preReturn = params.get("return");
  if (prePickup && prePickup >= todayStr) {
    pickup.value = prePickup;
  }
  if (preReturn && preReturn > (prePickup || todayStr)) {
    returnDate.value = preReturn;
  }
  if (pickup.value && returnDate.value) {
    updateTotal();
  }
})();

[pickup, pickupTime, returnDate, returnTime].forEach(inp=>{
  inp.addEventListener("change", updateTotal);
});
agreeCheckbox.addEventListener("change", updatePayBtn);

document
  .getElementById("pickupTime")
  ?.addEventListener("change", syncReturnTime);

function syncReturnTime() {
  const pickupTime = document.getElementById("pickupTime");
  const returnTime = document.getElementById("returnTime");

  if (!pickupTime || !returnTime) return;

  if (pickupTime.value) {
    returnTime.value = pickupTime.value;
  }
}

function updatePayBtn() {
  const ready = pickup.value && returnDate.value && agreeCheckbox.checked && idUpload.files.length > 0;
  stripeBtn.disabled = !ready;
  const hint = document.getElementById("payHint");
  if (hint) hint.style.display = ready ? "none" : "block";
}

function updateTotal() {
  if(!pickup.value || !returnDate.value) return;
  currentDayCount = Math.max(1, Math.ceil((new Date(returnDate.value) - new Date(pickup.value))/(1000*3600*24)));
  
  // Calculate cost with weekly rate if applicable
  const DAYS_PER_WEEK = 7;
  let cost = 0;
  if (carData.weekly && currentDayCount >= DAYS_PER_WEEK) {
    const weeks = Math.floor(currentDayCount / DAYS_PER_WEEK);
    const remainingDays = currentDayCount % DAYS_PER_WEEK;
    cost = (weeks * carData.weekly) + (remainingDays * carData.pricePerDay);
  } else {
    cost = currentDayCount * carData.pricePerDay;
  }
  
  const total = cost + (carData.deposit || 0);
  totalEl.textContent = total;
  updatePayBtn();
}

// ----- Reserve / Pay Now -----
stripeBtn.addEventListener("click", async ()=>{
  const email = document.getElementById("email").value;
  if(!email) { alert("Please enter your email address."); return; }

  stripeBtn.disabled = true;
  stripeBtn.textContent = "Processing...";

  try {
    const res = await fetch(API_BASE + "/api/create-checkout-session",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        car: carData.name,
        amount: parseFloat(totalEl.textContent),
        email: email,
        pickup: pickup.value,
        returnDate: returnDate.value
      })
    });

    if (!res.ok) {
      throw new Error("Server responded with status " + res.status);
    }

    const data = await res.json();
    if(data.url) {
      window.location.href = data.url;
    } else {
      throw new Error("No checkout URL returned");
    }
  } catch(err){
    console.error("Stripe error:", err);
    stripeBtn.disabled = false;
    stripeBtn.textContent = "💳 Pay Now";
    alert("Payment failed. Please try again or contact support.");
  }
});

// ----- Send Reservation Email -----
async function sendReservationEmail() {
  const email = document.getElementById("email").value;
  if (!email) {
    return false;
  }
  
  try {
    const formData = new FormData();
    formData.append('_to', 'slyservices@supports-info.com');
    formData.append('_subject', `New Reservation (No Payment) - ${carData.name}`);
    formData.append('Reservation Type', 'Reserve Without Payment');
    formData.append('Car', carData.name);
    formData.append('Customer Email', email);
    formData.append('Pickup Date', pickup.value);
    formData.append('Pickup Time', pickupTime.value || 'Not specified');
    formData.append('Return Date', returnDate.value);
    formData.append('Return Time', returnTime.value || 'Not specified');
    formData.append('Total Amount', '$' + totalEl.textContent);
    
    const response = await fetch('https://formsubmit.co/ajax/slyservices@supports-info.com', {
      method: 'POST',
      body: formData
    });
    
    return response.ok;
  } catch (error) {
    console.error('Error sending reservation email:', error);
    return false;
  }
}

// ----- Reserve Without Pay -----
async function reserve() {
  if(!pickup.value || !returnDate.value) { alert("Please select pickup and return dates."); return; }
  if(!idUpload.files.length) { alert("Please upload your Driver's License or ID."); return; }
  if(!agreeCheckbox.checked) { alert("Please agree to the Rental Agreement & Terms."); return; }

  const email = document.getElementById("email").value;
  if(!email) { alert("Please enter your email address."); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert("Please enter a valid email address."); return; }
  const phone = document.getElementById("phone").value;

  try {
    const res = await fetch(API_BASE + "/api/send-reservation-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        car: carData.name,
        pickup: pickup.value,
        pickupTime: pickupTime.value || '',
        returnDate: returnDate.value,
        returnTime: returnTime.value || '',
        email: email,
        phone: phone,
        total: totalEl.textContent,
        pricePerDay: carData.pricePerDay,
        pricePerWeek: carData.weekly || null,
        deposit: carData.deposit || 0,
        days: currentDayCount
      })
    });
    const emailSent = res.ok;
    alert(
      `✅ Reservation Confirmed!\n\n` +
      `🚗 Car: ${carData.name}\n` +
      `📅 Pickup: ${pickup.value}${pickupTime.value ? ' at ' + pickupTime.value : ''}\n` +
      `📅 Return: ${returnDate.value}${returnTime.value ? ' at ' + returnTime.value : ''}\n` +
      `💰 Total: $${totalEl.textContent}\n` +
      `📧 Email: ${email}\n` +
      (phone ? `📱 Phone: ${phone}\n` : '') +
      `\n` +
      (emailSent
        ? "A confirmation has been sent to your email. We will contact you shortly!"
        : "We will contact you shortly to confirm your reservation.")
    );
  } catch(e) {
    console.error("Reservation email notification failed:", e);
    alert(
      `✅ Reservation Confirmed!\n\n` +
      `🚗 Car: ${carData.name}\n` +
      `📅 Pickup: ${pickup.value}${pickupTime.value ? ' at ' + pickupTime.value : ''}\n` +
      `📅 Return: ${returnDate.value}${returnTime.value ? ' at ' + returnTime.value : ''}\n` +
      `💰 Total: $${totalEl.textContent}\n` +
      `📧 Email: ${email}\n` +
      (phone ? `📱 Phone: ${phone}\n` : '') +
      `\nWe will contact you shortly to confirm!`
    );
  }
}
