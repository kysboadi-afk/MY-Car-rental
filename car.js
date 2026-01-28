// ----------------------------
// Get vehicle from URL
// ----------------------------
const urlParams = new URLSearchParams(window.location.search);
const vehicleId = urlParams.get("vehicle");

// ----------------------------
// Vehicles data
// ----------------------------
const vehicles = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    images: ["images/car1.jpg","images/car2.jpg","images/car3.jpg"],
    pricePerDay: 300,
    deposit: 150,
    weekly: 0
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    images: ["images/car4.jpg","images/car5.jpg"],
    pricePerDay: 50,
    deposit: 0,
    weekly: 250
  }
};

// ----------------------------
// Select DOM elements
// ----------------------------
const sliderContainer = document.querySelector(".slider");
const carNameElem = document.querySelector("h3");
const carSubtitleElem = document.querySelector(".car-subtitle");
const priceElem = document.querySelector(".price");
const pickup = document.getElementById("pickup");
const pickupTime = document.getElementById("pickupTime");
const returnDate = document.getElementById("return");
const returnTime = document.getElementById("returnTime");
const totalElem = document.getElementById("total");
const stripePayBtn = document.getElementById("stripePay");
const emailInput = document.getElementById("email");
const agreeCheckbox = document.getElementById("agree");

// ----------------------------
// Load selected vehicle
// ----------------------------
if (!vehicleId || !vehicles[vehicleId]) {
  sliderContainer.innerHTML = "<p>Vehicle not found.</p>";
} else {
  const vehicle = vehicles[vehicleId];

  carNameElem.textContent = vehicle.name;
  carSubtitleElem.textContent = vehicle.subtitle;

  // Load images
  sliderContainer.innerHTML = "";
  vehicle.images.forEach((src, index) => {
    const img = document.createElement("img");
    img.src = src;
    img.classList.add("slide");
    if(index===0) img.classList.add("active");
    sliderContainer.appendChild(img);
  });

  // Add slider controls
  const prevBtn = document.createElement("button");
  prevBtn.textContent = "❮";
  prevBtn.onclick = () => prevSlide();
  prevBtn.classList.add("slider-btn");
  const nextBtn = document.createElement("button");
  nextBtn.textContent = "❯";
  nextBtn.onclick = () => nextSlide();
  nextBtn.classList.add("slider-btn");

  sliderContainer.appendChild(prevBtn);
  sliderContainer.appendChild(nextBtn);

  // Display price
  let priceText = `$${vehicle.pricePerDay} / day`;
  if(vehicle.weekly>0) priceText += ` • $${vehicle.weekly} weekly`;
  if(vehicle.deposit>0) priceText += ` • $${vehicle.deposit} deposit`;
  priceElem.textContent = priceText;
}

// ----------------------------
// Slider functionality
// ----------------------------
let currentSlide = 0;
const slides = () => document.querySelectorAll(".slide");

function showSlide(index) {
  const allSlides = slides();
  if(allSlides.length===0) return;
  if(index>=allSlides.length) currentSlide=0;
  else if(index<0) currentSlide=allSlides.length-1;
  else currentSlide = index;

  allSlides.forEach((slide, i) => {
    slide.classList.toggle("active", i===currentSlide);
  });
}

function nextSlide() { showSlide(currentSlide+1); }
function prevSlide() { showSlide(currentSlide-1); }

// ----------------------------
// Price & time automation
// ----------------------------
function calculateTotal() {
  if(!pickup.value || !returnDate.value) return 0;

  const start = new Date(`${pickup.value}T${pickupTime.value || "00:00"}`);
  const end = new Date(`${returnDate.value}T${returnTime.value || "00:00"}`);
  let diff = (end-start)/1000/60/60/24; // days
  if(diff<1) diff=1;

  let total = diff * vehicles[vehicleId].pricePerDay;
  totalElem.textContent = total.toFixed(2);
  return total;
}

pickup.addEventListener("change", calculateTotal);
pickupTime.addEventListener("change", calculateTotal);
returnDate.addEventListener("change", calculateTotal);
returnTime.addEventListener("change", calculateTotal);

// ----------------------------
// Stripe Checkout
// ----------------------------
stripePayBtn.addEventListener("click", async () => {
  const total = calculateTotal();
  if(total<=0) return alert("Select valid dates first.");
  if(!emailInput.value) return alert("Enter your email.");
  if(!agreeCheckbox.checked) return alert("Agree to terms.");

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          car: vehicles[vehicleId].name,
          amount: total,
          email: emailInput.value,
          pickup: pickup.value,
          returnDate: returnDate.value
        })
      }
    );
    const data = await res.json();
    if(data.url) window.location.href = data.url;
    else alert("Stripe session failed.");
  } catch(err) {
    console.error(err);
    alert("Payment error.");
  }
});

// Enable button if terms checked
agreeCheckbox.addEventListener("change", () => {
  stripePayBtn.disabled = !agreeCheckbox.checked;
});

// ----------------------------
// Reserve without paying
// ----------------------------
function reserve() {
  alert("Reserved successfully! (Payment skipped)");
}

// ----------------------------
// Back button
// ----------------------------
const backBtn = document.createElement("button");
backBtn.textContent = "⬅ Back to Cars";
backBtn.classList.add("back-btn");
backBtn.onclick = () => window.location.href="index.html";
document.querySelector(".container").prepend(backBtn);

// ----------------------------
// Initial calculation
// ----------------------------
calculateTotal();
