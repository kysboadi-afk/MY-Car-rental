// car.js

const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    pricePerDay: 300,
    deposit: 150,
    images: ["./images/car1.jpg", "./images/car2.jpg", "./images/car3.jpg"]
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    pricePerDay: 50,
    weekly: 250,
    deposit: 0,
    images: ["./images/car4.jpg", "./images/car5.jpg"]
  }
};

// Get vehicle ID from URL
const urlParams = new URLSearchParams(window.location.search);
const vehicleId = urlParams.get("vehicle");
const car = cars[vehicleId];

if (!car) {
  alert("Car not found!");
} else {
  // Populate car info
  document.getElementById("carName").textContent = car.name;
  document.getElementById("carSubtitle").textContent = car.subtitle;
  document.getElementById("carPrice").textContent =
    car.pricePerDay ? `$${car.pricePerDay} / day • $${car.deposit} deposit` :
    `$${car.weekly} weekly`;

  // Populate slider images
  const slider = document.getElementById("carSlider");
  car.images.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = car.name;
    img.className = "slide";
    if (i === 0) img.classList.add("active");
    slider.appendChild(img);
  });
}

// Simple slider controls
let currentSlide = 0;
function showSlide(index) {
  const slides = document.querySelectorAll("#carSlider .slide");
  slides.forEach((s) => s.classList.remove("active"));
  slides[index].classList.add("active");
  currentSlide = index;
}

slider.addEventListener("click", () => {
  const slides = document.querySelectorAll("#carSlider .slide");
  let next = currentSlide + 1 < slides.length ? currentSlide + 1 : 0;
  showSlide(next);
});

// Price calculation
const pickup = document.getElementById("pickup");
const returnDate = document.getElementById("return");
const totalEl = document.getElementById("total");

function calculateTotal() {
  if (!pickup.value || !returnDate.value) return;
  const start = new Date(pickup.value);
  const end = new Date(returnDate.value);
  const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  const total = (days > 0 ? days : 1) * (car.pricePerDay || car.weekly) + (car.deposit || 0);
  totalEl.textContent = total;
}

pickup.addEventListener("change", calculateTotal);
returnDate.addEventListener("change", calculateTotal);
