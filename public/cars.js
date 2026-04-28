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
// Timezone helpers are provided by la-date.js (loaded before this script).
const SlyLA = window.SlyLA;

// Capture the original data-i18n key for each vehicle's button so that
// re-applying "available" restores the correct per-vehicle label in any language.
const originalBtnI18nKey = {};
carCards.forEach(card => {
  const vehicleId = card.dataset.vehicle;
  if (!vehicleId) return;
  const btn = document.getElementById("select-btn-" + vehicleId);
  if (btn) originalBtnI18nKey[vehicleId] = btn.getAttribute("data-i18n") || "fleet.bookNow";
});

function applyFleetStatus(fleetStatus) {
  const i18n  = window.slyI18n || { t: function(k) { return k; } };

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
      link.href = "car.html?vehicle=" + encodeURIComponent(vehicleId);

      // fleet-status says available = true, so this vehicle is available today
      const todayBadge = document.createElement("span");
      todayBadge.className = "available-today-badge";
      todayBadge.setAttribute("data-i18n", "fleet.availableToday");
      todayBadge.textContent = i18n.t("fleet.availableToday");
      badge.insertAdjacentElement("afterend", todayBadge);
    } else {
      // ── Currently Booked state ──────────────────────────────────────────
      var isReserved = status && status.rental_status === "reserved";
      var badgeKey = isReserved ? "fleet.pendingPickup" : "fleet.currentlyBooked";
      badge.setAttribute("data-i18n", badgeKey);
      badge.textContent = i18n.t(badgeKey);
      badge.className = "status-badge unavailable booked";

      // Prefer available_at (ISO timestamp with buffered end_time) when present;
      // fall back to the pre-built next_available_display string.
      var nextAvailDisplay = status
        ? (SlyLA.formatTimestamp(status.available_at) || status.next_available_display || null)
        : null;
      if (nextAvailDisplay) {
        const nextBadge = document.createElement("span");
        nextBadge.className = "next-available-badge";
        const tpl = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
        nextBadge.textContent = tpl.replace("{date}", nextAvailDisplay);

        // ⓘ icon — tooltip explains the 2-hour preparation buffer
        const infoIcon = document.createElement("span");
        infoIcon.className = "buffer-info-icon";
        infoIcon.textContent = " ⓘ";
        infoIcon.setAttribute("data-tooltip", "Availability includes a 2-hour buffer for cleaning and inspection after each rental.");
        nextBadge.appendChild(infoIcon);

        badge.insertAdjacentElement("afterend", nextBadge);
      }

      if (isReserved) {
        btn.setAttribute("data-i18n", "fleet.completeBooking");
        btn.textContent = i18n.t("fleet.completeBooking") || "✅ Complete Booking";
        link.href = "https://www.slytrans.com/manage-booking.html";
      } else {
        btn.setAttribute("data-i18n", "fleet.extendRental");
        btn.textContent = i18n.t("fleet.extendRental") || "⏱️ Extend Rental";
        link.href = "car.html?vehicle=" + encodeURIComponent(vehicleId);
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
    applyFleetStatus(fleetStatus);
  } catch (err) {
    console.warn("Could not load fleet status:", err);
    // Leave default "Available" badges in place on any error
  }
}

loadFleetStatus();
