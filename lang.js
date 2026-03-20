// ===== SLY RIDES — Multi-Language Support (EN / ES) =====
(function () {
  "use strict";

  // ── Translation dictionaries ──────────────────────────────────────────────
  var TRANSLATIONS = {
    en: {
      nav: {
        browseCars:  "Browse Cars",
        howItWorks:  "How It Works",
        about:       "About",
        contact:     "Contact",
        reviews:     "Reviews",
        callNow:     "Call Now to Get Approved Today"
      },
      // index.html
      hero: {
        applyNow: "Apply Now"
      },
      stats: {
        yearsExp:      "Years Experience",
        happyCust:     "Happy Customers",
        satisfaction:  "Customer Satisfaction",
        safetyRating:  "Safety Rating"
      },
      hiw: {
        heading:    "How It Works",
        step1title: "1. Submit Your Application",
        step1body:  "Click Apply Now and fill out our quick rental application. Provide your name, phone number, age, driving experience, delivery app(s), and a copy of your driver\u2019s license for review.",
        step2title: "2. Get Approved",
        step2body:  "Our team reviews your application and contacts you to complete the approval process. You\u2019ll receive confirmation once you\u2019re approved and ready to book.",
        step3title: "3. Choose Your Car & Book Dates",
        step3body:  "Once approved, browse our available vehicles, pick the one that fits your needs, and select your pickup and return dates.",
        step4title: "4. Sign the Agreement",
        step4body:  "Review and e-sign your rental agreement online \u2014 no printing, no waiting, no back-and-forth.",
        step5title: "5. Pay & Drive",
        step5body:  "Complete your secure payment \u2014 then hit the road!",
        milesTitle: "Unlimited Mileage",
        milesBody:  "Drive as much as you need without worrying about mileage limits. Our rentals include unlimited mileage so you can focus on your trips, rideshare work, or daily driving with complete flexibility.",
        insTitle:   "Insurance Requirements",
        insBody:    "All of our vehicles are fully insured. However, renters are required to have their own insurance coverage to protect themselves in case of an accident. You may use your personal auto insurance if it meets the required coverage, or you can contact us to arrange insurance coverage when renting the vehicle."
      },
      testimonials: {
        heading:    "Hear It Straight From Our Customers",
        subheading: "Real drivers. Real stories. See why LA trusts SLY Rides."
      },
      about: {
        heading: "About SLY Transportation Services",
        body:    "SLY Transportation Services provides reliable, professional car rental solutions for Los Angeles visitors and rideshare drivers. Whether you\u2019re exploring the city or earning on platforms like Uber, Lyft, or DoorDash, our well-maintained fleet \u2014 from fuel-efficient sedans to head-turning rides \u2014 keeps you moving with confidence. We offer flexible rental terms, unlimited mileage, and responsive customer support, because your time and experience matter.",
        valuesTitle: "Our Values: Safety, Sustainability & Service Excellence",
        valuesBody:  "At SLY Transportation Services, our commitment is simple: safe, efficient, and professional transportation \u2014 every time. Every vehicle in our fleet is regularly inspected and meticulously cleaned. Every rental is backed by transparent pricing and a team that genuinely cares. Safe, reliable service isn\u2019t just a promise here \u2014 it\u2019s our standard."
      },
      applyModal: {
        title:       "Apply to Rent",
        subtitle:    "Fill out the form below to start your application. We\u2019ll review your information and contact you shortly.",
        labelName:   "Full Name",
        labelPhone:  "Phone Number",
        labelEmail:  "Email Address",
        labelLicense:"Driver\u2019s License",
        labelAge:    "Age",
        labelExp:    "Driving Experience",
        labelApps:   "Delivery App(s)",
        placeholderName:  "First and last name",
        placeholderPhone: "(213) 555-0100",
        placeholderEmail: "you@example.com",
        placeholderAge:   "Your age",
        expPlaceholder:   "-- Select your experience --",
        expLt3mo:   "Less than 3 months",
        exp3mo1yr:  "3 months \u2013 1 year",
        exp1to2:    "1\u20132 years",
        exp3to5:    "3\u20135 years",
        exp6to10:   "6\u201310 years",
        expGt10:    "More than 10 years",
        sendCode:    "Send Code",
        terms:       "I agree to the Rental Terms & Conditions",
        smsConsent:  "I agree to receive SMS messaging related to my booking, including confirmation, reminders, and support updates. Message rates and data may apply.",
        backBtn:     "\u2190 Back to Home",
        submitBtn:   "Submit Application",
        uploadLicense: "\uD83D\uDCF7 Upload License (JPG, PNG, or PDF \u00B7 max 5\u00A0MB)",
        phoneVerified: "\u2713 Phone verified",
        codeSentNote: "Code sent to your phone \u2014 valid 10 min.",
        resendBtn:   "Resend"
      },
      // cars.html
      fleet: {
        heading:    "Uber & Lyft Rental Cars in Los Angeles",
        subheading: "Reliable weekly rideshare rentals for Uber, Lyft, and delivery drivers. All vehicles are fully rideshare\u2011ready with unlimited miles.",
        sidebarTitle: "Browse by Type",
        filterAll:      "All Cars",
        filterEconomy:  "Economy / Ridesharing",
        filterSlingshot:"Slingshots",
        bookNow:     "Book Now",
        available:   "● Available",
        unavailable: "● Unavailable",
        driverEarnings: "\uD83D\uDCB0 Driver Earnings Example (Los Angeles)",
        mostPopular: "Most Popular",
        bestValue:   "Best Value",
        rentalPlans: "Rental Plans"
      },
      // car.html (booking page)
      booking: {
        backToCars:    "\u2B05 Back to Cars",
        pickupDate:    "Pickup Date",
        returnDate:    "Return Date",
        duration:      "Duration",
        days:          "days",
        selectTier:    "Select Duration",
        fullName:      "Full Name",
        email:         "Email",
        phone:         "Phone",
        uploadId:      "Driver\u2019s License / ID",
        uploadInsurance: "Insurance Card (Optional)",
        rentalAgreement: "Rental Agreement",
        iAgree:        "I have read and agree to the",
        agreementLink: "Rental Agreement",
        signature:     "Your Signature",
        signaturePh:   "Type your full name to sign",
        confirmSig:    "Confirm Signature",
        payNow:        "\uD83D\uDCB3 Pay Now",
        protection:    "Damage Protection Plan (DPP)",
        dppDesc:       "Covers accidental damage during your rental period.",
        total:         "Total",
        deposit:       "Deposit",
        orderSummary:  "Order Summary"
      },
      // contact.html
      contact: {
        heading:  "Contact Us",
        subtitle: "Have a question or need help? Send us a message and we\u2019ll get back to you promptly.",
        labelName:    "Your Name",
        labelEmail:   "Your Email",
        labelPhone:   "Phone (optional)",
        labelMessage: "Your Message",
        placeholderName:    "First and last name",
        placeholderEmail:   "you@example.com",
        placeholderPhone:   "(213) 555-0100",
        placeholderMessage: "How can we help you?",
        sendBtn:  "Send Message",
        otpLabel: "Verification Code",
        otpPh:    "Enter 6-digit code",
        sendOtp:  "Send Code",
        resend:   "Resend"
      },
      // success.html
      success: {
        title:      "\u2705 Payment Successful!",
        body:       "Thank you for booking with Sly Transportation Services LLC! Your car is reserved. We will be in touch shortly to confirm your rental details.",
        sending:    "Sending confirmation\u2026",
        homeBtn:    "Back to Homepage",
        failTitle:  "\u274C Payment Failed",
        failBody:   "Your payment was not completed. No charge was made. Please try booking again or contact us if you need help.",
        pendingTitle: "\u23F3 Payment Processing",
        pendingBody:  "Your payment is being processed. We will email you once it is confirmed. Please do not re-submit.",
        emailError: "We couldn\u2019t send your confirmation email automatically. Please contact us at slyservices@supports-info.com to confirm your booking."
      },
      // cancel.html
      cancel: {
        title:   "\u274C Payment Canceled",
        body:    "Your payment was not completed. No charge was made. You can try again anytime!",
        homeBtn: "Back to Homepage"
      },
      // thank-you.html
      thankyou: {
        title:   "\uD83C\uDF89 Thank You!",
        sub:     "Your submission has been received!",
        detail:  "Our team at Sly Transportation Services LLC will review your information and reach out to you shortly to complete your approval.",
        download:"📄 Download PDF",
        fillAgain:"🔄 Fill Again",
        questions:"Questions? Call us:"
      },
      // chatbot UI
      chatbot: {
        headerTitle:  "\uD83D\uDE97 Sly Transportation Services LLC Assistant",
        placeholder:  "Ask a question\u2026",
        sendBtn:      "Send",
        closeBtn:     "\u2715",
        welcome:      "Hi! \uD83D\uDC4B Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\nOur cars are <strong>$350/week with unlimited miles</strong>. I can help you get approved quickly.\n\nAsk me anything \u2014 pricing, requirements, earnings \u2014 or click below to apply!\n\n<a href=\"index.html\" id=\"chatApplyLink\">\uD83D\uDC49 Apply and get approved now</a>",
        fallback:     "I\u2019m not sure about that one \uD83E\uDD14\n\nTry asking about:\n\u2022 Pricing\n\u2022 Available cars\n\u2022 How to book\n\u2022 Delivery apps\n\u2022 Contact info\n\nOr email us at slyservices@supports-info.com"
      },
      footer: {
        copy: "\u00A9 2026 Sly Transportation Services LLC. All rights reserved."
      }
    },

    es: {
      nav: {
        browseCars:  "Ver Autos",
        howItWorks:  "C\u00F3mo Funciona",
        about:       "Nosotros",
        contact:     "Contacto",
        reviews:     "Rese\u00F1as",
        callNow:     "Llama Ahora para Obtener Aprobaci\u00F3n Hoy"
      },
      hero: {
        applyNow: "Solicitar Ahora"
      },
      stats: {
        yearsExp:     "A\u00F1os de Experiencia",
        happyCust:    "Clientes Satisfechos",
        satisfaction: "Satisfacci\u00F3n del Cliente",
        safetyRating: "Calificaci\u00F3n de Seguridad"
      },
      hiw: {
        heading:    "C\u00F3mo Funciona",
        step1title: "1. Env\u00EDa Tu Solicitud",
        step1body:  "Haz clic en Solicitar Ahora y completa nuestra breve solicitud de alquiler. Proporciona tu nombre, n\u00FAmero de tel\u00E9fono, edad, experiencia al volante, aplicaci\u00F3n(es) de entrega y una copia de tu licencia de conducir para revisi\u00F3n.",
        step2title: "2. Obt\u00E9n Aprobaci\u00F3n",
        step2body:  "Nuestro equipo revisa tu solicitud y se pone en contacto contigo para completar el proceso de aprobaci\u00F3n. Recibir\u00E1s confirmaci\u00F3n una vez aprobado y listo para reservar.",
        step3title: "3. Elige Tu Auto y Fechas",
        step3body:  "Una vez aprobado, navega por nuestros veh\u00EDculos disponibles, elige el que mejor se adapte a tus necesidades y selecciona tus fechas de recogida y devoluci\u00F3n.",
        step4title: "4. Firma el Contrato",
        step4body:  "Revisa y firma electr\u00F3nicamente tu contrato de alquiler en l\u00EDnea \u2014 sin imprimir, sin esperar, sin complicaciones.",
        step5title: "5. Paga y Maneja",
        step5body:  "\u00A1Completa tu pago seguro y sal a la carretera!",
        milesTitle: "Millaje Ilimitado",
        milesBody:  "Maneja todo lo que necesites sin preocuparte por l\u00EDmites de millaje. Nuestros alquileres incluyen millaje ilimitado para que puedas concentrarte en tus viajes, trabajo de viaje compartido o manejo diario con total flexibilidad.",
        insTitle:   "Requisitos de Seguro",
        insBody:    "Todos nuestros veh\u00EDculos est\u00E1n completamente asegurados. Sin embargo, los arrendatarios deben tener su propia cobertura de seguro para protegerse en caso de accidente. Puedes usar tu seguro de auto personal si cumple con la cobertura requerida, o contactarnos para organizar una cobertura cuando alquiles el veh\u00EDculo."
      },
      testimonials: {
        heading:    "Escucha Directamente de Nuestros Clientes",
        subheading: "Conductores reales. Historias reales. Descubre por qu\u00E9 LA conf\u00EDa en SLY Rides."
      },
      about: {
        heading: "Sobre SLY Transportation Services",
        body:    "SLY Transportation Services ofrece soluciones confiables y profesionales de alquiler de autos para visitantes de Los \u00C1ngeles y conductores de viaje compartido. Ya sea que explores la ciudad o generes ingresos en plataformas como Uber, Lyft o DoorDash, nuestra flota bien mantenida \u2014 desde sedanes eficientes hasta autos llamativos \u2014 te mantiene en movimiento con confianza. Ofrecemos t\u00E9rminos de alquiler flexibles, millaje ilimitado y soporte al cliente receptivo, porque tu tiempo y experiencia importan.",
        valuesTitle: "Nuestros Valores: Seguridad, Sostenibilidad y Excelencia en el Servicio",
        valuesBody:  "En SLY Transportation Services, nuestro compromiso es simple: transporte seguro, eficiente y profesional \u2014 siempre. Cada veh\u00EDculo de nuestra flota es inspeccionado y limpiado meticulosamente de manera regular. Cada alquiler est\u00E1 respaldado por precios transparentes y un equipo que genuinamente se preocupa. El servicio seguro y confiable no es solo una promesa aqu\u00ED \u2014 es nuestro est\u00E1ndar."
      },
      applyModal: {
        title:       "Solicitar Alquiler",
        subtitle:    "Completa el formulario a continuaci\u00F3n para iniciar tu solicitud. Revisaremos tu informaci\u00F3n y nos comunicaremos contigo pronto.",
        labelName:   "Nombre Completo",
        labelPhone:  "N\u00FAmero de Tel\u00E9fono",
        labelEmail:  "Correo Electr\u00F3nico",
        labelLicense:"Licencia de Conducir",
        labelAge:    "Edad",
        labelExp:    "Experiencia al Volante",
        labelApps:   "Aplicaci\u00F3n(es) de Entrega",
        placeholderName:  "Nombre y apellido",
        placeholderPhone: "(213) 555-0100",
        placeholderEmail: "tu@ejemplo.com",
        placeholderAge:   "Tu edad",
        expPlaceholder:   "-- Selecciona tu experiencia --",
        expLt3mo:   "Menos de 3 meses",
        exp3mo1yr:  "3 meses \u2013 1 a\u00F1o",
        exp1to2:    "1\u20132 a\u00F1os",
        exp3to5:    "3\u20135 a\u00F1os",
        exp6to10:   "6\u201310 a\u00F1os",
        expGt10:    "M\u00E1s de 10 a\u00F1os",
        sendCode:    "Enviar C\u00F3digo",
        terms:       "Acepto los T\u00E9rminos y Condiciones de Alquiler",
        smsConsent:  "Acepto recibir mensajes SMS relacionados con mi reserva, incluyendo confirmaci\u00F3n, recordatorios y actualizaciones de soporte. Pueden aplicarse tarifas de mensajes y datos.",
        backBtn:     "\u2190 Volver al Inicio",
        submitBtn:   "Enviar Solicitud",
        uploadLicense: "\uD83D\uDCF7 Subir Licencia (JPG, PNG o PDF \u00B7 m\u00E1x 5\u00A0MB)",
        phoneVerified: "\u2713 Tel\u00E9fono verificado",
        codeSentNote: "C\u00F3digo enviado a tu tel\u00E9fono \u2014 v\u00E1lido 10 min.",
        resendBtn:   "Reenviar"
      },
      fleet: {
        heading:    "Autos de Alquiler para Uber y Lyft en Los \u00C1ngeles",
        subheading: "Alquileres semanales confiables para conductores de Uber, Lyft y entrega. Todos los veh\u00EDculos est\u00E1n listos para viaje compartido con millaje ilimitado.",
        sidebarTitle: "Buscar por Tipo",
        filterAll:      "Todos los Autos",
        filterEconomy:  "Econ\u00F3mico / Viaje Compartido",
        filterSlingshot:"Slingshots",
        bookNow:     "Reservar Ahora",
        available:   "● Disponible",
        unavailable: "● No Disponible",
        driverEarnings: "\uD83D\uDCB0 Ejemplo de Ganancias del Conductor (Los \u00C1ngeles)",
        mostPopular: "M\u00E1s Popular",
        bestValue:   "Mejor Valor",
        rentalPlans: "Planes de Alquiler"
      },
      booking: {
        backToCars:    "\u2B05 Volver a Autos",
        pickupDate:    "Fecha de Recogida",
        returnDate:    "Fecha de Devoluci\u00F3n",
        duration:      "Duraci\u00F3n",
        days:          "d\u00EDas",
        selectTier:    "Seleccionar Duraci\u00F3n",
        fullName:      "Nombre Completo",
        email:         "Correo Electr\u00F3nico",
        phone:         "Tel\u00E9fono",
        uploadId:      "Licencia de Conducir / ID",
        uploadInsurance: "Tarjeta de Seguro (Opcional)",
        rentalAgreement: "Contrato de Alquiler",
        iAgree:        "He le\u00EDdo y acepto el",
        agreementLink: "Contrato de Alquiler",
        signature:     "Tu Firma",
        signaturePh:   "Escribe tu nombre completo para firmar",
        confirmSig:    "Confirmar Firma",
        payNow:        "\uD83D\uDCB3 Pagar Ahora",
        protection:    "Plan de Protecci\u00F3n por Da\u00F1os (DPP)",
        dppDesc:       "Cubre da\u00F1os accidentales durante tu per\u00EDodo de alquiler.",
        total:         "Total",
        deposit:       "Dep\u00F3sito",
        orderSummary:  "Resumen del Pedido"
      },
      contact: {
        heading:  "Cont\u00E1ctanos",
        subtitle: "\u00BFTienes alguna pregunta o necesitas ayuda? Env\u00EDanos un mensaje y te responderemos pronto.",
        labelName:    "Tu Nombre",
        labelEmail:   "Tu Correo Electr\u00F3nico",
        labelPhone:   "Tel\u00E9fono (opcional)",
        labelMessage: "Tu Mensaje",
        placeholderName:    "Nombre y apellido",
        placeholderEmail:   "tu@ejemplo.com",
        placeholderPhone:   "(213) 555-0100",
        placeholderMessage: "\u00BFC\u00F3mo podemos ayudarte?",
        sendBtn:  "Enviar Mensaje",
        otpLabel: "C\u00F3digo de Verificaci\u00F3n",
        otpPh:    "Ingresa el c\u00F3digo de 6 d\u00EDgitos",
        sendOtp:  "Enviar C\u00F3digo",
        resend:   "Reenviar"
      },
      success: {
        title:      "\u2705 \u00A1Pago Exitoso!",
        body:       "\u00A1Gracias por reservar con Sly Transportation Services LLC! Tu auto est\u00E1 reservado. Nos pondremos en contacto contigo pronto para confirmar los detalles de tu alquiler.",
        sending:    "Enviando confirmaci\u00F3n\u2026",
        homeBtn:    "Volver al Inicio",
        failTitle:  "\u274C Pago Fallido",
        failBody:   "Tu pago no fue completado. No se realiz\u00F3 ning\u00FAn cargo. Por favor intenta reservar de nuevo o cont\u00E1ctanos si necesitas ayuda.",
        pendingTitle: "\u23F3 Pago en Proceso",
        pendingBody:  "Tu pago est\u00E1 siendo procesado. Te enviaremos un correo una vez que sea confirmado. Por favor no vuelvas a enviar.",
        emailError: "No pudimos enviar tu correo de confirmaci\u00F3n autom\u00E1ticamente. Por favor cont\u00E1ctanos en slyservices@supports-info.com para confirmar tu reserva."
      },
      cancel: {
        title:   "\u274C Pago Cancelado",
        body:    "Tu pago no fue completado. No se realiz\u00F3 ning\u00FAn cargo. \u00A1Puedes intentarlo de nuevo en cualquier momento!",
        homeBtn: "Volver al Inicio"
      },
      thankyou: {
        title:    "\uD83C\uDF89 \u00A1Gracias!",
        sub:      "\u00A1Tu solicitud ha sido recibida!",
        detail:   "Nuestro equipo en Sly Transportation Services LLC revisar\u00E1 tu informaci\u00F3n y se comunicar\u00E1 contigo pronto para completar tu aprobaci\u00F3n.",
        download: "📄 Descargar PDF",
        fillAgain:"🔄 Completar de Nuevo",
        questions:"¿Preguntas? Ll\u00E1manos:"
      },
      chatbot: {
        headerTitle:  "\uD83D\uDE97 Asistente de Sly Transportation Services LLC",
        placeholder:  "Haz una pregunta\u2026",
        sendBtn:      "Enviar",
        closeBtn:     "\u2715",
        welcome:      "\u00A1Hola! \uD83D\uDC4B \u00BFQuieres alquilar un auto para DoorDash, Uber Eats u otras aplicaciones de entrega?\n\nNuestros autos son <strong>$350/semana con millaje ilimitado</strong>. Puedo ayudarte a obtener aprobaci\u00F3n r\u00E1pidamente.\n\nPr\u00E9guntame lo que quieras \u2014 precios, requisitos, ganancias \u2014 o haz clic abajo para solicitar.\n\n<a href=\"index.html\" id=\"chatApplyLink\">\uD83D\uDC49 Solicitar y obtener aprobaci\u00F3n ahora</a>",
        fallback:     "No estoy seguro de eso \uD83E\uDD14\n\nIntenta preguntar sobre:\n\u2022 Precios\n\u2022 Autos disponibles\n\u2022 C\u00F3mo reservar\n\u2022 Aplicaciones de entrega\n\u2022 Informaci\u00F3n de contacto\n\nO env\u00EDanos un correo a slyservices@supports-info.com"
      },
      footer: {
        copy: "\u00A9 2026 Sly Transportation Services LLC. Todos los derechos reservados."
      }
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getLang() {
    return localStorage.getItem("slyLang") || "en";
  }

  function getVal(obj, keyPath) {
    return keyPath.split(".").reduce(function (o, k) { return o && o[k]; }, obj);
  }

  function t(key) {
    var lang = getLang();
    var val = getVal(TRANSLATIONS[lang], key);
    if (val === undefined) val = getVal(TRANSLATIONS["en"], key);
    return (val !== undefined) ? val : key;
  }

  // ── Apply translations to DOM ─────────────────────────────────────────────
  function applyTranslations() {
    // textContent replacements
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var val = t(key);
      if (val !== key) el.textContent = val;
    });
    // placeholder replacements
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-placeholder");
      var val = t(key);
      if (val !== key) el.setAttribute("placeholder", val);
    });
    // aria-label replacements
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-aria");
      var val = t(key);
      if (val !== key) el.setAttribute("aria-label", val);
    });
    // innerHTML replacements (trusted static content only)
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-html");
      var val = t(key);
      if (val !== key) el.innerHTML = val;
    });
    // Update <html lang> attribute
    document.documentElement.lang = getLang() === "es" ? "es" : "en";
    // Update switcher button states
    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === getLang());
    });
  }

  // ── Language switcher ─────────────────────────────────────────────────────
  function buildSwitcher() {
    var header = document.querySelector(".site-header");
    if (!header) return;
    if (document.getElementById("langSwitcher")) return; // already built
    var div = document.createElement("div");
    div.id = "langSwitcher";
    div.className = "lang-switcher";
    div.setAttribute("aria-label", "Language / Idioma");
    div.innerHTML =
      '<button class="lang-btn" data-lang="en" title="English" aria-label="English">' +
        '<span class="lang-flag">\uD83C\uDDFA\uD83C\uDDF8</span><span class="lang-label">EN</span>' +
      '</button>' +
      '<button class="lang-btn" data-lang="es" title="Espa\u00F1ol" aria-label="Espa\u00F1ol">' +
        '<span class="lang-flag">\uD83C\uDDF2\uD83C\uDDFD</span><span class="lang-label">ES</span>' +
      '</button>';
    header.appendChild(div);
    div.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        localStorage.setItem("slyLang", btn.getAttribute("data-lang"));
        window.currentLang = btn.getAttribute("data-lang");
        applyTranslations();
        // Notify chatbot if already built
        if (typeof window.updateChatbotLang === "function") {
          window.updateChatbotLang(getLang());
        }
      });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    window.currentLang = getLang();
    buildSwitcher();
    applyTranslations();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ── Public API (used by chatbot.js and car.js) ────────────────────────────
  window.slyI18n = {
    t:    t,
    getLang: getLang,
    TRANSLATIONS: TRANSLATIONS
  };
}());
