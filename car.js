// --- Back Button ---
const backBtn = document.getElementById("backBtn");
backBtn.addEventListener("click", () => {
  window.location.href = "./index.html";
});

// --- Get vehicle from URL ---
const params = new URLSearchParams(window.location.search);
const vehicleId = params.get("vehicle");

// Vehicle Data
const vehicles = {
  slingshot: {
    name: "Slingshot R",
    subtitle: "Sports • 2-Seater",
    price: 300,
    deposit: 150,
    images: ["images/car1.jpg","images/car2.jpg","images/car3.jpg"]
  },
  camry: {
    name: "Camry 2012",
    subtitle: "Sedan • 5-Seater",
    price: 50,
    deposit: 0,
    images: ["images/car4.jpg","images/car5.jpg"]
  }
};

// --- Populate page ---
const carName = document.getElementById("carName");
const carSubtitle = document.getElementById("carSubtitle");
const carPrice = document.getElementById("carPrice");
const mainCarImg = document.getElementById("mainCarImg");

const selectedCar = vehicles[vehicleId];

if(selectedCar){
  carName.textContent = selectedCar.name;
  carSubtitle.textContent = selectedCar.subtitle;
  carPrice.textContent = `$${selectedCar.price} / day • $${selectedCar.deposit} deposit`;
  mainCarImg.src = selectedCar.images[0];
}

// --- Booking Logic ---
const pickupTimeInput = document.getElementById("pickupTime");
const returnTimeInput = document.getElementById("returnTime");
const totalSpan = document.getElementById("total");
const stripeBtn = document.getElementById("stripePay");
const emailInput = document.getElementById("email");
const pickupDateInput = document.getElementById("pickup");
const returnDateInput = document.getElementById("return");
const agreeCheckbox = document.getElementById("agree");

function calculateTotal(){
  const pickup = new Date(pickupDateInput.value);
  const ret = new Date(returnDateInput.value);
  if(pickup && ret && ret >= pickup){
    const diffDays = Math.ceil((ret - pickup) / (1000*60*60*24)) || 1;
    const total = diffDays * selectedCar.price + selectedCar.deposit;
    totalSpan.textContent = total;
    stripeBtn.disabled = !(emailInput.value && agreeCheckbox.checked);
  }
}

// Sync return time automatically
pickupTimeInput.addEventListener("change", () => {
  if(!returnTimeInput.value){
    returnTimeInput.value = pickupTimeInput.value;
  }
  calculateTotal();
});
returnDateInput.addEventListener("change", calculateTotal);
pickupDateInput.addEventListener("change", calculateTotal);
emailInput.addEventListener("input", calculateTotal);
agreeCheckbox.addEventListener("change", calculateTotal);

// Stripe Button
stripeBtn.addEventListener("click", async () => {
  const email = emailInput.value;
  const pickupDate = pickupDateInput.value;
  const returnDate = returnDateInput.value;

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          car: selectedCar.name,
          amount: parseInt(totalSpan.textContent),
          email,
          pickup: pickupDate,
          returnDate
        })
      }
    );

    const data = await res.json();
    if(data.url){
      window.location.href = data.url;
    } else {
      alert("Stripe session failed.");
    }
  } catch(err){
    console.error(err);
    alert("Payment error. Please try again.");
  }
});

// Reserve without paying
function reserve(){
  alert("Reserved without payment!");
}
