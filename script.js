// -----------------------------
// VARIABLES
// -----------------------------
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const stripePayBtn = document.getElementById("stripePay");
const pickup = document.getElementById("pickup");
const returnDate = document.getElementById("return");
const pickupTimeInput = document.getElementById("pickupTime");
const returnTimeInput = document.getElementById("returnTime");
const agree = document.getElementById("agree");
const totalPriceDisplay = document.getElementById("total");
const bookedDatesContainer = document.getElementById("bookedDatesContainer");
const availabilityStatus = document.getElementById("availability");

// Example booked dates
const bookedDates = { "Camry 2012": [], "Slingshot R": [] };

// -----------------------------
// CAR SELECTION
// -----------------------------
function selectCar(name, d, w, dep, el) {
  selectedCar = name;
  daily = d;
  weekly = w;
  deposit = dep;

  document.querySelectorAll(".car-slider").forEach(c => c.classList.remove("selected"));
  el.closest(".car-slider").classList.add("selected");

  displayBookedDates();
  disableBookedDates();
  calculateTotal();
  updateStripeButton();
}

// -----------------------------
// DISPLAY BOOKED DATES
// -----------------------------
function displayBookedDates() {
  bookedDatesContainer.innerHTML = "";
  if (!selectedCar) return;

  const dates = bookedDates[selectedCar];
  if (dates.length) {
    bookedDatesContainer.innerHTML = "<strong>Booked Dates:</strong> ";
    dates.forEach(date => {
      const span = document.createElement("span");
      span.className = "booked-date";
      span.innerText = date;
      bookedDatesContainer.appendChild(span);
    });
  }
}

// -----------------------------
// SYNC RETURN TIME
// -----------------------------
function syncReturnTime() {
  returnTimeInput.value = pickupTimeInput.value;
}

// -----------------------------
// CALCULATE TOTAL
// -----------------------------
function calculateTotal() {
  if (!selectedCar || !pickup.value || !returnDate.value) return;

  const pick = new Date(pickup.value);
  const ret = new Date(returnDate.value);
  if (ret <= pick) return;

  const days = Math.ceil((ret - pick) / (1000 * 60 * 60 * 24));
  let cost = (weekly > 0 && days >= 7) ? Math.floor(days / 7) * weekly + (days % 7) * daily : days * daily;
  cost += deposit;
  totalCost = cost;

  totalPriceDisplay.innerText = totalCost;
}

// -----------------------------
// CHECK AVAILABILITY
// -----------------------------
function checkAvailability() {
  if (!selectedCar || !pickup.value || !returnDate.value) {
    availabilityStatus.innerText = "";
    return;
  }

  const dates = bookedDates[selectedCar] || [];
  const pick = pickup.value;
  const ret = returnDate.value;

  const conflict = dates.some(date => date >= pick && date <= ret);
  if (conflict) {
    availabilityStatus.innerText = "❌ Not available";
    availabilityStatus.style.color = "red";
  } else {
    availabilityStatus.innerText = "✅ Available";
    availabilityStatus.style.color = "green";
  }

  updateStripeButton();
}

// -----------------------------
// RESERVE FUNCTION
// -----------------------------
function reserve() {
  if (!selectedCar) { alert("Please select a vehicle."); return; }
  if (!pickup.value || !returnDate.value) { alert("Please select dates."); return; }
  if (!agree.checked) { alert("You must agree to the Rental Agreement & Terms."); return; }

  const datesToBlock = getDatesBetween(pickup.value, returnDate.value);
  bookedDates[selectedCar] = bookedDates[selectedCar].concat(datesToBlock);

  displayBookedDates();
  checkAvailability();

  alert("✅ Temporary reservation successful! Dates blocked until payment.");
}

// -----------------------------
// GET DATES BETWEEN
// -----------------------------
function getDatesBetween(start, end) {
  let arr = [];
  let current = new Date(start);
  const last = new Date(end);
  while (current <= last) {
    arr.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }
  return arr;
}

// -----------------------------
// DISABLE BOOKED DATES
// -----------------------------
function disableBookedDates() {
  if (!selectedCar) return;
  const booked = bookedDates[selectedCar] || [];

  [pickup, returnDate].forEach(input => {
    const today = new Date().toISOString().split("T")[0];
    input.setAttribute("min", today);

    input.addEventListener("input", () => {
      if (booked.includes(input.value)) {
        alert("❌ This date is already booked!");
        input.value = "";
      }
      calculateTotal();
      checkAvailability();
    });
  });
}

// -----------------------------
// SLIDERS
// -----------------------------
const sliders = { slingshot: { index: 0 }, camry: { index: 0 } };
function nextSlide(car) { changeSlide(car, 1); }
function prevSlide(car) { changeSlide(car, -1); }
function goToSlide(car, i) { sliders[car].index = i; showSlide(car); }

function changeSlide(car, dir) {
  const slides = document.querySelectorAll(`.car-slider.${car} .slide`) || document.querySelectorAll(`.car-slider:nth-child(${car === 'slingshot' ? 1 : 2}) .slide`);
  sliders[car].index = (sliders[car].index + dir + slides.length) % slides.length;
  showSlide(car);
}

function showSlide(car) {
  const slides = document.querySelectorAll(`.car-slider.${car} .slide`) || document.querySelectorAll(`.car-slider:nth-child(${car === 'slingshot' ? 1 : 2}) .slide`);
  slides.forEach((s, i) => s.classList.toggle("active", i === sliders[car].index));

  const dots = document.querySelectorAll(`#dots-${car} .dot`);
  dots.forEach((dot, i) => dot.classList.toggle("active", i === sliders[car].index));
}

window.onload = () => {
  syncReturnTime();
  updateStripeButton();
};

// -----------------------------
// STRIPE BUTTON
// -----------------------------
stripePayBtn.addEventListener("click", async () => {
  if (!selectedCar || totalCost <= 0 || !pickup.value || !returnDate.value || !agree.checked) {
    alert("Please complete your booking first.");
    return;
  }

  const email = document.getElementById("email").value;

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car: selectedCar,
          amount: totalCost,
          email: email,
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

// -----------------------------
// UPDATE STRIPE BUTTON STATE
// -----------------------------
function updateStripeButton() {
  stripePayBtn.disabled = !selectedCar || !pickup.value || !returnDate.value || !agree.checked || availabilityStatus.innerText.includes("❌");
}

// -----------------------------
// EVENT LISTENERS
// -----------------------------
[pickup, returnDate, pickupTimeInput, returnTimeInput, agree].forEach(el => {
  el.addEventListener("change", () => {
    syncReturnTime();
    calculateTotal();
    checkAvailability();
    updateStripeButton();
  });
});
