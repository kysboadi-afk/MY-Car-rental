// =======================
// GLOBAL VARIABLES
// =======================
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const pickupInput = document.getElementById('pickup');
const returnInput = document.getElementById('return');
const pickupTimeInput = document.getElementById('pickupTime');
const returnTimeInput = document.getElementById('returnTime');
const agreeCheckbox = document.getElementById('agree');
const stripePayButton = document.getElementById('stripePay');
const totalPriceDisplay = document.getElementById('total');
const bookedDatesContainer = document.getElementById('bookedDatesContainer');
const availabilityStatus = document.getElementById('availability');

// Example booked dates
const bookedDates = { "Camry 2012": [], "Slingshot R": [] };

// =======================
// VEHICLE SELECTION
// =======================
function selectCar(name, d, w, dep, el) {
  selectedCar = name;
  daily = d;
  weekly = w;
  deposit = dep;

  document.querySelectorAll('.car-slider').forEach(card => card.classList.remove('selected'));
  el.closest('.car-slider').classList.add('selected');

  displayBookedDates(name);
  disableBookedDates();

  alert(name + " selected! Now choose dates below.");
  calculateTotal();
  checkAvailability();
  updateStripeButton();
}

// Show booked dates
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

// =======================
// DATE / TIME EVENTS
// =======================

// Auto-sync return time
pickupTimeInput.addEventListener('change', () => {
  returnTimeInput.value = pickupTimeInput.value;
});

// Recalculate total when dates change
[pickupInput, returnInput].forEach(el => {
  el.addEventListener('change', () => {
    calculateTotal();
    checkAvailability();
    updateStripeButton();
  });
});

// =======================
// CALCULATE TOTAL PRICE
// =======================
function calculateTotal() {
  if (!selectedCar || !pickupInput.value || !returnInput.value) {
    totalPriceDisplay.innerText = 0;
    return;
  }

  const start = new Date(pickupInput.value);
  const end = new Date(returnInput.value);

  if (end <= start) {
    totalPriceDisplay.innerText = 0;
    return;
  }

  const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  let cost = (weekly > 0 && days >= 7)
    ? Math.floor(days / 7) * weekly + (days % 7) * daily
    : days * daily;

  cost += deposit;
  totalCost = cost;
  totalPriceDisplay.innerText = totalCost;
}

// =======================
// CHECK AVAILABILITY
// =======================
function checkAvailability() {
  if (!selectedCar || !pickupInput.value || !returnInput.value) {
    availabilityStatus.innerText = '';
    return;
  }

  const start = pickupInput.value;
  const end = returnInput.value;
  const dates = bookedDates[selectedCar] || [];

  const conflict = dates.some(date => date >= start && date <= end);

  if (conflict) {
    availabilityStatus.innerText = '❌ Not available';
    availabilityStatus.style.color = 'red';
  } else {
    availabilityStatus.innerText = '✅ Available';
    availabilityStatus.style.color = 'green';
  }
}

// =======================
// RESERVE WITHOUT PAY
// =======================
async function reserve() {
  if (!selectedCar) { alert('Please select a vehicle'); return; }
  if (!pickupInput.value || !returnInput.value) { alert('Please select dates'); return; }
  
  const email = document.getElementById('email').value;
  if (!email) { alert('Please enter email'); return; }
  if (!agreeCheckbox.checked) { alert('You must agree to the terms'); return; }

  // Send reservation email to owner and customer confirmation
  try {
    const response = await fetch('https://slyservices-stripe-backend-ipeq.vercel.app/api/send-reservation-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        car: selectedCar,
        pickup: pickupInput.value,
        pickupTime: pickupTimeInput.value || 'Not specified',
        returnDate: returnInput.value,
        returnTime: returnTimeInput.value || 'Not specified',
        email: email,
        total: totalPriceDisplay.textContent
      })
    });

    if (response.ok) {
      alert(`✅ Reservation request sent!\n\nA confirmation email has been sent to ${email}. We will also contact you shortly to confirm.\n\nCar: ${selectedCar}\nPickup: ${pickupInput.value}\nReturn: ${returnInput.value}`);
    } else {
      alert("⚠️ Reservation request saved, but email notification failed. We'll contact you soon at " + email);
    }
  } catch (error) {
    console.error('Error sending reservation email:', error);
    alert("⚠️ Reservation request saved, but email notification failed. We'll contact you soon at " + email);
  }

  // Block dates temporarily (for display only)
  const datesToBlock = getDatesBetween(pickupInput.value, returnInput.value);
  bookedDates[selectedCar] = bookedDates[selectedCar].concat(datesToBlock);

  displayBookedDates(selectedCar);
  checkAvailability();
  updateStripeButton();
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

// Disable booked dates in picker
function disableBookedDates() {
  if (!selectedCar) return;

  const booked = bookedDates[selectedCar] || [];
  const today = new Date().toISOString().split('T')[0];

  pickupInput.setAttribute('min', today);
  returnInput.setAttribute('min', today);

  [pickupInput, returnInput].forEach(input => {
    input.addEventListener('input', function() {
      if (booked.includes(this.value)) {
        alert('❌ This date is already booked!');
        this.value = '';
      }
      calculateTotal();
      checkAvailability();
      updateStripeButton();
    });
  });
}

// =======================
// IMAGE SLIDER
// =======================
const sliders = { slingshot:{index:0,slides:[]}, camry:{index:0,slides:[]} };

function initSliders() {
  sliders.slingshot.slides = document.querySelectorAll('.car-slider:nth-child(1) .slide');
  sliders.camry.slides = document.querySelectorAll('.car-slider:nth-child(2) .slide');
}

function showSlide(car) {
  const s = sliders[car];
  s.slides.forEach((img,i) => img.classList.toggle('active', i === s.index));
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

function updateDots(car) {
  const s = sliders[car]; 
  const dots = document.querySelectorAll(`#dots-${car} .dot`);
  dots.forEach((dot,i) => dot.classList.toggle('active', i===s.index));
}

function goToSlide(car,index) {
  sliders[car].index = index; 
  showSlide(car);
}

window.onload = initSliders;

// =======================
// STRIPE PAYMENT
// =======================
function updateStripeButton() {
  stripePayButton.disabled = !selectedCar || !pickupInput.value || !returnInput.value || !agreeCheckbox.checked || availabilityStatus.innerText.includes('❌');
}

stripePayButton.addEventListener("click", async () => {
  if (!selectedCar || totalCost <= 0) {
    alert("Please complete your booking first.");
    return;
  }

  const email = document.getElementById("email").value;
  const pickupDate = pickupInput.value;
  const returnDateValue = returnInput.value;

  if (!email || !pickupDate || !returnDateValue) {
    alert("Please fill in all booking details.");
    return;
  }

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
          pickup: pickupDate,
          returnDate: returnDateValue
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

// Update Stripe button when input changes
[pickupInput, returnInput, agreeCheckbox].forEach(el => el.addEventListener('change', updateStripeButton));
