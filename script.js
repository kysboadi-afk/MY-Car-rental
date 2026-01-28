// ---------- GLOBAL VARIABLES ----------
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const stripePayBtn = document.getElementById("stripePay");
const pickup = document.getElementById("pickup");
const returnDate = document.getElementById("return");
const pickupTime = document.getElementById("pickupTime");
const returnTime = document.getElementById("returnTime");
const agree = document.getElementById("agree");
const totalPriceDisplay = document.getElementById("total");
const bookedDatesContainer = document.getElementById("bookedDatesContainer");
const availability = document.getElementById("availability");

const bookedDates = {
  "Slingshot R": [],
  "Camry 2012": []
};

// ---------- CAR SELECTION ----------
function selectCar(name, d, w, dep, el) {
  selectedCar = name;
  daily = d;
  weekly = w;
  deposit = dep;

  document.querySelectorAll('.car-slider').forEach(card => card.classList.remove('selected'));
  el.closest('.car-slider').classList.add('selected');

  displayBookedDates(name);
  disableBookedDates();
  calculateTotal();
  checkAvailability();
  updateStripeButton();

  alert(name + " selected! Now choose dates and enter your info below.");
}

function displayBookedDates(car) {
  bookedDatesContainer.innerHTML = '';
  const dates = bookedDates[car] || [];
  if (dates.length) {
    bookedDatesContainer.innerHTML = '<strong>Booked Dates:</strong> ';
    dates.forEach(date => {
      const span = document.createElement('span');
      span.className = 'booked-date';
      span.innerText = date;
      bookedDatesContainer.appendChild(span);
    });
  }
}

// ---------- RETURN TIME AUTO-SYNC ----------
function syncReturnTime() {
  returnTime.value = pickupTime.value;
}

// ---------- CALCULATE TOTAL PRICE ----------
function calculateTotal() {
  if (!selectedCar || !pickup.value || !returnDate.value) {
    totalPriceDisplay.innerText = "0";
    return;
  }

  const pick = new Date(pickup.value);
  const ret = new Date(returnDate.value);
  if (ret <= pick) {
    totalPriceDisplay.innerText = "0";
    return;
  }

  const days = Math.ceil((ret - pick) / (1000 * 60 * 60 * 24));
  let cost = (weekly > 0 && days >= 7) ? Math.floor(days / 7) * weekly + (days % 7) * daily : days * daily;
  cost += deposit;
  totalCost = cost;
  totalPriceDisplay.innerText = totalCost;
}

// ---------- CHECK AVAILABILITY ----------
function checkAvailability() {
  if (!selectedCar || !pickup.value || !returnDate.value) {
    availability.innerText = '';
    return;
  }

  const dates = bookedDates[selectedCar] || [];
  const conflict = dates.some(date => date >= pickup.value && date <= returnDate.value);
  if (conflict) {
    availability.innerText = "❌ Not available";
    availability.style.color = "red";
  } else {
    availability.innerText = "✅ Available";
    availability.style.color = "green";
  }
}

// ---------- TEMPORARY RESERVATION ----------
function reserve() {
  if (!selectedCar) return alert("Please select a vehicle.");
  if (!pickup.value || !returnDate.value) return alert("Please select valid pickup and return dates.");
  if (!document.getElementById("email").value) return alert("Please enter your email.");
  if (!agree.checked) return alert("You must agree to the rental agreement.");

  const datesToBlock = getDatesBetween(pickup.value, returnDate.value);
  bookedDates[selectedCar] = bookedDates[selectedCar].concat(datesToBlock);
  displayBookedDates(selectedCar);
  checkAvailability();
  updateStripeButton();

  alert("✅ Temporary reservation created! Dates are now blocked locally until payment.");
}

function getDatesBetween(start, end) {
  let arr = [];
  let current = new Date(start);
  const last = new Date(end);
  while (current <= last) {
    arr.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return arr;
}

// ---------- DISABLE BOOKED DATES ----------
function disableBookedDates() {
  if (!selectedCar) return;

  const booked = bookedDates[selectedCar] || [];
  const today = new Date().toISOString().split('T')[0];

  [pickup, returnDate].forEach(input => {
    input.setAttribute('min', today);
    input.addEventListener('input', () => {
      if (booked.includes(input.value)) {
        alert("❌ This date is already booked!");
        input.value = '';
      }
      calculateTotal();
      checkAvailability();
      updateStripeButton();
    });
  });
}

// ---------- IMAGE SLIDERS ----------
const sliders = {
  slingshot: { index: 0, slides: [] },
  camry: { index: 0, slides: [] }
};

function initSliders() {
  sliders.slingshot.slides = document.querySelectorAll('.car-slider:nth-child(1) .slide');
  sliders.camry.slides = document.querySelectorAll('.car-slider:nth-child(2) .slide');
}

function showSlide(car) {
  const s = sliders[car];
  s.slides.forEach((img, i) => img.classList.toggle('active', i === s.index));
  updateDots(car);
}

function nextSlide(car) {
  const s = sliders[car];
  s.index = (s.index + 1) % s.slides.length;
  showSlide(car);
}

function prevSlide(car) {
  const s = sliders[car];
  s.index = (s.index - 1 + s.slides.length) % s.slides.length;
  showSlide(car);
}

function goToSlide(car, index) {
  sliders[car].index = index;
  showSlide(car);
}

function updateDots(car) {
  const s = sliders[car];
  const dots = document.querySelectorAll(`#dots-${car} .dot`);
  dots.forEach((dot, i) => dot.classList.toggle('active', i === s.index));
}

window.onload = initSliders;

// ---------- STRIPE PAYMENT ----------
function updateStripeButton() {
  stripePayBtn.disabled =
    !selectedCar ||
    !pickup.value ||
    !returnDate.value ||
    !agree.checked ||
    availability.innerText.includes("❌");
}

stripePayBtn.addEventListener("click", async () => {
  if (!selectedCar || totalCost <= 0) {
    return alert("Please complete your booking first.");
  }

  const email = document.getElementById("email").value;
  const pickupValue = pickup.value;
  const returnValue = returnDate.value;

  if (!email || !pickupValue || !returnValue) return alert("Please fill in all booking details.");

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car: selectedCar,
          amount: totalCost,
          email,
          pickup: pickupValue,
          returnDate: returnValue
        })
      }
    );

    const data = await res.json();

    if (data.url) {
      window.location.href = data.url;
    } else {
      alert("Stripe session failed to create.");
    }
  } catch (err) {
    console.error(err);
    alert("Payment error. Please try again.");
  }
});

// ---------- AUTO UPDATE TOTAL AND BUTTON ----------
[pickup, returnDate, agree, pickupTime].forEach(el =>
  el.addEventListener("change", () => {
    syncReturnTime();
    calculateTotal();
    checkAvailability();
    updateStripeButton();
  })
);
