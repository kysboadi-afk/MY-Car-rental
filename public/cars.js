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

function isBookedToday(ranges) {
  const today = SlyLA.todayISO();
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
  const today = SlyLA.todayISO();

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
      var previousRangeEndPlusOneISO = SlyLA.addDaysToISO(previousRange.to, 1);
      if (currentRange.from <= previousRangeEndPlusOneISO) {
        if (currentRange.to > previousRange.to) previousRange.to = currentRange.to;
      } else {
        merged.push({ from: currentRange.from, to: currentRange.to });
      }
    }

    for (var mergedIndex = 0; mergedIndex < merged.length; mergedIndex++) {
      if (merged[mergedIndex].from <= today && today <= merged[mergedIndex].to) {
        return SlyLA.addDaysToISO(merged[mergedIndex].to, 1);
      }
    }

    for (var upcomingIndex = 0; upcomingIndex < merged.length; upcomingIndex++) {
      if (merged[upcomingIndex].from > today) {
        return SlyLA.addDaysToISO(merged[upcomingIndex].to, 1);
      }
    }

    var latestExpired = merged[merged.length - 1];
    if (latestExpired) {
      return SlyLA.addDaysToISO(latestExpired.to, 1);
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
      link.href = "car.html?vehicle=" + encodeURIComponent(vehicleId);

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
      var isReserved = status && status.rental_status === "reserved";
      var badgeKey = isReserved ? "fleet.pendingPickup" : "fleet.currentlyBooked";
      badge.setAttribute("data-i18n", badgeKey);
      badge.textContent = i18n.t(badgeKey);
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
          if (availDateISO === today) {
            nextBadge.textContent = "Available Today at " + timeStr;
          } else {
            const formatted2 = availDate.toLocaleDateString("en-US", {
              timeZone: SlyLA.tz,
              month: "short",
              day: "numeric",
              year: "numeric"
            });
            const tpl2 = i18n.t("fleet.nextAvailable") || "Next Available: {date}";
            nextBadge.textContent = tpl2.replace("{date}", formatted2 + " at " + timeStr);
          }
        }
      } else {
        const nextISO = getNextAvailDate(vehicleId);
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

      if (isReserved) {
        btn.setAttribute("data-i18n", "fleet.completeBooking");
        btn.textContent = i18n.t("fleet.completeBooking") || "✅ Complete Booking";
        link.href = "manage-booking.html";
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
