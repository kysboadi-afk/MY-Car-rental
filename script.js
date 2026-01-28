// ===== GLOBAL VARIABLES =====
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const stripeBackendURL = "https://my-car-rental-backend.vercel.app/api/create-checkout-session"; // Replace with your backend URL

const pickup = document.getElementById('pickup');
const returnDate = document.getElementById('return');
const agree = document.getElementById('agree');
const stripePayButton = document.getElementById('stripePay');
const totalPriceDisplay = document.getElementById('total');

const bookedDates = { "Camry 2012": [], "Slingshot R": [] };

// ===== CAR SELECTION =====
function selectCar(name, d, w, dep, el) {
  selectedCar = name;
  daily = d;
  weekly = w;
  deposit = dep;
  document.querySelectorAll('.car-slider').forEach(card => card.classList.remove('selected'));
  el.closest('.car-slider').classList.add('selected');
  displayBookedDates(name);
  disableBookedDates();
  alert(name + " selected! Now choose dates and enter your info below.");
  calculateTotal();
  checkAvailability();
  updateStripeButton();
}

function displayBookedDates(car) {
  const container = document.getElementById('bookedDatesContainer');
  container.innerHTML = '';
  const dates = bookedDates[car] || [];
  if(dates.length) {
    container.innerHTML = '<strong>Booked Dates:</strong> ';
    dates.forEach(date => {
      const span = document.createElement('span');
      span.className = 'booked-date';
      span.innerText = date;
      container.appendChild(span);
    });
  }
}

// ===== SYNC RETURN TIME =====
function syncReturnTime() {
  const pickupTime = document.getElementById('pickupTime').value;
  document.getElementById('returnTime').value = pickupTime;
}

// ===== CALCULATE TOTAL PRICE =====
function calculateTotal() {
  const pick = new Date(pickup.value);
  const ret = new Date(returnDate.value);
  if (!selectedCar || !pick || !ret || ret <= pick) return;

  const days = Math.ceil((ret - pick) / (1000*60*60*24));
  let cost = (weekly>0 && days>=7) ? Math.floor(days/7)*weekly + (days%7)*daily : days*daily;
  cost += deposit;
  totalCost = cost;
  totalPriceDisplay.innerText = totalCost;
}

// ===== CHECK AVAILABILITY =====
function checkAvailability() {
  const pick = pickup.value;
  const ret = returnDate.value;
  const status = document.getElementById('availability');
  if(!selectedCar || !pick || !ret) { status.innerText=''; return; }
  const dates = bookedDates[selectedCar] || [];
  let conflict = dates.some(date => date>=pick && date<=ret);
  if(conflict){ 
    status.innerText='❌ Not available'; 
    status.style.color='red'; 
  } else { 
    status.innerText='✅ Available'; 
    status.style.color='green'; 
  }
}

// ===== RESERVE FUNCTION =====
function reserve() {
  const email = document.getElementById('email').value;
  const agreeChecked = agree.checked;
  const pick = pickup.value;
  const ret = returnDate.value;

  if(!selectedCar){alert('Please select a vehicle');return;}
  if(!email){alert('Please enter your email');return;}
  if(!agreeChecked){alert('You must agree to the Rental Agreement & Terms before paying');return;}
  if(!pick || !ret){alert('Please select valid pickup and return dates');return;}

  alert('✅ Reservation request sent! We will contact you shortly.');

  const datesToBlock = getDatesBetween(pick, ret);
  bookedDates[selectedCar] = bookedDates[selectedCar].concat(datesToBlock);
  displayBookedDates(selectedCar);
  checkAvailability();
}

// ===== HELPER TO GET DATES BETWEEN =====
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

// ===== DISABLE BOOKED DATES =====
function disableBookedDates() {
  if(!selectedCar) return;

  const booked = bookedDates[selectedCar] || [];
  const pick = document.getElementById('pickup');
  const ret = document.getElementById('return');

  const today = new Date().toISOString().split('T')[0];
  pick.setAttribute('min', today);
  ret.setAttribute('min', today);

  [pick, ret].forEach(input => {
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

// ===== SLIDERS =====
const sliders = { slingshot:{index:0,slides:[]}, camry:{index:0,slides:[]} };

function initSliders() {
  sliders.slingshot.slides = document.querySelectorAll('.car-slider:nth-child(1) .slide');
  sliders.camry.slides = document.querySelectorAll('.car-slider:nth-child(2) .slide');
}

function showSlide(car){
  const s=sliders[car];
  s.slides.forEach((img,i)=>img.classList.toggle('active',i===s.index));
  updateDots(car);
}

function nextSlide(car){
  const s=sliders[car];
  s.index=(s.index+1)%s.slides.length;
  showSlide(car);
}

function prevSlide(car){
  const s=sliders[car];
  s.index=(s.index-1+s.slides.length)%s.slides.length;
  showSlide(car);
}

function updateDots(car){
  const s=sliders[car];
  const dots=document.querySelectorAll(`#dots-${car} .dot`);
  dots.forEach((dot,i)=>dot.classList.toggle('active',i===s.index));
}

function goToSlide(car,index){
  sliders[car].index=index;
  showSlide(car);
}

window.onload=initSliders;

// ===== STRIPE BUTTON =====
function updateStripeButton() {
  stripePayButton.disabled = !selectedCar || !pickup.value || !returnDate.value || !agree.checked || document.getElementById('availability').innerText.includes('❌');
}

stripePayButton.addEventListener("click", async () => {
  if (!selectedCar || !totalCost) { alert("Please complete your booking first."); return; }

  try {
    const response = await fetch(stripeBackendURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ car: selectedCar, amount: totalCost })
    });

    const data = await response.json(
