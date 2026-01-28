// Car data
const vehicles = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    pricePerDay: 300,
    deposit: 150,
    images: ["images/car1.jpg", "images/car2.jpg", "images/car3.jpg"]
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    pricePerDay: 50,
    deposit: 0,
    images: ["images/car4.jpg", "images/car5.jpg"]
  }
};

// Get vehicle from URL
const params = new URLSearchParams(window.location.search);
const vehicleId = params.get("vehicle");
const vehicle = vehicles[vehicleId];

if (vehicle) {
  // Populate details
  document.getElementById("carName").textContent = vehicle.name;
  document.getElementById("carSubtitle").textContent = vehicle.subtitle;
  document.getElementById("carPrice").textContent = `$${vehicle.pricePerDay} / day • $${vehicle.deposit} deposit`;

  // Populate slider images
  const slider = document.getElementById("carSlider");
  vehicle.images.forEach((imgSrc, index) => {
    const img = document.createElement("img");
    img.src = imgSrc;
    img.alt = vehicle.name;
    img.className = "slide" + (index === 0 ? " active" : "");
    slider.appendChild(img);
  });

  // Initialize slider controls
  let currentSlide = 0;
  const slides = slider.querySelectorAll(".slide");

  function showSlide(n) {
    slides.forEach((s, i) => s.classList.toggle("active", i === n));
  }

  slider.addEventListener("click", () => {
    currentSlide = (currentSlide + 1) % slides.length;
    showSlide(currentSlide);
  });
}

// Total calculation
const pickup = document.getElementById("pickup");
const ret = document.getElementById("return");
const totalSpan = document.getElementById("total");

function updateTotal() {
  if (pickup.value && ret.value) {
    const start = new Date(pickup.value);
    const end = new Date(ret.value);
    const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    const total = diffDays > 0 ? diffDays * vehicle.pricePerDay + vehicle.deposit : vehicle.deposit;
    totalSpan.textContent = total;
  }
}

pickup.addEventListener("change", updateTotal);
ret.addEventListener("change", updateTotal);

// Stripe / Reserve button logic here (reuse from your old script)
