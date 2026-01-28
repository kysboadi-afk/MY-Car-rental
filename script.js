const stripePayBtn = document.getElementById("stripePay");

stripePayBtn.addEventListener("click", async () => {
  if (!selectedCar || totalCost <= 0) {
    alert("Please complete your booking first.");
    return;
  }

  const email = document.getElementById("email").value;
  const pickupDate = pickup.value;
  const returnDateValue = returnDate.value;

  if (!email || !pickupDate || !returnDateValue) {
    alert("Please fill in all booking details.");
    return;
  }

  try {
    const res = await fetch(
      "https://slyservices-stripe-backend-ipeq.vercel.app/api/create-checkout-session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
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
      window.location.href = data.url; // Redirect to Stripe Checkout
    } else {
      alert("Stripe session failed to create.");
    }
  } catch (err) {
    console.error(err);
    alert("Payment error. Please try again.");
  }
});
