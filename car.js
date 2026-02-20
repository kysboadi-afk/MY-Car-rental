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
const agreeCheckbox = document.getElementById("agree");
const totalEl = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");

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
  stripeBtn.disabled = !(pickup.value && returnDate.value && agreeCheckbox.checked);
}

function updateTotal() {
  if(!pickup.value || !returnDate.value) return;
  const dayCount = Math.max(1, Math.ceil((new Date(returnDate.value) - new Date(pickup.value))/(1000*3600*24)));
  const total = dayCount * carData.pricePerDay + (carData.deposit || 0);
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
    if(data.url) {
      window.location.href = data.url;
    } else {
      alert("Payment could not be started. Please try again or contact us.");
      stripeBtn.disabled = false;
      stripeBtn.textContent = "💳 Pay Now";
    }
  } catch(err){
    console.error(err);
    alert("Payment error. Please check your connection and try again.");
    stripeBtn.disabled = false;
    stripeBtn.textContent = "💳 Pay Now";
  }
});

// ----- Reserve Without Pay -----
function reserve() {
  if(!pickup.value || !returnDate.value) { alert("Please select pickup and return dates."); return; }
  alert(`Reserved ${carData.name} from ${pickup.value} to ${returnDate.value}. We will contact you shortly!`);
}
