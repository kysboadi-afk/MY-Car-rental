// manage-booking.js
// Client-side logic for the customer booking management portal (/manage-booking.html).
//
// On load:
//   1. Parse ?t=<token> from the URL.
//   2. Call /api/manage-booking { action:"get", token } to load the booking.
//   3. Populate the summary table and pre-fill the edit form with current values.
//
// On "Preview New Pricing":
//   Call action:"check_availability" to see the new total / balance due.
//
// On "Apply Change" (first change, free):
//   Call action:"apply_change" directly — no Stripe.
//
// On "Pay Change Fee & Apply" (subsequent changes):
//   Call action:"initiate_paid_change" → get Stripe clientSecret → confirm payment.
//   Webhook handles the actual booking update.

(function () {
  "use strict";

  const API_BASE = "https://sly-rides.vercel.app/api/manage-booking";

  // ── Parse token from URL ────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const TOKEN  = params.get("t") || "";

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $loading       = document.getElementById("loading-state");
  const $error         = document.getElementById("error-state");
  const $errorMsg      = document.getElementById("error-msg");
  const $main          = document.getElementById("main-content");
  const $lockNotice    = document.getElementById("lock-notice");
  const $editSection   = document.getElementById("edit-section");
  const $pricePreview  = document.getElementById("price-preview");
  const $previewTotal  = document.getElementById("preview-total");
  const $previewBal    = document.getElementById("preview-balance");
  const $feeNotice     = document.getElementById("fee-notice");
  const $actionMsg     = document.getElementById("action-msg");
  const $btnApply      = document.getElementById("btn-apply");
  const $btnPreview    = document.getElementById("btn-preview");
  const $paidSection   = document.getElementById("paid-change-section");
  const $changeFeeAmt  = document.getElementById("change-fee-amount");
  const $btnPayFee     = document.getElementById("btn-pay-fee");
  const $stripeEl      = document.getElementById("stripe-element");
  const $stripeErr     = document.getElementById("stripe-error");
  const $dppTierRow    = document.getElementById("dpp-tier-row");
  const $newProtection = document.getElementById("new-protection");

  // ── Booking state ───────────────────────────────────────────────────────────
  let booking = null;
  let previewData = null;
  let stripeInstance = null;
  let stripeElements = null;
  let stripeCardElement = null;

  function showError(msg) {
    $loading.style.display = "none";
    $error.style.display = "block";
    $errorMsg.textContent = msg || "An unexpected error occurred.";
  }

  function setActionMsg(msg, type) {
    $actionMsg.innerHTML = msg
      ? `<div class="${type === "success" ? "success-msg" : "error-msg"}">${msg}</div>`
      : "";
  }

  function fmt(n) {
    return typeof n === "number" ? `$${n.toFixed(2)}` : "–";
  }

  function formatDate(d) {
    if (!d) return "–";
    const [y, m, day] = d.split("-");
    if (!y || !m || !day) return d;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}, ${y}`;
  }

  // ── Load booking ────────────────────────────────────────────────────────────
  async function loadBooking() {
    if (!TOKEN) {
      showError("No booking token found in the URL. Please use the link from your confirmation email.");
      return;
    }

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "get", token: TOKEN }),
      });
      const data = await resp.json();

      if (!resp.ok || data.error) {
        showError(data.error || "Could not load booking.");
        return;
      }

      booking = data;

      // Populate summary
      document.getElementById("s-booking-id").textContent = booking.bookingRef || "–";
      document.getElementById("s-vehicle").textContent    = booking.vehicleName || booking.vehicleId || "–";
      document.getElementById("s-pickup").textContent     = formatDate(booking.pickupDate) + (booking.pickupTime ? ` at ${booking.pickupTime}` : "");
      document.getElementById("s-return").textContent     = formatDate(booking.returnDate) + (booking.returnTime ? ` at ${booking.returnTime}` : "");
      document.getElementById("s-total").textContent      = fmt(booking.totalPrice);
      document.getElementById("s-deposit").textContent    = fmt(booking.depositPaid);
      document.getElementById("s-balance").textContent    = fmt(booking.balanceDue);

      const $status = document.getElementById("s-status");
      const statusMap = {
        reserved: ["Reserved", "status-reserved"],
        active:   ["Active",   "status-active"],
        partial:  ["Partial",  "status-partial"],
      };
      const [label, cls] = statusMap[booking.status] || [booking.status || "–", ""];
      $status.innerHTML = `<span class="status-badge ${cls}">${label}</span>`;

      if (booking.balancePaymentLink) {
        const $payLink = document.getElementById("s-pay-link");
        $payLink.href = booking.balancePaymentLink;
        $payLink.style.display = "inline-block";
      }

      // Pre-fill edit form with current values
      if (booking.pickupDate) document.getElementById("new-pickup").value  = booking.pickupDate;
      if (booking.returnDate) document.getElementById("new-return").value   = booking.returnDate;
      if (booking.pickupTime) {
        const el = document.getElementById("new-pickup-time");
        if ([...el.options].some((o) => o.value === booking.pickupTime)) el.value = booking.pickupTime;
      }
      if (booking.returnTime) {
        const el = document.getElementById("new-return-time");
        if ([...el.options].some((o) => o.value === booking.returnTime)) el.value = booking.returnTime;
      }

      // Lock editing if within 3 hours of pickup or booking is no longer reserved
      const isLocked = booking.lockedForEditing || !["reserved", "pending"].includes(booking.status);
      if (isLocked) {
        $lockNotice.style.display = "block";
        $editSection.style.display = "none";
      }

      $loading.style.display = "none";
      $main.style.display    = "block";
    } catch (err) {
      showError("Network error — please try again or call (213) 916-6606.");
      console.error("manage-booking load error:", err);
    }
  }

  // ── DPP tier toggle ─────────────────────────────────────────────────────────
  $newProtection.addEventListener("change", () => {
    $dppTierRow.style.display = $newProtection.checked ? "block" : "none";
    // Reset preview when protection plan changes
    $pricePreview.style.display = "none";
    $btnApply.style.display     = "none";
    $paidSection.style.display  = "none";
  });

  // ── Preview pricing ─────────────────────────────────────────────────────────
  $btnPreview.addEventListener("click", async () => {
    const newPickup  = document.getElementById("new-pickup").value;
    const newReturn  = document.getElementById("new-return").value;
    const newPickupT = document.getElementById("new-pickup-time").value;
    const newReturnT = document.getElementById("new-return-time").value;
    const hasDpp     = $newProtection.checked;
    const dppTier    = hasDpp ? document.getElementById("new-protection-tier").value : null;

    if (!newPickup || !newReturn) {
      setActionMsg("Please select both pickup and return dates.", "error");
      return;
    }
    if (newReturn < newPickup) {
      setActionMsg("Return date must be on or after pickup date.", "error");
      return;
    }

    $btnPreview.disabled = true;
    $btnPreview.textContent = "Checking…";
    setActionMsg("", null);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:               "check_availability",
          token:                TOKEN,
          newPickupDate:        newPickup,
          newReturnDate:        newReturn,
          newPickupTime:        newPickupT || undefined,
          newReturnTime:        newReturnT || undefined,
          newProtectionPlan:    hasDpp,
          newProtectionPlanTier: dppTier,
        }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        setActionMsg(data.error || "Could not check availability.", "error");
        return;
      }

      if (!data.available) {
        setActionMsg(data.reason || "These dates are not available.", "error");
        $pricePreview.style.display = "none";
        $btnApply.style.display     = "none";
        $paidSection.style.display  = "none";
        return;
      }

      previewData = data;

      $previewTotal.textContent = fmt(data.newTotal);
      $previewBal.textContent   = fmt(data.newBalanceDue);
      $pricePreview.style.display = "block";

      if (data.changeFeeRequired) {
        $feeNotice.textContent   = `A $${data.changeFee} change fee is required.`;
        $feeNotice.style.display = "block";
        $btnApply.style.display  = "none";
        // Show Stripe element for change fee
        $changeFeeAmt.textContent = `$${data.changeFee}`;
        $paidSection.style.display = "block";
        await mountStripeElement(TOKEN);
      } else {
        $feeNotice.style.display   = "none";
        $btnApply.style.display    = "block";
        $paidSection.style.display = "none";
      }
      setActionMsg("", null);
    } catch (err) {
      setActionMsg("Network error. Please try again.", "error");
      console.error("manage-booking preview error:", err);
    } finally {
      $btnPreview.disabled     = false;
      $btnPreview.textContent  = "Preview New Pricing";
    }
  });

  // ── Apply free change ───────────────────────────────────────────────────────
  $btnApply.addEventListener("click", async () => {
    const newPickup  = document.getElementById("new-pickup").value;
    const newReturn  = document.getElementById("new-return").value;
    const newPickupT = document.getElementById("new-pickup-time").value;
    const newReturnT = document.getElementById("new-return-time").value;
    const hasDpp     = $newProtection.checked;
    const dppTier    = hasDpp ? document.getElementById("new-protection-tier").value : null;

    $btnApply.disabled     = true;
    $btnApply.textContent  = "Applying…";
    setActionMsg("", null);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:               "apply_change",
          token:                TOKEN,
          newPickupDate:        newPickup,
          newReturnDate:        newReturn,
          newPickupTime:        newPickupT || undefined,
          newReturnTime:        newReturnT || undefined,
          newProtectionPlan:    hasDpp,
          newProtectionPlanTier: dppTier,
        }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        setActionMsg(data.error || "Failed to apply change.", "error");
        return;
      }

      // Reload page to show updated booking summary
      setActionMsg("✅ Booking updated successfully! Reloading…", "success");
      setTimeout(() => window.location.reload(), 1800);
    } catch (err) {
      setActionMsg("Network error. Please try again.", "error");
      console.error("manage-booking apply error:", err);
    } finally {
      $btnApply.disabled    = false;
      $btnApply.textContent = "Apply Change (Free)";
    }
  });

  // ── Mount Stripe card element for change fee ────────────────────────────────
  async function mountStripeElement(token) {
    if (stripeInstance) return; // already mounted

    const newPickup  = document.getElementById("new-pickup").value;
    const newReturn  = document.getElementById("new-return").value;
    const newPickupT = document.getElementById("new-pickup-time").value;
    const newReturnT = document.getElementById("new-return-time").value;
    const hasDpp     = $newProtection.checked;
    const dppTier    = hasDpp ? document.getElementById("new-protection-tier").value : null;

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:               "initiate_paid_change",
          token,
          newPickupDate:        newPickup,
          newReturnDate:        newReturn,
          newPickupTime:        newPickupT || undefined,
          newReturnTime:        newReturnT || undefined,
          newProtectionPlan:    hasDpp,
          newProtectionPlanTier: dppTier,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.clientSecret) {
        $stripeErr.textContent = data.error || "Could not initialize payment.";
        $stripeErr.style.display = "block";
        return;
      }

      stripeInstance = Stripe(data.publishableKey); // eslint-disable-line no-undef
      stripeElements = stripeInstance.elements();
      stripeCardElement = stripeElements.create("card");
      stripeCardElement.mount($stripeEl);
      stripeCardElement.on("change", (e) => {
        $stripeErr.style.display = e.error ? "block" : "none";
        if (e.error) $stripeErr.textContent = e.error.message;
      });

      // Store clientSecret for confirmation
      $btnPayFee.dataset.clientSecret = data.clientSecret;
    } catch (err) {
      $stripeErr.textContent = "Network error. Please try again.";
      $stripeErr.style.display = "block";
      console.error("manage-booking Stripe mount error:", err);
    }
  }

  // ── Pay change fee ──────────────────────────────────────────────────────────
  $btnPayFee.addEventListener("click", async () => {
    if (!stripeInstance || !stripeCardElement) {
      $stripeErr.textContent = "Payment not initialized. Please refresh the page.";
      $stripeErr.style.display = "block";
      return;
    }

    const clientSecret = $btnPayFee.dataset.clientSecret;
    if (!clientSecret) {
      $stripeErr.textContent = "Missing payment session. Please refresh.";
      $stripeErr.style.display = "block";
      return;
    }

    $btnPayFee.disabled    = true;
    $btnPayFee.textContent = "Processing…";
    $stripeErr.style.display = "none";

    try {
      const result = await stripeInstance.confirmCardPayment(clientSecret, {
        payment_method: { card: stripeCardElement },
      });

      if (result.error) {
        $stripeErr.textContent = result.error.message;
        $stripeErr.style.display = "block";
      } else if (result.paymentIntent && result.paymentIntent.status === "succeeded") {
        setActionMsg("✅ Change fee paid! Your booking is being updated. Reloading…", "success");
        setTimeout(() => window.location.reload(), 2500);
      }
    } catch (err) {
      $stripeErr.textContent = "Payment error. Please try again.";
      $stripeErr.style.display = "block";
      console.error("manage-booking pay fee error:", err);
    } finally {
      $btnPayFee.disabled    = false;
      $btnPayFee.textContent = "Pay Change Fee & Apply";
    }
  });

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  loadBooking();
})();
