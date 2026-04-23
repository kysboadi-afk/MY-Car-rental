// cars.js — Dynamic fleet page
// Fetches active vehicles from /api/v2-vehicles and live pricing from
// /api/public-pricing, then renders car cards so the admin can add,
// remove, or update vehicles in the admin portal without touching code.

const API_BASE = "https://sly-rides.vercel.app";
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;

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

function isBookedToday(ranges) {
  const today = SlyLA.todayISO();
  return (ranges || []).some(r => today >= r.from && today <= r.to);
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

function buildSlingshotCard(v, pricing) {
  const vid  = esc(v.vehicle_id);
  const name = esc(v.vehicle_name || v.vehicle_id);
  const img  = esc(v.cover_image || "/images/slingshot.jpg");

  const r3h  = pricing ? fmtMoney(pricing.slingshot["3hr"])  : "$200";
  const r6h  = pricing ? fmtMoney(pricing.slingshot["6hr"])  : "$250";
  const r24h = pricing ? fmtMoney(pricing.slingshot["24hr"]) : "$350";
  const dep  = pricing ? fmtMoney(pricing.slingshot.booking_deposit)  : "$50";
  const sec  = pricing ? fmtMoney(pricing.slingshot.security_deposit) : "$150";

  return `<div class="car-card" data-category="slingshot" data-vehicle="${vid}">
    <img src="${img}" alt="${name}" loading="lazy">
    <div class="car-info">
      <span class="status-badge available" id="status-badge-${vid}" data-i18n="fleet.available">● ${t("fleet.available", "Available")}</span>
      <h3>${name}</h3>
      <p class="car-subtitle">Sports 2-Seater</p>
      <p class="price-list-label" data-i18n="fleet.rentalPlans">${t("fleet.rentalPlans", "Rental Plans")}</p>
      <div class="price-list">
        <div class="price-item">${r3h} / 3 hrs</div>
        <div class="price-item price-item--popular">${r6h} / 6 hrs <span class="popular-tag" data-i18n="fleet.mostPopular">${t("fleet.mostPopular", "Most Popular")}</span></div>
        <div class="price-item">${r24h} / 24 hrs</div>
      </div>
      <p class="scarcity-notice">🔒 ${dep} booking deposit · ${sec} security deposit at pickup</p>
      <a href="car.html?vehicle=${vid}" class="select-link" id="select-link-${vid}">
        <button class="select-btn" id="select-btn-${vid}" data-i18n="fleet.bookNow">${t("fleet.bookNow", "Book Now")}</button>
      </a>
    </div>
  </div>`;
}

function buildCardHTML(v, pricing) {
  return v.type === "slingshot" ? buildSlingshotCard(v, pricing) : buildEconomyCard(v, pricing);
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

function getNextAvailDate(vehicleId, bookedDates) {
  const today = SlyLA.todayISO();
  const ranges = (bookedDates[vehicleId] || [])
    .filter(r => r && r.from && r.to)
    .slice()
    .sort((a, b) => a.from < b.from ? -1 : 1);
  if (!ranges.length) return null;

  const merged = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ from: r.from, to: r.to });
      continue;
    }
    const prevEndISO = SlyLA.addDaysToISO(prev.to, 1); // treat back-to-back ranges as continuous
    if (r.from <= prevEndISO) {
      if (r.to > prev.to) prev.to = r.to;
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }

  // 1) If currently inside a merged block, next available is after its end.
  for (const r of merged) {
    if (r.from <= today && today <= r.to) {
      return SlyLA.addDaysToISO(r.to, 1);
    }
  }

  // 2) If currently before an upcoming merged block while fleet says unavailable,
  //    show availability after that upcoming reserved block.
  const upcoming = merged.find(r => r.from > today);
  if (upcoming) {
    return SlyLA.addDaysToISO(upcoming.to, 1);
  }

  // 3) Fallback for stale status with only past ranges.
  const latestExpired = merged[merged.length - 1];
  if (latestExpired) {
    return SlyLA.addDaysToISO(latestExpired.to, 1);
  }
  return null;
}

