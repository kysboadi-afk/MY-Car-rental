// ===== Sly Transportation Services LLC CHATBOT =====

var botResponses = {
  en: [
    {
      patterns: ["hello","hi","hey","howdy","sup","what's up"],
      reply: "Hey! 👋 Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\nOur cars are <strong>$350/week with unlimited miles</strong>. I can help you get approved quickly.\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Click here to apply and get approved</a>"
    },
    {
      patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot"],
      reply: "Here are the Slingshot R rates 🔴\n\n⏱ Hourly Tiers (Sports 2-Seater):\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n\n💳 $150 security deposit required\n   (included in your payment at checkout)\n\nReady to book? Visit our Cars page!"
    },
    {
      patterns: ["camry price","camry cost","camry rate","camry how much","camry fee","how much is the camry","how much for the camry","how much camry","price of camry","cost of camry"],
      reply: "Here are the Camry rates 🔵🟢\n\n🔵 Camry 2012\n  • Daily       — $50 / day\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n\n🟢 Camry 2013 SE\n  • Daily       — $55 / day\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n\n✅ No security deposit required\n\nReady to book? Visit our Cars page!\n\n📋 Do you have a valid driving license?"
    },
    {
      patterns: ["price","cost","how much","rate","rates","fee","fees","daily","weekly","monthly"],
      reply: "Here are our current rates 🚗\n\n🔴 Slingshot R (Sports 2-Seater)\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n  • + $150 deposit\n\n🔵 Camry 2012\n  • Daily     — $50 / day\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit required\n\n🟢 Camry 2013 SE\n  • Daily     — $55 / day\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit required\n\nAsk me about a specific car for more details!"
    },
    {
      patterns: ["earn","earnings","income","make money","how much can","how much money","revenue"],
      reply: "💰 Earning Potential with SLY Rides\n\nOur delivery drivers typically earn:\n  • $800 – $1,500 per week\n\nworking on apps like DoorDash, Uber Eats, Instacart, and Amazon Flex.\n\nFor just $350/week with unlimited miles, that's a great return!\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Apply now to get approved</a>"
    },
    {
      patterns: ["car","cars","vehicle","vehicles","available","fleet","slingshot","camry"],
      reply: "We currently have 3 vehicles available:\n\n🔴 Slingshot R — Sports 2-Seater\n   3 hrs $200 · 6 hrs $250 · 24 hrs $350 (+ $150 deposit)\n\n🔵 Camry 2012 — $50/day or $350/week, Unlimited Miles (no deposit)\n\n🟢 Camry 2013 SE — $55/day or $350/week, Unlimited Miles (no deposit)\n\nVisit our Cars page to browse and book!"
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
      reply: "Here's our deposit info 💰\n\n🔴 Slingshot R: $150 deposit\n🔵 Camry 2012: No deposit required\n🟢 Camry 2013 SE: No deposit required\n\nDeposits are refundable upon return of the vehicle in good condition."
    },
    {
      patterns: ["cancel","cancellation","refund","no show","no-show","noshow"],
      reply: "⚠️ No-Refund Policy\n\nAll payments are final once a booking is confirmed.\n\n• Cancellations or no-shows after booking are not eligible for a refund\n• Please review your reservation details carefully before completing payment\n• Refunds may be issued only if the company cancels or cannot fulfill the rental\n\nFor questions, call (213) 916-6606 or email slyservices@supports-info.com 🙏"
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
      reply: "Aquí están las tarifas del Slingshot R 🔴\n\n⏱ Tarifas por Horas (Deportivo 2 plazas):\n  • 3 Horas  — $200\n  • 6 Horas  — $250\n  • 24 Horas — $350\n\n💳 Se requiere depósito de seguridad de $150\n   (incluido en tu pago al finalizar)\n\n¿Listo para reservar? ¡Visita nuestra página de autos!"
    },
    {
      patterns: ["precio camry","costo camry","cuánto camry","cuanto camry","tarifa camry","camry precio","camry costo"],
      reply: "Aquí están las tarifas del Camry 🔵🟢\n\n🔵 Camry 2012\n  • Diario    — $50 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n\n🟢 Camry 2013 SE\n  • Diario    — $55 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n\n✅ No se requiere depósito de seguridad\n\n¿Listo para reservar?\n\n📋 ¿Tienes una licencia de conducir válida?"
    },
    {
      patterns: ["precio","costo","cuánto cuesta","cuanto cuesta","cuánto es","cuanto es","tarifa","tarifas","cobran","cobras","diario","semanal","mensual"],
      reply: "Aquí están nuestras tarifas actuales 🚗\n\n🔴 Slingshot R (Deportivo 2 plazas)\n  • 3 Horas  — $200\n  • 6 Horas  — $250\n  • 24 Horas — $350\n  • + $150 depósito\n\n🔵 Camry 2012\n  • Diario    — $50 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n  • Sin depósito\n\n🟢 Camry 2013 SE\n  • Diario    — $55 / día\n  • 1 Semana  — $350 🚗 Millaje Ilimitado\n  • 2 Semanas — $650 🚗 Millaje Ilimitado\n  • 1 Mes     — $1,300 🚗 Millaje Ilimitado\n  • Sin depósito\n\n¡Pregúntame sobre un auto específico para más detalles!"
    },
    {
      patterns: ["ganar","ganancias","ingresos","cuánto puedo ganar","cuanto puedo ganar","dinero"],
      reply: "💰 Potencial de Ganancias con SLY Rides\n\nNuestros conductores de entrega típicamente ganan:\n  • $800 – $1,500 por semana\n\ntrabajando en apps como DoorDash, Uber Eats, Instacart y Amazon Flex.\n\n¡Por solo $350/semana con millaje ilimitado, es un excelente retorno!\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Solicita ahora para obtener aprobación</a>"
    },
    {
      patterns: ["auto","autos","carro","carros","vehículo","vehiculo","disponible","flota","slingshot","camry"],
      reply: "Actualmente tenemos 3 vehículos disponibles:\n\n🔴 Slingshot R — Deportivo 2 plazas\n   3 hrs $200 · 6 hrs $250 · 24 hrs $350 (+ $150 depósito)\n\n🔵 Camry 2012 — $50/día o $350/semana, Millaje Ilimitado (sin depósito)\n\n🟢 Camry 2013 SE — $55/día o $350/semana, Millaje Ilimitado (sin depósito)\n\n¡Visita nuestra página de Autos para ver y reservar!"
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
      reply: "Aquí está nuestra información de depósito 💰\n\n🔴 Slingshot R: $150 de depósito\n🔵 Camry 2012: No se requiere depósito\n🟢 Camry 2013 SE: No se requiere depósito\n\nLos depósitos son reembolsables al devolver el vehículo en buenas condiciones."
    },
    {
      patterns: ["cancelar","cancelación","cancelacion","reembolso","reembolsar","no presentarse"],
      reply: "⚠️ Política de No Reembolso\n\nTodos los pagos son finales una vez confirmada la reserva.\n\n• Las cancelaciones o no presentaciones después de la reserva no son elegibles para reembolso\n• Revisa los detalles de tu reserva cuidadosamente antes de completar el pago\n• Los reembolsos solo se emiten si la empresa cancela o no puede cumplir con el alquiler\n\nPara preguntas, llama al (213) 916-6606 o envía un correo a slyservices@supports-info.com 🙏"
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
      return item.reply;
    }
  }
  // Also try English responses as fallback for bilingual users
  if (lang === "es") {
    var enResponses = botResponses["en"];
    for (var j = 0; j < enResponses.length; j++) {
      var enItem = enResponses[j];
      if (enItem.patterns.some(function(p) { return lower.includes(p); })) {
        return enItem.reply;
      }
    }
  }
  return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.fallback") : "I\u2019m not sure about that one \uD83E\uDD14\n\nTry asking about:\n\u2022 Pricing\n\u2022 Available cars\n\u2022 How to book\n\u2022 Delivery apps\n\u2022 Contact info\n\nOr email us at slyservices@supports-info.com";
}

