// ---------------------------
// Get vehicle from URL
// ---------------------------
const urlParams = new URLSearchParams(window.location.search);
const vehicleId = urlParams.get("vehicle");

// Vehicle data
const vehicles = {
  slingshot: {
    name: "Slingshot R",
    type: "Sports / 2-seater",
    daily: 300,
    deposit: 150,
    images: ["images/car1.jpg", "images/car2.jpg", "images/car3.jpg"]
  },
  camry: {
    name: "Camry 2012",
    type: "Sedan / 5-seater",
    daily: 50,
    weekly: 250,
    images: ["images/car4.jpg", "images/car5.jpg"]
  }
};

// ---------------------------
// DOM Elements
// ---------------------------
const carTitle = document.getElementById("carTitle");
const carSubtitle = document.getElementById("carSubtitle");
const sliderContainer = document.getElementById("sliderContainer");
const priceElem = document.getElementById("price");
const totalElem = document.getElementById("total");

const pickup = document.getElementById("pickup");
const returnDate = document.getElementById("return");
const pickupTime = document.getElementById("pickupTime");
const returnTime = document.getElementById("returnTime");
const stripePayBtn = document.getElementById("stripePay");
const emailInput = document.getElementById("email");

let selectedCar = null;
let totalCost = 0;
let currentSlide = 0;

// ---------------------------
// Load car details
// ---------------------------
if (vehicleId && vehicles[vehicleId]) {
  selectedCar = vehicles[vehicleId];
  carTitle.textContent = selectedCar.name;
  carSubtitle.textContent = selectedCar.type;

  // Populate slider
  selectedCar.images.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.className = i === 0 ? "slide active" : "slide";
    sliderContainer.appendChild(img);
  });

  priceElem.textContent = selectedCar.daily;
}

// ---------------------------
// Slider Controls
// ---------------------------
function nextSlide() {
  const slides = sliderContainer.querySelectorAll(".slide");
  slides[currentSlide].classList.remove("active");
  currentSlide = (currentSlide + 1) % slides.length;
  slides[currentSlide].classList.add("active");
}

function prevSlide() {
  const slides = sliderContainer.querySelectorAll(".slide");
  slides[currentSlide].classList.remove("active");
  currentSlide = (currentSlide - 1 + slides.length) % slides.length;
  slides[currentSlide].classList.add("active");
}

// ---------------------------
// Booking
// ---------------------------
function calculateTotal() {
  if (!selectedCar) return;
  const start = new Date(pickup.value);
  const end = new Date(returnDate.value);
  if (start && end && end > start) {
    const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    totalCost = diffDays * selectedCar.daily;
    totalElem.textContent = totalCost;
    checkReady();
  }
}

pickupTime.addEventListener("change", () => {
  returnTime.value = pickupTime.value;
});

[pickup, returnDate, pickupTime, returnTime, emailInput].forEach(el =>
  el.addEventListener("change", () => {
    calculateTotal();
    checkReady();
  })
);

// ---------------------------
// Stripe Payment
// ---------------------------
stripePayBtn.addEventListener("click", async () => {
  if (!selectedCar || totalCost <= 0 || !emailInput.value) {
    alert("Please complete your booking first.");
    return;
  }

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car: selectedCar.name,
          amount: totalCost,
          email: emailInput.value,
          pickup: pickup.value,
          returnDate: returnDate.value
        })
      }
    );
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert("Stripe session failed to create.");
  } catch (err) {
    console.error(err);
    alert("Payment error. Please try again.");
  }
});

// ---------------------------
// Enable Pay Now button
// ---------------------------
function checkReady() {
  if (
    pickup.value &&
    returnDate.value &&
    pickupTime.value &&
    returnTime.value &&
    emailInput.value
  ) {
    stripePayBtn.disabled = false;
  } else {
    stripePayBtn.disabled = true;
  }
}