function applyFleetStatus(fleetStatus, bookedDates) {
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

      if (!isBookedToday(bookedDates[vid])) {
        const todayBadge = document.createElement("span");
        todayBadge.className = "available-today-badge";
        todayBadge.setAttribute("data-i18n", "fleet.availableToday");
        todayBadge.textContent = i18n.t("fleet.availableToday");
        badge.insertAdjacentElement("afterend", todayBadge);
      }
    } else {
      badge.setAttribute("data-i18n", "fleet.currentlyBooked");
      badge.textContent = i18n.t("fleet.currentlyBooked");
      badge.className   = "status-badge unavailable booked";

      // Build the "Next Available" badge, using time-aware data when present.
      // If fleet-status returned available_at (ISO timestamp):
      //   • Same day  → "Available Today at HH:MM"
      //   • Future day → "Next Available: [date]" using that date
      // Else fall back to the date-only getNextAvailDate logic (blocked_dates).
      const availableAt = status ? status.available_at : null;
      const nextBadge = document.createElement("span");
      nextBadge.className = "next-available-badge";

      const availDate = availableAt ? new Date(availableAt) : null;
      const hasValidAvailableAt = !!(availDate && Number.isFinite(availDate.getTime()));

      if (hasValidAvailableAt) {
        const nowMs = Date.now();
        if (availDate.getTime() <= nowMs) {
          // Return time is already in the past — just say "Available Today"
          nextBadge.textContent = "Available Today";
        } else {
          const availDateISO = SlyLA.isoDateInLA(availDate);
          const timeStr = availDate.toLocaleTimeString("en-US", {
            timeZone: SlyLA.tz,
            hour: "numeric",
            minute: "2-digit",
            hour12: true
          });
          if (availDateISO === SlyLA.todayISO()) {
            nextBadge.textContent = `Available Today at ${timeStr}`;
          } else {
            const formatted = availDate.toLocaleDateString("en-US", {
              timeZone: SlyLA.tz,
              month: "short",
              day: "numeric",
              year: "numeric"
            });
            const tpl = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
            nextBadge.textContent = tpl.replace("{date}", `${formatted} at ${timeStr}`);
          }
        }
      } else {
        const nextISO = getNextAvailDate(vid, bookedDates);
        if (nextISO) {
          const d = new Date(nextISO + "T00:00:00");
          const formatted = d.toLocaleDateString("en-US", {
            timeZone: SlyLA.tz,
            month: "short",
            day: "numeric",
            year: "numeric"
          });
          const tpl = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
          nextBadge.textContent = tpl.replace("{date}", formatted);
        }
      }

      if (nextBadge.textContent) {
        badge.insertAdjacentElement("afterend", nextBadge);
      }

      btn.setAttribute("data-i18n", "fleet.extendRental");
      btn.textContent = i18n.t("fleet.extendRental") || "⏱️ Extend Rental";
      btn.disabled = false;
      btn.style.display = "";
      btn.classList.add("btn-booked");
      link.style.pointerEvents = "";
    }
  });
}

async function loadFleetStatus() {
  try {
    const [fleetRes, bookedRes] = await Promise.all([
      fetch(API_BASE + "/api/fleet-status"),
      fetch(API_BASE + "/api/booked-dates"),
    ]);
    const fleetStatus = fleetRes.ok ? await fleetRes.json() : {};
    const bookedDates = bookedRes.ok ? await bookedRes.json() : {};
    applyFleetStatus(fleetStatus, bookedDates);
  } catch (err) {
    console.warn("Could not load fleet status:", err);
  }
}

// ─── Rideshare info section visibility ───────────────────────────────────────
// Sections only relevant to rideshare/economy vehicles (not Slingshot rentals).
const rideshareOnlySections = [
  document.querySelector(".why-drivers-section"),
  document.querySelector(".fleet-cta-section"),
];

function updateRideshareVisibility(vehicles) {
  const hasEconomy = vehicles.some(v => v.type !== "slingshot");
  rideshareOnlySections.forEach(el => {
    if (el) el.style.display = hasEconomy ? "" : "none";
  });
}

// ─── Main fleet loader ────────────────────────────────────────────────────────
async function loadFleet() {
  const grid = document.getElementById("car-grid");
  if (!grid) return;

  showLoadingState(grid);

  const [vehiclesResult, pricingResult] = await Promise.allSettled([
    fetch(API_BASE + "/api/v2-vehicles").then(r => r.ok ? r.json() : []),
    fetch(API_BASE + "/api/public-pricing").then(r => r.ok ? r.json() : null),
  ]);

  const vehicles = vehiclesResult.status === "fulfilled" ? (vehiclesResult.value || []) : [];
  const pricing  = pricingResult.status  === "fulfilled" ? pricingResult.value           : null;

  // Only render vehicles the admin has marked as active.
  // Vehicles with rental_status "rented"/"reserved" are kept in the grid but
  // shown as "Currently Booked" by applyFleetStatus — they must NOT be hidden
  // here or the "Extend Rental" button and "Next Available" badge disappear.
  const active = vehicles
    .filter(v => !v.status || v.status === "active")
    .sort((a, b) => {
      // Slingshot first, then economy, then anything else
      const VEHICLE_TYPE_ORDER = { slingshot: 0, economy: 1 };
      const ao = VEHICLE_TYPE_ORDER[a.type] ?? 2;
      const bo = VEHICLE_TYPE_ORDER[b.type] ?? 2;
      if (ao !== bo) return ao - bo;
      // Within same type: use display_order if set, then vehicle_id alphabetically
      const da = a.display_order ?? 999;
      const db = b.display_order ?? 999;
      return da !== db ? da - db : (a.vehicle_id < b.vehicle_id ? -1 : 1);
    });

  if (!active.length) {
    grid.innerHTML = `<p class="fleet-empty">No vehicles currently available. Please check back soon or <a href="tel:+12139166606">call (213) 916-6606</a>.</p>`;
    return;
  }

  grid.innerHTML = active.map(v => buildCardHTML(v, pricing)).join("");

  // Capture current i18n keys so applyFleetStatus can restore them correctly
  captureButtonKeys();

  // Hide rideshare-specific sections if no economy vehicles are present
  updateRideshareVisibility(active);

  // Fetch and apply live availability badges
  loadFleetStatus();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
setupFilters();
loadFleet();
