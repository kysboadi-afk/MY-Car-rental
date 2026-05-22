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
  const $btnOpenPartial   = document.getElementById("btn-open-partial");
  const $btnViewPlan      = document.getElementById("btn-view-plan");
  const $btnDownloadLatestReceipt = document.getElementById("btn-download-latest-receipt");
  const $balanceWrap      = document.getElementById("balance-payment-wrap");
  const $balanceStripeEl  = document.getElementById("balance-stripe-element");
  const $balanceError     = document.getElementById("balance-error");
  const $btnConfirmBal    = document.getElementById("btn-confirm-balance");
  const $btnRetry         = document.getElementById("btn-retry-verify");
  const $docAgreementLink = document.getElementById("doc-agreement-link");
  const $docAgreementUnavailable = document.getElementById("doc-agreement-unavailable");
  const $docLatestReceipt = document.getElementById("doc-latest-receipt");
  const $docLatestReceiptUnavailable = document.getElementById("doc-latest-receipt-unavailable");
  const $openRenterChatbot = document.getElementById("open-renter-chatbot");
  const $activityList     = document.getElementById("activity-list");
  const $activityEmpty    = document.getElementById("activity-empty");
  // Partial payment DOM refs
  const $partialSection   = document.getElementById("partial-payment-section");
  const $partialAmtInput  = document.getElementById("partial-amount-input");
  const $partialMaxBtn    = document.getElementById("partial-max-btn");
  const $partialPreview   = document.getElementById("partial-amount-preview");
  const $btnInitPartial   = document.getElementById("btn-init-partial");
  const $partialStripeEl  = document.getElementById("partial-stripe-element");
  const $partialError     = document.getElementById("partial-error");
  const $btnConfirmPartial = document.getElementById("btn-confirm-partial");

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
  let partialStripe    = null;
  let partialElements  = null;
  let partialPayEl     = null;
  let currentBalance   = 0;
  let ledgerSummary    = null;
  let ledgerTransactions = [];
  let latestReceiptTransaction = null;
  let agreementPdfUrl  = null;

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

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
  }

  function setDisplay(id, visible, displayValue = "") {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? displayValue : "none";
  }

  function formatDateTime(dateValue, timeValue) {
    if (!dateValue) return "–";
    const base = formatDate(dateValue);
    return timeValue ? `${base} at ${timeValue}` : base;
  }

  function formatPlanDate(value) {
    if (!value) return "–";
    const dateOnly = String(value).slice(0, 10);
    return formatDate(dateOnly);
  }

  function normalizeStatusKey(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, "_");
  }

  function normalizeVehicleLookupKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function resolveVehicleRouteId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const exact = vehicleOptions.find((v) => String(v.id || "").trim() === raw);
    if (exact?.id) return String(exact.id).trim();
    const lowered = raw.toLowerCase();
    const ci = vehicleOptions.find((v) => String(v.id || "").trim().toLowerCase() === lowered);
    if (ci?.id) return String(ci.id).trim();
    const lookup = normalizeVehicleLookupKey(raw);
    const byId = vehicleOptions.find((v) => normalizeVehicleLookupKey(v.id) === lookup);
    if (byId?.id) return String(byId.id).trim();
    const byName = vehicleOptions.find((v) => normalizeVehicleLookupKey(v.name) === lookup);
    if (byName?.id) return String(byName.id).trim();
    return raw;
  }

  function buildExtensionHref(b) {
    const resolvedVehicleId = resolveVehicleRouteId(b?.vehicleId || b?.vehicleName || "");
    const token = String(activeToken || params.get("t") || "").trim();
    const query = new URLSearchParams();
    if (resolvedVehicleId) query.set("vehicle", resolvedVehicleId);
    query.set("extend", "1");
    if (token) query.set("t", token);
    return `car.html?${query.toString()}`;
  }

  function buildBalanceLink(b) {
    if (b?.balancePaymentLink) return b.balancePaymentLink;
    const params = new URLSearchParams();
    if (b?.vehicleId) params.set("v", b.vehicleId);
    if (b?.pickupDate) params.set("p", b.pickupDate);
    if (b?.returnDate) params.set("r", b.returnDate);
    if (b?.customerEmail) params.set("e", b.customerEmail);
    if (b?.bookingId) params.set("b", b.bookingId);
    return params.toString() ? `${window.location.origin}/balance.html?${params.toString()}` : "";
  }

  function isOverdueDate(value) {
    const dateKey = String(value || "").slice(0, 10);
    if (!dateKey) return false;
    const today = new Date();
    const nowKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return dateKey < nowKey;
  }

  function transactionTitle(tx) {
    const type = String(tx?.transaction_type || "").replace(/_/g, " ");
    const normalized = type.toLowerCase();
    if (normalized === "payment") return "Payment received";
    if (normalized === "extension") return "Extension charge";
    if (normalized === "late fee") return "Late fee";
    if (normalized === "waiver") return "Waiver applied";
    if (normalized === "refund") return "Refund posted";
    return type ? type.replace(/\b\w/g, (c) => c.toUpperCase()) : "Account activity";
  }

  function transactionMeta(tx) {
    const created = tx?.created_at ? new Date(tx.created_at) : null;
    const createdLabel = created && Number.isFinite(created.getTime())
      ? created.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "Date unavailable";
    const notes = String(tx?.notes || "").trim();
    return notes ? `${createdLabel} • ${notes}` : createdLabel;
  }

  function findLatestReceiptTransaction(transactions) {
    return (transactions || []).find((tx) => {
      return tx && tx.transaction_type === "payment" && tx.direction === "credit";
    }) || null;
  }

  function downloadReceiptForTransaction(tx) {
    if (!booking || !tx) return;
    const paidAt = tx.created_at ? new Date(tx.created_at).toLocaleString() : "Date unavailable";
    const amount = fmt(Number(tx.amount || 0));
    const receiptRef = tx.stripe_payment_intent_id || tx.source_id || tx.id || booking.bookingId || "payment";
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>SLY Receipt</title>
<style>
body{font-family:Arial,sans-serif;padding:32px;color:#111} .wrap{max-width:720px;margin:0 auto}
h1{margin:0 0 8px} .meta{color:#555;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-top:18px} td{border:1px solid #ddd;padding:10px;vertical-align:top}
.amount{font-size:28px;font-weight:700;color:#1b5e20;margin:20px 0}
</style></head><body><div class="wrap">
<h1>Payment Receipt</h1>
<div class="meta">Sly Car Rentals • (844) 511-4059</div>
<div class="amount">${escapeHtml(amount)}</div>
<table>
  <tr><td><strong>Booking ID</strong></td><td>${escapeHtml(booking.bookingId || "—")}</td></tr>
  <tr><td><strong>Renter</strong></td><td>${escapeHtml(booking.customerName || "—")}</td></tr>
  <tr><td><strong>Vehicle</strong></td><td>${escapeHtml(booking.vehicleName || booking.vehicleId || "—")}</td></tr>
  <tr><td><strong>Payment Date</strong></td><td>${escapeHtml(paidAt)}</td></tr>
  <tr><td><strong>Payment Reference</strong></td><td>${escapeHtml(receiptRef)}</td></tr>
  <tr><td><strong>Description</strong></td><td>${escapeHtml(transactionTitle(tx))}</td></tr>
</table>
</div></body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sly-receipt-${booking.bookingId || "payment"}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
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
    inquiry_received:     { label: "Inquiry Received",     cls: "badge-pending" },
    identity_pending:     { label: "Identity Pending",     cls: "badge-review" },
    identity_verified:    { label: "Identity Verified",    cls: "badge-review" },
    agreement_pending:    { label: "Agreement Pending",    cls: "badge-pending" },
    agreement_signed:     { label: "Agreement Signed",     cls: "badge-confirmed" },
    pending_manual_payment: { label: "Pay at Pickup",      cls: "badge-review" },
    ready_for_pickup:     { label: "Ready for Pickup",     cls: "badge-confirmed" },
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
    const firstName = (b.customerName || "").split(" ")[0];
    const greeting  = firstName ? `Hi, ${escapeHtml(firstName)}!` : "Your Rental Dashboard";
    const statusKey = normalizeStatusKey(b.status);
    const isSlingshot = String(b.category || "").toLowerCase() === "slingshot";
    const total     = Number(b.totalPrice || 0) || (Number(b.depositPaid || 0) + Number(b.balanceDue || 0)) || 0;
    const paidFromLedger = Number(ledgerSummary?.total_paid || 0);
    const paid      = Math.max(Number(b.depositPaid || 0), paidFromLedger);
    const balanceFromLedger = Number(ledgerSummary?.remaining_balance);
    const balance   = Number.isFinite(balanceFromLedger) ? balanceFromLedger : Number(b.balanceDue || 0);
    const paidPct   = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : (balance === 0 ? 100 : 0);
    const plan      = b.paymentPlan || null;
    const overdueAmount = plan?.isOverdue
      ? Number(plan.nextInstallmentAmount || 0)
      : (statusKey === "overdue" ? balance : 0);
    const nextDueText = plan?.nextDueDate ? formatPlanDate(plan.nextDueDate) : (statusKey === "overdue" ? "Past due" : "Not scheduled");
    const progressText = plan
      ? `${plan.paidInstallments || 0}/${plan.totalInstallments || plan.installments || 0}`
      : `${paidPct}%`;

    setText("dash-greeting", greeting);
    setText("dash-subtitle", "Manage payments, view recent activity, and use renter self-service tools without leaving your booking.");
    setText("s-booking-id", b.bookingId || "–");
    setHtml("s-status", statusBadgeHtml(b.status));
    setText("vehicle-status-tag", statusKey === "overdue" ? "Action needed" : "Current booking details");
    setText("hero-payment-chip", isSlingshot && ["agreement_signed", "pending_manual_payment", "ready_for_pickup"].includes(statusKey)
      ? "Payment due at pickup"
      : (balance > 0 ? `${fmt(balance)} still due` : "Paid in full"));
    setText("hero-plan-chip", isSlingshot ? "Manual slingshot workflow" : (plan ? `Plan: ${plan.status || "active"}` : "No active payment plan"));

    const vehicleLabel = [b.vehicleYear, b.vehicleName].filter(Boolean).join(" ");
    setText("s-vehicle", vehicleLabel || "–");
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
    setText("s-pickup", formatDateTime(b.pickupDate, b.pickupTime));
    setText("s-return", formatDateTime(b.returnDate, b.returnTime));

    const dppRow = document.getElementById("dpp-row");
    const dppVal = document.getElementById("s-protection");
    if (b.hasProtectionPlan && dppRow && dppVal) {
      const tierNames = { basic: "Basic", standard: "Standard", premium: "Premium" };
      dppVal.textContent = `${tierNames[b.protectionPlanTier] || ""} Protection Plan`.trim();
      dppRow.style.display = "";
    } else if (dppRow) {
      dppRow.style.display = "none";
    }

    setText("s-total", fmt(total));
    setText("s-deposit", fmt(paid));
    setText("s-balance", fmt(balance));
    setText("stat-total", fmt(total));
    setText("stat-paid", fmt(paid));
    setText("stat-balance", fmt(balance));
    setText("stat-overdue", fmt(overdueAmount));
    setText("stat-next-due", nextDueText);
    setText("stat-plan-progress", progressText);
    setText("stat-paid-note", paid > 0 ? `${fmt(paid)} recorded across deposit and later payments.` : "No posted payments yet.");
    setText("stat-balance-note", isSlingshot
      ? (["agreement_signed", "pending_manual_payment", "ready_for_pickup"].includes(statusKey)
          ? "Payment for this slingshot booking is collected in person at pickup."
          : "Complete the onboarding steps below to finish your slingshot reservation.")
      : (balance > 0 ? "Use the payment actions below to pay now or make a partial payment." : "No balance remains on this booking."));
    setText("stat-overdue-note", overdueAmount > 0 ? "Past-due amount requires attention." : "No overdue amount is currently flagged.");
    setText("stat-next-due-note", plan?.nextDueDate ? "Based on your active payment plan." : "No payment-plan due date is currently scheduled.");
    setText("stat-plan-progress-note", plan ? "Installment completion using the active plan." : "If a plan is created later, progress will appear here.");

    const balRow = document.getElementById("balance-row");
    if (balRow) balRow.className = balance > 0 ? "fin-row fin-balance" : "fin-row fin-zero";
    setText("progress-paid-label", `${fmt(paid)} paid`);
    setText("progress-pct-label", `${paidPct}% complete`);
    const fillEl = document.getElementById("payment-progress-fill");
    if (fillEl) fillEl.style.width = `${paidPct}%`;

    const managedStatuses = ["reserved", "reserved_unpaid", "pending", "pending_verification", "approved", "active", "active_rental", "booked_paid", "overdue", "partial"];
    const canPayBalance = !isSlingshot && managedStatuses.includes(statusKey) && balance > 0;
    currentBalance = balance;
    if (canPayBalance && $payBalSection) {
      $payBalSection.style.display = "block";
      if ($btnInitBalance) $btnInitBalance.textContent = `Pay Balance (${fmt(balance)})`;
      if ($btnOpenPartial) $btnOpenPartial.style.display = "";
    } else if ($payBalSection) {
      $payBalSection.style.display = "none";
    }

    const pifEl = document.getElementById("paid-in-full-notice");
    if (pifEl) pifEl.style.display = (balance <= 0 && total > 0) ? "block" : "none";

    renderPaymentPlanSummary(b, balance);
    renderLedgerSummary(b, total, paid, balance, overdueAmount);

    const extensionEligible = ["active", "active_rental", "overdue", "extended"].includes(statusKey);
    const extensionHref = buildExtensionHref(b);
    const extensionCta = document.getElementById("extension-cta");
    if (extensionCta) {
      extensionCta.href = extensionHref;
      extensionCta.textContent = extensionEligible ? "⏱️ Open Extension Flow" : "📞 Contact Support About Extensions";
      if (!extensionEligible) extensionCta.href = "tel:+18445114059";
    }
    setText("extension-status-pill", extensionEligible ? "Eligible to review extension options" : "Extension requires support");
    setText("extension-balance", fmt(balance));
    setText("extension-overdue", fmt(overdueAmount));
    setText("extension-balance-note", balance > 0 ? "Current balance remains due before or alongside any extension arrangements." : "Your existing booking balance is currently clear.");
    setText("extension-overdue-note", overdueAmount > 0 ? "An overdue amount is currently flagged on your account." : "No overdue extension-related amount is flagged.");
    setText("extension-cta-note", extensionEligible
      ? "The CTA opens the current specialized extension experience without changing extension pricing or validation."
      : "Call support to review extension options for this booking status.");

    const editableStatuses = ["reserved", "reserved_unpaid", "pending"];
    const isLocked = !editableStatuses.includes(statusKey);
    if (isLocked) {
      if ($lockNotice) {
        $lockNotice.style.display = "block";
        if (isSlingshot && (statusKey === "identity_pending" || statusKey === "identity_verified" || statusKey === "agreement_pending")) {
          const resumeHref = `slingshot-book.html?vehicle=${encodeURIComponent(b.vehicleId || "")}&resume=${encodeURIComponent(b.bookingId || "")}`;
          $lockNotice.innerHTML = `📝 Complete your slingshot onboarding to continue. <a href="${resumeHref}">Resume identity / agreement steps</a> or call <a href="tel:+18445114059">(844) 511-4059</a>.`;
        } else if (isSlingshot && (statusKey === "agreement_signed" || statusKey === "pending_manual_payment" || statusKey === "ready_for_pickup")) {
          $lockNotice.innerHTML = "💵 Your slingshot payment will be collected in person at pickup. Use this dashboard to view your agreement and booking details.";
        } else if (statusKey === "approved" || statusKey === "active" || statusKey === "active_rental" || statusKey === "booked_paid") {
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
      renderVehicleOptions($newVehicle, b.vehicleId || "");
      const pickupEl = document.getElementById("new-pickup");
      const returnEl = document.getElementById("new-return");
      if (pickupEl && b.pickupDate) pickupEl.value = b.pickupDate;
      if (returnEl && b.returnDate) returnEl.value = b.returnDate;
      const pickupTimeEl = document.getElementById("new-pickup-time");
      const returnTimeEl = document.getElementById("new-return-time");
      if (b.pickupTime && pickupTimeEl && [...pickupTimeEl.options].some((o) => o.value === b.pickupTime)) pickupTimeEl.value = b.pickupTime;
      if (b.returnTime && returnTimeEl && [...returnTimeEl.options].some((o) => o.value === b.returnTime)) returnTimeEl.value = b.returnTime;
      if ($newProtection) {
        $newProtection.checked = !!b.hasProtectionPlan;
        if ($dppTierRow) $dppTierRow.style.display = b.hasProtectionPlan ? "block" : "none";
        const ownInsEl = document.getElementById("own-insurance-note");
        if (ownInsEl) ownInsEl.style.display = b.hasProtectionPlan ? "none" : "block";
      }
      if (b.protectionPlanTier) {
        const tierEl = document.getElementById("new-protection-tier");
        if (tierEl && [...tierEl.options].some((o) => o.value === b.protectionPlanTier)) tierEl.value = b.protectionPlanTier;
      }
    }

    if ($docAgreementLink && $docAgreementUnavailable) {
      if (agreementPdfUrl) {
        $docAgreementLink.href = agreementPdfUrl;
        $docAgreementLink.style.display = "";
        $docAgreementUnavailable.style.display = "none";
      } else {
        $docAgreementLink.style.display = "none";
        $docAgreementUnavailable.style.display = "";
      }
    }

    if ($btnDownloadLatestReceipt) {
      const canDownload = !!latestReceiptTransaction;
      $btnDownloadLatestReceipt.setAttribute("aria-disabled", canDownload ? "false" : "true");
    }
    if ($docLatestReceipt && $docLatestReceiptUnavailable) {
      $docLatestReceipt.style.display = latestReceiptTransaction ? "" : "none";
      $docLatestReceiptUnavailable.style.display = latestReceiptTransaction ? "none" : "";
    }
  }

  function renderPaymentPlanSummary(b, balance) {
    const plan = b.paymentPlan || null;
    setText("plan-status-badge", plan ? String(plan.status || "Active").replace(/^./, (c) => c.toUpperCase()) : "No active plan");
    if (!plan) {
      setDisplay("plan-empty-state", true);
      setDisplay("plan-content", false);
      return;
    }

    setDisplay("plan-empty-state", false);
    setDisplay("plan-content", true);

    const totalInstallments = Number(plan.totalInstallments || plan.installments || 0);
    const paidInstallments = Number(plan.paidInstallments || 0);
    const percent = totalInstallments > 0 ? Math.round((paidInstallments / totalInstallments) * 100) : 0;
    const planBanner = document.getElementById("plan-banner");
    const overduePill = document.getElementById("plan-overdue-pill");
    if (planBanner) planBanner.className = `plan-banner${plan.isOverdue ? " is-overdue" : ""}`;
    if (overduePill) overduePill.textContent = plan.isOverdue ? `Overdue by ${plan.overdueDays || 0} day(s)` : "On track";

    setText("plan-progress-text", `${paidInstallments} of ${totalInstallments} installments paid`);
    setText("plan-banner-note", plan.isOverdue
      ? "A payment appears overdue. Please pay today or call support if you need help."
      : "Your next payment information is current and visible below.");
    const planFill = document.getElementById("plan-progress-fill");
    if (planFill) planFill.style.width = `${percent}%`;
    setText("plan-progress-left", `${paidInstallments} paid`);
    setText("plan-progress-right", `${percent}% complete`);
    setText("plan-next-due", formatPlanDate(plan.nextDueDate));
    setText("plan-next-due-note", plan.nextDueDate
      ? (isOverdueDate(plan.nextDueDate) ? "This due date is already past due." : "Upcoming scheduled due date.")
      : "No upcoming due date is currently scheduled.");
    setText("plan-next-amount", plan.nextInstallmentAmount ? fmt(Number(plan.nextInstallmentAmount)) : "–");
    setText("plan-next-amount-note", plan.nextInstallmentNumber
      ? `Installment ${plan.nextInstallmentNumber} is next in your schedule.`
      : "No unpaid installment remains on this plan.");
    setText("plan-remaining-balance", fmt(balance));
    setText("plan-remaining-note", "Remaining balance still visible in renter payment flow.");
    setText("plan-history-summary", `${paidInstallments}/${totalInstallments}`);
    setText("plan-history-note", plan.isOverdue ? "Plan has an overdue installment." : "Plan history is currently on track.");
  }

  function renderLedgerSummary(b, total, paid, balance, overdueAmount) {
    const transactions = Array.isArray(ledgerTransactions) ? ledgerTransactions.slice(0, 6) : [];
    latestReceiptTransaction = findLatestReceiptTransaction(ledgerTransactions);
    const paymentCount = (ledgerTransactions || []).filter((tx) => tx.transaction_type === "payment" && tx.direction === "credit").length;
    const noticeCount = (ledgerTransactions || []).filter((tx) => ["late_fee", "refund", "extension"].includes(tx.transaction_type)).length
      + (overdueAmount > 0 ? 1 : 0);

    setText("history-payment-count", String(paymentCount));
    setText("history-payment-note", paymentCount > 0 ? `${paymentCount} posted payment${paymentCount === 1 ? "" : "s"} on file.` : "No posted renter payments yet.");
    setText("history-notice-count", String(noticeCount));
    setText("history-notice-note", noticeCount > 0 ? "Review recent account activity below." : "You’re all caught up right now.");
    setText("activity-summary-pill", transactions.length > 0 ? `${transactions.length} recent entries` : "Recent activity");

    if (!$activityList || !$activityEmpty) return;
    if (!transactions.length) {
      $activityList.innerHTML = "";
      $activityEmpty.style.display = "block";
      return;
    }

    $activityEmpty.style.display = "none";
    $activityList.innerHTML = transactions.map((tx) => {
      const amount = Number(tx.amount || 0);
      const amountCls = tx.direction === "credit" ? "history-item-amount is-credit" : "history-item-amount is-debit";
      const amountPrefix = tx.direction === "credit" ? "-" : "+";
      return `<div class="history-item">
        <div class="history-item-main">
          <div class="history-item-title">${escapeHtml(transactionTitle(tx))}</div>
          <div class="history-item-meta">${escapeHtml(transactionMeta(tx))}</div>
        </div>
        <div class="${amountCls}">${escapeHtml(amountPrefix + fmt(amount))}</div>
      </div>`;
    }).join("");

    if ($btnDownloadLatestReceipt) {
      const canDownload = !!latestReceiptTransaction;
      $btnDownloadLatestReceipt.setAttribute("aria-disabled", canDownload ? "false" : "true");
      $btnDownloadLatestReceipt.disabled = !canDownload;
    }
    if ($docLatestReceipt) {
      $docLatestReceipt.style.display = latestReceiptTransaction ? "" : "none";
    }
    if ($docLatestReceiptUnavailable) {
      $docLatestReceiptUnavailable.style.display = latestReceiptTransaction ? "none" : "";
    }
  }

  async function loadSupplementalData() {
    if (!booking?.bookingId) return;

    ledgerSummary = null;
    ledgerTransactions = [];
    agreementPdfUrl = null;
    latestReceiptTransaction = null;

    const ledgerPromise = fetch("/api/renter-ledger-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking_id: booking.bookingId }),
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) return null;
        return data;
      })
      .catch(() => null);

    const agreementPromise = fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_agreement_url", token: activeToken }),
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.error) return null;
        return data;
      })
      .catch(() => null);

    const [ledgerData, agreementData] = await Promise.all([ledgerPromise, agreementPromise]);
    if (ledgerData?.summary) {
      ledgerSummary = ledgerData.summary;
      ledgerTransactions = Array.isArray(ledgerData.transactions) ? ledgerData.transactions : [];
    }
    if (agreementData?.url) {
      agreementPdfUrl = agreementData.url;
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
      await loadSupplementalData();
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
      // Close partial payment section if open
      if ($partialSection) $partialSection.style.display = "none";
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
          $btnInitBalance.textContent = `Pay Balance (${fmt(currentBalance || Number(booking?.balanceDue || 0))})`;
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

  // ── Open/close partial payment section ──────────────────────────────────────
  if ($btnOpenPartial) {
    $btnOpenPartial.addEventListener("click", () => {
      if (!$partialSection) return;
      const isVisible = $partialSection.style.display !== "none";
      if (isVisible) {
        $partialSection.style.display = "none";
        return;
      }
      // Close the full balance panel if open
      if ($balanceWrap) $balanceWrap.style.display = "none";

      // Seed the amount input with the current balance
      const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
      if ($partialAmtInput) {
        $partialAmtInput.max   = maxAmt.toFixed(2);
        $partialAmtInput.value = maxAmt.toFixed(2);
      }
      updatePartialPreview();

      // Reset Stripe section
      if ($partialStripeEl) $partialStripeEl.style.display = "none";
      if ($btnConfirmPartial) $btnConfirmPartial.style.display = "none";
      if ($partialError) $partialError.style.display = "none";
      if ($btnInitPartial) { $btnInitPartial.disabled = false; $btnInitPartial.textContent = "Initialize Payment"; }

      $partialSection.style.display = "block";
    });
  }

  function updatePartialPreview() {
    if (!$partialPreview || !$partialAmtInput) return;
    const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
    const val = Math.round(parseFloat($partialAmtInput.value) * 100) / 100;
    if (!Number.isFinite(val) || val <= 0) {
      $partialPreview.textContent = "";
      return;
    }
    if (val > maxAmt) {
      $partialPreview.innerHTML = `<span style="color:#c62828">Amount exceeds remaining balance (${fmt(maxAmt)})</span>`;
      return;
    }
    const remaining = Math.max(0, Math.round((maxAmt - val) * 100) / 100);
    $partialPreview.innerHTML = remaining > 0
      ? `After payment: <strong style="color:#b45309">${fmt(remaining)} still due</strong>`
      : `<span style="color:#2e7d32">✓ Pays balance in full</span>`;
  }

  if ($partialAmtInput) {
    $partialAmtInput.addEventListener("input", updatePartialPreview);
  }

  if ($partialMaxBtn) {
    $partialMaxBtn.addEventListener("click", () => {
      if (!$partialAmtInput) return;
      const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
      $partialAmtInput.value = maxAmt.toFixed(2);
      updatePartialPreview();
    });
  }

  // ── Initialize partial payment ───────────────────────────────────────────────
  if ($btnInitPartial) {
    $btnInitPartial.addEventListener("click", async () => {
      if ($partialError) $partialError.style.display = "none";
      const maxAmt = currentBalance || Number(booking?.balanceDue || 0);
      const requestedAmt = Math.round(parseFloat($partialAmtInput?.value || "0") * 100) / 100;

      if (!Number.isFinite(requestedAmt) || requestedAmt <= 0) {
        if ($partialError) { $partialError.textContent = "Enter a valid payment amount."; $partialError.style.display = "block"; }
        return;
      }
      if (requestedAmt > maxAmt) {
        if ($partialError) { $partialError.textContent = `Amount exceeds remaining balance (${fmt(maxAmt)}).`; $partialError.style.display = "block"; }
        return;
      }

      $btnInitPartial.disabled    = true;
      $btnInitPartial.textContent = "Preparing Payment…";

      // Unmount any previous partial Stripe element
      if (partialPayEl) { try { partialPayEl.unmount(); } catch (_e) { /* ok */ } partialPayEl = null; }
      partialStripe = null; partialElements = null;
      if ($partialStripeEl) $partialStripeEl.innerHTML = "";

      try {
        const isFullBalance = Math.round(requestedAmt * 100) === Math.round(maxAmt * 100);
        const body = { action: "create_balance_payment_intent", token: activeToken };
        if (!isFullBalance) body.payment_amount = requestedAmt;

        const resp = await fetch(API_BASE, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });
        const data = await resp.json();

        if (!resp.ok || !data.clientSecret) {
          if ($partialError) { $partialError.textContent = data.error || "Could not initialize payment."; $partialError.style.display = "block"; }
          return;
        }
        if (typeof Stripe === "undefined") { // eslint-disable-line no-undef
          if ($partialError) { $partialError.textContent = "Payment library failed to load. Please refresh."; $partialError.style.display = "block"; }
          return;
        }

        partialStripe   = Stripe(data.publishableKey); // eslint-disable-line no-undef
        partialElements = partialStripe.elements({ clientSecret: data.clientSecret });
        partialPayEl    = partialElements.create("payment", {
          fields: { billingDetails: { name: "never" } },
        });
        if ($partialStripeEl) {
          $partialStripeEl.style.display = "block";
          partialPayEl.mount($partialStripeEl);
        }
        const payAmt = Number(data.paymentAmount || requestedAmt);
        if ($btnConfirmPartial) {
          $btnConfirmPartial.textContent = `Pay ${fmt(payAmt)}`;
          $btnConfirmPartial.style.display = "";
          $btnConfirmPartial.disabled = false;
        }
        // Disable amount inputs while payment is initialized
        if ($partialAmtInput) $partialAmtInput.disabled = true;
        if ($partialMaxBtn) $partialMaxBtn.disabled = true;
      } catch (err) {
        if ($partialError) { $partialError.textContent = "Network error. Please try again."; $partialError.style.display = "block"; }
        console.error("[manage-booking] partial init error:", err);
      } finally {
        if ($btnInitPartial) { $btnInitPartial.disabled = false; $btnInitPartial.textContent = "Initialize Payment"; }
      }
    });
  }

  // ── Confirm partial payment ──────────────────────────────────────────────────
  if ($btnConfirmPartial) {
    $btnConfirmPartial.addEventListener("click", async () => {
      if (!partialStripe || !partialElements) return;
      $btnConfirmPartial.disabled    = true;
      $btnConfirmPartial.textContent = "Processing…";
      if ($partialError) $partialError.style.display = "none";

      try {
        const result = await partialStripe.confirmPayment({
          elements: partialElements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (result.error) {
          if ($partialError) { $partialError.textContent = result.error.message || "Payment failed. Please try again."; $partialError.style.display = "block"; }
          return;
        }
        if (result.paymentIntent?.status === "succeeded") {
          setActionMsg("✅ Payment received. Updating your booking…", "success", document.getElementById("action-msg-finance"));
          setTimeout(() => window.location.reload(), PAYMENT_SUCCESS_RELOAD_DELAY_MS);
        }
      } catch (err) {
        if ($partialError) { $partialError.textContent = "Payment failed. Please try again."; $partialError.style.display = "block"; }
        console.error("[manage-booking] partial pay error:", err);
      } finally {
        if ($btnConfirmPartial) { $btnConfirmPartial.disabled = false; $btnConfirmPartial.textContent = "Confirm Payment"; }
      }
    });
  }

  if ($btnViewPlan) {
    $btnViewPlan.addEventListener("click", () => {
      const planCard = document.getElementById("payment-plan-card");
      if (planCard) planCard.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  if ($openRenterChatbot) {
    $openRenterChatbot.addEventListener("click", () => {
      const toggle = document.getElementById("chat-toggle");
      if (toggle) {
        toggle.click();
        return;
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    });
  }

  function handleReceiptDownload() {
    if (!latestReceiptTransaction) return;
    downloadReceiptForTransaction(latestReceiptTransaction);
  }

  if ($btnDownloadLatestReceipt) {
    $btnDownloadLatestReceipt.addEventListener("click", handleReceiptDownload);
  }
  if ($docLatestReceipt) {
    $docLatestReceipt.addEventListener("click", handleReceiptDownload);
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
