// =======================
// GLOBAL VARIABLES
// =======================
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const bookedDates = { "Camry 2012": [], "Slingshot R": [] };

const pickup = document.getElementById('pickup');
const returnDate = document.getElementById('return');
const pickupTime = document.getElementById('pickupTime');
const returnTime = document.getElementById('returnTime');
const agree = document.getElementById('agree');
const stripePayBtn = document.getElementById('stripePay');
const totalPriceDisplay = document.getElementById('total');
const bookedDatesContainer = document.getElementById('bookedDatesContainer');
const availabilityStatus = document.getElementById('availability');

// =======================
// CAR SELECTION
// =======================
function selectCar(name, d, w, dep, el) {
    selectedCar = name;
    daily = d;
    weekly = w;
    deposit = dep;
    
    document.querySelectorAll('.car-slider').forEach(card => card.classList.remove('selected'));
    el.closest('.car-slider').classList.add('selected');

    displayBookedDates();
    disableBookedDates();
    calculateTotal();
    checkAvailability();
    updateStripeButton();

    alert(`${name} selected! Now choose dates and enter your info below.`);
}

// =======================
// DISPLAY BOOKED DATES
// =======================
function displayBookedDates() {
    bookedDatesContainer.innerHTML = '';
    if (!selectedCar) return;
    const dates = bookedDates[selectedCar] || [];
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
// SYNC RETURN TIME
// =======================
pickupTime.addEventListener('input', syncReturnTime);
function syncReturnTime() {
    returnTime.value = pickupTime.value;
}

// =======================
// CALCULATE TOTAL PRICE
// =======================
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

// =======================
// CHECK AVAILABILITY
// =======================
function checkAvailability() {
    if (!selecte
