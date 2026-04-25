// ===== Sly Transportation Services LLC CHATBOT =====

// Safely escape user-supplied text before embedding it into bot HTML
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Returns true when the chatbot is embedded in a Slingshot-specific page.
// Set window.slyChatbotMode = "slingshot" before loading this script to activate.
function isSlingshotMode() {
  return window.slyChatbotMode === "slingshot";
}

// ── Los Angeles timezone helper ───────────────────────────────────────────────
// SlyLA is provided by la-date.js; if that script wasn't loaded (e.g., on a
// page that only embeds the chatbot widget), define a self-contained fallback.
var SlyLA = window.SlyLA || (function () {
  var TZ = "America/Los_Angeles";
  function isoDateInLA(d) {
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(d instanceof Date ? d : new Date(d || Date.now()));
      var y = (parts.find(function(p){return p.type==="year";})||{}).value;
      var m = (parts.find(function(p){return p.type==="month";})||{}).value;
      var day=(parts.find(function(p){return p.type==="day";})||{}).value;
      return y+"-"+m+"-"+day;
    } catch(_) { return new Date().toISOString().slice(0,10); }
  }
  function addDaysToISO(iso, n) {
    var p = String(iso||"").split("-").map(Number);
    if (!isFinite(p[0])||!isFinite(p[1])||!isFinite(p[2])) return null;
    var dt = new Date(Date.UTC(p[0],p[1]-1,p[2]));
    dt.setUTCDate(dt.getUTCDate()+n);
    return dt.toISOString().slice(0,10);
  }
  return { tz: TZ, todayISO: function(){return isoDateInLA(new Date());},
           isoDateInLA: isoDateInLA, addDaysToISO: addDaysToISO };
}());
var CHATBOT_API_BASE = "https://sly-rides.vercel.app";
var slyFleetStatus  = null;
var slyBookedDates  = null;
var slyChatPricing  = null;

(function fetchChatbotFleetStatus() {
  fetch(CHATBOT_API_BASE + "/api/fleet-status")
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { if (data) slyFleetStatus = data; })
    .catch(function() { /* fail silently — static fallback replies used instead */ });
})();

(function fetchChatbotBookedDates() {
  fetch(CHATBOT_API_BASE + "/api/booked-dates")
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { if (data) slyBookedDates = data; })
    .catch(function() { /* fail silently */ });
})();

(function fetchChatbotPricing() {
  fetch(CHATBOT_API_BASE + "/api/public-pricing")
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { if (data) slyChatPricing = data; })
    .catch(function() { /* fail silently — hardcoded fallbacks used instead */ });
})();

/**
 * Returns live pricing from the API if loaded, otherwise hardcoded fallback.
 * @returns {{ slingshot: {3hr,6hr,24hr,48hr,72hr,booking_deposit},
 *             economy:   {daily,weekly,biweekly,monthly,booking_deposit},
 *             tax_rate:  number }}
 * Note: Slingshot security deposit = rental tier price (no flat security_deposit field).
 */
function getChatPricing() {
  return slyChatPricing || {
    slingshot: { "3hr": 200, "6hr": 250, "24hr": 350, "48hr": 700, "72hr": 1050,
                 booking_deposit: 50 },
    economy:   { daily: 55, weekly: 350, biweekly: 650, monthly: 1300, booking_deposit: 50 },
    tax_rate:  0.1025,
  };
}

var KNOWN_VEHICLE_META = {
  slingshot:  { name: "Slingshot R", icon: "🔴", type: "slingshot" },
  slingshot2: { name: "Slingshot R (Unit 2)", icon: "🔴", type: "slingshot" },
  slingshot3: { name: "Slingshot R (Unit 3)", icon: "🔴", type: "slingshot" },
  camry:      { name: "Camry 2012", icon: "🔵", type: "economy" },
  camry2013:  { name: "Camry 2013 SE", icon: "🟢", type: "economy" }
};
var fleetVehicleIdsCache = { key: "", ids: [] };

