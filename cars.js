const API_BASE = "https://sly-rides.vercel.app";

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

// Returns the latest return date (YYYY-MM-DD) among ranges that overlap today,
// or null if none are active right now.
function activeUntil(ranges) {
  const todayStr = new Date().toISOString().slice(0, 10);
  let latest = null;
  ranges.forEach(function (r) {
    if (r.from <= todayStr && todayStr <= r.to) {
      if (!latest || r.to > latest) latest = r.to;
    }
  });
  return latest;
}

// Format YYYY-MM-DD → "Mar 15"
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Fetch booked dates and add an "In Use Until …" badge to currently-booked cards.
(async function updateAvailability() {
  try {
    const resp = await fetch(API_BASE + "/api/booked-dates");
    if (!resp.ok) return;
    const data = await resp.json();

    carCards.forEach(function (card) {
      const vehicleId = card.dataset.vehicle;
      if (!vehicleId || !data[vehicleId]) return;

      const until = activeUntil(data[vehicleId]);
      if (!until) return;

      card.classList.add("car-in-use");

      const badge = document.createElement("span");
      badge.className = "car-in-use-badge";
      badge.textContent = "In Use Until " + fmtDate(until);
      card.insertBefore(badge, card.firstChild);
    });
  } catch (e) {
    // Silently ignore — don't break the page if the API is unreachable
  }
})();
