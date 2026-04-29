// cars.js — Dynamic fleet page
// Fetches active vehicles from /api/v2-vehicles and live pricing from
// /api/public-pricing, then renders car cards so the admin can add,
// remove, or update vehicles in the admin portal without touching code.

const API_BASE = "https://sly-rides.vercel.app";
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;

// ─── Fleet-status API contract ────────────────────────────────────────────────
// Canonical fields returned per vehicle by api/fleet-status.js.
// If this list drifts from the actual API response, loadFleetStatus() will
// log a console.error immediately so the mismatch is caught during development.
const FLEET_STATUS_EXPECTED_KEYS = ["available", "rental_status", "available_at", "next_available_display"];

function validateFleetStatusShape(fleetStatus) {
  const entries = Object.values(fleetStatus);
  if (!entries.length) return;
  const first = entries[0];
  const missing = FLEET_STATUS_EXPECTED_KEYS.filter(k => !(k in first));
  if (missing.length) {
    console.error(
      "[fleet-status] API response is missing expected fields:", missing,
      "— verify api/fleet-status.js response shape matches FLEET_STATUS_EXPECTED_KEYS in cars.js"
    );
  }
}

// ─── i18n helper ─────────────────────────────────────────────────────────────
function t(key, fallback) {
  try {
    return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t(key) : (fallback || key);
  } catch (_) { return fallback || key; }
}

// ─── Safe HTML escaping ───────────────────────────────────────────────────────
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtMoney(n) {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── Card builders ────────────────────────────────────────────────────────────

function buildEconomyCard(v, pricing) {
  const vid      = esc(v.vehicle_id);
  const name     = esc(v.vehicle_name || v.vehicle_id);
  const img      = esc(v.cover_image || "/images/car1.jpg");
  const subtitle = esc(v.subtitle || t("fleet.sedan5seater", "Sedan • 5 Seater"));
  const scarcity = v.scarcity_text ? `<p class="scarcity-notice">${esc(v.scarcity_text)}</p>` : "";

  const daily    = pricing ? fmtMoney(pricing.economy.daily)    : "$55";
  const weekly   = pricing ? fmtMoney(pricing.economy.weekly)   : "$350";
  const biweekly = pricing ? fmtMoney(pricing.economy.biweekly) : "$650";
  const monthly  = pricing ? fmtMoney(pricing.economy.monthly)  : "$1,300";

  return `<div class="car-card" data-category="economy" data-vehicle="${vid}">
    <img src="${img}" alt="${name}" loading="lazy">
    <div class="car-info">
      <span class="status-badge available" id="status-badge-${vid}" data-i18n="fleet.available">● ${t("fleet.available", "Available")}</span>
      <h3>${name}</h3>
      <p class="car-subtitle" data-i18n="fleet.sedan5seater">${subtitle}</p>
      <div class="rideshare-badges">
        <span class="rideshare-badge" data-i18n="fleet.rideshareReadyBadge">${t("fleet.rideshareReadyBadge", "🚗 Uber &amp; Lyft Ready")}</span>
        <span class="rideshare-badge" data-i18n="fleet.unlimitedMilesBadge">${t("fleet.unlimitedMilesBadge", "∞ Unlimited Miles")}</span>
      </div>
      <p class="price-list-label" data-i18n="fleet.rentalPlans">${t("fleet.rentalPlans", "Rental Plans")}</p>
      <div class="price-list">
        <div class="price-item">${daily} / <span data-i18n="fleet.unitDay">${t("fleet.unitDay", "day")}</span></div>
        <div class="price-item price-item--popular">${weekly} / <span data-i18n="fleet.unitWeek">${t("fleet.unitWeek", "week")}</span> <span class="popular-tag" data-i18n="fleet.mostPopular">${t("fleet.mostPopular", "Most Popular")}</span></div>
        <div class="price-item">${biweekly} / <span data-i18n="fleet.unitBiweek">${t("fleet.unitBiweek", "2 weeks")}</span></div>
        <div class="price-item">${monthly} / <span data-i18n="fleet.unitMonth">${t("fleet.unitMonth", "month")}</span> <span class="best-value-tag" data-i18n="fleet.bestValue">${t("fleet.bestValue", "Best Value")}</span></div>
      </div>
      <div class="earnings-breakdown">
        <p class="earnings-breakdown-title" data-i18n="fleet.driverEarnings">${t("fleet.driverEarnings", "💰 Driver Earnings Example (Los Angeles)")}</p>
        <ul class="earnings-breakdown-list">
          <li><span data-i18n="fleet.earningsLi1">${t("fleet.earningsLi1", "Avg. weekly Uber/Lyft earnings:")}</span> <strong>$1,200 – $1,600</strong></li>
          <li><span data-i18n="fleet.earningsLi2">${t("fleet.earningsLi2", "Weekly rental:")}</span> <strong>${weekly}</strong></li>
          <li><span data-i18n="fleet.earningsLi3">${t("fleet.earningsLi3", "Est. driver take-home:")}</span> <strong>$850 – $1,250</strong></li>
        </ul>
      </div>
      ${scarcity}
      <a href="car.html?vehicle=${vid}" class="select-link" id="select-link-${vid}">
        <button class="select-btn" id="select-btn-${vid}" data-i18n="fleet.bookNow">${t("fleet.bookNow", "Book Now")}</button>
      </a>
    </div>
  </div>`;
}


function buildCardHTML(v, pricing) {
  return buildEconomyCard(v, pricing);
}

// ─── Loading / empty states ───────────────────────────────────────────────────
function showLoadingState(grid) {
  grid.innerHTML = `<div class="fleet-loading">
    <span class="fleet-loading-spinner" aria-hidden="true"></span>
    <span>${t("fleet.loading", "Loading vehicles…")}</span>
  </div>`;
}

// ─── Filter buttons ───────────────────────────────────────────────────────────
function setupFilters() {
  document.querySelectorAll(".sidebar-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      document.querySelectorAll("#car-grid .car-card").forEach(card => {
        card.style.display = (filter === "all" || card.dataset.category === filter) ? "" : "none";
      });
    });
  });
}

