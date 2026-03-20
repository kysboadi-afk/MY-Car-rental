// ─── Filter buttons ───────────────────────────────────────────────────────────

const filterBtns = document.querySelectorAll('.sidebar-btn');
const carCards = document.querySelectorAll('#car-grid .car-card');

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const filter = btn.dataset.filter;
    carCards.forEach(card => {
      if (filter === 'all' || card.dataset.category === filter) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });
  });
});

// ----- Fleet Status & Availability -----
const API_BASE = "https://sly-rides.vercel.app";

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function isBookedToday(ranges) {
  const today = todayISO();
  return (ranges || []).some(r => today >= r.from && today <= r.to);
}

// Capture the original data-i18n key for each vehicle's button so that
// re-applying "available" restores the correct per-vehicle label in any language
// (e.g. "fleet.reserveVehicle" for Camry vs "fleet.bookNow" for Slingshot).
const originalBtnI18nKey = {};
carCards.forEach(card => {
  const vehicleId = card.dataset.vehicle;
  if (!vehicleId) return;
  const btn = document.getElementById("select-btn-" + vehicleId);
  if (btn) originalBtnI18nKey[vehicleId] = btn.getAttribute("data-i18n") || "fleet.bookNow";
});

function applyFleetStatus(fleetStatus, bookedDates) {
  const i18n = window.slyI18n || { t: function(k) { return k; } };
  carCards.forEach(card => {
    const vehicleId = card.dataset.vehicle;
    if (!vehicleId) return;

    const badge   = document.getElementById("status-badge-" + vehicleId);
    const btn     = document.getElementById("select-btn-" + vehicleId);
    const link    = document.getElementById("select-link-" + vehicleId);
    if (!badge || !btn || !link) return;

    const status = fleetStatus[vehicleId];
    const available = status ? status.available !== false : true;

    // Remove old today-badge if re-applying
    const oldTodayBadge = card.querySelector(".available-today-badge");
    if (oldTodayBadge) oldTodayBadge.remove();

    if (available) {
      const i18nKey = originalBtnI18nKey[vehicleId] || "fleet.bookNow";
      badge.setAttribute("data-i18n", "fleet.available");
      badge.textContent = i18n.t("fleet.available");
      badge.className = "status-badge available";

      btn.setAttribute("data-i18n", i18nKey);
      btn.textContent = i18n.t(i18nKey);
      btn.disabled = false;
      btn.classList.remove("btn-booked");
      link.style.pointerEvents = "";

      // "Available Today" badge — only when today is not blocked
      const bookedToday = isBookedToday(bookedDates[vehicleId]);
      if (!bookedToday) {
        const todayBadge = document.createElement("span");
        todayBadge.className = "available-today-badge";
        todayBadge.setAttribute("data-i18n", "fleet.availableToday");
        todayBadge.textContent = i18n.t("fleet.availableToday");
        badge.insertAdjacentElement("afterend", todayBadge);
      }
    } else {
      badge.setAttribute("data-i18n", "fleet.unavailable");
      badge.textContent = i18n.t("fleet.unavailable");
      badge.className = "status-badge unavailable";

      btn.setAttribute("data-i18n", "fleet.booked");
      btn.textContent = i18n.t("fleet.booked");
      btn.disabled = true;
      btn.classList.add("btn-booked");
      link.style.pointerEvents = "none";
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
    // Leave default "Available" badges in place on any error
  }
}

loadFleetStatus();
