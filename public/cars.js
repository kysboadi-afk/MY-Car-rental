// ─── Filter buttons ───────────────────────────────────────────────────────────

const filterBtns = document.querySelectorAll('.sidebar-btn');
const carCards = document.querySelectorAll('#car-grid .car-card');

const rideshareOnlySections = [
  document.querySelector('.why-drivers-section'),
  document.querySelector('.fleet-cta-section'),
];
const slingshotOnlySections = [
  document.getElementById('slingshot-explore-section'),
  document.getElementById('slingshot-why-section'),
];

function applyBottomSections(filter) {
  const isSlingshotOnly = filter === 'slingshot';
  rideshareOnlySections.forEach(el => { if (el) el.style.display = isSlingshotOnly ? 'none' : ''; });
  slingshotOnlySections.forEach(el => { if (el) el.style.display = isSlingshotOnly ? '' : 'none'; });
}

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

    applyBottomSections(filter);
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
// re-applying "available" restores the correct per-vehicle label in any language.
const originalBtnI18nKey = {};
carCards.forEach(card => {
  const vehicleId = card.dataset.vehicle;
  if (!vehicleId) return;
  const btn = document.getElementById("select-btn-" + vehicleId);
  if (btn) originalBtnI18nKey[vehicleId] = btn.getAttribute("data-i18n") || "fleet.bookNow";
});

function applyFleetStatus(fleetStatus, bookedDates) {
  const i18n  = window.slyI18n || { t: function(k) { return k; } };
  const today = new Date().toISOString().slice(0, 10);

  // Helper: find the next available ISO date after the current booking ends
  function getNextAvailDate(vehicleId) {
    const ranges = ((bookedDates[vehicleId] || []).slice().sort(function(a, b) {
      return a.from < b.from ? -1 : 1;
    }));
    for (var i = 0; i < ranges.length; i++) {
      if (ranges[i].from <= today && today <= ranges[i].to) {
        const d = new Date(ranges[i].to + "T00:00:00");
        d.setDate(d.getDate() + 1);
        return d.toISOString().slice(0, 10);
      }
    }
    return null;
  }

  carCards.forEach(card => {
    const vehicleId = card.dataset.vehicle;
    if (!vehicleId) return;

    const badge   = document.getElementById("status-badge-" + vehicleId);
    const btn     = document.getElementById("select-btn-" + vehicleId);
    const link    = document.getElementById("select-link-" + vehicleId);
    if (!badge || !btn || !link) return;

    const status    = fleetStatus[vehicleId];
    const available = status ? status.available !== false : true;

    // Remove old today-badge and next-available badge if re-applying
    const oldTodayBadge = card.querySelector(".available-today-badge");
    if (oldTodayBadge) oldTodayBadge.remove();
    const oldNextBadge = card.querySelector(".next-available-badge");
    if (oldNextBadge) oldNextBadge.remove();

    if (available) {
      const i18nKey = originalBtnI18nKey[vehicleId] || "fleet.bookNow";
      badge.setAttribute("data-i18n", "fleet.available");
      badge.textContent = i18n.t("fleet.available");
      badge.className = "status-badge available";

      btn.setAttribute("data-i18n", i18nKey);
      btn.textContent = i18n.t(i18nKey);
      btn.disabled = false;
      btn.style.display = "";
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
      // ── Currently Booked state ──────────────────────────────────────────
      badge.setAttribute("data-i18n", "fleet.currentlyBooked");
      badge.textContent = i18n.t("fleet.currentlyBooked");
      badge.className = "status-badge unavailable booked";

      // "Next Available: [date]" badge
      const nextISO = getNextAvailDate(vehicleId);
      if (nextISO) {
        const d = new Date(nextISO + "T00:00:00");
        const formatted = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const nextBadge = document.createElement("span");
        nextBadge.className = "next-available-badge";
        const tpl = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
        nextBadge.textContent = tpl.replace("{date}", formatted);
        badge.insertAdjacentElement("afterend", nextBadge);
      }

      btn.style.display = "none";
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

