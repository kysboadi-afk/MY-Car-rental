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
    const ranges = ((bookedDates[vehicleId] || []).filter(function(r) {
      return r && r.from && r.to;
    }).slice().sort(function(a, b) {
      return a.from < b.from ? -1 : 1;
    }));
    if (!ranges.length) return null;

    var merged = [];
    for (var rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
      var previousRange = merged[merged.length - 1];
      var currentRange = ranges[rangeIndex];
      if (!previousRange) {
        merged.push({ from: currentRange.from, to: currentRange.to });
        continue;
      }
      var previousRangeEndPlusOne = new Date(previousRange.to + "T00:00:00");
      previousRangeEndPlusOne.setDate(previousRangeEndPlusOne.getDate() + 1);
      var previousRangeEndPlusOneISO = previousRangeEndPlusOne.toISOString().slice(0, 10);
      if (currentRange.from <= previousRangeEndPlusOneISO) {
        if (currentRange.to > previousRange.to) previousRange.to = currentRange.to;
      } else {
        merged.push({ from: currentRange.from, to: currentRange.to });
      }
    }

    for (var mergedIndex = 0; mergedIndex < merged.length; mergedIndex++) {
      if (merged[mergedIndex].from <= today && today <= merged[mergedIndex].to) {
        const nextAvailableDate = new Date(merged[mergedIndex].to + "T00:00:00");
        nextAvailableDate.setDate(nextAvailableDate.getDate() + 1);
        return nextAvailableDate.toISOString().slice(0, 10);
      }
    }

    for (var upcomingIndex = 0; upcomingIndex < merged.length; upcomingIndex++) {
      if (merged[upcomingIndex].from > today) {
        const nextAvailableDate = new Date(merged[upcomingIndex].to + "T00:00:00");
        nextAvailableDate.setDate(nextAvailableDate.getDate() + 1);
        return nextAvailableDate.toISOString().slice(0, 10);
      }
    }

    var latestExpired = merged[merged.length - 1];
    if (latestExpired) {
      const nextAvailableDate = new Date(latestExpired.to + "T00:00:00");
      nextAvailableDate.setDate(nextAvailableDate.getDate() + 1);
      return nextAvailableDate.toISOString().slice(0, 10);
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
        const availDateISO = availDate.toISOString().slice(0, 10);
        if (availDateISO === today) {
          const timeStr = availDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          nextBadge.textContent = "Available Today at " + timeStr;
        } else {
          const formatted2 = availDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          const tpl2 = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
          nextBadge.textContent = tpl2.replace("{date}", formatted2);
        }
      } else {
        const nextISO = getNextAvailDate(vehicleId);
        if (nextISO) {
          const d = new Date(nextISO + "T00:00:00");
          const formatted = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
    // Leave default "Available" badges in place on any error
  }
}

loadFleetStatus();