function buildChatbot() {
  var tFn = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t : function(k) { return k; };

  // Inject HTML
  document.body.insertAdjacentHTML("beforeend",
    '<div id="chat-widget">' +
      '<button id="chat-toggle" aria-label="Open chat">\uD83D\uDCAC</button>' +
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
    '</div>'
  );

  var toggle   = document.getElementById("chat-toggle");
  var closeBtn = document.getElementById("chat-close");
  var chatBox  = document.getElementById("chat-box");
  var input    = document.getElementById("chat-input");
  var sendBtn  = document.getElementById("chat-send");
  var messages = document.getElementById("chat-messages");

  // Track whether the user has ever manually dismissed the chat
  var userDismissed = false;

  function addMessage(text, sender) {
    var msg = document.createElement("div");
    msg.className = "chat-msg " + sender;
    if (sender === "bot") {
      // Bot replies are hardcoded static strings (never user input), so innerHTML is safe.
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

  function openChat() {
    chatBox.hidden = false;
    toggle.hidden  = true;
    if (!messages.children.length) {
      var welcome = (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t("chatbot.welcome") : "Hi! 👋";
      addMessage(welcome, "bot");
    }
    input.focus();
  }

  function closeChat() {
    chatBox.hidden = true;
    toggle.hidden  = false;
    userDismissed  = true;
  }

  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;
    addMessage(text, "user");
    input.value = "";
    setTimeout(function() { addMessage(getBotReply(text), "bot"); }, 400);
  }

  toggle.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMessage(); });

  // Auto-open the chatbot after a random delay between 10 and 20 seconds,
  // unless the user has already opened or dismissed it themselves.
  var autoDelay = Math.floor(Math.random() * 10000) + 10000; // 10–20 s
  setTimeout(function () {
    if (!userDismissed && chatBox.hidden) {
      openChat();
    }
  }, autoDelay);

  // Update chatbot UI text when language changes (called by lang.js)
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
