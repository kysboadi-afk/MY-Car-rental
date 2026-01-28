// Car data
const cars = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    images: ["images/car1.jpg","images/car2.jpg","images/car3.jpg"],
    pricePerDay: 300,
    deposit: 150
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    images: ["images/car4.jpg","images/car5.jpg"],
    pricePerDay: 50,
    weekly: 250
  }
};

// Get selected car from URL
const urlParams = new URLSearchParams(window.location.search);
const vehicleId = urlParams.get("vehicle");
const carData = cars[vehicleId];

const carSlider = document.getElementById("carSlider");
const backBtn = document.getElementById("backBtn");
const totalSpan = document.getElementById("total");
let selectedCar = carData;
let totalCost = 0;

// Redirect back to homepage
backBtn.addEventListener("click", () => {
  window.location.href = "index.html";
});

// Populate slider
if(carData && carSlider){
  const sliderDiv = document.createElement("div");
  sliderDiv.classList.add("slider");
  carData.images.forEach((imgSrc, index) => {
    const img = document.createElement("img");
    img.src = imgSrc;
    img.alt = carData.name;
    img.className = "slide" + (index===0 ? " active" : "");
    sliderDiv.appendChild(img);
  });

  const infoDiv = document.createElement("div");
  infoDiv.classList.add("car-info");
  infoDiv.innerHTML = `
    <h3>${carData.name}</h3>
    <p class="car-subtitle">${carData.subtitle}</p>
    <p class="price">$${carData.pricePerDay} / day ${carData.deposit ? "• $" + carData.deposit + " deposit" : ""}</p>
  `;

  carSlider.appendChild(sliderDiv);
  carSlider.appendChild(infoDiv);

  // Slider logic
  let currentIndex = 0;
  function showSlide(index){
    const slides = sliderDiv.querySelectorAll(".slide");
    slides.forEach((s,i)=> s.classList.toggle("active", i===index));
  }

  sliderDiv.addEventListener("click", () => {
    currentIndex = (currentIndex + 1) % carData.images.length;
    showSlide(currentIndex);
  });
}

// Price calculation
const pickupInput = document.getElementById("pickup");
const returnInput = document.getElementById("return");
function calculateTotal() {
  const pickup = new Date(pickupInput.value);
  const ret = new Date(returnInput.value);
  if(pickup && ret && ret > pickup){
    const diffDays = Math.ceil((ret - pickup)/(1000*60*60*24));
    totalCost = diffDays * carData.pricePerDay;
    totalSpan.textContent = totalCost;
    document.getElementById("stripePay").disabled = false;
  }
}
pickupInput.addEventListener("change", calculateTotal);
returnInput.addEventListener("change", calculateTotal);

// Stripe pay
const stripePayBtn = document.getElementById("stripePay");
stripePayBtn.addEventListener("click", async () => {
  if(!selectedCar || totalCost<=0){
    alert("Please select dates first.");
    return;
  }
  const email = document.getElementById("email").value;
  if(!email){
    alert("Enter your email.");
    return;
  }

  try {
    const res = await fetch("https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        car: selectedCar.name,
        amount: totalCost,
        email: email
      })
    });
    const data = await res.json();
    if(data.url) window.location.href = data.url;
    else alert("Stripe session failed");
  } catch(err){
    console.error(err);
    alert("Payment error. Try again.");
  }
});