function prettifyVehicleId(vehicleId) {
  return String(vehicleId || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function getVehicleMeta(vehicleId) {
  var known = KNOWN_VEHICLE_META[vehicleId];
  if (known) return known;
  var text = String(vehicleId || "").toLowerCase();
  return {
    name: prettifyVehicleId(vehicleId),
    icon: /sling/.test(text) ? "🔴" : "🚗",
    type: /sling/.test(text) ? "slingshot" : "other"
  };
}

function getFleetVehicleIds() {
  var fleetKeys = Object.keys(slyFleetStatus || {}).sort();
  var bookedKeys = Object.keys(slyBookedDates || {}).sort();
  var cacheKey = [fleetKeys.join(","), bookedKeys.join(",")].join("|");
  if (fleetVehicleIdsCache.key === cacheKey) {
    return fleetVehicleIdsCache.ids.slice();
  }

  var seen = {};
  var ids = [];
  function add(id) {
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  }

  Object.keys(KNOWN_VEHICLE_META).forEach(add);
  fleetKeys.forEach(add);
  bookedKeys.forEach(add);

  fleetVehicleIdsCache = { key: cacheKey, ids: ids.slice() };
  return ids;
}

function getSlingshotUnitCount() {
  var count = getFleetVehicleIds().filter(function(id) { return getVehicleMeta(id).type === "slingshot"; }).length;
  return count || 1;
}

/** Build the general pricing message for all vehicles in the given language. */
function buildChatPricingText(lang) {
  var p = getChatPricing(), s = p.slingshot, e = p.economy;
  var slingshotCount = getSlingshotUnitCount();
  // In Slingshot mode only show Slingshot pricing.
  if (isSlingshotMode()) {
    return buildChatSlingshotPricingText(lang);
  }
  if (lang === "es") {
    return "Aquí están nuestras tarifas actuales 🚗\n\n" +
      "🔴 Slingshot R — Deportivo 2 plazas (" + slingshotCount + " unidades disponibles)\n" +
      "  • 3 Horas  — $" + s["3hr"] + " (depósito reembolsable: $" + s["3hr"] + ")\n" +
      "  • 6 Horas  — $" + s["6hr"] + " (depósito reembolsable: $" + s["6hr"] + ")\n" +
      "  • 24 Horas — $" + s["24hr"] + " (depósito reembolsable: $" + s["24hr"] + ")\n" +
      "  • 💡 El depósito de seguridad iguala el precio del alquiler\n\n" +
      "🔵 Camry 2012\n" +
      "  • Diario    — $" + e.daily + " / día\n" +
      "  • 1 Semana  — $" + e.weekly + " 🚗 Millaje Ilimitado\n" +
      "  • 2 Semanas — $" + e.biweekly + " 🚗 Millaje Ilimitado\n" +
      "  • 1 Mes     — $" + e.monthly + " 🚗 Millaje Ilimitado\n" +
      "  • Sin depósito\n\n" +
      "🟢 Camry 2013 SE\n" +
      "  • Diario    — $" + e.daily + " / día\n" +
      "  • 1 Semana  — $" + e.weekly + " 🚗 Millaje Ilimitado\n" +
      "  • 2 Semanas — $" + e.biweekly + " 🚗 Millaje Ilimitado\n" +
      "  • 1 Mes     — $" + e.monthly + " 🚗 Millaje Ilimitado\n" +
      "  • Sin depósito\n\n" +
      "¡Pregúntame sobre un auto específico para más detalles!";
  }
  return "Here are our current rates 🚗\n\n" +
    "🔴 Slingshot R — Sports 2-Seater (" + slingshotCount + " units available)\n" +
    "  • 3 Hours  — $" + s["3hr"] + " (refundable deposit: $" + s["3hr"] + ")\n" +
    "  • 6 Hours  — $" + s["6hr"] + " (refundable deposit: $" + s["6hr"] + ")\n" +
    "  • 24 Hours — $" + s["24hr"] + " (refundable deposit: $" + s["24hr"] + ")\n" +
    "  • 💡 Security deposit equals your rental fee\n\n" +
    "🔵 Camry 2012\n" +
    "  • Daily     — $" + e.daily + " / day\n" +
    "  • 1 Week   — $" + e.weekly + " 🚗 Unlimited Miles\n" +
    "  • 2 Weeks — $" + e.biweekly + " 🚗 Unlimited Miles\n" +
    "  • 1 Month  — $" + e.monthly + " 🚗 Unlimited Miles\n" +
    "  • No deposit required\n\n" +
    "🟢 Camry 2013 SE\n" +
    "  • Daily     — $" + e.daily + " / day\n" +
    "  • 1 Week   — $" + e.weekly + " 🚗 Unlimited Miles\n" +
    "  • 2 Weeks — $" + e.biweekly + " 🚗 Unlimited Miles\n" +
    "  • 1 Month  — $" + e.monthly + " 🚗 Unlimited Miles\n" +
    "  • No deposit required\n\n" +
    "Ask me about a specific car for more details!";
}

/** Build the Slingshot-only pricing message. */
function buildChatSlingshotPricingText(lang) {
  var s = getChatPricing().slingshot;
  var slingshotCount = getSlingshotUnitCount();
  if (lang === "es") {
    return "Aquí están las tarifas del Slingshot R 🔴 (tenemos " + slingshotCount + " unidades)\n\n" +
      "⏱ Tarifas por Duración (Deportivo 2 plazas):\n" +
      "  • 3 Horas  — $" + s["3hr"] + "  💰 Depósito reembolsable: $" + s["3hr"] + "\n" +
      "  • 6 Horas  — $" + s["6hr"] + "  💰 Depósito reembolsable: $" + s["6hr"] + "\n" +
      "  • 24 Horas — $" + s["24hr"] + "  💰 Depósito reembolsable: $" + s["24hr"] + "\n" +
      "  • 48 Horas — $" + s["48hr"] + "  💰 Depósito reembolsable: $" + s["48hr"] + "\n" +
      "  • 72 Horas — $" + s["72hr"] + " 💰 Depósito reembolsable: $" + s["72hr"] + "\n\n" +
      "💡 El depósito de seguridad iguala el precio del alquiler y se reembolsa después de la devolución e inspección del vehículo.\n\n" +
      "¿Listo para reservar? <a href=\"car.html?vehicle=slingshot\">👉 Reservar el Slingshot</a>";
  }
  return "Here are the Slingshot R rates 🔴 (we have " + slingshotCount + " units)\n\n" +
    "⏱ Rates by Duration (Sports 2-Seater):\n" +
    "  • 3 Hours  — $" + s["3hr"] + "  💰 Refundable deposit: $" + s["3hr"] + "\n" +
    "  • 6 Hours  — $" + s["6hr"] + "  💰 Refundable deposit: $" + s["6hr"] + "\n" +
    "  • 24 Hours — $" + s["24hr"] + "  💰 Refundable deposit: $" + s["24hr"] + "\n" +
    "  • 48 Hours — $" + s["48hr"] + "  💰 Refundable deposit: $" + s["48hr"] + "\n" +
    "  • 72 Hours — $" + s["72hr"] + " 💰 Refundable deposit: $" + s["72hr"] + "\n\n" +
    "💡 The security deposit equals your rental fee and is fully refunded after the vehicle is returned and inspected with no issues.\n\n" +
    "Ready to book? <a href=\"car.html?vehicle=slingshot\">👉 Book the Slingshot</a>";
}

/** Build the Camry-only pricing message. */
function buildChatCamryPricingText(lang) {
  var e = getChatPricing().economy;
  if (lang === "es") {
    return "Aquí están las tarifas del Camry 🔵🟢\n\n" +
      "🔵 Camry 2012\n" +
      "  • Diario    — $" + e.daily + " / día\n" +
      "  • 1 Semana  — $" + e.weekly + " 🚗 Millaje Ilimitado\n" +
      "  • 2 Semanas — $" + e.biweekly + " 🚗 Millaje Ilimitado\n" +
      "  • 1 Mes     — $" + e.monthly + " 🚗 Millaje Ilimitado\n\n" +
      "🟢 Camry 2013 SE\n" +
      "  • Diario    — $" + e.daily + " / día\n" +
      "  • 1 Semana  — $" + e.weekly + " 🚗 Millaje Ilimitado\n" +
      "  • 2 Semanas — $" + e.biweekly + " 🚗 Millaje Ilimitado\n" +
      "  • 1 Mes     — $" + e.monthly + " 🚗 Millaje Ilimitado\n\n" +
      "✅ No se requiere depósito de seguridad\n\n" +
      "¿Listo para reservar?\n\n📋 ¿Tienes una licencia de conducir válida?";
  }
  return "Here are the Camry rates 🔵🟢\n\n" +
    "🔵 Camry 2012\n" +
    "  • Daily       — $" + e.daily + " / day\n" +
    "  • 1 Week    — $" + e.weekly + " 🚗 Unlimited Miles\n" +
    "  • 2 Weeks  — $" + e.biweekly + " 🚗 Unlimited Miles\n" +
    "  • 1 Month  — $" + e.monthly + " 🚗 Unlimited Miles\n\n" +
    "🟢 Camry 2013 SE\n" +
    "  • Daily       — $" + e.daily + " / day\n" +
    "  • 1 Week    — $" + e.weekly + " 🚗 Unlimited Miles\n" +
    "  • 2 Weeks  — $" + e.biweekly + " 🚗 Unlimited Miles\n" +
    "  • 1 Month  — $" + e.monthly + " 🚗 Unlimited Miles\n\n" +
    "✅ No security deposit required\n\n" +
    "Ready to book? Visit our Cars page!\n\n📋 Do you have a valid driving license?";
}

/** Build the deposit info message. */
function buildChatDepositText(lang) {
  var s = getChatPricing().slingshot;
  if (lang === "es") {
    return "Aquí está nuestra información de depósito 💰\n\n" +
      "🔴 Slingshot R — Depósito de seguridad reembolsable:\n" +
      "  • 3 Horas  — Depósito: $" + s["3hr"] + " (igual al precio del alquiler)\n" +
      "  • 6 Horas  — Depósito: $" + s["6hr"] + " (igual al precio del alquiler)\n" +
      "  • 24 Horas — Depósito: $" + s["24hr"] + " (igual al precio del alquiler)\n" +
      "  • 48 Horas — Depósito: $" + s["48hr"] + " (igual al precio del alquiler)\n" +
      "  • 72 Horas — Depósito: $" + s["72hr"] + " (igual al precio del alquiler)\n\n" +
      "💡 El depósito se cobra al reservar y se reembolsa después de la devolución e inspección del vehículo (generalmente en 5–7 días hábiles).";
  }
  return "Here's our deposit info 💰\n\n" +
    "🔴 Slingshot R — Refundable security deposit per rental duration:\n" +
    "  • 3 Hours  — Deposit: $" + s["3hr"] + " (equals rental fee)\n" +
    "  • 6 Hours  — Deposit: $" + s["6hr"] + " (equals rental fee)\n" +
    "  • 24 Hours — Deposit: $" + s["24hr"] + " (equals rental fee)\n" +
    "  • 48 Hours — Deposit: $" + s["48hr"] + " (equals rental fee)\n" +
    "  • 72 Hours — Deposit: $" + s["72hr"] + " (equals rental fee)\n\n" +
    "💡 The deposit is charged at booking and refunded after the vehicle is returned and inspected with no issues (typically within 5–7 business days).";
}

/** Format an ISO date string (YYYY-MM-DD) as "March 28, 2026". */
function fmtDateChatbot(iso, locale) {
  var p = iso.split("-");
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return d.toLocaleDateString(locale || "en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Return the ISO date of the day after the given ISO date. */
function nextDayChatbot(iso) {
  return SlyLA.addDaysToISO(iso, 1);
}

/**
 * Return a human-readable booking-status string for a single vehicle.
 * Checks slyBookedDates for the active rental and the next upcoming one.
 */
function getVehicleBookingInfo(vehicleId, lang) {
  var locale = lang === "es" ? "es-US" : "en-US";
  var vName = getVehicleMeta(vehicleId).name;

  if (!slyBookedDates) {
    return lang === "es"
      ? "No pude obtener la información de reservas ahora mismo. Llámanos al 📞 (213) 916-6606 para información actualizada."
      : "I couldn't load the latest booking info right now. Call us at 📞 (213) 916-6606 for up-to-date availability.";
  }

  var today  = SlyLA.todayISO();
  var ranges = (slyBookedDates[vehicleId] || []).slice().sort(function(a, b) {
    return a.from < b.from ? -1 : 1;
  });

  var active = null;
  var next   = null;
  for (var i = 0; i < ranges.length; i++) {
    var r = ranges[i];
    if (r.from <= today && today <= r.to) { active = r; }
    else if (r.from > today && !next)     { next = r; }
  }

  if (active) {
    var availBack = fmtDateChatbot(nextDayChatbot(active.to), locale);
    var waitlistNote = lang === "es"
      ? "🔔 ¿Quieres reservar este auto cuando esté disponible? ¡Únete a la lista de espera por solo $50 de depósito no reembolsable (se aplica al alquiler)! Visita nuestra página de Autos y haz clic en 'Unirse a la Lista de Espera'."
      : "🔔 Want to reserve this car when it's available? Join the waitlist for just a $50 non-refundable deposit (applied toward your rental)! Visit our Cars page and click 'Join Waitlist'.";
    if (lang === "es") {
      return "🔴 El " + vName + " está actualmente alquilado\n\n" +
        "📅 Periodo: " + fmtDateChatbot(active.from, locale) + " – " + fmtDateChatbot(active.to, locale) + "\n" +
        "✅ Disponible nuevamente: " + availBack + "\n\n" +
        (next ? "⚠️ Próxima reserva después: " + fmtDateChatbot(next.from, locale) + " – " + fmtDateChatbot(next.to, locale) + "\n\n" : "") +
        waitlistNote;
    }
    return "🔴 The " + vName + " is currently rented out\n\n" +
      "📅 Rental period: " + fmtDateChatbot(active.from, locale) + " – " + fmtDateChatbot(active.to, locale) + "\n" +
      "✅ Available again: " + availBack + "\n\n" +
      (next ? "⚠️ Next booking after that: " + fmtDateChatbot(next.from, locale) + " – " + fmtDateChatbot(next.to, locale) + "\n\n" : "") +
      waitlistNote;
  }

  if (next) {
    if (lang === "es") {
      return "✅ El " + vName + " está disponible ahora\n\n" +
        "⚠️ Próxima reserva: " + fmtDateChatbot(next.from, locale) + " – " + fmtDateChatbot(next.to, locale) + "\n\n" +
        "¡Reserva pronto para asegurar tu fecha!";
    }
    return "✅ The " + vName + " is available right now!\n\n" +
      "⚠️ Next booking: " + fmtDateChatbot(next.from, locale) + " – " + fmtDateChatbot(next.to, locale) + "\n\n" +
      "Book soon to secure your dates!";
  }

  // Fully open — no bookings
  if (lang === "es") {
    return "✅ El " + vName + " está disponible — ¡sin reservas próximas!\n\n¡Reserva hoy en nuestra página de Autos!";
  }
  return "✅ The " + vName + " is available — no upcoming bookings!\n\nBook today on our Cars page!";
}

/**
 * Build a summary for ALL vehicles combining fleet-status + next-available info.
 */
function buildAvailabilityMessage(lang) {
  var ids   = getFleetVehicleIds();
  var locale = lang === "es" ? "es-US" : "en-US";
  var today  = SlyLA.todayISO();

  var lines = [];
  for (var k = 0; k < ids.length; k++) {
    var id     = ids[k];
    var meta   = getVehicleMeta(id);
    var vName  = meta.name;
    var icon   = meta.icon;
    var ranges = slyBookedDates ? ((slyBookedDates[id] || []).slice().sort(function(a, b) {
      return a.from < b.from ? -1 : 1;
    })) : [];

    var active = null;
    var next   = null;
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (r.from <= today && today <= r.to) { active = r; }
      else if (r.from > today && !next)     { next = r; }
    }

    if (active) {
      var avail = fmtDateChatbot(nextDayChatbot(active.to), locale);
      lines.push(icon + " " + vName + " — " +
        (lang === "es" ? "🔴 Alquilado hasta " + fmtDateChatbot(active.to, locale) + " · libre: " + avail
                       : "🔴 Rented until " + fmtDateChatbot(active.to, locale) + " · free: " + avail));
    } else {
      var statusSuffix = "";
      if (next && slyBookedDates) {
        statusSuffix = lang === "es"
          ? " (próx. reserva: " + fmtDateChatbot(next.from, locale) + ")"
          : " (next booking: " + fmtDateChatbot(next.from, locale) + ")";
      }
      lines.push(icon + " " + vName + " — " + (lang === "es" ? "✅ Disponible" : "✅ Available") + statusSuffix);
    }
  }

  var header = lang === "es"
    ? "📅 Estado actual de disponibilidad:\n\n"
    : "📅 Current availability for all vehicles:\n\n";
  var footer = lang === "es"
    ? "\n\nPara reservar, visita nuestra página de Autos o llámanos al 📞 (213) 916-6606"
    : "\n\nTo book, visit our Cars page or call 📞 (213) 916-6606";

  return header + lines.join("\n") + footer;
}

/**
 * Build a human-readable fleet listing with live availability status.
 * When slyFleetStatus is null (fetch not yet returned or failed), status
 * indicators are omitted and the static listing is shown as a clean fallback.
 * When a vehicle is booked and slyBookedDates is loaded, also shows the
 * next available date.
 */
function buildFleetMessage(lang) {
  var locale = lang === "es" ? "es-US" : "en-US";
  var today  = SlyLA.todayISO();

  function statusLine(vehicleId) {
    if (!slyFleetStatus) return "";
    var v = slyFleetStatus[vehicleId];
    if (!v) return "";
    if (v.available) return " ✅ Available";
    // Vehicle unavailable — try to find when it frees up
    if (slyBookedDates) {
      var ranges = (slyBookedDates[vehicleId] || []).slice().sort(function(a, b) {
        return a.from < b.from ? -1 : 1;
      });
      for (var i = 0; i < ranges.length; i++) {
        if (ranges[i].from <= today && today <= ranges[i].to) {
          var freeDate = fmtDateChatbot(nextDayChatbot(ranges[i].to), locale);
          return lang === "es"
            ? " 🔴 No Disponible · libre: " + freeDate
            : " 🔴 Unavailable · free: " + freeDate;
        }
      }
    }
    return " 🔴 Currently Unavailable";
  }

  if (isSlingshotMode()) {
    // Slingshot-mode: only show Slingshot info
    var sp = getChatPricing().slingshot;
    if (lang === "es") {
      return "🔴 <strong>Slingshot R</strong> — Deportivo 2 plazas" + statusLine("slingshot") + "\n\n" +
        "⏱ Tarifas:\n" +
        "  • 3 Horas  — $" + sp["3hr"] + "  💰 Depósito reembolsable: $" + sp["3hr"] + "\n" +
        "  • 6 Horas  — $" + sp["6hr"] + "  💰 Depósito reembolsable: $" + sp["6hr"] + "\n" +
        "  • 24 Horas — $" + sp["24hr"] + "  💰 Depósito reembolsable: $" + sp["24hr"] + "\n" +
        "  • 48 Horas — $" + sp["48hr"] + "  💰 Depósito reembolsable: $" + sp["48hr"] + "\n" +
        "  • 72 Horas — $" + sp["72hr"] + " 💰 Depósito reembolsable: $" + sp["72hr"] + "\n\n" +
        "💡 El depósito iguala el precio del alquiler y se reembolsa después de la devolución.\n\n" +
        "<a href=\"car.html?vehicle=slingshot\">👉 Reservar el Slingshot</a>";
    }
    return "🔴 <strong>Slingshot R</strong> — Sports 2-Seater" + statusLine("slingshot") + "\n\n" +
      "⏱ Rates:\n" +
      "  • 3 Hours  — $" + sp["3hr"] + "  💰 Refundable deposit: $" + sp["3hr"] + "\n" +
      "  • 6 Hours  — $" + sp["6hr"] + "  💰 Refundable deposit: $" + sp["6hr"] + "\n" +
      "  • 24 Hours — $" + sp["24hr"] + "  💰 Refundable deposit: $" + sp["24hr"] + "\n" +
      "  • 48 Hours — $" + sp["48hr"] + "  💰 Refundable deposit: $" + sp["48hr"] + "\n" +
      "  • 72 Hours — $" + sp["72hr"] + " 💰 Refundable deposit: $" + sp["72hr"] + "\n\n" +
      "💡 The security deposit equals your rental fee and is refunded after return & inspection.\n\n" +
      "<a href=\"car.html?vehicle=slingshot\">👉 Book the Slingshot</a>";
  }

  var fleetIds = getFleetVehicleIds();
  var slingshotIds = fleetIds.filter(function(id) { return getVehicleMeta(id).type === "slingshot"; });
  var economyIds = fleetIds.filter(function(id) { return getVehicleMeta(id).type === "economy"; });
  var otherIds = fleetIds.filter(function(id) {
    var t = getVehicleMeta(id).type;
    return t !== "slingshot" && t !== "economy";
  });

  function renderList(ids, renderer) {
    return ids.map(function(id) {
      var meta = getVehicleMeta(id);
      return renderer(id, meta);
    }).join("\n");
  }

  if (lang === "es") {
    var p = getChatPricing(), s = p.slingshot, e = p.economy;
    var outEs = "Contamos con <strong>" + fleetIds.length + " vehículos</strong> en nuestra flota:\n\n";
    if (slingshotIds.length) {
      outEs += renderList(slingshotIds, function(id, meta) {
        return meta.icon + " " + meta.name + " — Deportivo 2 plazas" + statusLine(id);
      }) + "\n" +
        "   3 hrs $" + s["3hr"] + " · 6 hrs $" + s["6hr"] + " · 24 hrs $" + s["24hr"] + "\n" +
        "   💰 Depósito reembolsable igual al precio del alquiler\n\n";
    }
    if (economyIds.length) {
      outEs += renderList(economyIds, function(id, meta) {
        return meta.icon + " " + meta.name + " — $" + e.daily + "/día o $" + e.weekly + "/semana, Millaje Ilimitado (sin depósito)" + statusLine(id);
      }) + "\n\n";
    }
    if (otherIds.length) {
      outEs += renderList(otherIds, function(id, meta) {
        return meta.icon + " " + meta.name + statusLine(id);
      }) + "\n\n";
    }
    return outEs + "¡Visita nuestra página de Autos para ver y reservar!";
  }
  var pricing2 = getChatPricing(), slPricing = pricing2.slingshot, economy2 = pricing2.economy;
  var outEn = "We have <strong>" + fleetIds.length + " vehicles</strong> in our fleet:\n\n";
  if (slingshotIds.length) {
    outEn += renderList(slingshotIds, function(id, meta) {
      return meta.icon + " " + meta.name + " — Sports 2-Seater" + statusLine(id);
    }) + "\n" +
      "   3 hrs $" + slPricing["3hr"] + " · 6 hrs $" + slPricing["6hr"] + " · 24 hrs $" + slPricing["24hr"] + "\n" +
      "   💰 Refundable deposit equals your rental fee\n\n";
  }
  if (economyIds.length) {
    outEn += renderList(economyIds, function(id, meta) {
      return meta.icon + " " + meta.name + " — $" + economy2.daily + "/day or $" + economy2.weekly + "/week, Unlimited Miles (no deposit)" + statusLine(id);
    }) + "\n\n";
  }
  if (otherIds.length) {
    outEn += renderList(otherIds, function(id, meta) {
      return meta.icon + " " + meta.name + statusLine(id);
    }) + "\n\n";
  }
  return outEn + "Visit our Cars page to browse and book!";
}

var botResponses = {
  en: [
    {
      patterns: ["hello","hi","hey","howdy","sup","what's up"],
      reply: "Hey! 👋 Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\nOur cars are <strong>$350/week with unlimited miles</strong>. I can help you get approved quickly.\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Click here to apply and get approved</a>"
    },
    {
      patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot"],
      reply: function() { return buildChatSlingshotPricingText("en"); }
    },
    {
      patterns: ["camry price","camry cost","camry rate","camry how much","camry fee","how much is the camry","how much for the camry","how much camry","price of camry","cost of camry"],
      reply: function() { return buildChatCamryPricingText("en"); }
    },
    {
      patterns: ["price","cost","how much","rate","rates","fee","fees","daily","weekly","monthly"],
      reply: function() { return buildChatPricingText("en"); }
    },
    {
      patterns: ["earn","earnings","income","make money","how much can","how much money","revenue"],
      reply: "💰 Earning Potential with SLY Rides\n\nOur delivery drivers typically earn:\n  • $800 – $1,500 per week\n\nworking on apps like DoorDash, Uber Eats, Instacart, and Amazon Flex.\n\nFor just $350/week with unlimited miles, that's a great return!\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Apply now to get approved</a>"
    },
    {
      patterns: ["car","cars","vehicle","vehicles","available","fleet","slingshot","camry"],
      reply: function() { return buildFleetMessage("en"); }
    },
    {
      patterns: ["when is slingshot","slingshot available","slingshot booked","how long slingshot","slingshot rented","when will slingshot","slingshot free","slingshot when available","slingshot when free","slingshot status","slingshot availability"],
      reply: function() {
        var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        return getVehicleBookingInfo("slingshot", lang);
      }
    },
    {
      patterns: ["camry 2012 available","2012 available","camry 2012 booked","how long camry 2012","when is camry 2012","camry 2012 rented","2012 booked","camry 2012 status","camry 2012 free"],
      reply: function() {
        var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        return getVehicleBookingInfo("camry", lang);
      }
    },
    {
      patterns: ["camry 2013 available","2013 available","camry 2013 booked","how long camry 2013","when is camry 2013","camry 2013 rented","2013 booked","camry 2013 status","camry 2013 free"],
      reply: function() {
        var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        return getVehicleBookingInfo("camry2013", lang);
      }
    },
    {
      patterns: ["when is camry","camry available","camry booked","camry rented","how long camry","camry free","camry status","camry availability"],
      reply: function() {
        var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        return "Here's the status of both Camry vehicles:\n\n" +
          getVehicleBookingInfo("camry", lang) + "\n\n────────────────────\n\n" +
          getVehicleBookingInfo("camry2013", lang);
      }
    },
    {
      patterns: ["when available","when booked","how long booked","when free","when can i get","availability","what's available","what is available","how long rented","how long is it rented","which cars are available"],
      reply: function() {
        var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        return buildAvailabilityMessage(lang);
      }
    },
    {
      patterns: ["book","booking","reserve","reservation","how do i","how to"],
      reply: "Booking is easy! 📅\n\n1. Visit our Cars page to browse vehicles\n2. Click 'Select' on your chosen vehicle\n3. Choose your pickup & return dates\n4. Enter your name, email & phone\n5. Upload your Driver's License / ID\n6. Sign the rental agreement\n7. Click 💳 Pay Now\n\n📋 Do you have a valid driving license? A valid driver's license is required to rent any of our vehicles."
    },
    {
      patterns: ["apply","application","sign up","get approved","approved","approval","start","get started"],
      reply: "Getting approved is quick and easy! 🚀\n\nJust fill out our short application:\n  • Full name & phone number\n  • Driver's license upload\n  • Age (must be 21+)\n  • Driving experience (3+ months)\n  • Which delivery apps you use\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Click here to apply now</a>\n\nApprovals are typically same-day! 🎉"
    },
    {
      patterns: ["license","licence","driver","driving license","driving licence","id","identification","requirement","requirements","qualify","eligible"],
      reply: "📋 Driver's License Requirement\n\nYes! A valid driving license is required to rent any of our vehicles.\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • At least 3 months of driving experience\n  • License must not be expired\n  • You will need to upload a photo of your license during booking\n\nDo you have a valid driving license? If yes, you're ready to apply! 🚗\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Apply now</a>"
    },
    {
      patterns: ["deposit","security"],
      reply: function() { return buildChatDepositText("en"); }
    },
    {
      patterns: ["cancel","cancellation","refund","no show","no-show","noshow"],
      reply: "⚠️ No-Refund Policy\n\nAll payments are final once a booking is confirmed.\n\n• Cancellations or no-shows after booking are not eligible for a refund\n• Slingshot: the $50 reservation deposit is NON-REFUNDABLE and will be forfeited\n• Please review your reservation details carefully before completing payment\n• Refunds may be issued only if the company cancels or cannot fulfill the rental\n\nFor questions, call (213) 916-6606 or email slyservices@supports-info.com 🙏"
    },
    {
      patterns: ["contact","phone","call","email","reach","support","help"],
      reply: "You can reach us at:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours. Feel free to ask!"
    },
    {
      patterns: ["pay","payment","stripe","credit","card","paypal"],
      reply: "We accept all major credit and debit cards via Stripe 💳\n\nTo pay:\n1. Select your car & dates\n2. Enter your email\n3. Check the rental agreement box\n4. Click 💳 Pay Now\n\nYou'll be redirected to a secure Stripe checkout page."
    },
    {
      patterns: ["location","where","pickup","pick up","pick-up","address"],
      reply: "📍 Please contact us to confirm the pickup location:\n\n📧 slyservices@supports-info.com\n\nWe'll share the exact address after your booking is confirmed!"
    },
    {
      patterns: ["app","uber","lyft","turo","getaround","rideshare","ride share","drive for","what app","doordash","instacart","grubhub","amazon flex","amazon"],
      reply: "Great question! 🚗 We are <strong>not</strong> a rideshare or delivery app.<br><br>We are <strong>Sly Transportation Services LLC</strong> — a car rental company based in Los Angeles, CA.<br><br>We rent vehicles directly to you, so <em>you</em> can drive for any app you like — DoorDash, Uber Eats, Instacart, Amazon Flex, and more!<br><br>Ready to get behind the wheel? 👇<br><a href=\"index.html\" id=\"chatApplyLink\">👉 Apply &amp; Get Approved Now</a>"
    },
    {
      patterns: ["thanks","thank you","thank","appreciate","great","awesome","perfect"],
      reply: "You're welcome! 😊 Happy to help. Enjoy your ride with Sly Transportation Services LLC! 🚗💨"
    },
    {
      patterns: ["text","sms","notification","notifications","reminder","reminders","message","messages","will i get","will you text","do you text","do you send","what texts","what messages","what notifications","automated message","automated text"],
      reply: "📱 Automated SMS Notifications\n\nHere's every text you'll receive from us:\n\n<strong>Before Pickup</strong>\n  • 24 hrs before — pickup reminder with time & location\n\n<strong>During Your Rental</strong>\n  • Before return window — option to extend your rental\n  • At return time — heads-up that rental time has ended\n  • +1 hr past return — grace period expired notice\n  • +2 hrs past return — late fee assessment (if applicable)\n\n<strong>After Return</strong>\n  • Upon completion — thank-you message\n  • Day 7 — follow-up message\n\nAll texts include a STOP opt-out option.\n\nQuestions? 📞 (213) 916-6606"
    }
  ],
  es: [
    {
      patterns: ["hola","buenos días","buenas tardes","buenas noches","buenas","qué tal","qué onda","saludos"],
      reply: "¡Hola! 👋 ¿Quieres alquilar un auto para DoorDash, Uber Eats u otras aplicaciones de entrega?\n\nNuestros autos son <strong>$350/semana con millaje ilimitado</strong>. Puedo ayudarte a obtener aprobación rápidamente.\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Haz clic aquí para solicitar y obtener aprobación</a>"
    },
    {
      patterns: ["precio slingshot","costo slingshot","cuánto slingshot","cuanto slingshot","tarifa slingshot","slingshot precio","slingshot costo"],
      reply: function() { return buildChatSlingshotPricingText("es"); }
    },
    {
      patterns: ["precio camry","costo camry","cuánto camry","cuanto camry","tarifa camry","camry precio","camry costo"],
      reply: function() { return buildChatCamryPricingText("es"); }
    },
    {
      patterns: ["precio","costo","cuánto cuesta","cuanto cuesta","cuánto es","cuanto es","tarifa","tarifas","cobran","cobras","diario","semanal","mensual"],
      reply: function() { return buildChatPricingText("es"); }
    },
    {
      patterns: ["ganar","ganancias","ingresos","cuánto puedo ganar","cuanto puedo ganar","dinero"],
      reply: "💰 Potencial de Ganancias con SLY Rides\n\nNuestros conductores de entrega típicamente ganan:\n  • $800 – $1,500 por semana\n\ntrabajando en apps como DoorDash, Uber Eats, Instacart y Amazon Flex.\n\n¡Por solo $350/semana con millaje ilimitado, es un excelente retorno!\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Solicita ahora para obtener aprobación</a>"
    },
    {
      patterns: ["auto","autos","carro","carros","vehículo","vehiculo","disponible","flota","slingshot","camry"],
      reply: function() { return buildFleetMessage("es"); }
    },
    {
      patterns: ["cuando slingshot","slingshot disponible","slingshot reservado","cuánto tiempo slingshot","cuanto tiempo slingshot","slingshot alquilado","cuando estará slingshot","slingshot libre","slingshot cuando disponible","disponibilidad slingshot"],
      reply: function() {
        return getVehicleBookingInfo("slingshot", "es");
      }
    },
    {
      patterns: ["camry 2012 disponible","2012 disponible","camry 2012 reservado","camry 2012 libre","cuando camry 2012","camry 2012 alquilado","disponibilidad camry 2012"],
      reply: function() { return getVehicleBookingInfo("camry", "es"); }
    },
    {
      patterns: ["camry 2013 disponible","2013 disponible","camry 2013 reservado","camry 2013 libre","cuando camry 2013","camry 2013 alquilado","disponibilidad camry 2013"],
      reply: function() { return getVehicleBookingInfo("camry2013", "es"); }
    },
    {
      patterns: ["cuando camry","camry disponible","camry reservado","camry alquilado","camry libre","disponibilidad camry"],
      reply: function() {
        return "Aquí está el estado de los dos vehículos Camry:\n\n" +
          getVehicleBookingInfo("camry", "es") + "\n\n────────────────────\n\n" +
          getVehicleBookingInfo("camry2013", "es");
      }
    },
    {
      patterns: ["cuando disponible","cuándo disponible","cuando libre","cuándo libre","disponibilidad","qué está disponible","que esta disponible","cuándo puedo rentar","cuando puedo rentar","cuánto tiempo está rentado","cuanto tiempo esta rentado"],
      reply: function() { return buildAvailabilityMessage("es"); }
    },
    {
      patterns: ["reservar","reserva","reservación","reservacion","cómo reservo","como reservo","cómo alquilo","como alquilo","cómo rento","como rento","cómo funciona","como funciona"],
      reply: "¡Reservar es fácil! 📅\n\n1. Visita nuestra página de Autos para ver los vehículos\n2. Haz clic en 'Seleccionar' en el vehículo que elijas\n3. Elige tus fechas de recogida y devolución\n4. Ingresa tu nombre, correo y teléfono\n5. Sube tu Licencia de Conducir / ID\n6. Firma el contrato de alquiler\n7. Haz clic en 💳 Pagar Ahora\n\n📋 ¿Tienes una licencia de conducir válida? Se requiere licencia de conducir válida para alquilar cualquiera de nuestros vehículos."
    },
    {
      patterns: ["solicitar","solicitud","registrar","aprobación","aprobacion","aprobar","empezar","cómo empiezo","como empiezo"],
      reply: "¡Obtener aprobación es rápido y fácil! 🚀\n\nSolo completa nuestra breve solicitud:\n  • Nombre completo y número de teléfono\n  • Subir licencia de conducir\n  • Edad (debe tener 21+)\n  • Experiencia al volante (3+ meses)\n  • Qué aplicaciones de entrega usas\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Haz clic aquí para solicitar ahora</a>\n\n¡Las aprobaciones son generalmente el mismo día! 🎉"
    },
    {
      patterns: ["licencia","carnet","documento","identificación","identificacion","requisito","requisitos","calificar","elegible"],
      reply: "📋 Requisito de Licencia de Conducir\n\n¡Sí! Se requiere una licencia de conducir válida para alquilar cualquiera de nuestros vehículos.\n\n✅ Lo que necesitarás:\n  • Licencia de conducir válida emitida por el gobierno\n  • Debe tener 21 años o más\n  • Al menos 3 meses de experiencia al volante\n  • La licencia no debe estar vencida\n  • Deberás subir una foto de tu licencia durante la reserva\n\n¿Tienes una licencia de conducir válida? ¡Si es así, estás listo para solicitar! 🚗\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Solicitar ahora</a>"
    },
    {
      patterns: ["depósito","deposito","fianza","garantía","garantia","seguridad"],
      reply: function() { return buildChatDepositText("es"); }
    },
    {
      patterns: ["cancelar","cancelación","cancelacion","reembolso","reembolsar","no presentarse"],
      reply: "⚠️ Política de No Reembolso\n\nTodos los pagos son finales una vez confirmada la reserva.\n\n• Las cancelaciones o no presentaciones después de la reserva no son elegibles para reembolso\n• Slingshot: el depósito de $50 es NO REEMBOLSABLE y se pierde si cancelas\n• Revisa los detalles de tu reserva cuidadosamente antes de completar el pago\n• Los reembolsos solo se emiten si la empresa cancela o no puede cumplir con el alquiler\n\nPara preguntas, llama al (213) 916-6606 o envía un correo a slyservices@supports-info.com 🙏"
    },
    {
      patterns: ["contacto","teléfono","telefono","llamar","correo","comunicarme","ayuda","soporte","asistencia"],
      reply: "Puedes contactarnos en:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\nGeneralmente respondemos dentro de pocas horas. ¡No dudes en preguntar!"
    },
    {
      patterns: ["pagar","pago","tarjeta","crédito","credito","débito","debito","cómo pago","como pago"],
      reply: "Aceptamos todas las tarjetas de crédito y débito principales a través de Stripe 💳\n\nPara pagar:\n1. Selecciona tu auto y fechas\n2. Ingresa tu correo electrónico\n3. Marca la casilla del contrato de alquiler\n4. Haz clic en 💳 Pagar Ahora\n\nSerás redirigido a una página segura de pago de Stripe."
    },
    {
      patterns: ["ubicación","ubicacion","dirección","direccion","dónde","donde","recoger","recogida"],
      reply: "📍 Por favor contáctanos para confirmar la ubicación de recogida:\n\n📧 slyservices@supports-info.com\n\n¡Compartiremos la dirección exacta después de confirmar tu reserva!"
    },
    {
      patterns: ["app","uber","lyft","doordash","instacart","grubhub","amazon","entrega","delivery"],
      reply: "¡Buena pregunta! 🚗 <strong>No</strong> somos una aplicación de viaje compartido o entrega.<br><br>Somos <strong>Sly Transportation Services LLC</strong> — una empresa de alquiler de autos en Los Ángeles, CA.<br><br>¡Te alquilamos vehículos directamente para que <em>tú</em> puedas trabajar en cualquier app que desees — DoorDash, Uber Eats, Instacart, Amazon Flex y más!<br><br>¿Listo para ponerte al volante? 👇<br><a href=\"index.html\" id=\"chatApplyLink\">👉 Solicitar y Obtener Aprobación Ahora</a>"
    },
    {
      patterns: ["gracias","muchas gracias","te agradezco","genial","perfecto","excelente"],
      reply: "¡De nada! 😊 Un placer ayudarte. ¡Disfruta tu viaje con Sly Transportation Services LLC! 🚗💨"
    },
    {
      patterns: ["texto","sms","notificación","notificacion","notificaciones","recordatorio","recordatorios","mensaje","mensajes","me van a mandar","van a enviar","mensajes automáticos","mensajes automaticos","qué mensajes","que mensajes"],
      reply: "📱 Notificaciones SMS Automáticas\n\nEsquema de mensajes que recibirás:\n\n<strong>Antes del recogida</strong>\n  • 24 hrs antes — recordatorio de recogida con hora y ubicación\n\n<strong>Durante tu renta</strong>\n  • Antes del fin — opción para extender tu renta\n  • Al vencer — aviso de que el tiempo de renta terminó\n  • +1 hr vencido — aviso de período de gracia expirado\n  • +2 hrs vencido — cargo por retraso (si aplica)\n\n<strong>Después de devolución</strong>\n  • Al completarse — mensaje de agradecimiento\n  • Día 7 — mensaje de seguimiento\n\nTodos incluyen opción STOP para cancelar.\n\n¿Preguntas? 📞 (213) 916-6606"
    }
  ]
};

// ── Slingshot-mode response set ────────────────────────────────────────────────
// Used by getBotReply() when isSlingshotMode() is true. Only covers Slingshot topics.
var slingshotBotResponses = {
  en: [
    {
      patterns: ["hello","hi","hey","howdy","sup","what's up"],
      reply: "Hey! 👋 Welcome to <strong>SLY Slingshot Rentals</strong> 🔴\n\nLooking to rent the iconic Polaris Slingshot in Los Angeles?\n\n<a href=\"car.html?vehicle=slingshot\">👉 Book the Slingshot now</a>"
    },
    {
      patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot","price","cost","how much","rate","rates","fee","fees"],
      reply: function() { return buildChatSlingshotPricingText("en"); }
    },
    {
      patterns: ["deposit","security","refund","refundable"],
      reply: function() { return buildChatDepositText("en"); }
    },
    {
      patterns: ["available","availability","when is slingshot","slingshot available","slingshot booked","how long slingshot","slingshot rented","when will slingshot","slingshot free","slingshot when available","slingshot when free","slingshot status","slingshot availability","check availability"],
      reply: function() {
        return getVehicleBookingInfo("slingshot", "en");
      }
    },
    {
      patterns: ["car","vehicle","fleet","slingshot","book","booking","reserve","reservation","how do i","how to"],
      reply: "Booking the Slingshot R is easy! 🔴\n\n1. Click the link below to go to the booking page\n2. Choose your rental duration (3 hrs · 6 hrs · 24 hrs · 48 hrs · 72 hrs)\n3. Pick your pickup date & time\n4. Enter your name, email & phone\n5. Upload your Driver's License\n6. Sign the rental agreement\n7. Click 💳 Pay Now\n\n<a href=\"car.html?vehicle=slingshot\">👉 Book the Slingshot</a>"
    },
    {
      patterns: ["require","requirement","requirements","license","licence","driver","id","identification","qualify","eligible","age","21","insurance"],
      reply: "📋 Requirements to Rent the Slingshot\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • License must not be expired\n  • Upload a photo of your license during booking\n  • Auto insurance (own policy) OR add our Damage Protection Plan\n\n<a href=\"car.html?vehicle=slingshot\">👉 Book Now</a>"
    },
    {
      patterns: ["cancel","cancellation","no show","no-show","noshow","refund policy"],
      reply: "⚠️ Cancellation Policy\n\nAll payments are final once a booking is confirmed.\n\n• Cancellations or no-shows after booking are not eligible for a refund of the rental fee\n• The refundable security deposit will be released only if the booking is cancelled before pickup and the vehicle has not been used\n• Refunds may be issued only if SLY Slingshot Rentals cancels or cannot fulfill the rental\n\nFor questions, call (213) 916-6606 or email slyservices@supports-info.com 🙏"
    },
    {
      patterns: ["contact","phone","call","email","reach","support","help"],
      reply: "You can reach us at:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours. Feel free to ask!"
    },
    {
      patterns: ["pay","payment","stripe","credit","card","paypal"],
      reply: "We accept all major credit and debit cards via Stripe 💳\n\nThe full amount (rental fee + matching refundable security deposit + tax) is charged securely at booking.\n\n<a href=\"car.html?vehicle=slingshot\">👉 Book & Pay Now</a>"
    },
    {
      patterns: ["location","where","pickup","pick up","pick-up","address"],
      reply: "📍 Please contact us to confirm the pickup location:\n\n📧 slyservices@supports-info.com\n\nWe'll share the exact address after your booking is confirmed!"
    },
    {
      patterns: ["late fee","late return","return late","overdue","grace period","late charge","return policy","late policy"],
      reply: "⏰ Late Return Fee — Slingshot\n\nA <strong>30-minute grace period</strong> is provided after your scheduled return time.\n\nAfter the grace period: <strong>$100/hour</strong> for each hour (or part thereof) you are late.\n\nPlease return the vehicle on time to avoid late charges! 🙏"
    },
    {
      patterns: ["thanks","thank you","thank","appreciate","great","awesome","perfect"],
      reply: "You're welcome! 😊 Enjoy your Slingshot experience! 🔴💨"
    },
    {
      patterns: ["text","sms","notification","notifications","reminder","reminders","message","messages","will i get","will you text","do you text","do you send","what texts","what messages","what notifications","automated message","automated text"],
      reply: "📱 Automated SMS Notifications\n\nHere's every text you'll receive from us:\n\n<strong>Before Pickup</strong>\n  • 24 hrs before — pickup reminder with time & location\n\n<strong>During Your Rental</strong>\n  • Before return window — option to extend your rental\n  • At return time — heads-up that rental time has ended\n  • +1 hr past return — grace period expired notice\n  • +2 hrs past return — late fee assessment (if applicable)\n\n<strong>After Return</strong>\n  • Upon completion — thank-you message\n  • Day 7 — follow-up message\n\nAll texts include a STOP opt-out option.\n\nQuestions? 📞 (213) 916-6606"
    }
  ],
  es: [
    {
      patterns: ["hola","buenos días","buenas tardes","buenas noches","buenas","qué tal","qué onda","saludos"],
      reply: "¡Hola! 👋 Bienvenido a <strong>SLY Slingshot Rentals</strong> 🔴\n\n¿Quieres rentar el icónico Polaris Slingshot en Los Ángeles?\n\n<a href=\"car.html?vehicle=slingshot\">👉 Reservar el Slingshot ahora</a>"
    },
    {
      patterns: ["precio slingshot","costo slingshot","cuánto slingshot","cuanto slingshot","tarifa slingshot","slingshot precio","slingshot costo","precio","costo","cuánto cuesta","cuanto cuesta","tarifa","tarifas"],
      reply: function() { return buildChatSlingshotPricingText("es"); }
    },
    {
      patterns: ["depósito","deposito","fianza","garantía","garantia","seguridad","reembolso","reembolsable"],
      reply: function() { return buildChatDepositText("es"); }
    },
    {
      patterns: ["disponible","disponibilidad","cuando slingshot","slingshot disponible","slingshot reservado","cuánto tiempo slingshot","cuanto tiempo slingshot","slingshot alquilado","cuando estará slingshot","slingshot libre","disponibilidad slingshot","revisar disponibilidad"],
      reply: function() {
        return getVehicleBookingInfo("slingshot", "es");
      }
    },
    {
      patterns: ["auto","carro","vehículo","vehiculo","slingshot","reservar","reserva","reservación","reservacion","cómo reservo","como reservo","cómo rento","como rento"],
      reply: "¡Reservar el Slingshot R es fácil! 🔴\n\n1. Haz clic en el enlace de abajo para ir a la página de reservas\n2. Elige la duración del alquiler (3 hrs · 6 hrs · 24 hrs · 48 hrs · 72 hrs)\n3. Selecciona tu fecha y hora de recogida\n4. Ingresa tu nombre, correo y teléfono\n5. Sube tu Licencia de Conducir\n6. Firma el contrato de alquiler\n7. Haz clic en 💳 Pagar Ahora\n\n<a href=\"car.html?vehicle=slingshot\">👉 Reservar el Slingshot</a>"
    },
    {
      patterns: ["requisito","requisitos","licencia","documento","identificación","calificar","elegible","edad","21","seguro"],
      reply: "📋 Requisitos para Rentar el Slingshot\n\n✅ Lo que necesitarás:\n  • Licencia de conducir válida emitida por el gobierno\n  • Debe tener 21 años o más\n  • La licencia no debe estar vencida\n  • Subir foto de la licencia durante la reserva\n  • Seguro de auto propio O añadir nuestro Plan de Protección\n\n<a href=\"car.html?vehicle=slingshot\">👉 Reservar Ahora</a>"
    },
    {
      patterns: ["cancelar","cancelación","cancelacion","no presentarse","política de reembolso"],
      reply: "⚠️ Política de Cancelación\n\nTodos los pagos son finales una vez confirmada la reserva.\n\n• Las cancelaciones o no presentaciones no son elegibles para reembolso del alquiler\n• El depósito de seguridad reembolsable se libera solo si se cancela antes del uso del vehículo\n• Los reembolsos se emiten solo si SLY Slingshot Rentals cancela o no puede cumplir\n\nPara preguntas, llama al (213) 916-6606 o escribe a slyservices@supports-info.com 🙏"
    },
    {
      patterns: ["contacto","teléfono","telefono","llamar","correo","comunicarme","ayuda"],
      reply: "Puedes contactarnos en:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\n¡Generalmente respondemos dentro de pocas horas!"
    },
    {
      patterns: ["pagar","pago","tarjeta","crédito","débito","cómo pago","como pago"],
      reply: "Aceptamos todas las tarjetas de crédito y débito a través de Stripe 💳\n\nEl monto total (alquiler + depósito reembolsable + impuesto) se cobra de forma segura al reservar.\n\n<a href=\"car.html?vehicle=slingshot\">👉 Reservar y Pagar Ahora</a>"
    },
    {
      patterns: ["ubicación","ubicacion","dónde","donde","recoger","recogida"],
      reply: "📍 Por favor contáctanos para confirmar la ubicación de recogida:\n\n📧 slyservices@supports-info.com\n\n¡Compartiremos la dirección exacta después de confirmar tu reserva!"
    },
    {
      patterns: ["cargo tardío","cargo por mora","devolución tardía","devolver tarde","tarde","vencido","período de gracia","periodo de gracia","cargo por retraso","política de devolución"],
      reply: "⏰ Cargo por Devolución Tardía — Slingshot\n\nSe proporciona un <strong>período de gracia de 30 minutos</strong> después de tu hora de devolución programada.\n\nDespués del período de gracia: <strong>$100/hora</strong> por cada hora (o fracción) de retraso.\n\n¡Por favor devuelve el vehículo a tiempo para evitar cargos por mora! 🙏"
    },
    {
      patterns: ["gracias","muchas gracias","genial","perfecto","excelente"],
      reply: "¡De nada! 😊 ¡Disfruta tu experiencia en el Slingshot! 🔴💨"
    },
    {
      patterns: ["texto","sms","notificación","notificacion","notificaciones","recordatorio","recordatorios","mensaje","mensajes","me van a mandar","van a enviar","mensajes automáticos","mensajes automaticos","qué mensajes","que mensajes"],
      reply: "📱 Notificaciones SMS Automáticas\n\nEsquema de mensajes que recibirás:\n\n<strong>Antes del recogida</strong>\n  • 24 hrs antes — recordatorio de recogida con hora y ubicación\n\n<strong>Durante tu renta</strong>\n  • Antes del fin — opción para extender tu renta\n  • Al vencer — aviso de que el tiempo de renta terminó\n  • +1 hr vencido — aviso de período de gracia expirado\n  • +2 hrs vencido — cargo por retraso (si aplica)\n\n<strong>Después de devolución</strong>\n  • Al completarse — mensaje de agradecimiento\n  • Día 7 — mensaje de seguimiento\n\nTodos incluyen opción STOP para cancelar.\n\n¿Preguntas? 📞 (213) 916-6606"
    }
  ]
};

function getBotReply(input) {
  var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : (localStorage.getItem("slyLang") || "en");
  // Use Slingshot-only responses when in Slingshot mode
  var responseSet = isSlingshotMode() ? slingshotBotResponses : botResponses;
  var responses = responseSet[lang] || responseSet["en"];
  var lower = input.toLowerCase();
  for (var i = 0; i < responses.length; i++) {
    var item = responses[i];
    if (item.patterns.some(function(p) { return lower.includes(p); })) {
      return typeof item.reply === "function" ? item.reply() : item.reply;
    }
  }
  // Also try English responses as fallback for bilingual users
  if (lang === "es") {
    var enResponses = responseSet["en"];
    for (var j = 0; j < enResponses.length; j++) {
      var enItem = enResponses[j];
      if (enItem.patterns.some(function(p) { return lower.includes(p); })) {
        return typeof enItem.reply === "function" ? enItem.reply() : enItem.reply;
      }
    }
  }
  return isSlingshotMode()
    ? "I\u2019m not sure about that one \uD83E\uDD14\n\nTry asking about:\n\u2022 Slingshot pricing\n\u2022 Availability\n\u2022 How to book\n\u2022 Deposit info\n\u2022 Contact info\n\nOr email us at slyservices@supports-info.com"
    : (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.fallback") : "I\u2019m not sure about that one \uD83E\uDD14\n\nTry asking about:\n\u2022 Pricing\n\u2022 Available cars\n\u2022 How to book\n\u2022 Delivery apps\n\u2022 Contact info\n\nOr email us at slyservices@supports-info.com";
}

function buildChatbot() {
  var tFn = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t : function(k) { return k; };

  // ── Inject chat widget HTML ────────────────────────────────────────────────
  document.body.insertAdjacentHTML("beforeend",
    '<div id="chat-widget">' +
      '<button id="chat-toggle" aria-label="Open chat">\uD83D\uDCAC' +
        '<span id="chat-badge" hidden aria-hidden="true"></span>' +
      '</button>' +
      '<div id="chat-box" hidden>' +
        '<div id="chat-header">' +
          '<span id="chat-header-title">' + tFn("chatbot.headerTitle") + '</span>' +
          '<button id="chat-close" aria-label="Close chat">\u2715</button>' +
        '</div>' +
        '<div id="chat-messages"></div>' +
        '<div id="chat-input-row">' +
          '<input id="chat-input" type="text" placeholder="' + tFn("chatbot.placeholder") + '" autocomplete="off"/>' +
          '<button id="chat-send">' + tFn("chatbot.sendBtn") + '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    // Reminder popup (shown 12 s after badge appears with no interaction)
    '<div id="chat-reminder" hidden role="alertdialog" aria-label="Chat reminder">' +
      '<button id="chat-reminder-close" aria-label="Dismiss reminder">\u2715</button>' +
      (isSlingshotMode()
        ? '<p>\uD83D\uDD34 <strong>Slingshot R — From $200</strong></p><p>Book LA\'s most iconic 3-wheeler. Available now!</p><button id="chat-reminder-cta">Book Now \u2192</button>'
        : '<p>\uD83D\uDE97 <strong>$350/week \u2014 Unlimited Miles!</strong></p><p>Rent a car for DoorDash or Uber Eats and start earning today.</p><button id="chat-reminder-cta">Apply Now \u2192</button>'
      ) +
    '</div>'
  );

  var toggle      = document.getElementById("chat-toggle");
  var badge       = document.getElementById("chat-badge");
  var closeBtn    = document.getElementById("chat-close");
  var chatBox     = document.getElementById("chat-box");
  var input       = document.getElementById("chat-input");
  var sendBtn     = document.getElementById("chat-send");
  var messages    = document.getElementById("chat-messages");
  var reminder    = document.getElementById("chat-reminder");
  var reminderClose = document.getElementById("chat-reminder-close");
  var reminderCta   = document.getElementById("chat-reminder-cta");

  // ── State ──────────────────────────────────────────────────────────────────
  // mode: "greeting" | "faq" | "qualify" | "free"
  var mode         = "greeting";
  var qualifyStep  = 0;
  var qualifyData  = {};
  var userInteracted = false;    // true once the user sends any message or clicks a chip
  var userDismissed  = false;    // true once the user manually closes the chat
  var reminderTimer  = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function addMessage(text, sender) {
    var msg = document.createElement("div");
    msg.className = "chat-msg " + sender;
    if (sender === "bot") {
      // Bot replies are hardcoded static strings (never raw user input), innerHTML is safe.
      // Convert \n to <br> so plain-text replies keep their line breaks.
      msg.innerHTML = text.replace(/\n/g, "<br>");
      // Wire up any "Apply Now" links injected into bot replies so they open the
      // apply modal instead of navigating away (only on the homepage).
      msg.querySelectorAll("#chatApplyLink").forEach(function (link) {
        if (typeof openApplyModal === "function") {
          link.addEventListener("click", function (e) {
            e.preventDefault();
            openApplyModal();
            closeChat();
          });
        }
      });
    } else {
      // User input is always set via innerText to prevent XSS.
      msg.innerText = text;
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function addChips(chips) {
    var row = document.createElement("div");
    row.className = "chat-chips";
    chips.forEach(function(chip) {
      var btn = document.createElement("button");
      btn.className = "chat-chip";
      btn.textContent = chip.label;
      btn.addEventListener("click", function() {
        // Remove chips once one is selected
        if (row.parentNode) row.parentNode.removeChild(row);
        userInteracted = true;
        addMessage(chip.label, "user");
        chip.action();
      });
      row.appendChild(btn);
    });
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Entry point chips ──────────────────────────────────────────────────────
  function showEntryChips() {
    if (isSlingshotMode()) {
      var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
      if (lang === "es") {
        addChips([
          { label: "💰 Precios",                action: function() { showFAQAnswer("pricing");      } },
          { label: "📅 Disponibilidad",         action: function() { showFAQAnswer("availability"); } },
          { label: "💳 Info de Depósito",       action: function() { showFAQAnswer("deposit");      } },
          { label: "📋 Cómo Reservar",          action: function() { showFAQAnswer("booking");      } },
          { label: "🔴 Reservar Slingshot",     action: function() { addMessage("¡Perfecto! Visita <a href=\"car.html?vehicle=slingshot\">esta página</a> para reservar el Slingshot.", "bot"); } }
        ]);
      } else {
        addChips([
          { label: "💰 Pricing",               action: function() { showFAQAnswer("pricing");      } },
          { label: "📅 Availability",          action: function() { showFAQAnswer("availability"); } },
          { label: "💳 Deposit Info",          action: function() { showFAQAnswer("deposit");      } },
          { label: "📋 How to Book",           action: function() { showFAQAnswer("booking");      } },
          { label: "🔴 Book Slingshot",        action: function() { addMessage("Great choice! Visit <a href=\"car.html?vehicle=slingshot\">this page</a> to book the Slingshot.", "bot"); } }
        ]);
      }
      return;
    }
    addChips([
      { label: "✅ Yes, I want to apply",   action: startQualify },
      { label: "❓ I have a question",       action: startFAQ    }
    ]);
  }

  // ── FAQ chip path ──────────────────────────────────────────────────────────
  function startFAQ() {
    mode = "faq";
    setTimeout(function() {
      var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
      if (lang === "es") {
        addMessage("¿Sobre qué te gustaría saber más? 👇", "bot");
      } else {
        addMessage("What would you like to know? 👇", "bot");
      }
      addFAQChips();
    }, 400);
  }

  function addFAQChips() {
    var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
    var chips;
    if (isSlingshotMode()) {
      // Slingshot-only FAQ chips
      if (lang === "es") {
        chips = [
          { label: "💰 Precios",               action: function() { showFAQAnswer("pricing");      } },
          { label: "📅 Disponibilidad",        action: function() { showFAQAnswer("availability"); } },
          { label: "💳 Info de Depósito",      action: function() { showFAQAnswer("deposit");      } },
          { label: "📋 Cómo Reservar",         action: function() { showFAQAnswer("booking");      } },
          { label: "📋 Requisitos",            action: function() { showFAQAnswer("reqs");         } },
          { label: "⏰ Cargo por Mora",         action: function() { showFAQAnswer("latefee");      } },
          { label: "📞 Contacto",              action: function() { showFAQAnswer("contact");      } },
          { label: "🔴 Reservar Slingshot",    action: function() {
            addMessage("¡Visita esta página para reservar: <a href=\"car.html?vehicle=slingshot\">Reservar Slingshot</a>", "bot");
          }}
        ];
      } else {
        chips = [
          { label: "💰 Pricing",               action: function() { showFAQAnswer("pricing");      } },
          { label: "📅 Availability",          action: function() { showFAQAnswer("availability"); } },
          { label: "💳 Deposit Info",          action: function() { showFAQAnswer("deposit");      } },
          { label: "📋 How to Book",           action: function() { showFAQAnswer("booking");      } },
          { label: "📋 Requirements",          action: function() { showFAQAnswer("reqs");         } },
          { label: "⏰ Late Fee Policy",        action: function() { showFAQAnswer("latefee");      } },
          { label: "📞 Contact",               action: function() { showFAQAnswer("contact");      } },
          { label: "🔴 Book Slingshot",        action: function() {
            addMessage("Visit this page to book: <a href=\"car.html?vehicle=slingshot\">Book the Slingshot</a>", "bot");
          }}
        ];
      }
    } else if (lang === "es") {
      chips = [
        { label: "💰 Precios",              action: function() { showFAQAnswer("pricing");      } },
        { label: "🚗 Autos Disponibles",    action: function() { showFAQAnswer("cars");         } },
        { label: "📅 Disponibilidad",       action: function() { showFAQAnswer("availability"); } },
        { label: "📋 Requisitos",           action: function() { showFAQAnswer("reqs");         } },
        { label: "📞 Contacto",             action: function() { showFAQAnswer("contact");      } },
        { label: "✅ Solicitar Ahora",       action: startQualify }
      ];
    } else {
      chips = [
        { label: "💰 Pricing",              action: function() { showFAQAnswer("pricing");      } },
        { label: "🚗 Available Cars",       action: function() { showFAQAnswer("cars");         } },
        { label: "📅 Check Availability",   action: function() { showFAQAnswer("availability"); } },
        { label: "📋 Requirements",         action: function() { showFAQAnswer("reqs");         } },
        { label: "📞 Contact",              action: function() { showFAQAnswer("contact");      } },
        { label: "✅ Apply Now",             action: startQualify }
      ];
    }
    addChips(chips);
  }

  function showFAQAnswer(topic) {
    var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
    var replies = {
      pricing: {
        en: function() { return buildChatPricingText("en"); },
        es: function() { return buildChatPricingText("es"); }
      },
      cars: {
        en: function() { return buildFleetMessage("en"); },
        es: function() { return buildFleetMessage("es"); }
      },
      deposit: {
        en: function() { return buildChatDepositText("en"); },
        es: function() { return buildChatDepositText("es"); }
      },
      reqs: {
        en: isSlingshotMode()
          ? "📋 Requirements to Rent the Slingshot\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • License must not be expired\n  • Upload a photo of your license during booking\n  • Auto insurance (own policy) OR add our Damage Protection Plan"
          : "📋 Requirements to Rent\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • At least 3 months of driving experience\n  • License must not be expired\n  • Upload a photo of your license during booking",
        es: isSlingshotMode()
          ? "📋 Requisitos para Rentar el Slingshot\n\n✅ Lo que necesitarás:\n  • Licencia de conducir válida emitida por el gobierno\n  • Debe tener 21 años o más\n  • La licencia no debe estar vencida\n  • Subir foto de la licencia durante la reserva\n  • Seguro de auto propio O añadir nuestro Plan de Protección"
          : "📋 Requisitos para Alquilar\n\n✅ Lo que necesitarás:\n  • Licencia de conducir válida emitida por el gobierno\n  • Debe tener 21 años o más\n  • Al menos 3 meses de experiencia al volante\n  • La licencia no debe estar vencida\n  • Subir una foto de tu licencia durante la reserva"
      },
      contact: {
        en: "You can reach us at:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours!",
        es: "Puedes contactarnos en:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\n¡Generalmente respondemos dentro de pocas horas!"
      },
      availability: {
        en: function() {
          return isSlingshotMode()
            ? getVehicleBookingInfo("slingshot", "en")
            : buildAvailabilityMessage("en");
        },
        es: function() {
          return isSlingshotMode()
            ? getVehicleBookingInfo("slingshot", "es")
            : buildAvailabilityMessage("es");
        }
      },
      booking: {
        en: "Booking the Slingshot R is easy! 🔴\n\n1. Click the link below to open the booking page\n2. Choose your rental duration (3 hrs · 6 hrs · 24 hrs · 48 hrs · 72 hrs)\n3. Pick your pickup date & time\n4. Enter your name, email & phone\n5. Upload your Driver's License\n6. Sign the rental agreement\n7. Click 💳 Pay Now — the rental fee + matching refundable deposit are charged at booking\n\n<a href=\"car.html?vehicle=slingshot\">👉 Book the Slingshot Now</a>",
        es: "¡Reservar el Slingshot R es fácil! 🔴\n\n1. Haz clic en el enlace de abajo para abrir la página de reservas\n2. Elige la duración del alquiler (3 hrs · 6 hrs · 24 hrs · 48 hrs · 72 hrs)\n3. Selecciona tu fecha y hora de recogida\n4. Ingresa tu nombre, correo y teléfono\n5. Sube tu Licencia de Conducir\n6. Firma el contrato de alquiler\n7. Haz clic en 💳 Pagar Ahora — el alquiler + depósito reembolsable se cobran al reservar\n\n<a href=\"car.html?vehicle=slingshot\">👉 Reservar el Slingshot Ahora</a>"
      },
      latefee: {
        en: "⏰ Late Return Fee — Slingshot\n\nA <strong>30-minute grace period</strong> is provided after your scheduled return time.\n\nAfter the grace period: <strong>$100/hour</strong> for each hour (or part thereof) you are late.\n\nPlease return the vehicle on time to avoid late charges! 🙏",
        es: "⏰ Cargo por Devolución Tardía — Slingshot\n\nSe proporciona un <strong>período de gracia de 30 minutos</strong> después de tu hora de devolución programada.\n\nDespués del período de gracia: <strong>$100/hora</strong> por cada hora (o fracción) de retraso.\n\n¡Por favor devuelve el vehículo a tiempo para evitar cargos por mora! 🙏"
      }
    };
    var replyValue = (replies[topic] && replies[topic][lang]) || (replies[topic] && replies[topic]["en"]) || "";
    var msg = typeof replyValue === "function" ? replyValue() : replyValue;
    setTimeout(function() {
      addMessage(msg, "bot");
      // Show follow-up chips after FAQ answer
      setTimeout(function() {
        var lang2 = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        if (isSlingshotMode()) {
          addChips([
            { label: lang2 === "es" ? "🔙 Más preguntas"        : "🔙 More questions",   action: startFAQ },
            { label: lang2 === "es" ? "🔴 Reservar Slingshot"   : "🔴 Book Slingshot",   action: function() {
              addMessage(lang2 === "es"
                ? "¡Visita <a href=\"car.html?vehicle=slingshot\">esta página</a> para reservar el Slingshot!"
                : "Visit <a href=\"car.html?vehicle=slingshot\">this page</a> to book the Slingshot!", "bot");
            }}
          ]);
        } else {
          addChips([
            { label: lang2 === "es" ? "🔙 Más preguntas"  : "🔙 More questions",  action: startFAQ    },
            { label: lang2 === "es" ? "✅ Solicitar Ahora" : "✅ Apply Now",        action: startQualify }
          ]);
        }
      }, 600);
    }, 400);
  }

  // ── Guided qualification flow ──────────────────────────────────────────────
  var QUALIFY_STEPS = ["name", "phone", "license", "app", "experience", "terms"];

  function startQualify() {
    // In Slingshot mode there is no delivery-app qualify flow — redirect to booking.
    if (isSlingshotMode()) {
      var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
      setTimeout(function() {
        if (lang === "es") {
          addMessage("¡Reservar es rápido y fácil! 🔴\n\nVisita <a href=\"car.html?vehicle=slingshot\">esta página</a> para elegir tu duración, ingresar tus datos y pagar de forma segura.", "bot");
        } else {
          addMessage("Booking is quick and easy! 🔴\n\nVisit <a href=\"car.html?vehicle=slingshot\">this page</a> to pick your duration, enter your info, and pay securely.", "bot");
        }
        setTimeout(function() {
          var lang2 = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
          addChips([
            { label: lang2 === "es" ? "🔙 Más preguntas" : "🔙 More questions", action: startFAQ }
          ]);
        }, 600);
      }, 400);
      return;
    }
    mode        = "qualify";
    qualifyStep = 0;
    qualifyData = {};
    setTimeout(function() {
      var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
      if (lang === "es") {
        addMessage("¡Vamos a comenzar! 🚀\n\n¿Cuál es tu nombre completo?", "bot");
      } else {
        addMessage("Let's get you approved! 🚀\n\nWhat's your full name?", "bot");
      }
    }, 400);
  }

  function handleQualifyInput(text) {
    var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
    var step = QUALIFY_STEPS[qualifyStep];

    if (step === "name") {
      qualifyData.name = text.trim();
      qualifyStep++;
      setTimeout(function() {
        if (lang === "es") {
          addMessage("¡Mucho gusto, <strong>" + escHtml(qualifyData.name) + "</strong>! 👋\n\n¿Cuál es tu número de teléfono? (Necesitamos contactarte para completar la aprobación)", "bot");
        } else {
          addMessage("Nice to meet you, <strong>" + escHtml(qualifyData.name) + "</strong>! 👋\n\nWhat's your phone number? (We need it to contact you for approval)", "bot");
        }
      }, 400);
      return;
    }

    if (step === "phone") {
      qualifyData.phone = text.trim();
      qualifyStep++;
      setTimeout(function() {
        if (lang === "es") {
          addMessage("Perfecto 📞\n\n¿Tienes una licencia de conducir válida y vigente?", "bot");
          addChips([
            { label: "✅ Sí, tengo licencia", action: function() { handleQualifyChip("license", "yes"); } },
            { label: "❌ No tengo licencia",  action: function() { handleQualifyChip("license", "no");  } }
          ]);
        } else {
          addMessage("Got it 📞\n\nDo you have a valid, non-expired driver's license?", "bot");
          addChips([
            { label: "✅ Yes, I have a license", action: function() { handleQualifyChip("license", "yes"); } },
            { label: "❌ No license",             action: function() { handleQualifyChip("license", "no");  } }
          ]);
        }
      }, 400);
      return;
    }

    if (step === "app") {
      qualifyData.app = text.trim();
      qualifyStep++;
      setTimeout(function() {
        if (lang === "es") {
          addMessage("¿Cuántos meses tienes de experiencia manejando?", "bot");
          addChips([
            { label: "Menos de 3 meses",  action: function() { handleQualifyChip("experience", "lt3");  } },
            { label: "3–12 meses",        action: function() { handleQualifyChip("experience", "3to12"); } },
            { label: "Más de 1 año",      action: function() { handleQualifyChip("experience", "gt1y"); } }
          ]);
        } else {
          addMessage("How many months of driving experience do you have?", "bot");
          addChips([
            { label: "Less than 3 months", action: function() { handleQualifyChip("experience", "lt3");  } },
            { label: "3–12 months",        action: function() { handleQualifyChip("experience", "3to12"); } },
            { label: "More than 1 year",   action: function() { handleQualifyChip("experience", "gt1y"); } }
          ]);
        }
      }, 400);
      return;
    }

    // Free-text fallback for other steps (shouldn't normally be reached)
    setTimeout(function() {
      addMessage(getBotReply(text), "bot");
    }, 400);
  }

  function handleQualifyChip(field, value) {
    var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";

    if (field === "license") {
      qualifyData.license = value;
      qualifyStep++;

      if (value === "no") {
        // Cannot proceed without license
        setTimeout(function() {
          if (lang === "es") {
            addMessage("Lo sentimos — se requiere una licencia de conducir válida para alquilar con nosotros. 😔\n\nCuando obtengas tu licencia, ¡estaremos aquí! Puedes preguntar sobre nuestros autos o tarifas mientras tanto.", "bot");
            addChips([{ label: "🔙 Más preguntas", action: startFAQ }]);
          } else {
            addMessage("Sorry — a valid driver's license is required to rent with us. 😔\n\nWhen you get your license, we'll be here! You can ask about our cars or rates in the meantime.", "bot");
            addChips([{ label: "🔙 Ask a question", action: startFAQ }]);
          }
          mode = "free";
        }, 400);
        return;
      }

      // Has license — ask about delivery app
      setTimeout(function() {
        if (lang === "es") {
          addMessage("¡Excelente! 🎉\n\n¿Para qué aplicación(es) de entrega planeas manejar?", "bot");
          addChips([
            { label: "DoorDash",      action: function() { handleQualifyChip("app", "DoorDash");     } },
            { label: "Uber Eats",     action: function() { handleQualifyChip("app", "Uber Eats");    } },
            { label: "Instacart",     action: function() { handleQualifyChip("app", "Instacart");    } },
            { label: "Amazon Flex",   action: function() { handleQualifyChip("app", "Amazon Flex");  } },
            { label: "Otra",          action: function() { handleQualifyChip("app", "Other");        } }
          ]);
        } else {
          addMessage("Great! 🎉\n\nWhich delivery app(s) are you planning to drive for?", "bot");
          addChips([
            { label: "DoorDash",      action: function() { handleQualifyChip("app", "DoorDash");     } },
            { label: "Uber Eats",     action: function() { handleQualifyChip("app", "Uber Eats");    } },
            { label: "Instacart",     action: function() { handleQualifyChip("app", "Instacart");    } },
            { label: "Amazon Flex",   action: function() { handleQualifyChip("app", "Amazon Flex");  } },
            { label: "Other",         action: function() { handleQualifyChip("app", "Other");        } }
          ]);
        }
      }, 400);
      return;
    }

    if (field === "app") {
      qualifyData.app = value;
      qualifyStep++;
      setTimeout(function() {
        if (lang === "es") {
          addMessage("¿Cuántos meses tienes de experiencia manejando?", "bot");
          addChips([
            { label: "Menos de 3 meses",  action: function() { handleQualifyChip("experience", "lt3");  } },
            { label: "3–12 meses",        action: function() { handleQualifyChip("experience", "3to12"); } },
            { label: "Más de 1 año",      action: function() { handleQualifyChip("experience", "gt1y"); } }
          ]);
        } else {
          addMessage("How many months of driving experience do you have?", "bot");
          addChips([
            { label: "Less than 3 months", action: function() { handleQualifyChip("experience", "lt3");  } },
            { label: "3–12 months",        action: function() { handleQualifyChip("experience", "3to12"); } },
            { label: "More than 1 year",   action: function() { handleQualifyChip("experience", "gt1y"); } }
          ]);
        }
      }, 400);
      return;
    }

    if (field === "experience") {
      qualifyData.experience = value;
      qualifyStep++;
      setTimeout(function() {
        if (lang === "es") {
          addMessage("¡Casi listo! 🏁\n\n¿Aceptas los <a href=\"rental-agreement.html\" target=\"_blank\">Términos del Contrato de Alquiler</a>?", "bot");
          addChips([
            { label: "✅ Acepto los términos", action: function() { handleQualifyChip("terms", "yes"); } },
            { label: "📄 Leer primero",        action: function() { handleQualifyChip("terms", "read"); } }
          ]);
        } else {
          addMessage("Almost done! 🏁\n\nDo you agree to the <a href=\"rental-agreement.html\" target=\"_blank\">Rental Agreement Terms</a>?", "bot");
          addChips([
            { label: "✅ I agree to the terms", action: function() { handleQualifyChip("terms", "yes"); } },
            { label: "📄 Read first",            action: function() { handleQualifyChip("terms", "read"); } }
          ]);
        }
      }, 400);
      return;
    }

    if (field === "terms") {
      if (value === "read") {
        setTimeout(function() {
          if (lang === "es") {
            addMessage("Por supuesto — puedes leer el contrato completo en <a href=\"rental-agreement.html\" target=\"_blank\">esta página</a>.\n\n¿Aceptas los términos?", "bot");
            addChips([
              { label: "✅ Acepto los términos", action: function() { handleQualifyChip("terms", "yes"); } }
            ]);
          } else {
            addMessage("Of course — you can read the full agreement on <a href=\"rental-agreement.html\" target=\"_blank\">this page</a>.\n\nDo you agree to the terms?", "bot");
            addChips([
              { label: "✅ I agree to the terms", action: function() { handleQualifyChip("terms", "yes"); } }
            ]);
          }
        }, 400);
        return;
      }

      // terms = yes → run pre-approval logic
      qualifyData.terms = true;
      qualifyStep++;
      runPreApproval();
      return;
    }
  }

  // ── Pre-approval logic ─────────────────────────────────────────────────────
  function runPreApproval() {
    var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
    var hasLicense  = qualifyData.license === "yes";
    var enoughExp   = qualifyData.experience === "3to12" || qualifyData.experience === "gt1y";
    var agreedTerms = !!qualifyData.terms;

    setTimeout(function() {
      if (hasLicense && enoughExp && agreedTerms) {
        // APPROVED
        if (lang === "es") {
          addMessage(
            "🎉 <strong>¡Parece que cumples los requisitos, " + escHtml(qualifyData.name || "amigo") + "!</strong>\n\n" +
            "✅ Licencia de conducir: Válida\n✅ Experiencia: Suficiente\n✅ Términos: Aceptados\n\n" +
            "El siguiente paso es completar tu solicitud oficial para que nuestro equipo pueda contactarte.\n\n" +
            "<a href=\"index.html\" id=\"chatApplyLink\">👉 Completar solicitud ahora</a>",
            "bot"
          );
        } else {
          addMessage(
            "🎉 <strong>Great news, " + escHtml(qualifyData.name || "there") + "! You appear to qualify!</strong>\n\n" +
            "✅ Driver's license: Valid\n✅ Experience: Sufficient\n✅ Terms: Agreed\n\n" +
            "The next step is completing your official application so our team can reach out to you.\n\n" +
            "<a href=\"index.html\" id=\"chatApplyLink\">👉 Complete your application now</a>",
            "bot"
          );
        }
      } else if (hasLicense && !enoughExp) {
        // NEEDS REVIEW — license but limited experience
        if (lang === "es") {
          addMessage(
            "⚠️ <strong>" + escHtml(qualifyData.name || "Amigo") + ", necesitamos revisar tu solicitud.</strong>\n\n" +
            "Requerimos al menos 3 meses de experiencia al volante.\n\n" +
            "Sin embargo, puedes enviar tu solicitud y nuestro equipo la revisará personalmente. " +
            "¡A veces hacemos excepciones!\n\n" +
            "<a href=\"index.html\" id=\"chatApplyLink\">👉 Enviar solicitud de todas formas</a>",
            "bot"
          );
        } else {
          addMessage(
            "⚠️ <strong>" + escHtml(qualifyData.name || "Hi") + ", your application needs review.</strong>\n\n" +
            "We typically require at least 3 months of driving experience.\n\n" +
            "However, you can still submit your application and our team will review it personally — we sometimes make exceptions!\n\n" +
            "<a href=\"index.html\" id=\"chatApplyLink\">👉 Submit application anyway</a>",
            "bot"
          );
        }
      } else {
        // REJECTED — no license
        if (lang === "es") {
          addMessage(
            "😔 <strong>Lo sentimos, " + escHtml(qualifyData.name || "amigo") + ".</strong>\n\n" +
            "Una licencia de conducir válida es un requisito estricto.\n\n" +
            "Cuando obtengas tu licencia, ¡estaremos aquí para ayudarte!",
            "bot"
          );
        } else {
          addMessage(
            "😔 <strong>Sorry, " + escHtml(qualifyData.name || "there") + ".</strong>\n\n" +
            "A valid driver's license is a strict requirement.\n\n" +
            "When you get your license, come back and we'll be happy to help!",
            "bot"
          );
        }
      }
      mode = "free";
    }, 600);
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function openChat() {
    chatBox.hidden = false;
    toggle.hidden  = true;
    badge.hidden   = true;
    dismissReminder();
    if (!messages.children.length) {
      var welcome;
      if (isSlingshotMode()) {
        var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        welcome = lang === "es"
          ? "¡Hola! 👋 Bienvenido a <strong>SLY Slingshot Rentals</strong> 🔴\n\nPuedo ayudarte con:\n• 💰 Precios y depósitos\n• 📅 Disponibilidad\n• 📋 Cómo reservar\n• 📞 Contacto\n\n¿Qué necesitas saber?"
          : "Hi! 👋 Welcome to <strong>SLY Slingshot Rentals</strong> 🔴\n\nI can help you with:\n• 💰 Pricing &amp; deposits\n• 📅 Availability\n• 📋 How to book\n• 📞 Contact info\n\nWhat would you like to know?";
      } else {
        welcome = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.welcome") : "Hi! 👋";
      }
      addMessage(welcome, "bot");
      setTimeout(showEntryChips, 600);
    }
    input.focus();
  }

  function closeChat() {
    chatBox.hidden = true;
    toggle.hidden  = false;
    userDismissed  = true;
  }

  function dismissReminder() {
    reminder.hidden = true;
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
  }

  // ── Send message ──────────────────────────────────────────────────────────
  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;
    userInteracted = true;
    addMessage(text, "user");
    input.value = "";

    if (mode === "qualify") {
      handleQualifyInput(text);
    } else {
      setTimeout(function() {
        var reply;
        try {
          reply = getBotReply(text);
        } catch (e) {
          reply = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.fallback") : "I\u2019m not sure about that one \uD83E\uDD14\n\nTry asking about:\n\u2022 Pricing\n\u2022 Available cars\n\u2022 How to book\n\u2022 Contact info\n\nOr email us at slyservices@supports-info.com";
        }
        addMessage(reply, "bot");
        // After any free-text reply in non-qualify mode, offer follow-up chips
        if (mode === "free" || mode === "faq") {
          setTimeout(function() {
            var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
            if (isSlingshotMode()) {
              addChips([
                { label: lang === "es" ? "🔴 Reservar Slingshot" : "🔴 Book Slingshot", action: function() {
                  addMessage(lang === "es"
                    ? "Visita <a href=\"car.html?vehicle=slingshot\">esta página</a> para reservar el Slingshot."
                    : "Visit <a href=\"car.html?vehicle=slingshot\">this page</a> to book the Slingshot.", "bot");
                }},
                { label: lang === "es" ? "❓ Más preguntas" : "❓ More questions", action: startFAQ }
              ]);
            } else {
              addChips([
                { label: lang === "es" ? "✅ Solicitar Ahora" : "✅ Apply Now",  action: startQualify },
                { label: lang === "es" ? "❓ Más preguntas"  : "❓ More questions", action: startFAQ }
              ]);
            }
          }, 800);
        }
      }, 400);
    }
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  toggle.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMessage(); });

  reminderClose.addEventListener("click", function() {
    dismissReminder();
    userDismissed = true;
  });
  reminderCta.addEventListener("click", function() {
    dismissReminder();
    openChat();
  });

  // ── Badge + reminder logic ─────────────────────────────────────────────────
  // Show badge on toggle after scroll-halfway AND 10–20 s delay.
  // Then show reminder popup 12 s after badge appears if still no interaction.
  var badgeShown  = false;
  var scrolledHalf = false;

  function maybeShowBadge() {
    if (badgeShown || userInteracted || !chatBox.hidden) return;
    badge.hidden = false;
    badge.setAttribute("aria-hidden", "false");
    toggle.classList.add("chat-toggle-pulse");
    badgeShown = true;
    // Show reminder 12 s after badge if user hasn't interacted yet
    reminderTimer = setTimeout(function() {
      if (!userInteracted && chatBox.hidden && !userDismissed) {
        reminder.hidden = false;
      }
    }, 12000);
  }

  // Single scroll listener: sets scrolledHalf flag and shows badge if delay has already passed.
  window.addEventListener("scroll", function() {
    if (scrolledHalf) return;
    var halfwayPoint = document.documentElement.scrollHeight / 2;
    if (window.scrollY + window.innerHeight >= halfwayPoint) {
      scrolledHalf = true;
      // If the auto-open delay has already fired (badgeShown not set yet and chat still hidden)
      // show the badge now; otherwise the delay timer will call maybeShowBadge() when it fires.
      if (!badgeShown && !userInteracted && chatBox.hidden) {
        maybeShowBadge();
      }
    }
  }, { passive: true });

  // Auto-open OR show badge after 10–20 s random delay
  var autoDelay = Math.floor(Math.random() * 10000) + 10000; // 10–20 s
  setTimeout(function() {
    if (userInteracted || !chatBox.hidden) return;
    if (scrolledHalf) {
      // User has scrolled halfway — show badge+pulse instead of auto-opening
      maybeShowBadge();
    } else {
      // Auto-open the chatbot (original behavior)
      if (!userDismissed) {
        openChat();
      }
    }
  }, autoDelay);

  // ── Language change hook ──────────────────────────────────────────────────
  window.updateChatbotLang = function() {
    var newT = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t : function(k) { return k; };
    var headerTitle = document.getElementById("chat-header-title");
    var chatInput   = document.getElementById("chat-input");
    var chatSendBtn = document.getElementById("chat-send");
    if (headerTitle) headerTitle.textContent = newT("chatbot.headerTitle");
    if (chatInput)   chatInput.setAttribute("placeholder", newT("chatbot.placeholder"));
    if (chatSendBtn) chatSendBtn.textContent = newT("chatbot.sendBtn");
  };
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", buildChatbot)
  : buildChatbot();
