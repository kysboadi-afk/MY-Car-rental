/* ================= GLOBAL STATE ================= */
let selectedCar = null;
let daily = 0;
let weekly = 0;
let deposit = 0;
let totalCost = 0;

const pickup = document.getElementById("pickup");
const pickupTime = document.getElementById("pickupTime");
const returnDate = document.getElementById("return");
const returnTime = document.getElementById("returnTime");
const totalDisplay = document.getElementById("total");
const stripePayBtn = document.getElementById("stripePay");

/* ================= VEHICLE SELECT ================= */
function selectCar(name, d, w, dep, btn) {
  selectedCar = name;
  daily = d;
  weekly = w;
  deposit = dep;

  document.querySelectorAll(".car-slider")
    .forEach(c => c.classList.remove("selected"));

  btn.closest(".car-slider").classList.add("selected");

  calculateTotal();
  updateStripeButton();
}

/* ================= TIME SYNC ================= */
pickupTime.addEventListener("change", () => {
  returnTime.value = pickupTime.value;
});

/* ================= PRICE ================= */
function calculateTotal() {
  if (!pickup.value || !returnDate.value || !selectedCar) return;

  const start = new Date(pickup.value);
  const end = new Date(returnDate.value);
  if (end <= start) return;

  const days = Math.ceil((end - start) / 86400000);
  totalCost = days * daily + deposit;

  totalDisplay.textContent = totalCost;
}

/* ================= STRIPE ENABLE ================= */
function updateStripeButton() {
  stripePayBtn.disabled = !selectedCar || totalCost <= 0;
}

pickup.addEventListener("change", calculateTotal);
returnDate.addEventListener("change", calculateTotal);

/* ================= SLIDER ================= */
const sliders = {
  slingshot: { index: 0, slides: [] },
  camry: { index: 0, slides: [] }
};

window.onload = () => {
  sliders.slingshot.slides = document.querySelectorAll(".car-slider:nth-child(1) .slide");
  sliders.camry.slides = document.querySelectorAll(".car-slider:nth-child(2) .slide");
};

function showSlide(car) {
  const s = sliders[car];
  s.slides.forEach((img,i)=>img.classList.toggle("active", i===s.index));
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

/* ================= STRIPE ================= */
stripePayBtn.addEventListener("click", async () => {
  const email = document.getElementById("email").value;

  if (!email) {
    alert("Enter email");
    return;
  }

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          car: selectedCar,
          amount: totalCost,
          email
        })
      }
    );

    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert("Stripe error");
  } catch (e) {
    alert("Payment failed");
  }
});
