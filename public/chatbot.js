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

// ── Live fleet status + booked dates (fetched at startup) ─────────────────────
var CHATBOT_API_BASE = "https://sly-rides.vercel.app";
var slyFleetStatus  = null;
var slyBookedDates  = null;

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

// ── Booking-info helpers ───────────────────────────────────────────────────────

/** Format an ISO date string (YYYY-MM-DD) as "March 28, 2026". */
function fmtDateChatbot(iso, locale) {
  var p = iso.split("-");
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return d.toLocaleDateString(locale || "en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Return the ISO date of the day after the given ISO date. */
function nextDayChatbot(iso) {
  var p = iso.split("-");
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Return a human-readable booking-status string for a single vehicle.
 * Checks slyBookedDates for the active rental and the next upcoming one.
 */
function getVehicleBookingInfo(vehicleId, lang) {
  var locale = lang === "es" ? "es-US" : "en-US";
  var names = { slingshot: "Slingshot R",
                camry: "Camry 2012", camry2013: "Camry 2013 SE" };
  var vName = names[vehicleId] || vehicleId;

  if (!slyBookedDates) {
    return lang === "es"
      ? "No pude obtener la información de reservas ahora mismo. Llámanos al 📞 (213) 916-6606 para información actualizada."
      : "I couldn't load the latest booking info right now. Call us at 📞 (213) 916-6606 for up-to-date availability.";
  }

  var today  = new Date().toISOString().slice(0, 10);
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
  var ids   = ["slingshot", "camry", "camry2013"];
  var icons = { slingshot: "🔴", camry: "🔵", camry2013: "🟢" };
  var names = { slingshot: "Slingshot R",
                camry: "Camry 2012", camry2013: "Camry 2013 SE" };
  var locale = lang === "es" ? "es-US" : "en-US";
  var today  = new Date().toISOString().slice(0, 10);

  var lines = [];
  for (var k = 0; k < ids.length; k++) {
    var id     = ids[k];
    var vName  = names[id];
    var icon   = icons[id];
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
  var today  = new Date().toISOString().slice(0, 10);

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

  if (lang === "es") {
    return "Contamos con <strong>3 vehículos</strong> en nuestra flota:\n\n" +
      "🔴 Slingshot R — Deportivo 2 plazas" + statusLine("slingshot") + "\n" +
      "   3 hrs $200 · 6 hrs $250 · 24 hrs $350\n" +
      "   🔒 $50 depósito no reembolsable al reservar · $150 seguridad al recoger\n\n" +
      "🔵 Camry 2012 — $55/día o $350/semana, Millaje Ilimitado (sin depósito)" + statusLine("camry") + "\n\n" +
      "🟢 Camry 2013 SE — $55/día o $350/semana, Millaje Ilimitado (sin depósito)" + statusLine("camry2013") + "\n\n" +
      "¡Visita nuestra página de Autos para ver y reservar!";
  }
  return "We have <strong>3 vehicles</strong> in our fleet:\n\n" +
    "🔴 Slingshot R — Sports 2-Seater" + statusLine("slingshot") + "\n" +
    "   3 hrs $200 · 6 hrs $250 · 24 hrs $350\n" +
    "   🔒 $50 non-refundable deposit to book · $150 security deposit at pickup\n\n" +
    "🔵 Camry 2012 — $55/day or $350/week, Unlimited Miles (no deposit)" + statusLine("camry") + "\n\n" +
    "🟢 Camry 2013 SE — $55/day or $350/week, Unlimited Miles (no deposit)" + statusLine("camry2013") + "\n\n" +
    "Visit our Cars page to browse and book!";
}

var botResponses = {
  en: [
    {
      patterns: ["hello","hi","hey","howdy","sup","what's up"],
      reply: "Hey! 👋 Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\nOur cars are <strong>$350/week with unlimited miles</strong>. I can help you get approved quickly.\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Click here to apply and get approved</a>"
    },
    {
      patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot"],
      reply: "Here are the Slingshot R rates 🔴 (we have 2 units)\n\n⏱ Hourly Tiers (Sports 2-Seater):\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n\n🔒 $50 non-refundable reservation deposit required to book\n   (applied toward your total at pickup)\n💳 $150 refundable security deposit due at pickup\n\nReady to book? Visit our Cars page!"
    },
    {
      patterns: ["camry price","camry cost","camry rate","camry how much","camry fee","how much is the camry","how much for the camry","how much camry","price of camry","cost of camry"],
      reply: "Here are the Camry rates 🔵🟢\n\n🔵 Camry 2012\n  • Daily       — $55 / day\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n\n🟢 Camry 2013 SE\n  • Daily       — $55 / day\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n\n✅ No security deposit required\n\nReady to book? Visit our Cars page!\n\n📋 Do you have a valid driving license?"
    },
    {
      patterns: ["price","cost","how much","rate","rates","fee","fees","daily","weekly","monthly"],
      reply: "Here are our current rates 🚗\n\n🔴 Slingshot R — Sports 2-Seater (2 units available)\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n  • 🔒 $50 non-refundable reservation deposit (to book)\n  • 💳 $150 security deposit (due at pickup)\n\n🔵 Camry 2012\n  • Daily     — $55 / day\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit required\n\n🟢 Camry 2013 SE\n  • Daily     — $55 / day\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit required\n\nAsk me about a specific car for more details!"
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
      reply: "Here's our deposit info 💰\n\n🔴 Slingshot R:\n  • $50 non-refundable reservation deposit (charged at booking to secure your reservation)\n  • $150 refundable security deposit (due at pickup)\n🔵 Camry 2012: No deposit required\n🟢 Camry 2013 SE: No deposit required\n\n⚠️ The Slingshot $50 deposit is NON-REFUNDABLE and forfeited if you cancel or no-show."
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
    }
  ],

  es: [
    {
      patterns: ["hola","buenos días","buenas tardes","buenas noches","buenas","qué tal","qué onda","saludos"],
      reply: "¡Hola! 👋 ¿Quieres alquilar un auto para DoorDash, Uber Eats u otras aplicaciones de entrega?\n\nNuestros autos son <strong>$350/semana con millaje ilimitado</strong>. Puedo ayudarte a obtener aprobación rápidamente.\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Haz clic aquí para solicitar y obtener aprobación</a>"
    },
    {
      patterns: ["precio slingshot","costo slingshot","cuánto slingshot","cuanto slingshot","tarifa slingshot","slingshot precio","slingshot costo"],
      reply: "Aquí están las tarifas del Slingshot R 🔴 (tenemos 2 unidades)\n\n⏱ Tarifas por Horas (Deportivo 2 plazas):\n  • 3 Horas  — $200\n  • 6 Horas  — $250\n  • 24 Horas — $350\n\n🔒 $50 de depósito de reserva no reembolsable (para asegurar tu reserva)\n💳 $150 de depósito de seguridad reembolsable (a pagar al recoger)\n\n¿Listo para reservar? ¡Visita nuestra página de autos!"
    },
    {
      patterns: ["precio camry","costo camry","cuánto camry","cuanto camry","tarifa camry","camry precio","camry costo"],
      reply: "Aquí están las tarifas del Camry 🔵🟢\n\n🔵 Camry 2012\n  • Diario    — $55 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n\n🟢 Camry 2013 SE\n  • Diario    — $55 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n\n✅ No se requiere depósito de seguridad\n\n¿Listo para reservar?\n\n📋 ¿Tienes una licencia de conducir válida?"
    },
    {
      patterns: ["precio","costo","cuánto cuesta","cuanto cuesta","cuánto es","cuanto es","tarifa","tarifas","cobran","cobras","diario","semanal","mensual"],
      reply: "Aquí están nuestras tarifas actuales 🚗\n\n🔴 Slingshot R — Deportivo 2 plazas (2 unidades disponibles)\n  • 3 Horas  — $200\n  • 6 Horas  — $250\n  • 24 Horas — $350\n  • 🔒 $50 depósito de reserva no reembolsable (al reservar)\n  • 💳 $150 depósito de seguridad (al recoger)\n\n🔵 Camry 2012\n  • Diario    — $55 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n  • Sin depósito\n\n🟢 Camry 2013 SE\n  • Diario    — $55 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n  • Sin depósito\n\n¡Pregúntame sobre un auto específico para más detalles!"
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
      reply: "Aquí está nuestra información de depósito 💰\n\n🔴 Slingshot R:\n  • $50 depósito de reserva no reembolsable (cobrado al reservar)\n  • $150 depósito de seguridad reembolsable (a pagar al recoger)\n🔵 Camry 2012: No se requiere depósito\n🟢 Camry 2013 SE: No se requiere depósito\n\n⚠️ El depósito de $50 del Slingshot es NO REEMBOLSABLE y se pierde si cancelas o no te presentas."
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
    }
  ]
};

function getBotReply(input) {
  var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : (localStorage.getItem("slyLang") || "en");
  var responses = botResponses[lang] || botResponses["en"];
  var lower = input.toLowerCase();
  for (var i = 0; i < responses.length; i++) {
    var item = responses[i];
    if (item.patterns.some(function(p) { return lower.includes(p); })) {
      return typeof item.reply === "function" ? item.reply() : item.reply;
    }
  }
  // Also try English responses as fallback for bilingual users
  if (lang === "es") {
    var enResponses = botResponses["en"];
    for (var j = 0; j < enResponses.length; j++) {
      var enItem = enResponses[j];
      if (enItem.patterns.some(function(p) { return lower.includes(p); })) {
        return typeof enItem.reply === "function" ? enItem.reply() : enItem.reply;
      }
    }
  }
  return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.fallback") : "I\u2019m not sure about that one \uD83E\uDD14\n\nTry asking about:\n\u2022 Pricing\n\u2022 Available cars\n\u2022 How to book\n\u2022 Delivery apps\n\u2022 Contact info\n\nOr email us at slyservices@supports-info.com";
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
      '<p>\uD83D\uDE97 <strong>$350/week — Unlimited Miles!</strong></p>' +
      '<p>Rent a car for DoorDash or Uber Eats and start earning today.</p>' +
      '<button id="chat-reminder-cta">Apply Now \u2192</button>' +
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
    if (lang === "es") {
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
        en: "Here are our current rates 🚗\n\n🔴 Slingshot R — Sports 2-Seater (2 units)\n  • 3 Hours — $200\n  • 6 Hours — $250\n  • 24 Hours — $350\n  • 🔒 $50 non-refundable reservation deposit (to book)\n  • 💳 $150 security deposit (due at pickup)\n\n🔵 Camry 2012\n  • Daily — $55 / day\n  • 1 Week — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650\n  • 1 Month — $1,300\n  • No deposit\n\n🟢 Camry 2013 SE\n  • Daily — $55 / day\n  • 1 Week — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650\n  • 1 Month — $1,300\n  • No deposit",
        es: "Aquí están nuestras tarifas actuales 🚗\n\n🔴 Slingshot R — Deportivo 2 plazas (2 unidades)\n  • 3 Horas — $200\n  • 6 Horas — $250\n  • 24 Horas — $350\n  • 🔒 $50 depósito de reserva no reembolsable (al reservar)\n  • 💳 $150 depósito de seguridad (al recoger)\n\n🔵 Camry 2012\n  • Diario — $55 / día\n  • 1 Semana — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650\n  • 1 Mes — $1,300\n  • Sin depósito\n\n🟢 Camry 2013 SE\n  • Diario — $55 / día\n  • 1 Semana — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650\n  • 1 Mes — $1,300\n  • Sin depósito"
      },
      cars: {
        en: function() { return buildFleetMessage("en"); },
        es: function() { return buildFleetMessage("es"); }
      },
      reqs: {
        en: "📋 Requirements to Rent\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • At least 3 months of driving experience\n  • License must not be expired\n  • Upload a photo of your license during booking",
        es: "📋 Requisitos para Alquilar\n\n✅ Lo que necesitarás:\n  • Licencia de conducir válida emitida por el gobierno\n  • Debe tener 21 años o más\n  • Al menos 3 meses de experiencia al volante\n  • La licencia no debe estar vencida\n  • Subir una foto de tu licencia durante la reserva"
      },
      contact: {
        en: "You can reach us at:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours!",
        es: "Puedes contactarnos en:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\n¡Generalmente respondemos dentro de pocas horas!"
      },
      availability: {
        en: function() { return buildAvailabilityMessage("en"); },
        es: function() { return buildAvailabilityMessage("es"); }
      }
    };
    var replyValue = (replies[topic] && replies[topic][lang]) || (replies[topic] && replies[topic]["en"]) || "";
    var msg = typeof replyValue === "function" ? replyValue() : replyValue;
    setTimeout(function() {
      addMessage(msg, "bot");
      // Show back-to-apply chip after FAQ answer
      setTimeout(function() {
        var lang2 = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
        addChips([
          { label: lang2 === "es" ? "🔙 Más preguntas"  : "🔙 More questions",  action: startFAQ    },
          { label: lang2 === "es" ? "✅ Solicitar Ahora" : "✅ Apply Now",        action: startQualify }
        ]);
      }, 600);
    }, 400);
  }

  // ── Guided qualification flow ──────────────────────────────────────────────
  var QUALIFY_STEPS = ["name", "phone", "license", "app", "experience", "terms"];

  function startQualify() {
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
      var welcome = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.welcome") : "Hi! 👋";
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
        var reply = getBotReply(text);
        addMessage(reply, "bot");
        // After any free-text reply in non-qualify mode, offer to apply
        if (mode === "free" || mode === "faq") {
          setTimeout(function() {
            var lang = (window.slyI18n && window.slyI18n.getLang) ? window.slyI18n.getLang() : "en";
            addChips([
              { label: lang === "es" ? "✅ Solicitar Ahora" : "✅ Apply Now",  action: startQualify },
              { label: lang === "es" ? "❓ Más preguntas"  : "❓ More questions", action: startFAQ }
            ]);
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
