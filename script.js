// =====================
// Variables
// =====================
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const stripeBackendURL = "https://slyservices-stripe-backend.vercel.app/api/create-checkout-session";

const pickup = document.getElementById('pickup');
const returnDate = document.getElementById('return');
const pickupTime = document.getElementById('pickupTime');
const returnTime = document.getElementById('returnTime');
const agree = document.getElementById('agree');
const stripePayButton = document.getElementById('stripePay');
const totalPriceDisplay = document.getElementById('total');
const bookedDatesContainer = document.getElementById('bookedDatesContainer');
const availabilityText = document.getElementById('availability');

const bookedDates = { "Camry 2012": [], "Slingshot R": [] };

// =====================
// Car Selection
// =====================
function selectCar(name, d, w, dep, el) {
  selectedCar = name;
  daily = d;
  weekly = w;
  deposit = dep;

  document.querySelectorAll('.car-slider').forEach(card => card.classList.remove('selected'));
  el.closest('.car-slider').classList.add('selected');

  displayBookedDates(name);
  disableBookedDates();

  alert(`${name} selected! Now choose dates and enter your info below.`);
  calculateTotal();
  checkAvailability();
  updateStripeButton();
}

// =====================
// Display Booked Dates
// =====================
function displayBookedDates(car) {
  bookedDatesContainer.innerHTML = '';
  const dates = bookedDates[car] || [];
  if(dates.length) {
    bookedDatesContainer.innerHTML = '<strong>Booked Dates:</strong> ';
    dates.forEach(date => {
      const span = document.createElement('span');
      span.className = 'booked-date';
      span.innerText = date;
      bookedDatesContainer.appendChild(span);
    });
  }
}

// =====================
// Sync Return Time
// =====================
function syncReturnTime() {
  returnTime.value = pickupTime.value;
}

// =====================
// Calculate Total Price
// =====================
function calculateTotal() {
  const pick = new Date(pickup.value);
  const ret = new Date(returnDate.value);
  if (!selectedCar || !pick || !ret || ret <= pick) return;

  const days = Math.ceil((ret - pick) / (1000*60*60*24));
  let cost = (weekly > 0 && days >= 7) ? Math.floor(days/7) * weekly + (days % 7) * daily : days * daily;
  cost += deposit;
  totalCost = cost;
  totalPriceDisplay.innerText = totalCost;
}

// =====================
// Check Availability
// =====================
function checkAvailability() {
  if(!selectedCar || !pickup.value || !returnDate.value) { 
    availabilityText.innerText = '';
    return; 
  }
  const dates = bookedDates[selectedCar] || [];
  let conflict = dates.some(date => date >= pickup.value && date <= returnDate.value);
  if(conflict){ 
    availabilityText.innerText = '❌ Not available';
    availabilityText.style.color = 'red';
  } else { 
    availabilityText.innerText = '✅ Available';
    availabilityText.style.color = 'green';
  }
}

// =====================
// Temporary Reserve
// =====================
function reserve() {
  const email = document.getElementById('email').value;
  const agreeChecked = agree.checked;

  if(!selectedCar){ alert('Please select a vehicle'); return; }
  if(!email){ alert('Please enter your email'); return; }
  if(!agreeChecked){ alert('You must agree to the Rental Agreement & Terms before paying'); return; }
  if(!pickup.value || !returnDate.value){ alert('Please select valid pickup and return dates'); return; }

  // Temporary reservation (dates not fully booked yet)
  alert('✅ Temporary reservation recorded! These dates are visible to you but will only be blocked after payment.');
}

// =====================
// Get all dates between start and end
// =====================
function getDatesBetween(start, end) {
  let arr = [];
  let current = new Date(start);
  const last = new Date(end);
  while(current <= last){
    arr.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return arr;
}

// =====================
// Disable booked dates
// =====================
function disableBookedDates() {
  if(!selectedCar) return;

  const booked = bookedDates[selectedCar] || [];
  const today = new Date().toISOString().split('T')[0];
  pickup.setAttribute('min', today);
  returnDate.setAttribute('min', today);

  [pickup, returnDate].forEach(input => {
    input.addEventListener('input', function() {
      if(booked.includes(this.value)) {
        alert('❌ This date is already booked!');
        this.value = '';
      }
      calculateTotal();
      checkAvailability();
      updateStripeButton();
    });
  });
}

// =====================
// Sliders
// =====================
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

function nextSlide(car) { const s = sliders[car]; s.index = (s.index + 1) % s.slides.length; showSlide(car); }
function prevSlide(car) { const s = sliders[car]; s.index = (s.index - 1 + s.slides.length) % s.slides.length; showSlide(car); }

function updateDots(car) {
  const s = sliders[car];
  const dots = document.querySelectorAll(`#dots-${car} .dot`);
  dots.forEach((dot,i)=>dot.classList.toggle('active', i === s.index));
}

function goToSlide(car, index) { sliders[car].index = index; showSlide(car); }

window.onload = initSliders;

// =====================
// Stripe Payment
// =====================
function updateStripeButton() {
  stripePayButton.disabled = !selectedCar || !pickup.value || !returnDate.value || !agree.checked || availabilityText.innerText.includes('❌');
}

stripePayButton.addEventListener("click", async () => {
  if (!selectedCar || !totalCost) { alert("Please complete your booking first."); return; }

  const email = document.getElementById('email').value;

  try {
    const response = await fetch(stripeBackendURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        car: selectedCar,
        amount: totalCost,
        email: email,
        pickup: pickup.value,
        returnDate: returnDate.value
      })
    });

    const data = await response.json();

    // On successful Stripe session creation
    if(data.url) {
      // Mark dates as booked AFTER successful payment
      const booked = getDatesBetween(pickup.value, returnDate.value);
      bookedDates[selectedCar] = bookedDates[selectedCar].concat(booked);
      displayBookedDates(selectedCar);

      window.location.href = data.url; // Redirect to Stripe Checkout
    } else {
      alert("Error creating Stripe session.");
      console.error(data);
    }

  } catch (err) {
    alert("Error connecting to Stripe. Please try again.");
    console.error(err);
  }
});

[pickup, returnDate, agree].forEach(el => el.addEventListener('change', updateStripeButton));
pickupTime.addEventListener('change', syncReturnTime);
