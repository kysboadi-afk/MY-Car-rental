// manage-booking.js
// Client-side logic for the renter self-service portal (/manage-booking.html).
//
// Flow:
//   1. Parse ?t=<token> from URL → skip verify state if present.
//   2. Verify state: customer enters phone/email/booking-ID → POST action:"verify" → get token.
//   3. Dashboard load: POST action:"get", token → populate all dashboard sections.
//   4. Pay balance: POST action:"create_balance_payment_intent" → mount Stripe Payment Element.
//   5. Modify booking: preview / apply_change / initiate_paid_change (unchanged logic).

(function () {
  "use strict";

  const API_BASE  = "/api/manage-booking";
  const VEHICLES_API = "/api/v2-vehicles?scope=cars";
  const PAYMENT_SUCCESS_RELOAD_DELAY_MS = 2200;

  // Static vehicle image map (vehicleId → relative path from site root)
  const VEHICLE_IMAGES = {
    camry:      "images/IMG_0046.png",
    camry2013:  "images/IMG_5144.png",
    fusion2017: "images/car1.jpg",
    slingshot:  "images/slingshot.jpg",
  };

  // ── Parse token from URL ────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  let activeToken = params.get("t") || "";

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const $verifyState      = document.getElementById("verify-state");
  const $verifyIdentifier = document.getElementById("verify-identifier");
  const $verifyMsg        = document.getElementById("verify-msg");
  const $btnVerify        = document.getElementById("btn-verify");
  const $loading          = document.getElementById("loading-state");
  const $error            = document.getElementById("error-state");
  const $errorMsg         = document.getElementById("error-msg");
  const $main             = document.getElementById("main-content");
  const $lockNotice       = document.getElementById("lock-notice");
  const $editSection      = document.getElementById("edit-section");
  const $pricePreview     = document.getElementById("price-preview");
  const $previewTotal     = document.getElementById("preview-total");
  const $previewBal       = document.getElementById("preview-balance");
  const $feeNotice        = document.getElementById("fee-notice");
  const $actionMsg        = document.getElementById("action-msg");
  const $btnApply         = document.getElementById("btn-apply");
  const $btnPreview       = document.getElementById("btn-preview");
  const $paidSection      = document.getElementById("paid-change-section");
  const $changeFeeAmt     = document.getElementById("change-fee-amount");
  const $btnPayFee        = document.getElementById("btn-pay-fee");
  const $stripeEl         = document.getElementById("stripe-element");
  const $stripeErr        = document.getElementById("stripe-error");
  const $dppTierRow       = document.getElementById("dpp-tier-row");
  const $newProtection    = document.getElementById("new-protection");
  const $newVehicle       = document.getElementById("new-vehicle");
  const $payBalSection    = document.getElementById("pay-balance-section");
  const $btnInitBalance   = document.getElementById("btn-init-balance");
  const $balanceWrap      = document.getElementById("balance-payment-wrap");
  const $balanceStripeEl  = document.getElementById("balance-stripe-element");
  const $balanceError     = document.getElementById("balance-error");
  const $btnConfirmBal    = document.getElementById("btn-confirm-balance");
  const $btnRetry         = document.getElementById("btn-retry-verify");

  // ── Booking state ───────────────────────────────────────────────────────────
  let booking          = null;
  let previewData      = null;
  let vehicleOptions   = [];
  let stripeInstance   = null;
  let stripeElements   = null;
  let stripeCardEl     = null;
  let balanceStripe    = null;
  let balanceElements  = null;
  let balancePayEl     = null;

  // ── Helpers ─────────────────────────────────────────────────────────────────
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

  function showSection(which) {
    [$verifyState, $loading, $error, $main].forEach((el) => {
      if (el) el.style.display = "none";
    });
    if (which) which.style.display = "block";
  }

  function showError(msg) {
    if ($errorMsg) $errorMsg.textContent = msg || "An unexpected error occurred.";
    showSection($error);
  }

  function setActionMsg(msg, type, target) {
    const el = target || $actionMsg;
    if (!el) return;
    el.innerHTML = msg
      ? `<div class="${type === "success" ? "success-msg" : "error-msg"}">${escapeHtml(msg)}</div>`
      : "";
  }

  function setVerifyMsg(msg, type) {
    if (!$verifyMsg) return;
    $verifyMsg.innerHTML = msg
      ? `<div class="${type === "success" ? "success-msg" : "error-msg"}">${escapeHtml(msg)}</div>`
      : "";
  }

  // ── Status badge mapping ────────────────────────────────────────────────────
  const STATUS_MAP = {
    reserved:             { label: "Upcoming",         cls: "badge-upcoming" },
    reserved_unpaid:      { label: "Pending Payment",  cls: "badge-pending" },
    pending:              { label: "Pending Review",   cls: "badge-pending" },
    pending_verification: { label: "Under Review",     cls: "badge-review" },
    approved:             { label: "Confirmed",        cls: "badge-confirmed" },
    active:               { label: "Active Rental",    cls: "badge-active-rental" },
    active_rental:        { label: "Active Rental",    cls: "badge-active-rental" },
    overdue:              { label: "Overdue",          cls: "badge-overdue" },
    extended:             { label: "Extended",         cls: "badge-extended" },
    booked_paid:          { label: "Confirmed",        cls: "badge-confirmed" },
    partial:              { label: "Partial Payment",  cls: "badge-pending" },
  };

  function statusBadgeHtml(rawStatus) {
    const key = (rawStatus || "").toLowerCase().replace(/\s+/g, "_");
    const { label, cls } = STATUS_MAP[key] || { label: rawStatus || "–", cls: "badge-default" };
    return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  // ── Vehicle options ─────────────────────────────────────────────────────────
  async function loadVehicleOptions() {
    if (vehicleOptions.length > 0) return vehicleOptions;
    try {
      const resp = await fetch(VEHICLES_API, { headers: { Accept: "application/json" } });
      const data = await resp.json();
      vehicleOptions = Array.isArray(data)
        ? data
            .filter((v) => v && (v.id || v.vehicle_id) && (v.name || v.vehicle_name))
            .map((v) => ({ id: v.id || v.vehicle_id, name: v.name || v.vehicle_name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];
    } catch (err) {
      console.error("manage-booking: vehicle options load error:", err);
      vehicleOptions = [];
    }
    return vehicleOptions;
  }

  function renderVehicleOptions($select, selectedId) {
    if (!$select) return;
    const opts = ['<option value="">-- Select vehicle --</option>'].concat(
      vehicleOptions.map(
        (v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`
      )
    );
    $select.innerHTML = opts.join("");
    if (selectedId) $select.value = selectedId;
  }

  // ── Populate dashboard ──────────────────────────────────────────────────────
  function populateDashboard(b) {
    // Greeting
    const firstName = (b.customerName || "").split(" ")[0];
    const greeting  = firstName ? `Hi, ${escapeHtml(firstName)}!` : "Your Rental Dashboard";
    const greetEl   = document.getElementById("dash-greeting");
    if (greetEl) greetEl.textContent = greeting;

    // Booking ID + status badge in header
    const idEl = document.getElementById("s-booking-id");
    if (idEl) idEl.textContent = b.bookingId || "–";
    const statusEl = document.getElementById("s-status");
    if (statusEl) statusEl.innerHTML = statusBadgeHtml(b.status);

    // ── Vehicle card ──────────────────────────────────────────────────────────
    const vehicleLabel = [b.vehicleYear, b.vehicleName].filter(Boolean).join(" ");
    const vehicleEl = document.getElementById("s-vehicle");
    if (vehicleEl) vehicleEl.textContent = vehicleLabel || "–";

    const imgEl = document.getElementById("vehicle-img");
    if (imgEl) {
      const src = VEHICLE_IMAGES[b.vehicleId] || "";
      if (src) {
        imgEl.src = src;
        imgEl.alt = vehicleLabel || "Rental vehicle";
        imgEl.style.display = "";
      } else {
        imgEl.style.display = "none";
      }
    }

    const pickupText = formatDate(b.pickupDate) + (b.pickupTime ? ` at ${b.pickupTime}` : "");
    const returnText = formatDate(b.returnDate) + (b.returnTime ? ` at ${b.returnTime}` : "");
    const pickupEl = document.getElementById("s-pickup");
    const returnEl = document.getElementById("s-return");
    if (pickupEl) pickupEl.textContent = pickupText;
    if (returnEl) returnEl.textContent = returnText;

    // DPP row
    const dppRow = document.getElementById("dpp-row");
    const dppVal = document.getElementById("s-protection");
    if (b.hasProtectionPlan && dppRow && dppVal) {
      const tierNames = { basic: "Basic", standard: "Standard", premium: "Premium" };
      dppVal.textContent = `${tierNames[b.protectionPlanTier] || ""} Protection Plan`.trim();
      dppRow.style.display = "";
    }

    // ── Financial summary ─────────────────────────────────────────────────────
    const total   = Number(b.totalPrice  || 0);
    const paid    = Number(b.depositPaid || 0);
    const balance = Number(b.balanceDue  || 0);
    const paidPct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : (balance === 0 ? 100 : 0);

    const totalEl   = document.getElementById("s-total");
    const depositEl = document.getElementById("s-deposit");
    const balEl     = document.getElementById("s-balance");
    if (totalEl)   totalEl.textContent   = fmt(total);
    if (depositEl) depositEl.textContent = fmt(paid);
    if (balEl)     balEl.textContent     = fmt(balance);

    // Balance row color
    const balRow = document.getElementById("balance-row");
    if (balRow) {
      balRow.className = balance > 0 ? "fin-row fin-balance" : "fin-row fin-zero";
    }

    // Progress bar
    const fillEl = document.getElementById("payment-progress-fill");
    if (fillEl) fillEl.style.width = `${paidPct}%`;
    const paidLbl = document.getElementById("progress-paid-label");
    const pctLbl  = document.getElementById("progress-pct-label");
    if (paidLbl) paidLbl.textContent = `${fmt(paid)} paid`;
    if (pctLbl)  pctLbl.textContent  = `${paidPct}% complete`;

    // ── Pay balance section ───────────────────────────────────────────────────
    const managedStatuses = ["reserved", "reserved_unpaid", "pending", "pending_verification", "approved", "active", "active_rental", "booked_paid", "overdue", "partial"];
    const statusKey = (b.status || "").toLowerCase().replace(/\s+/g, "_");
    const canPayBalance = managedStatuses.includes(statusKey) && balance > 0;

    if (canPayBalance && $payBalSection) {
      $payBalSection.style.display = "block";
      if ($btnInitBalance) $btnInitBalance.textContent = `Pay Balance (${fmt(balance)})`;
    } else if ($payBalSection) {
      $payBalSection.style.display = "none";
    }

    // Show "paid in full" notice
    const pifEl = document.getElementById("paid-in-full-notice");
    if (pifEl) {
      pifEl.style.display = (balance <= 0 && total > 0) ? "block" : "none";
    }

    // ── Lock notice + edit section visibility ─────────────────────────────────
    const editableStatuses = ["reserved", "reserved_unpaid", "pending"];
    const isLocked = !editableStatuses.includes(statusKey);
    if (isLocked) {
      if ($lockNotice) {
        $lockNotice.style.display = "block";
        if (statusKey === "approved" || statusKey === "active" || statusKey === "active_rental" || statusKey === "booked_paid") {
          $lockNotice.innerHTML = "✅ Your booking is confirmed. Dates and vehicle cannot be changed online. Please call <a href=\"tel:+18445114059\">(844) 511-4059</a> if you need assistance.";
        } else if (statusKey === "overdue") {
          $lockNotice.innerHTML = "⚠️ Your rental is overdue. Please return the vehicle and contact us immediately at <a href=\"tel:+18445114059\">(844) 511-4059</a>.";
        } else if (statusKey === "pending_verification") {
          $lockNotice.innerHTML = "⏳ Your booking is under review. Please call <a href=\"tel:+18445114059\">(844) 511-4059</a> if you need to make changes.";
        } else {
          $lockNotice.innerHTML = "ℹ️ Your booking is locked. Please call <a href=\"tel:+18445114059\">(844) 511-4059</a> for assistance.";
        }
      }
      if ($editSection) $editSection.style.display = "none";
    } else {
      if ($lockNotice) $lockNotice.style.display = "none";
      if ($editSection) $editSection.style.display = "";
      // Pre-fill edit form
      renderVehicleOptions($newVehicle, b.vehicleId || "");
      if (b.pickupDate) {
        const el = document.getElementById("new-pickup");
        if (el) el.value = b.pickupDate;
      }
      if (b.returnDate) {
        const el = document.getElementById("new-return");
        if (el) el.value = b.returnDate;
      }
      const pickupTimeEl = document.getElementById("new-pickup-time");
      if (b.pickupTime && pickupTimeEl) {
        if ([...pickupTimeEl.options].some((o) => o.value === b.pickupTime)) pickupTimeEl.value = b.pickupTime;
      }
      const returnTimeEl = document.getElementById("new-return-time");
      if (b.returnTime && returnTimeEl) {
        if ([...returnTimeEl.options].some((o) => o.value === b.returnTime)) returnTimeEl.value = b.returnTime;
      }
      if ($newProtection) {
        $newProtection.checked = !!b.hasProtectionPlan;
        if ($dppTierRow) $dppTierRow.style.display = b.hasProtectionPlan ? "block" : "none";
        const ownInsEl = document.getElementById("own-insurance-note");
        if (ownInsEl) ownInsEl.style.display = b.hasProtectionPlan ? "none" : "block";
      }
      if (b.protectionPlanTier) {
        const tierEl = document.getElementById("new-protection-tier");
        if (tierEl && [...tierEl.options].some((o) => o.value === b.protectionPlanTier)) {
          tierEl.value = b.protectionPlanTier;
        }
      }
    }

    // ── Documents section ─────────────────────────────────────────────────────
    // balancePaymentLink is sometimes an agreement/doc URL — use it if it points to a PDF
    const agreementLink = document.getElementById("doc-agreement-link");
    const agreementNA   = document.getElementById("doc-agreement-unavailable");
    if (agreementLink && agreementNA) {
      // Show Download link if we have a PDF-like URL in balancePaymentLink or a rental-agreement URL
      const docUrl = b.agreementPdfUrl || null;
      if (docUrl) {
        agreementLink.href = docUrl;
        agreementLink.style.display = "";
        agreementNA.style.display   = "none";
      } else {
        agreementLink.style.display = "none";
        agreementNA.style.display   = "";
      }
    }
  }

  // ── Step 2: Load booking ────────────────────────────────────────────────────
  async function loadBooking() {
    if (!activeToken) {
      showSection($verifyState);
      return;
    }

    const payload = { action: "get", token: activeToken };
    console.log("[manage-booking] Step 2 — get payload:", payload);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await resp.json();
      console.log("[manage-booking] Step 2 — response (status " + resp.status + "):", data);

      if (!resp.ok || data.error) {
        if (resp.status === 401) {
          activeToken = "";
          showSection($verifyState);
          setVerifyMsg("Your session has expired. Please verify your booking again.", "error");
          return;
        }
        showError(data.error || "Could not load booking.");
        return;
      }

      booking = data;
      populateDashboard(booking);
      showSection($main);
    } catch (err) {
      showError("Network error — please try again or call (844) 511-4059.");
      console.error("[manage-booking] load error:", err);
    }
  }

  // ── Step 1: Verify identity ─────────────────────────────────────────────────
  async function verifyBooking() {
    const identifier = ($verifyIdentifier ? $verifyIdentifier.value : "").trim();
    if (!identifier) {
      setVerifyMsg("Enter the phone, email, or booking ID used on your booking.", "error");
      return;
    }

    if ($btnVerify) { $btnVerify.disabled = true; $btnVerify.textContent = "Verifying…"; }
    setVerifyMsg("", null);

    const payload = { action: "verify", identifier };
    console.log("[manage-booking] Step 1 — verify payload:", payload);

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
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

      activeToken = data.token;
      setVerifyMsg("Verified! Loading your booking…", "success");
      showSection($loading);
      await loadBooking();
    } catch (err) {
      setVerifyMsg("Network error. Please try again.", "error");
      console.error("[manage-booking] Step 1 — verify error:", err);
    } finally {
      if ($btnVerify) { $btnVerify.disabled = false; $btnVerify.textContent = "Access My Booking"; }
    }
  }

  // ── DPP tier toggle ─────────────────────────────────────────────────────────
  if ($newProtection) {
    $newProtection.addEventListener("change", () => {
      if ($dppTierRow) $dppTierRow.style.display = $newProtection.checked ? "block" : "none";
      const ownInsEl = document.getElementById("own-insurance-note");
      if (ownInsEl) ownInsEl.style.display = $newProtection.checked ? "none" : "block";
      if ($pricePreview) $pricePreview.style.display = "none";
      if ($btnApply)    $btnApply.style.display     = "none";
      if ($paidSection) $paidSection.style.display  = "none";
    });
  }

  // ── Preview pricing ─────────────────────────────────────────────────────────
  if ($btnPreview) {
    $btnPreview.addEventListener("click", async () => {
      const newPickup   = document.getElementById("new-pickup")?.value;
      const newReturn   = document.getElementById("new-return")?.value;
      const newPickupT  = document.getElementById("new-pickup-time")?.value;
      const newReturnT  = document.getElementById("new-return-time")?.value;
      const hasDpp      = !!$newProtection?.checked;
      const dppTier     = hasDpp ? document.getElementById("new-protection-tier")?.value : null;
      const newVehicleId = ($newVehicle?.value || "").trim() || undefined;

      if (!newPickup || !newReturn) {
        setActionMsg("Please select both pickup and return dates.", "error");
        return;
      }
      if (newReturn < newPickup) {
        setActionMsg("Return date must be on or after pickup date.", "error");
        return;
      }

      $btnPreview.disabled    = true;
      $btnPreview.textContent = "Checking…";
      setActionMsg("", null);

      try {
        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action:                "check_availability",
            token:                 activeToken,
            newPickupDate:         newPickup,
            newReturnDate:         newReturn,
            newPickupTime:         newPickupT || undefined,
            newReturnTime:         newReturnT || undefined,
            newVehicleId,
            newProtectionPlan:     hasDpp,
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
          if ($pricePreview) $pricePreview.style.display = "none";
          if ($btnApply)     $btnApply.style.display     = "none";
          if ($paidSection)  $paidSection.style.display  = "none";
          return;
        }

        previewData = data;
        if ($previewTotal) $previewTotal.textContent = fmt(data.newTotal);
        if ($previewBal)   $previewBal.textContent   = fmt(data.newBalanceDue);
        if ($pricePreview) $pricePreview.style.display = "block";

        if (data.changeFeeRequired) {
          if ($feeNotice) { $feeNotice.textContent = `A $${data.changeFee} change fee is required.`; $feeNotice.style.display = "block"; }
          if ($btnApply)   $btnApply.style.display  = "none";
          if ($changeFeeAmt) $changeFeeAmt.textContent = `$${data.changeFee}`;
          if ($paidSection) $paidSection.style.display = "block";
          await mountStripeElement(activeToken);
        } else {
          if ($feeNotice)   $feeNotice.style.display   = "none";
          if ($btnApply)    $btnApply.style.display     = "block";
          if ($paidSection) $paidSection.style.display  = "none";
        }
        setActionMsg("", null);
      } catch (err) {
        setActionMsg("Network error. Please try again.", "error");
        console.error("[manage-booking] preview error:", err);
      } finally {
        if ($btnPreview) { $btnPreview.disabled = false; $btnPreview.textContent = "Preview Pricing"; }
      }
    });
  }

  // ── Apply free change ───────────────────────────────────────────────────────
  if ($btnApply) {
    $btnApply.addEventListener("click", async () => {
      const newPickup   = document.getElementById("new-pickup")?.value;
      const newReturn   = document.getElementById("new-return")?.value;
      const newPickupT  = document.getElementById("new-pickup-time")?.value;
      const newReturnT  = document.getElementById("new-return-time")?.value;
      const hasDpp      = !!$newProtection?.checked;
      const dppTier     = hasDpp ? document.getElementById("new-protection-tier")?.value : null;
      const newVehicleId = ($newVehicle?.value || "").trim() || undefined;

      $btnApply.disabled    = true;
      $btnApply.textContent = "Applying…";
      setActionMsg("", null);

      try {
        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action:                "apply_change",
            token:                 activeToken,
            newPickupDate:         newPickup,
            newReturnDate:         newReturn,
            newPickupTime:         newPickupT || undefined,
            newReturnTime:         newReturnT || undefined,
            newVehicleId,
            newProtectionPlan:     hasDpp,
            newProtectionPlanTier: dppTier,
          }),
        });
        const data = await resp.json();

        if (!resp.ok) {
          setActionMsg(data.error || "Failed to apply change.", "error");
          return;
        }
        setActionMsg("✅ Booking updated! Reloading…", "success");
        setTimeout(() => window.location.reload(), 1800);
      } catch (err) {
        setActionMsg("Network error. Please try again.", "error");
        console.error("[manage-booking] apply error:", err);
      } finally {
        if ($btnApply) { $btnApply.disabled = false; $btnApply.textContent = "Apply Change (Free)"; }
      }
    });
  }

  // ── Mount Stripe card element for change fee ────────────────────────────────
  async function mountStripeElement(token) {
    if (stripeInstance) return;
    const newPickup   = document.getElementById("new-pickup")?.value;
    const newReturn   = document.getElementById("new-return")?.value;
    const newPickupT  = document.getElementById("new-pickup-time")?.value;
    const newReturnT  = document.getElementById("new-return-time")?.value;
    const hasDpp      = !!$newProtection?.checked;
    const dppTier     = hasDpp ? document.getElementById("new-protection-tier")?.value : null;
    const newVehicleId = ($newVehicle?.value || "").trim() || undefined;

    try {
      const resp = await fetch(API_BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:                "initiate_paid_change",
          token,
          newPickupDate:         newPickup,
          newReturnDate:         newReturn,
          newPickupTime:         newPickupT || undefined,
          newReturnTime:         newReturnT || undefined,
          newVehicleId,
          newProtectionPlan:     hasDpp,
          newProtectionPlanTier: dppTier,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.clientSecret) {
        if ($stripeErr) { $stripeErr.textContent = data.error || "Could not initialize payment."; $stripeErr.style.display = "block"; }
        return;
      }
      if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
        if ($stripeErr) { $stripeErr.textContent = "Payment library failed to load. Please refresh."; $stripeErr.style.display = "block"; }
        return;
      }
      stripeInstance = Stripe(data.publishableKey); // eslint-disable-line no-undef
      stripeElements = stripeInstance.elements();
      stripeCardEl   = stripeElements.create("card");
      if ($stripeEl) stripeCardEl.mount($stripeEl);
      stripeCardEl.on("change", (e) => {
        if ($stripeErr) { $stripeErr.style.display = e.error ? "block" : "none"; if (e.error) $stripeErr.textContent = e.error.message; }
      });
      if ($btnPayFee) $btnPayFee.dataset.clientSecret = data.clientSecret;
    } catch (err) {
      if ($stripeErr) { $stripeErr.textContent = "Network error. Please try again."; $stripeErr.style.display = "block"; }
      console.error("[manage-booking] Stripe mount error:", err);
    }
  }

  // ── Pay change fee ──────────────────────────────────────────────────────────
  if ($btnPayFee) {
    $btnPayFee.addEventListener("click", async () => {
      if (!stripeInstance || !stripeCardEl) {
        if ($stripeErr) { $stripeErr.textContent = "Payment not initialized. Please refresh."; $stripeErr.style.display = "block"; }
        return;
      }
      const clientSecret = $btnPayFee.dataset.clientSecret;
      if (!clientSecret) {
        if ($stripeErr) { $stripeErr.textContent = "Missing payment session. Please refresh."; $stripeErr.style.display = "block"; }
        return;
      }
      $btnPayFee.disabled    = true;
      $btnPayFee.textContent = "Processing…";
      if ($stripeErr) $stripeErr.style.display = "none";

      try {
        const result = await stripeInstance.confirmCardPayment(clientSecret, {
          payment_method: { card: stripeCardEl },
        });
        if (result.error) {
          if ($stripeErr) { $stripeErr.textContent = result.error.message; $stripeErr.style.display = "block"; }
        } else if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Change fee paid! Your booking is being updated. Reloading…", "success");
          setTimeout(() => window.location.reload(), 2500);
        }
      } catch (err) {
        if ($stripeErr) { $stripeErr.textContent = "Payment error. Please try again."; $stripeErr.style.display = "block"; }
        console.error("[manage-booking] pay fee error:", err);
      } finally {
        if ($btnPayFee) { $btnPayFee.disabled = false; $btnPayFee.textContent = "Pay Change Fee & Apply"; }
      }
    });
  }

  // ── Pay remaining balance ───────────────────────────────────────────────────
  if ($btnInitBalance) {
    $btnInitBalance.addEventListener("click", async () => {
      $btnInitBalance.disabled    = true;
      $btnInitBalance.textContent = "Loading Payment…";
      if ($balanceError) $balanceError.style.display = "none";

      try {
        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ action: "create_balance_payment_intent", token: activeToken }),
        });
        const data = await resp.json();

        if (!resp.ok || !data.clientSecret) {
          if ($balanceError) { $balanceError.textContent = data.error || "Could not initialize balance payment."; $balanceError.style.display = "block"; }
          return;
        }
        if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
          if ($balanceError) { $balanceError.textContent = "Payment library failed to load. Please refresh."; $balanceError.style.display = "block"; }
          return;
        }
        balanceStripe   = Stripe(data.publishableKey); // eslint-disable-line no-undef
        balanceElements = balanceStripe.elements({ clientSecret: data.clientSecret });
        balancePayEl    = balanceElements.create("payment", {
          fields: { billingDetails: { name: "never" } },
        });
        if ($balanceStripeEl) { $balanceStripeEl.innerHTML = ""; balancePayEl.mount($balanceStripeEl); }
        if ($balanceWrap) $balanceWrap.style.display = "block";
        const balAmt = Number(data.balanceAmount || booking?.balanceDue || 0);
        if ($btnConfirmBal) $btnConfirmBal.textContent = `Pay ${fmt(balAmt)}`;
      } catch (err) {
        if ($balanceError) { $balanceError.textContent = "Network error. Please try again."; $balanceError.style.display = "block"; }
        console.error("[manage-booking] balance init error:", err);
      } finally {
        if ($btnInitBalance) {
          $btnInitBalance.disabled    = false;
          $btnInitBalance.textContent = `Pay Balance (${fmt(Number(booking?.balanceDue || 0))})`;
        }
      }
    });
  }

  if ($btnConfirmBal) {
    $btnConfirmBal.addEventListener("click", async () => {
      if (!balanceStripe || !balanceElements) return;
      $btnConfirmBal.disabled    = true;
      $btnConfirmBal.textContent = "Processing…";
      if ($balanceError) $balanceError.style.display = "none";

      try {
        const result = await balanceStripe.confirmPayment({
          elements: balanceElements,
          redirect: "if_required",
        });
        if (result.error) {
          if ($balanceError) { $balanceError.textContent = result.error.message || "Payment failed. Please try again."; $balanceError.style.display = "block"; }
          return;
        }
        if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Payment received. Updating your booking…", "success", document.getElementById("action-msg-finance"));
          setTimeout(() => window.location.reload(), PAYMENT_SUCCESS_RELOAD_DELAY_MS);
        }
      } catch (err) {
        if ($balanceError) { $balanceError.textContent = "Payment failed. Please try again."; $balanceError.style.display = "block"; }
        console.error("[manage-booking] balance pay error:", err);
      } finally {
        if ($btnConfirmBal) { $btnConfirmBal.disabled = false; $btnConfirmBal.textContent = "Confirm Payment"; }
      }
    });
  }

  // ── Retry button in error state ─────────────────────────────────────────────
  if ($btnRetry) {
    $btnRetry.addEventListener("click", () => {
      showSection($verifyState);
    });
  }

  // ── Verify button ───────────────────────────────────────────────────────────
  if ($btnVerify) {
    $btnVerify.addEventListener("click", verifyBooking);
  }
  if ($verifyIdentifier) {
    $verifyIdentifier.addEventListener("keydown", (e) => {
      if (e.key === "Enter") verifyBooking();
    });
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  (async function bootstrap() {
    await loadVehicleOptions();
    if (activeToken) {
      showSection($loading);
      await loadBooking();
      return;
    }
    showSection($verifyState);
  })();
})();
