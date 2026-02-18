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
const totalEl = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");

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
  
  // Calculate cost with weekly rate if applicable
  const DAYS_PER_WEEK = 7;
  let cost = 0;
  if (carData.weekly && dayCount >= DAYS_PER_WEEK) {
    const weeks = Math.floor(dayCount / DAYS_PER_WEEK);
    const remainingDays = dayCount % DAYS_PER_WEEK;
    cost = (weeks * carData.weekly) + (remainingDays * carData.pricePerDay);
  } else {
    cost = dayCount * carData.pricePerDay;
  }
  
  const total = cost + (carData.deposit || 0);
  totalEl.textContent = total;
  stripeBtn.disabled = false;
}

// ----- Reserve / Pay Now -----
stripeBtn.addEventListener("click", async ()=>{
  const email = document.getElementById("email").value;
  if(!email) { alert("Enter email"); return; }

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
    else alert("Stripe session failed");
  } catch(err){ console.error(err); alert("Payment error"); }
});

// ----- Reserve Without Pay -----
function reserve() {
  alert(`Reserved ${carData.name} from ${pickup.value} to ${returnDate.value}`);
}
