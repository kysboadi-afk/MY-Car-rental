// slingshots.js — Slingshot fleet page
// Fetches active slingshot vehicles from /api/v2-vehicles and live pricing from
// /api/public-pricing, then renders a card per vehicle so each slingshot can
// be booked individually via the standard car.html booking flow (Stripe).

const API_BASE = "https://sly-rides.vercel.app";
const SlyLA = window.SlyLA;

// ─── Fleet-status API contract ────────────────────────────────────────────────
const FLEET_STATUS_EXPECTED_KEYS = ["available", "rental_status", "available_at", "next_available_display"];

function validateFleetStatusShape(fleetStatus) {
  const entries = Object.values(fleetStatus);
  if (!entries.length) return;
  const first = entries[0];
  const missing = FLEET_STATUS_EXPECTED_KEYS.filter(k => !(k in first));
  if (missing.length) {
    console.error(
      "[fleet-status] API response is missing expected fields:", missing,
      "— verify api/fleet-status.js response shape matches FLEET_STATUS_EXPECTED_KEYS in slingshots.js"
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

// ─── Card builder ─────────────────────────────────────────────────────────────

// Default hourly tiers shown when a slingshot vehicle has no hourlyTiers data.
const DEFAULT_SLINGSHOT_TIERS = [
  { label: "2 Hours",   price: 150, popular: false },
  { label: "3 Hours",   price: 200, popular: true  },
  { label: "6 Hours",   price: 250, popular: false },
  { label: "24 Hours",  price: 350, popular: false },
];

// Derive a display-ready tier list from a vehicle's hourlyTiers map.
// Returns [{label, price, popular}] sorted by ascending hour count.
function getSlingshotTiers(v) {
  const raw = v.hourlyTiers;
  if (!raw || typeof raw !== "object" || !Object.keys(raw).length) {
    return DEFAULT_SLINGSHOT_TIERS;
  }
  const entries = Object.values(raw)
    .filter(t => t && t.label && t.price != null)
    .sort((a, b) => (a.hours || 0) - (b.hours || 0));
  if (!entries.length) return DEFAULT_SLINGSHOT_TIERS;
  // Mark the second entry (index 1) as "Most Popular" to highlight the 3-hour tier.
  return entries.map((t, i) => ({ label: t.label, price: t.price, popular: i === 1 }));
}

function buildSlingshotCard(v, pricing) {
  const vid      = esc(v.vehicle_id);
  const name     = esc(v.vehicle_name || v.vehicle_id);
  const img      = esc(v.cover_image || "/images/slingshot.jpg");
  const subtitle = esc(v.subtitle || "3-Wheeler \u2022 Open-Air");
  const scarcity = v.scarcity_text ? `<p class="scarcity-notice">${esc(v.scarcity_text)}</p>` : "";

  const tiers = getSlingshotTiers(v);
  const tierHtml = tiers.map(t => {
    const amt = fmtMoney(t.price);
    const lbl = esc(t.label);
    if (t.popular) {
      return `<div class="price-item price-item--popular">${amt} / ${lbl} <span class="popular-tag">Most Popular</span></div>`;
    }
    return `<div class="price-item">${amt} / ${lbl}</div>`;
  }).join("");

  return `<div class="car-card" data-category="slingshot" data-vehicle="${vid}">
    <img src="${img}" alt="${name}" loading="lazy">
    <div class="car-info">
      <span class="status-badge available" id="status-badge-${vid}">&#9679; Available</span>
      <h3>${name}</h3>
      <p class="car-subtitle">${subtitle}</p>
      <div class="rideshare-badges">
        <span class="rideshare-badge">&#127937; Thrill Ride</span>
        <span class="rideshare-badge">&#127804; Scenic Cruising</span>
      </div>
      <p class="price-list-label">Rental Plans</p>
      <div class="price-list">
        ${tierHtml}
      </div>
      ${scarcity}
      <a href="car.html?vehicle=${vid}" class="select-link" id="select-link-${vid}">
        <button class="select-btn" id="select-btn-${vid}">Book Now</button>
      </a>
    </div>
  </div>`;
}

// ─── Loading / empty states ───────────────────────────────────────────────────
function showLoadingState(grid) {
  grid.innerHTML = `<div class="fleet-loading">
    <span class="fleet-loading-spinner" aria-hidden="true"></span>
    <span>Loading slingshots&hellip;</span>
  </div>`;
}

// ─── Fleet status & availability badges ──────────────────────────────────────
const originalBtnI18nKey = {};

function captureButtonKeys() {
  document.querySelectorAll("#slingshot-grid .car-card").forEach(card => {
    const vid = card.dataset.vehicle;
    if (!vid) return;
    const btn = document.getElementById("select-btn-" + vid);
    if (btn) originalBtnI18nKey[vid] = btn.getAttribute("data-i18n") || "fleet.bookNow";
  });
}

function applyFleetStatus(fleetStatus) {
  document.querySelectorAll("#slingshot-grid .car-card").forEach(card => {
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
      badge.textContent = "\u25CF Available";
      badge.className   = "status-badge available";

      btn.textContent = "Book Now";
      btn.disabled = false;
      btn.style.display = "";
      btn.classList.remove("btn-booked");
      link.style.pointerEvents = "";
      link.href = `car.html?vehicle=${encodeURIComponent(vid)}`;

      const todayBadge = document.createElement("span");
      todayBadge.className = "available-today-badge";
      todayBadge.textContent = "Available Today";
      badge.insertAdjacentElement("afterend", todayBadge);
    } else {
      const isReserved = status && status.rental_status === "reserved";
      badge.textContent = isReserved ? "Pending Pickup" : "Currently Booked";
      badge.className   = "status-badge unavailable booked";

      const nextAvailDisplay = status
        ? (SlyLA.formatTimestamp(status.available_at) || status.next_available_display || null)
        : null;
      if (nextAvailDisplay) {
        const nextBadge = document.createElement("span");
        nextBadge.className = "next-available-badge";
        nextBadge.textContent = `Next Available: ${nextAvailDisplay}`;
        badge.insertAdjacentElement("afterend", nextBadge);
      }

      if (isReserved) {
        btn.textContent = "\u2705 Complete Booking";
        link.href = "https://www.slytrans.com/manage-booking.html";
      } else {
        btn.textContent = "\u23F1\uFE0F Extend Rental";
        link.href = `car.html?vehicle=${encodeURIComponent(vid)}&extend=1`;
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

// ─── Fleet loader ─────────────────────────────────────────────────────────────
async function loadSlingshotFleet() {
  const grid = document.getElementById("slingshot-grid");
  if (!grid) return;

  const hasStaticCards = grid.querySelector(".car-card");
  if (!hasStaticCards) showLoadingState(grid);

  let vehicles = [];
  let pricing  = null;

  try {
    const [vRes, pRes] = await Promise.all([
      fetch(API_BASE + "/api/v2-vehicles?scope=slingshot"),
      fetch(API_BASE + "/api/public-pricing"),
    ]);
    if (vRes.ok) vehicles = await vRes.json();
    if (pRes.ok) pricing  = await pRes.json();
  } catch (err) {
    console.warn("Could not load slingshot fleet data:", err);
  }

  const active = (Array.isArray(vehicles) ? vehicles : []).filter(v => {
    if (v.status && v.status !== "active") return false;
    const cat = (v.category || "").toLowerCase();
    if (!cat || (cat !== "car" && cat !== "slingshot")) {
      console.error("[slingshots.js] Vehicle skipped — missing or invalid category:", v.vehicle_id, cat || "(none)");
      return false;
    }
    return cat === "slingshot";
  });

  if (!active.length) {
    if (!grid.querySelector(".car-card")) {
      grid.innerHTML = `<p class="fleet-empty">No slingshots available at this time. Please check back soon.</p>`;
    }
    return;
  }

  grid.innerHTML = active.map(v => buildSlingshotCard(v, pricing)).join("");
  captureButtonKeys();
  loadFleetStatus();
}

loadSlingshotFleet();
