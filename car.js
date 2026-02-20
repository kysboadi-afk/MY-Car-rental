// ----- Car Data -----
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    pricePerDay: 300,
    deposit: 150,
    images: ["images/car1.jpg","images/car2.jpg","images/car3.jpg"]
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    pricePerDay: 50,
    weekly: 250,
    images: ["images/car4.jpg","images/car5.jpg"]
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
const totalEl = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");
const idUpload = document.getElementById("idUpload");
const fileInfo = document.getElementById("fileInfo");

let uploadedFile = null;

// ----- File Upload Handling -----
idUpload.addEventListener("change", function(e) {
  const file = e.target.files[0];
  
  if (!file) {
    uploadedFile = null;
    updateFileInfo(null);
    updatePaymentButton();
    return;
  }
  
  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (!allowedTypes.includes(file.type)) {
    alert("Please upload a valid ID document (JPG, PNG, or PDF)");
    e.target.value = '';
    uploadedFile = null;
    updateFileInfo(null);
    updatePaymentButton();
    return;
  }
  
  // Validate file size (5MB max)
  const maxSize = 5 * 1024 * 1024; // 5MB in bytes
  if (file.size > maxSize) {
    alert("File size must be less than 5MB");
    e.target.value = '';
    uploadedFile = null;
    updateFileInfo(null);
    updatePaymentButton();
    return;
  }
  
  uploadedFile = file;
  updateFileInfo(file);
  updatePaymentButton();
});

function updateFileInfo(file) {
  const fileName = fileInfo.querySelector('.file-name');
  const fileSize = fileInfo.querySelector('.file-size');
  
  if (file) {
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    fileInfo.classList.add('has-file');
  } else {
    fileName.textContent = 'No file selected';
    fileSize.textContent = '';
    fileInfo.classList.remove('has-file');
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// ----- Send ID Document via Email -----
async function sendIDViaEmail() {
  if (!uploadedFile) {
    return false;
  }
  
  try {
    // Using FormSubmit service for email delivery
    const formData = new FormData();
    formData.append('_to', 'slyservices@support-info.com');
    formData.append('_subject', `New Car Rental Booking - ${carData.name}`);
    formData.append('Car', carData.name);
    formData.append('Customer Email', document.getElementById("email").value);
    formData.append('Pickup Date', pickup.value);
    formData.append('Return Date', returnDate.value);
    formData.append('Total Amount', '$' + totalEl.textContent);
    formData.append('ID Document', uploadedFile);
    
    const response = await fetch('https://formsubmit.co/ajax/slyservices@support-info.com', {
      method: 'POST',
      body: formData
    });
    
    return response.ok;
  } catch (error) {
    console.error('Error sending ID document:', error);
    return false;
  }
}

[pickup, pickupTime, returnDate, returnTime].forEach(inp=>{
  inp.addEventListener("change", updateTotal);
});
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

function updateTotal() {
  if(!pickup.value || !returnDate.value) return;
  const dayCount = Math.max(1, Math.ceil((new Date(returnDate.value) - new Date(pickup.value))/(1000*3600*24)));
  const total = dayCount * carData.pricePerDay + (carData.deposit || 0);
  totalEl.textContent = total;
  updatePaymentButton();
}

function updatePaymentButton() {
  // Enable payment button only if:
  // 1. Total is calculated (pickup and return dates are set)
  // 2. ID document is uploaded
  const hasTotal = totalEl.textContent !== '0';
  const hasID = uploadedFile !== null;
  
  stripeBtn.disabled = !(hasTotal && hasID);
}

// ----- Reserve / Pay Now -----
stripeBtn.addEventListener("click", async ()=>{
  const email = document.getElementById("email").value;
  if(!email) { alert("Enter email"); return; }
  
  if(!uploadedFile) {
    alert("Please upload your ID document before proceeding with payment");
    return;
  }
  
  // Send ID document via email
  stripeBtn.disabled = true;
  stripeBtn.textContent = "Sending ID...";
  
  const emailSent = await sendIDViaEmail();
  
  if (!emailSent) {
    alert("Failed to send ID document. Please try again or contact support.");
    stripeBtn.disabled = false;
    stripeBtn.textContent = "💳 Pay Now";
    return;
  }
  
  stripeBtn.textContent = "Processing...";

  try {
    const res = await fetch("https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",{
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
    const data = await res.json();
    if(data.url) window.location.href = data.url;
    else {
      alert("Stripe session failed");
      stripeBtn.disabled = false;
      stripeBtn.textContent = "💳 Pay Now";
    }
  } catch(err){ 
    console.error(err); 
    alert("Payment error");
    stripeBtn.disabled = false;
    stripeBtn.textContent = "💳 Pay Now";
  }
});

// ----- Reserve Without Pay -----
function reserve() {
  alert(`Reserved ${carData.name} from ${pickup.value} to ${returnDate.value}`);
}
