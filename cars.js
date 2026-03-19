// ─── Approval gate ────────────────────────────────────────────────────────────
// Prevent unapproved visitors from viewing the car grid.  The gate checks the
// "slyApplicant" entry written by apply-modal.js after a successful submission.
(function () {
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem("slyApplicant") || "null"); } catch (_) {}

  // Approval gate temporarily disabled — Twilio setup pending. All visitors may proceed.
  return;

  // ── Build a full-screen overlay that blocks the page content ──────────────
  var isReview  = stored && stored.decision === "review";
  var isDeclined = stored && stored.decision === "declined";

  var icon    = isReview ? "⏳" : "🔒";
  var heading = isReview ? "Application Under Review" : "Approval Required";
  var message = isReview
    ? "Your application is currently under review. Our team will contact you within 24\u00a0hours. You\u2019ll receive an SMS message once you\u2019re approved."
    : "You must complete and be approved through our application process before you can browse or rent a vehicle.";

  var actions =
    '<a href="index.html" class="approval-gate-btn">\u2190 Go Back &amp; Apply</a>' +
    (isReview || isDeclined
      ? '<a href="tel:+12139166606" class="approval-gate-btn-secondary">\uD83D\uDCDE\u00a0Call Us</a>'
      : '');

  var overlay = document.createElement("div");
  overlay.className = "approval-gate-overlay";
  overlay.innerHTML =
    '<div class="approval-gate-box">' +
      '<div class="gate-icon">' + icon + '</div>' +
      '<h2>' + heading + '</h2>' +
      '<p>' + message + '</p>' +
      '<div class="approval-gate-actions">' + actions + '</div>' +
    '</div>';

  // Inject immediately — cars.js runs after the body is in the DOM.
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
}());

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

// Capture the original button label for each vehicle from the HTML before any
// fleet-status override so that re-applying "available" restores the correct
// per-vehicle text (e.g. "Reserve This Vehicle" for Camry vs "Book Now" for Slingshot).
const originalBtnText = {};
carCards.forEach(card => {
  const vehicleId = card.dataset.vehicle;
  if (!vehicleId) return;
  const btn = document.getElementById("select-btn-" + vehicleId);
  if (btn) originalBtnText[vehicleId] = btn.textContent;
});

function applyFleetStatus(fleetStatus, bookedDates) {
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
      badge.textContent = "● Available";
      badge.className = "status-badge available";

      btn.textContent = originalBtnText[vehicleId] || "Book Now";
      btn.disabled = false;
      btn.classList.remove("btn-booked");
      link.style.pointerEvents = "";

      // "Available Today" badge — only when today is not blocked
      const bookedToday = isBookedToday(bookedDates[vehicleId]);
      if (!bookedToday) {
        const todayBadge = document.createElement("span");
        todayBadge.className = "available-today-badge";
        todayBadge.textContent = "✓ Available Today";
        badge.insertAdjacentElement("afterend", todayBadge);
      }
    } else {
      badge.textContent = "● Unavailable";
      badge.className = "status-badge unavailable";

      btn.textContent = "Booked";
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
