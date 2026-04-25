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

  const API_BASE = "/api/manage-booking";
  const VEHICLES_API = "/api/v2-vehicles?scope=cars";
  const PAYMENT_SUCCESS_RELOAD_DELAY_MS = 2200;

  // ── Parse token from URL ────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  let activeToken  = params.get("t") || "";

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $verifyState   = document.getElementById("verify-state");
  const $verifyIdentifier = document.getElementById("verify-identifier");
  const $verifyVehicle = document.getElementById("verify-vehicle");
  const $verifyMsg     = document.getElementById("verify-msg");
  const $btnVerify     = document.getElementById("btn-verify");
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
  const $newVehicle    = document.getElementById("new-vehicle");
  const $payBalanceSection = document.getElementById("pay-balance-section");
  const $btnInitBalance = document.getElementById("btn-init-balance");
  const $balanceWrap = document.getElementById("balance-payment-wrap");
  const $balanceStripeEl = document.getElementById("balance-stripe-element");
  const $balanceError = document.getElementById("balance-error");
  const $btnConfirmBalance = document.getElementById("btn-confirm-balance");

  // ── Booking state ───────────────────────────────────────────────────────────
  let booking = null;
  let previewData = null;
  let vehicleOptions = [];
  let stripeInstance = null;
  let stripeElements = null;
  let stripeCardElement = null;
  let balanceStripe = null;
  let balanceElements = null;
  let balancePaymentElement = null;

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

  function setVerifyMsg(msg, type) {
    $verifyMsg.innerHTML = msg
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

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function loadVehicleOptions() {
    if (vehicleOptions.length > 0) return vehicleOptions;
    try {
      const resp = await fetch(VEHICLES_API, { headers: { "Accept": "application/json" } });
      const data = await resp.json();
      vehicleOptions = Array.isArray(data) ? data
        .filter((v) => v && (v.id || v.vehicle_id) && (v.name || v.vehicle_name))
        .map((v) => ({
          id: v.id || v.vehicle_id,
          name: v.name || v.vehicle_name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        : [];
    } catch (err) {
      console.error("manage-booking vehicles load error:", err);
      vehicleOptions = [];
    }
    return vehicleOptions;
  }

  function renderVehicleOptions($select, selectedId) {
    if (!$select) return;
    const opts = ['<option value="">-- Select vehicle --</option>']
      .concat(vehicleOptions.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`));
    $select.innerHTML = opts.join("");
    if (selectedId) $select.value = selectedId;
  }

  // ── Load booking ────────────────────────────────────────────────────────────
  // Step 2 of the two-step flow: send { action:"get", token } to retrieve the
  // booking details.  Must only be called after activeToken has been set by
  // verifyBooking() (Step 1) or pre-populated from the URL ?t= param.
  async function loadBooking() {
    if (!activeToken) {
      // No token — drop back to the verify form so the customer can identify
      // themselves and obtain a fresh token via the verify action.
      $loading.style.display  = "none";
      $verifyState.style.display = "block";
      return;
    }

    const getPayload = { action: "get", token: activeToken };
    console.log("[manage-booking] Step 2 — get payload:", getPayload);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(getPayload),
      });
      const data = await resp.json();
      console.log("[manage-booking] Step 2 — get response (status " + resp.status + "):", data);

      if (!resp.ok || data.error) {
        console.error("[manage-booking] get failed — status:", resp.status, "body:", data);
        // A 401 means the token is missing or expired.  Clear it and return the
        // customer to the verify form so they can obtain a fresh one.
        if (resp.status === 401) {
          activeToken = "";
          $loading.style.display     = "none";
          $verifyState.style.display = "block";
          setVerifyMsg("Your session has expired. Please verify your booking again.", "error");
          return;
        }
        showError(data.error || "Could not load booking.");
        return;
      }

      booking = data;

      // Populate summary
      document.getElementById("s-booking-id").textContent = booking.bookingId || "–";
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

      // Pre-fill edit form with current values
      renderVehicleOptions($newVehicle, booking.vehicleId || "");
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

      // Lock editing if booking status is beyond "editable" states.
      // Statuses that allow edits: reserved, pending.
      // Statuses that are verified but read-only: approved, pending_verification.
      const editableStatuses = ["reserved", "pending"];
      const managedStatuses  = ["reserved", "pending", "pending_verification", "approved"];
      const isLocked = !editableStatuses.includes(booking.status);
      if (isLocked) {
        $lockNotice.style.display = "block";
        if (booking.status === "approved") {
          $lockNotice.innerHTML = "✅ Your booking has been confirmed. Dates and vehicle cannot be changed online. Please call <a href=\"tel:+12139166606\">(213) 916-6606</a> if you need assistance.";
        } else if (booking.status === "pending_verification") {
          $lockNotice.innerHTML = "⏳ Your booking is under review. Please call <a href=\"tel:+12139166606\">(213) 916-6606</a> if you need to make changes.";
        }
        $editSection.style.display = "none";
      }

      const canPayBalance = managedStatuses.includes(booking.status) &&
        Number(booking.balanceDue || 0) > 0;
      if (canPayBalance) {
        $payBalanceSection.style.display = "block";
        $btnInitBalance.textContent = `Complete Booking / Pay Balance (${fmt(Number(booking.balanceDue || 0))})`;
      } else {
        $payBalanceSection.style.display = "none";
      }

      $loading.style.display = "none";
      $main.style.display    = "block";
    } catch (err) {
      showError("Network error — please try again or call (213) 916-6606.");
      console.error("manage-booking load error:", err);
    }
  }

  // ── Step 1: Verify identity and obtain a manage token ──────────────────────
  async function verifyBooking() {
    const identifier = ($verifyIdentifier.value || "").trim();
    if (!identifier) {
      setVerifyMsg("Enter the phone, email, or booking ID used on your booking.", "error");
      return;
    }

    $btnVerify.disabled = true;
    $btnVerify.textContent = "Verifying…";
    setVerifyMsg("", null);

    const verifyPayload = { action: "verify", identifier };
    console.log("[manage-booking] Step 1 — verify payload:", verifyPayload);

    try {
      const resp = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyPayload),
      });
      const data = await resp.json();
      console.log("[manage-booking] Step 1 — verify response (status " + resp.status + "):", data);
      if (!resp.ok) {
        setVerifyMsg(data.error || "Verification failed. Please check your information and try again.", "error");
        return;
      }
      if (!data.token) {
        setVerifyMsg("Verification failed. Please try again.", "error");
        return;
      }
      // Store the token so Step 2 (get) can use it.
      activeToken = data.token;
      console.log("[manage-booking] token stored, proceeding to Step 2 (get)");
      setVerifyMsg("Verified. Loading your booking…", "success");
      $verifyState.style.display = "none";
      $loading.style.display = "block";
      await loadBooking();
    } catch (err) {
      setVerifyMsg("Network error. Please try again.", "error");
      console.error("[manage-booking] Step 1 — verify network error:", err);
    } finally {
      $btnVerify.disabled = false;
      $btnVerify.textContent = "Verify Booking";
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
    const newVehicleId = ($newVehicle.value || "").trim() || undefined;

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
          token:                activeToken,
          newPickupDate:        newPickup,
          newReturnDate:        newReturn,
          newPickupTime:        newPickupT || undefined,
          newReturnTime:        newReturnT || undefined,
          newVehicleId,
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
        await mountStripeElement(activeToken);
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
    const newVehicleId = ($newVehicle.value || "").trim() || undefined;

    $btnApply.disabled     = true;
    $btnApply.textContent  = "Applying…";
    setActionMsg("", null);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:               "apply_change",
          token:                activeToken,
          newPickupDate:        newPickup,
          newReturnDate:        newReturn,
          newPickupTime:        newPickupT || undefined,
          newReturnTime:        newReturnT || undefined,
          newVehicleId,
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
    const newVehicleId = ($newVehicle.value || "").trim() || undefined;

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
          newVehicleId,
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

      if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
        $stripeErr.textContent = "Payment library failed to load. Please refresh the page.";
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

  $btnInitBalance.addEventListener("click", async () => {
    $btnInitBalance.disabled = true;
    $btnInitBalance.textContent = "Loading Payment…";
    $balanceError.style.display = "none";
    try {
      const resp = await fetch("/api/complete-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_payment_intent",
          booking_ref: booking.bookingId,
          email: booking.customerEmail || undefined,
          phone: booking.customerPhone || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.clientSecret) {
        $balanceError.textContent = data.error || "Could not initialize balance payment.";
        $balanceError.style.display = "block";
        return;
      }
      if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
        $balanceError.textContent = "Payment library failed to load. Please refresh.";
        $balanceError.style.display = "block";
        return;
      }
      balanceStripe = Stripe(data.publishableKey); // eslint-disable-line no-undef
      balanceElements = balanceStripe.elements({ clientSecret: data.clientSecret });
      balancePaymentElement = balanceElements.create("payment", {
        fields: { billingDetails: { name: "never" } },
      });
      $balanceStripeEl.innerHTML = "";
      balancePaymentElement.mount($balanceStripeEl);
      $balanceWrap.style.display = "block";
      $btnConfirmBalance.textContent = `Pay ${fmt(Number(data.balanceAmount || booking.balanceDue || 0))}`;
    } catch (err) {
      $balanceError.textContent = "Network error. Please try again.";
      $balanceError.style.display = "block";
      console.error("manage-booking balance init error:", err);
    } finally {
      $btnInitBalance.disabled = false;
      $btnInitBalance.textContent = `Complete Booking / Pay Balance (${fmt(Number(booking && booking.balanceDue ? booking.balanceDue : 0))})`;
    }
  });

  $btnConfirmBalance.addEventListener("click", async () => {
    if (!balanceStripe || !balanceElements) return;
    $btnConfirmBalance.disabled = true;
    $btnConfirmBalance.textContent = "Processing…";
    $balanceError.style.display = "none";
    try {
      const result = await balanceStripe.confirmPayment({
        elements: balanceElements,
        redirect: "if_required",
      });
      if (result.error) {
        $balanceError.textContent = result.error.message || "Payment failed. Please try again.";
        $balanceError.style.display = "block";
        return;
      }
      if (result.paymentIntent && result.paymentIntent.status === "succeeded") {
        setActionMsg("✅ Payment received. Updating your booking…", "success");
        setTimeout(() => window.location.reload(), PAYMENT_SUCCESS_RELOAD_DELAY_MS);
      }
    } catch (err) {
      $balanceError.textContent = "Payment failed. Please try again.";
      $balanceError.style.display = "block";
      console.error("manage-booking balance pay error:", err);
    } finally {
      $btnConfirmBalance.disabled = false;
      $btnConfirmBalance.textContent = "Complete Payment";
    }
  });

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  (async function bootstrap() {
    await loadVehicleOptions();
    if (activeToken) {
      $loading.style.display = "block";
      await loadBooking();
      return;
    }
    $loading.style.display = "none";
    $verifyState.style.display = "block";
  })();

  $btnVerify.addEventListener("click", verifyBooking);
})();