// ─── Fleet status & availability badges ──────────────────────────────────────
// Keyed by vehicleId so applyFleetStatus can restore the original i18n key.
const originalBtnI18nKey = {};

function captureButtonKeys() {
  document.querySelectorAll("#car-grid .car-card").forEach(card => {
    const vid = card.dataset.vehicle;
    if (!vid) return;
    const btn = document.getElementById("select-btn-" + vid);
    if (btn) originalBtnI18nKey[vid] = btn.getAttribute("data-i18n") || "fleet.bookNow";
  });
}

function applyFleetStatus(fleetStatus) {
  const i18n = window.slyI18n || { t: k => k };

  document.querySelectorAll("#car-grid .car-card").forEach(card => {
    const vid = card.dataset.vehicle;
    if (!vid) return;

    const badge = document.getElementById("status-badge-" + vid);
    const btn   = document.getElementById("select-btn-" + vid);
    const link  = document.getElementById("select-link-" + vid);
    if (!badge || !btn || !link) return;

    const status    = fleetStatus[vid];
    const available = status ? status.available !== false : true;

    card.querySelector(".available-today-badge")?.remove();
    card.querySelector(".next-available-badge")?.remove();

    if (available) {
      const i18nKey = originalBtnI18nKey[vid] || "fleet.bookNow";
      badge.setAttribute("data-i18n", "fleet.available");
      badge.textContent = i18n.t("fleet.available");
      badge.className   = "status-badge available";

      btn.setAttribute("data-i18n", i18nKey);
      btn.textContent = i18n.t(i18nKey);
      btn.disabled = false;
      btn.style.display = "";
      btn.classList.remove("btn-booked");
      link.style.pointerEvents = "";
      link.href = `car.html?vehicle=${encodeURIComponent(vid)}`;

      const todayBadge = document.createElement("span");
      todayBadge.className = "available-today-badge";
      todayBadge.setAttribute("data-i18n", "fleet.availableToday");
      todayBadge.textContent = i18n.t("fleet.availableToday");
      badge.insertAdjacentElement("afterend", todayBadge);
    } else {
      const isReserved = status && status.rental_status === "reserved";
      const badgeKey = isReserved ? "fleet.pendingPickup" : "fleet.currentlyBooked";
      badge.setAttribute("data-i18n", badgeKey);
      badge.textContent = i18n.t(badgeKey);
      badge.className   = "status-badge unavailable booked";

      // Prefer available_at (timestamp with time) when available;
      // fall back to the date-only next_available_display string.
      const nextAvailDisplay = status
        ? (SlyLA.formatTimestamp(status.available_at) || status.next_available_display || null)
        : null;
      if (nextAvailDisplay) {
        const nextBadge = document.createElement("span");
        nextBadge.className = "next-available-badge";
        const tpl = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
        nextBadge.textContent = tpl.replace("{date}", nextAvailDisplay);
        badge.insertAdjacentElement("afterend", nextBadge);
      }

      if (isReserved) {
        btn.setAttribute("data-i18n", "fleet.completeBooking");
        btn.textContent = i18n.t("fleet.completeBooking") || "✅ Complete Booking";
        link.href = "https://www.slytrans.com/manage-booking.html";
      } else {
        btn.setAttribute("data-i18n", "fleet.extendRental");
        btn.textContent = i18n.t("fleet.extendRental") || "⏱️ Extend Rental";
        link.href = `car.html?vehicle=${encodeURIComponent(vid)}`;
      }
      btn.disabled = false;
      btn.style.display = "";
      btn.classList.add("btn-booked");
      link.style.pointerEvents = "";
    }
  });
}

async function loadFleetStatus() {
  try {
    const fleetRes = await fetch(API_BASE + "/api/fleet-status");
    const fleetStatus = fleetRes.ok ? await fleetRes.json() : {};
    validateFleetStatusShape(fleetStatus);
    applyFleetStatus(fleetStatus);
  } catch (err) {
    console.warn("Could not load fleet status:", err);
  }
}


  // Fetch and apply live availability badges
  loadFleetStatus();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
setupFilters();
loadFleet();
