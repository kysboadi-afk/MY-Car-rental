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

  // Populate slider container
  const sliderContainer = document.getElementById("carSlider");
  sliderContainer.style.position = "relative";

  // Add slides
  vehicle.images.forEach((imgSrc, index) => {
    const img = document.createElement("img");
    img.src = imgSrc;
    img.alt = vehicle.name;
    img.className = "slide" + (index === 0 ? " active" : "");
    sliderContainer.appendChild(img);
  });

  // Create dots
  const dotsContainer = document.createElement("div");
  dotsContainer.className = "slider-dots";
  sliderContainer.appendChild(dotsContainer);

  vehicle.images.forEach((_, i) => {
    const dot = document.createElement("span");
    dot.className = "dot" + (i === 0 ? " active" : "");
    dot.addEventListener("click", () => {
      currentSlide = i;
      showSlide(currentSlide);
    });
    dotsContainer.appendChild(dot);
  });

  // Create Next / Prev buttons
  const prevBtn = document.createElement("button");
  prevBtn.innerHTML = "&#10094;";
  prevBtn.className = "prevBtn";
  prevBtn.addEventListener("click", () => {
    currentSlide = (currentSlide - 1 + slides.length) % slides.length;
    showSlide(currentSlide);
  });
  sliderContainer.appendChild(prevBtn);

  const nextBtn = document.createElement("button");
  nextBtn.innerHTML = "&#10095;";
  nextBtn.className = "nextBtn";
  nextBtn.addEventListener("click", () => {
    currentSlide = (currentSlide + 1) % slides.length;
    showSlide(currentSlide);
  });
  sliderContainer.appendChild(nextBtn);

  // Show slides function
  let currentSlide = 0;
  const slides = sliderContainer.querySelectorAll(".slide");
  const dots = sliderContainer.querySelectorAll(".dot");

  function showSlide(n) {
    slides.forEach((s, i) => s.classList.toggle("active", i === n));
    dots.forEach((d, i) => d.classList.toggle("active", i === n));
  }
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
