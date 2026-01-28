// =====================
// CAR DATA
// =====================
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    images: ["images/car1.jpg","images/car2.jpg","images/car3.jpg"],
    pricePerDay: 300,
    deposit: 150
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    images: ["images/car4.jpg","images/car5.jpg"],
    pricePerDay: 50,
    weekly: 250
  }
  // Add more cars here
};

// =====================
// GET SELECTED CAR
// =====================
const urlParams = new URLSearchParams(window.location.search);
const vehicleId = urlParams.get("vehicle");
const selectedCar = cars[vehicleId];

if (!selectedCar) {
  document.getElementById("carInfo").innerHTML = "<p>Car not found!</p>";
  throw new Error("Car not found!");
}

// =====================
// POPULATE CAR INFO
// =====================
const carInfoDiv = document.getElementById("carInfo");
carInfoDiv.innerHTML = `
  <h3>${selectedCar.name}</h3>
  <p class="car-subtitle">${selectedCar.subtitle}</p>
  <p class="price">
    ${selectedCar.pricePerDay ? "$"+selectedCar.pricePerDay+" / day" : ""}
    ${selectedCar.deposit ? "• $"+selectedCar.deposit+" deposit" : ""}
    ${selectedCar.weekly ? "• $"+selectedCar.weekly+" weekly" : ""}
  </p>
`;

// =====================
// POPULATE SLIDER
// =====================
const sliderDiv = document.getElementById("carSlider");
selectedCar.images.forEach((src, i) => {
  const img = document.createElement("img");
  img.src = src;
  img.className = "slide" + (i === 0 ? " active" : "");
  sliderDiv.appendChild(img);
});

// =====================
// SLIDER LOGIC
// =====================
let currentSlide = 0;
function showSlide(n) {
  const slides = sliderDiv.getElementsByClassName("slide");
  if (n >= slides.length) currentSlide = 0;
  if (n < 0) currentSlide = slides.length - 1;
  for (let i = 0; i < slides.length; i++) slides[i].classList.remove("active");
  slides[currentSlide].classList.add("active");
}

sliderDiv.addEventListener("click", () => {
  currentSlide++;
  showSlide(currentSlide);
});

// =====================
// BOOKING AUTOMATION
// =====================
const pickup = document.getElementById("pickup");
const pickupTime = document.getElementById("pickupTime");
const returnDate = document.getElementById("return");
const returnTime = document.getElementById("returnTime");
const totalSpan = document.getElementById("total");
const stripePayBtn = document.getElementById("stripePay");

function calculateTotal() {
  if (!pickup.value || !returnDate.value) return 0;
  const start = new Date(pickup.value);
  const end = new Date(returnDate.value);
  let diffDays = Math.ceil((end - start) / (1000*60*60*24));
  if (diffDays <= 0) diffDays = 1;
  let total = (selectedCar.pricePerDay || 0) * diffDays;
  totalSpan.textContent = total;
  return total;
}

pickup.addEventListener("change", calculateTotal);
returnDate.addEventListener("change", calculateTotal);

function syncReturnTime() {
  returnTime.value = pickupTime.value;
}

pickupTime.addEventListener("change", syncReturnTime);

// Enable Stripe button if form ready
const email = document.getElementById("email");
const agree = document.getElementById("agree");

function checkReady() {
  stripePayBtn.disabled = !(email.value && agree.checked);
}
email.addEventListener("input", checkReady);
agree.addEventListener("change", checkReady);

// =====================
// RESERVE / PAY
// =====================
stripePayBtn.addEventListener("click", async () => {
  const totalCost = calculateTotal();
  if (!totalCost) return alert("Select pickup and return dates");

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car: selectedCar.name,
          amount: totalCost,
          email: email.value,
          pickup: pickup.value,
          returnDate: returnDate.value
        })
      }
    );
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert("Stripe session failed");
  } catch (err) {
    console.error(err);
    alert("Payment error");
  }
});

function reserve() {
  alert(`Reserved ${selectedCar.name}!`);
}
