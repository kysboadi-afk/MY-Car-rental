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
        terms:       "I agree to the",
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
        reserveVehicle: "Reserve This Vehicle",
        available:   "● Available",
        unavailable: "● Unavailable",
        booked:      "Booked",
        availableToday: "\u2713 Available Today",
        driverEarnings: "\uD83D\uDCB0 Driver Earnings Example (Los Angeles)",
        mostPopular: "Most Popular",
        bestValue:   "Best Value",
        rentalPlans: "Rental Plans",
        priceListLabel: "Rental Plans",
        slingshotTagline: "Built for Thrills \u2022 Pure Fun",
        slingshotSub:     "Experience the Ultimate City Ride",
        slingshotBullet1: "\uD83C\uDF34 Cruise the streets of Los Angeles in style",
        slingshotBullet2: "\u26A1 Feel the open-air rush of a 3-wheeled sports car",
        slingshotBullet3: "\uD83C\uDFAF Perfect for exploring LA, photo shoots & special occasions",
        slingshotCta:     "Limited availability \u2014 reserve yours today",
        rideshareReady:   "\uD83D\uDE97 Uber & Lyft Ready",
        unlimitedMilesTag:"\u221E Unlimited Miles",
        scarcityHigh:     "\uD83D\uDD25 High demand \u2014 reserve today",
        scarcityLimited:  "\u26A1 Limited vehicles available",
        earningsTagline:  "Uber & Lyft Ready \u2022 Unlimited Miles",
        earningsTitle:    "Driver Earnings Example (Los Angeles)",
        earningsAvg:      "Avg. weekly Uber/Lyft earnings: $1,200 \u2013 $1,600",
        earningsWeekly:   "Weekly rental: $350",
        earningsTakeHome: "Est. driver take\u2011home: $850 \u2013 $1,250",
        earningsCta:      "Limited vehicles available \u2014 reserve today",
        driverReqHeading: "Driver Requirements",
        driverReq1:       "\uD83E\uDD2A Valid Driver\u2019s License",
        driverReq2:       "\uD83D\uDE97 Active or eligible Uber / Lyft driver account",
        driverReq3:       "\uD83C\uDF82 Minimum age 23",
        whyHeading:       "Why Drivers Choose SLY Transportation",
        why1:             "\u2705 Rideshare\u2011approved vehicles",
        why2:             "\u267E\uFE0F Unlimited miles for Uber, Lyft, and delivery",
        why3:             "\uD83D\uDCB0 Affordable weekly rentals",
        why4:             "\uD83D\uDD27 Reliable vehicles ready to drive",
        why5:             "\uD83D\uDD11 Keep the same vehicle as long as payments stay current",
        ctaHeading:       "Start Driving Today",
        ctaSub:           "Reserve your rideshare vehicle and begin earning with Uber, Lyft, or delivery apps immediately.",
        ctaBtn:           "Browse Available Vehicles \u2191"
      },
      // car.html (booking page)
      booking: {
        backToCars:    "\u2B05 Back to Cars",
        pickupDate:    "Pickup Date",
        pickupTime:    "Pickup Time",
        returnDate:    "Return Date",
        returnTime:    "Return Time",
        returnTimeNote:"(same as pickup time)",
        duration:      "Duration",
        days:          "days",
        selectTier:    "Select Duration",
        heading:       "Complete Your Reservation",
        fullName:      "Full Name",
        namePh:        "Enter your full name",
        email:         "Email Address",
        emailPh:       "Enter your email",
        phone:         "Phone Number",
        phonePh:       "Enter your phone number",
        smsConsent:    "By submitting this form, you agree to receive SMS messaging regarding vehicle availability. Reply STOP to opt out.",
        uploadIdLabel: "\uD83D\uDCCE Upload Driver\u2019s License / ID",
        idRequired:    "A valid government-issued ID is required to confirm your rental.",
        accepted:      "Accepted: JPG, PNG, PDF",
        noFile:        "No file selected",
        insuranceQuestion: "\uD83D\uDEE1\uFE0F Do you have auto insurance that covers rental vehicles?",
        hasInsurance:  "Yes, I have rental car coverage",
        addDpp:        "Add Damage Protection",
        uploadInsuranceLabel: "\uD83D\uDCCE Upload Proof of Insurance",
        insuranceRequired: "Valid auto insurance documentation is required for all rentals.",
        dppWarning:    "\u26A0\uFE0F Your Personal Auto Insurance may not cover rental Vehicles",
        dppPrice:      "Protect yourself with our <strong>Damage Protection Plan: $13/day \u2022 $85/week \u2022 $150/2\u00A0wks \u2022 $295/month</strong>",
        dppIncluded:   "What\u2019s included:",
        dppBullet1:    "\u2705 Covers accidental vehicle damage",
        dppBullet2:    "\u2705 Reduces your liability to $1,000",
        signStep:      "\uD83D\uDCC4 Step 1: Read & Sign your Rental Agreement",
        reviewSignBtn: "\u270D Review & Sign Rental Agreement",
        signedBtn:     "\u2705 Rental Agreement Signed",
        iAgreeTerms:   "I have read and signed the Rental Agreement & Terms",
        refundNotice:  "\u26A0\uFE0F <strong>No-Refund Policy:</strong> All payments are final once a booking is confirmed. Cancellations or no-shows after booking are not eligible for a refund. Please review your reservation details carefully before completing payment. Refunds may be issued only if the company cancels or cannot fulfill the rental.",
        subtotalLabel: "Subtotal",
        salesTaxLabel: "Sales Tax",
        totalLabel:    "Total",
        taxNote:       "(+ applicable sales tax)",
        payHint:       "Fill in dates, enter your name and email, upload your ID, select your insurance coverage option (and upload proof if you have coverage), and sign & agree to terms to enable payment.",
        nameError:     "Please enter at least a first and last name.",
        loadingPayment:"Loading payment form\u2026",
        processing:    "Processing\u2026",
        changeBooking: "\u2190 Change booking details",
        typeName:      "Type your full legal name to sign:",
        signPh:        "Your full name",
        sigNote:       "Typing your name above constitutes your legal electronic signature.",
        iAgreeBtn:     "\u2705 I Agree & Sign",
        cancelSignBtn: "Cancel",
        sigMatchError: "Signature must match the full name entered in the booking form.",
        calcAtCheckout:"Calculated at checkout",
        alertVehicleNotFound: "Vehicle not found.",
        alertEnterEmail: "Please enter your email address.",
        alertEnterName: "Please enter your full name.",
        agreementIntroTpl: "This Rental Agreement is entered into between SLY Transportation Services (\u201CCompany\u201D) and {name} (\u201CRenter\u201D) for the rental of a {car} from {pickup} to {returnDate}.",
        signedByTpl: "Signed by {name}. Check the box below to confirm.",
        depositSlingshotIntroTpl: "A <strong>${amount} refundable security deposit</strong> is included in the rental payment and returned after the vehicle is inspected upon return (typically within 5\u20137 business days). Deposit covers damages, loss of use, cleaning, tolls, and fuel.",
        depositDppHtml: "<strong>Damage Protection Plan ($13/day &bull; $85/week &bull; $150/2\u00A0wks &bull; $295/month):</strong> optional add-on \u2014 reduces your damage liability to $1,000",
        depositSlingshotRatesTpl: "<strong>Slingshot Rental Rates:</strong> {rates} \u2014 plus ${deposit} refundable security deposit (included in payment)",
        depositNoDeposit: "No security deposit is required for this vehicle.",
        lineRentalTpl: "{label} rental",
        lineDeposit: "Security deposit (refundable)",
        lineDppDayTpl: "Damage Protection Plan ({days} day \u00D7 ${rate}/day)",
        lineDppTpl: "Damage Protection Plan ({days} days)",
        lineSalesTaxPctTpl: "Sales tax ({pct}%)",
        lineSalesTax: "Sales tax",
        lineWeekTpl: "{weeks} week rental",
        lineBiweekTpl: "{count} \u00D7 2-week rental",
        lineMonthTpl: "{months} month rental",
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
      // car.html rental agreement
      agreement: {
        heading:          "SLY TRANSPORTATION SERVICES \u2014 CAR RENTAL AGREEMENT",
        partiesTitle:     "PARTIES",
        ownerLabel:       "Owner:",
        ownerDetails:     "SLY Transportation Services \u2014 (213) 916-6606 \u2014 info@slytrans.com",
        renterLabel:      "Renter:",
        renterDetails:    "Name, address, phone, email, driver\u2019s license number, and date of birth as provided at time of booking.",
        vehicleTitle:     "VEHICLE INFORMATION",
        makeLabel:        "Make",
        modelLabel:       "Model",
        yearLabel:        "Year",
        vinLabel:         "VIN / Plate",
        colorLabel:       "Color",
        fuelLine:         "Fuel Level at Pickup: Full \u00A0 Half \u00A0 Quarter \u00A0\u00A0\u00A0 Condition Photos Attached: Yes",
        rentalPeriodTitle:"RENTAL PERIOD",
        rentalPeriodBody: "Rental start and end dates/times are as specified at the time of booking. The vehicle must be returned to the same location at the agreed return date and time.",
        lateFee:          "Late Fee: $50/day after a 2-hour grace period.",
        mileageFuelTitle: "MILEAGE & FUEL",
        mileageLimit:     "Mileage Limit: Unlimited.",
        fuelPolicy:       "Fuel Policy: Return the vehicle with the same fuel level as at pickup, or pay a $5/gallon replacement fee.",
        depositTitle:     "SECURITY DEPOSIT (Refundable)",
        insuranceLiabilityTitle: "INSURANCE & LIABILITY",
        insuranceProvide: "Renter must provide <strong>one of the following</strong> prior to vehicle release:",
        insuranceBullet1: "Valid personal auto insurance covering rental vehicles (proof required), <strong>OR</strong>",
        insuranceBullet2: "Purchase of SLY Transportation Services Damage Protection Plan",
        dppOptional:      "Damage Protection Plan (Optional): $13/day \u2022 $85/week \u2022 $150/2\u00A0weeks \u2022 $295/month",
        dppReduces:       "This plan reduces the renter\u2019s financial responsibility for covered vehicle damage to a maximum of <strong>$1,000 per incident</strong>.",
        withoutDpp:       "<strong>Without Protection Plan:</strong> Renter is fully responsible for all damages and associated costs, including but not limited to:",
        withoutBullet1:   "Full cost of vehicle repair or replacement",
        withoutBullet2:   "Loss of use (rental downtime)",
        withoutBullet3:   "Diminished value",
        withoutBullet4:   "Administrative, towing, and storage fees",
        withDpp:          "<strong>With Protection Plan:</strong> Renter\u2019s responsibility is limited to the stated deductible, provided all terms of this agreement are followed.",
        exclusionsTitle:  "<strong>Exclusions (Protection Plan Void If):</strong>",
        exclusion1:       "Driver is under the influence of drugs or alcohol",
        exclusion2:       "Unauthorized driver operates the vehicle",
        exclusion3:       "Reckless, illegal, or negligent use",
        exclusion4:       "Off-road or prohibited use",
        exclusion5:       "Failure to report damage within 24 hours",
        exclusion6:       "Violation of rental agreement terms",
        thirdParty:       "<strong>Third-Party Liability:</strong> Renter is solely responsible for any third-party claims, including bodily injury, property damage, or death. SLY Transportation Services is not liable for renter negligence. Renter agrees to indemnify and hold harmless SLY Transportation Services from any claims, losses, or expenses arising from vehicle use.",
        useRestrictionsTitle: "USE RESTRICTIONS",
        useRestrictionsIntro: "Renter agrees to all of the following restrictions:",
        useRestrictions1: "No smoking \u00A0 No pets \u00A0 No off-road use \u00A0 No subleasing",
        useRestrictions2: "Approved drivers only \u00A0 No racing or towing \u00A0 No commercial hauling",
        conditionTitle:   "CONDITION INSPECTION",
        conditionBody:    "Vehicle is inspected and accepted as-is at time of pickup. Condition photos are taken at pickup. Renter must report any pre-existing damage within 24 hours of pickup.",
        terminationTitle: "TERMINATION",
        terminationBody:  "SLY Transportation Services may terminate this agreement immediately for breach of terms, unpaid fees, unlawful use, or safety violations. Renter is liable for all costs to recover the vehicle.",
        paymentTitle:     "PAYMENT TERMS",
        paymentBody:      "All fees are due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.",
        noRefund:         "\u2757 <strong>No-Refund Policy:</strong> All payments are final once a booking is confirmed. Cancellations or no-shows after booking are not eligible for a refund. Refunds may be issued only if SLY Transportation cancels or cannot fulfill the rental.",
        chargebackTitle:  "PAYMENT AUTHORIZATION & CHARGEBACK POLICY",
        chargebackIntro:  "By signing this agreement, renter expressly authorizes SLY Transportation Services to charge the payment method on file for all amounts owed under this agreement, including but not limited to:",
        chargebackBullet1:"Rental charges and extensions",
        chargebackBullet2:"Security deposit and any applicable deductions",
        chargebackBullet3:"Vehicle damage, repair, or replacement costs",
        chargebackBullet4:"Loss of use and diminished value",
        chargebackBullet5:"Fuel, cleaning, smoking, or excess wear fees",
        chargebackBullet6:"Towing, storage, tickets, tolls, and administrative fees",
        chargebackAfter:  "Renter agrees that these charges may be processed after the rental period if additional costs are identified upon inspection or later discovery.",
        chargebackAck:    "Renter acknowledges that all charges are valid, agreed upon, and authorized under this contract. Renter agrees not to dispute, reverse, or initiate a chargeback for any legitimate charge incurred in accordance with this agreement.",
        chargebackDisputeTitle: "<strong>In the event of a payment dispute or chargeback, renter agrees that:</strong>",
        chargebackDispute1:"This signed agreement serves as binding proof of authorization",
        chargebackDispute2:"SLY Transportation Services may submit this agreement, along with rental records, photos, inspection reports, and communication logs, as evidence to the payment processor",
        chargebackDispute3:"Renter remains financially responsible for all charges, including any fees resulting from the dispute",
        chargebackAction: "If a chargeback is initiated without valid cause, SLY Transportation Services reserves the right to pursue collection, legal action, and recovery of all associated costs, including reasonable attorney\u2019s fees where permitted by law.",
        governingTitle:   "GOVERNING LAW",
        governingBody:    "This agreement is governed by the laws of the State of California. Disputes shall be resolved in the courts of Los Angeles County. By signing, the renter acknowledges they have read, understood, and agreed to all terms above."
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
        emailError: "We couldn\u2019t send your confirmation email automatically. Please contact us at slyservices@supports-info.com to confirm your booking.",
        pageTitle:  "Payment Successful | Sly Transportation Services LLC"
      },
      // cancel.html
      cancel: {
        title:   "\u274C Payment Canceled",
        body:    "Your payment was not completed. No charge was made. You can try again anytime!",
        homeBtn: "Back to Homepage",
        pageTitle: "Payment Canceled | Sly Transportation Services LLC"
      },
      // thank-you.html
      thankyou: {
        title:   "\uD83C\uDF89 Thank You!",
        sub:     "Your submission has been received!",
        detail:  "Our team at Sly Transportation Services LLC will review your information and reach out to you shortly to complete your approval.",
        download:"📄 Download PDF",
        fillAgain:"🔄 Fill Again",
        questions:"Questions? Call us:",
        pageTitle: "Thank You | Sly Transportation Services LLC"
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
        copy: "\u00A9 2026 Sly Transportation Services LLC. All rights reserved.",
        privacyPolicy: "Privacy Policy"
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
        terms:       "Acepto los",
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
        reserveVehicle: "Reservar Este Veh\u00EDculo",
        available:   "● Disponible",
        unavailable: "● No Disponible",
        booked:      "Reservado",
        availableToday: "\u2713 Disponible Hoy",
        driverEarnings: "\uD83D\uDCB0 Ejemplo de Ganancias del Conductor (Los \u00C1ngeles)",
        mostPopular: "M\u00E1s Popular",
        bestValue:   "Mejor Valor",
        rentalPlans: "Planes de Alquiler",
        priceListLabel: "Planes de Alquiler",
        slingshotTagline: "Hecho para la Emoci\u00F3n \u2022 Diversi\u00F3n Pura",
        slingshotSub:     "Vive la M\u00E1xima Experiencia en la Ciudad",
        slingshotBullet1: "\uD83C\uDF34 Recorre las calles de Los \u00C1ngeles con estilo",
        slingshotBullet2: "\u26A1 Siente la adrenalina al aire libre en un auto deportivo de 3 ruedas",
        slingshotBullet3: "\uD83C\uDFAF Perfecto para explorar LA, sesiones de fotos y ocasiones especiales",
        slingshotCta:     "Disponibilidad limitada \u2014 reserva el tuyo hoy",
        rideshareReady:   "\uD83D\uDE97 Listo para Uber y Lyft",
        unlimitedMilesTag:"\u221E Millaje Ilimitado",
        scarcityHigh:     "\uD83D\uDD25 Alta demanda \u2014 reserva hoy",
        scarcityLimited:  "\u26A1 Veh\u00EDculos limitados disponibles",
        earningsTagline:  "Listo para Uber y Lyft \u2022 Millaje Ilimitado",
        earningsTitle:    "Ejemplo de Ganancias del Conductor (Los \u00C1ngeles)",
        earningsAvg:      "Ganancias semanales prom. Uber/Lyft: $1,200 \u2013 $1,600",
        earningsWeekly:   "Alquiler semanal: $350",
        earningsTakeHome: "Ganancia estimada del conductor: $850 \u2013 $1,250",
        earningsCta:      "Veh\u00EDculos limitados \u2014 reserva hoy",
        driverReqHeading: "Requisitos del Conductor",
        driverReq1:       "\uD83E\uDD2A Licencia de Conducir V\u00E1lida",
        driverReq2:       "\uD83D\uDE97 Cuenta activa o elegible de Uber / Lyft",
        driverReq3:       "\uD83C\uDF82 Edad m\u00EDnima 23 a\u00F1os",
        whyHeading:       "Por Qu\u00E9 los Conductores Eligen SLY Transportation",
        why1:             "\u2705 Veh\u00EDculos aprobados para viaje compartido",
        why2:             "\u267E\uFE0F Millaje ilimitado para Uber, Lyft y entrega",
        why3:             "\uD83D\uDCB0 Alquileres semanales asequibles",
        why4:             "\uD83D\uDD27 Veh\u00EDculos confiables listos para conducir",
        why5:             "\uD83D\uDD11 Conserva el mismo veh\u00EDculo mientras los pagos est\u00E9n al d\u00EDa",
        ctaHeading:       "Empieza a Conducir Hoy",
        ctaSub:           "Reserva tu veh\u00EDculo de viaje compartido y comienza a ganar con Uber, Lyft o apps de entrega de inmediato.",
        ctaBtn:           "Ver Veh\u00EDculos Disponibles \u2191"
      },
      booking: {
        backToCars:    "\u2B05 Volver a Autos",
        pickupDate:    "Fecha de Recogida",
        pickupTime:    "Hora de Recogida",
        returnDate:    "Fecha de Devoluci\u00F3n",
        returnTime:    "Hora de Devoluci\u00F3n",
        returnTimeNote:"(misma hora que la recogida)",
        duration:      "Duraci\u00F3n",
        days:          "d\u00EDas",
        selectTier:    "Seleccionar Duraci\u00F3n",
        heading:       "Completa Tu Reserva",
        fullName:      "Nombre Completo",
        namePh:        "Ingresa tu nombre completo",
        email:         "Correo Electr\u00F3nico",
        emailPh:       "Ingresa tu correo",
        phone:         "N\u00FAmero de Tel\u00E9fono",
        phonePh:       "Ingresa tu n\u00FAmero de tel\u00E9fono",
        smsConsent:    "Al enviar este formulario, aceptas recibir mensajes SMS sobre la disponibilidad del veh\u00EDculo. Responde STOP para cancelar.",
        uploadIdLabel: "\uD83D\uDCCE Subir Licencia de Conducir / ID",
        idRequired:    "Se requiere una identificaci\u00F3n gubernamental v\u00E1lida para confirmar tu alquiler.",
        accepted:      "Aceptado: JPG, PNG, PDF",
        noFile:        "Ning\u00FAn archivo seleccionado",
        insuranceQuestion: "\uD83D\uDEE1\uFE0F \u00BFTienes seguro de auto que cubra veh\u00EDculos de alquiler?",
        hasInsurance:  "S\u00ED, tengo cobertura para autos de alquiler",
        addDpp:        "Agregar Protecci\u00F3n contra Da\u00F1os",
        uploadInsuranceLabel: "\uD83D\uDCCE Subir Prueba de Seguro",
        insuranceRequired: "Se requiere documentaci\u00F3n v\u00E1lida de seguro de auto para todos los alquileres.",
        dppWarning:    "\u26A0\uFE0F Tu seguro de auto personal puede no cubrir veh\u00EDculos de alquiler",
        dppPrice:      "Prot\u00E9gete con nuestro <strong>Plan de Protecci\u00F3n contra Da\u00F1os: $13/d\u00EDa \u2022 $85/semana \u2022 $150/2\u00A0sem \u2022 $295/mes</strong>",
        dppIncluded:   "Qu\u00E9 incluye:",
        dppBullet1:    "\u2705 Cubre da\u00F1os accidentales al veh\u00EDculo",
        dppBullet2:    "\u2705 Reduce tu responsabilidad a $1,000",
        signStep:      "\uD83D\uDCC4 Paso 1: Lee y Firma tu Contrato de Alquiler",
        reviewSignBtn: "\u270D Revisar y Firmar el Contrato de Alquiler",
        signedBtn:     "\u2705 Contrato de Alquiler Firmado",
        iAgreeTerms:   "He le\u00EDdo y firmado el Contrato de Alquiler y T\u00E9rminos",
        refundNotice:  "\u26A0\uFE0F <strong>Pol\u00EDtica de No Reembolso:</strong> Todos los pagos son definitivos una vez confirmada la reserva. Las cancelaciones o no presentaciones despu\u00E9s de la reserva no son elegibles para reembolso. Por favor revisa los detalles de tu reserva con cuidado antes de completar el pago. Los reembolsos solo se emitir\u00E1n si la empresa cancela o no puede cumplir con el alquiler.",
        subtotalLabel: "Subtotal",
        salesTaxLabel: "Impuesto sobre Ventas",
        totalLabel:    "Total",
        taxNote:       "(+ impuesto aplicable)",
        payHint:       "Completa las fechas, ingresa tu nombre y correo, sube tu ID, selecciona tu opci\u00F3n de seguro (y sube prueba si tienes cobertura), y firma y acepta los t\u00E9rminos para habilitar el pago.",
        nameError:     "Por favor ingresa al menos un nombre y apellido.",
        loadingPayment:"Cargando formulario de pago\u2026",
        processing:    "Procesando\u2026",
        changeBooking: "\u2190 Cambiar detalles de reserva",
        typeName:      "Escribe tu nombre legal completo para firmar:",
        signPh:        "Tu nombre completo",
        sigNote:       "Escribir tu nombre arriba constituye tu firma electr\u00F3nica legal.",
        iAgreeBtn:     "\u2705 Acepto y Firmo",
        cancelSignBtn: "Cancelar",
        sigMatchError: "La firma debe coincidir con el nombre completo ingresado en el formulario de reserva.",
        calcAtCheckout:"Se calcula en el pago",
        alertVehicleNotFound: "Veh\u00EDculo no encontrado.",
        alertEnterEmail: "Por favor ingresa tu direcci\u00F3n de correo electr\u00F3nico.",
        alertEnterName: "Por favor ingresa tu nombre completo.",
        agreementIntroTpl: "Este Contrato de Alquiler se celebra entre SLY Transportation Services (\u201CCompany\u201D) y {name} (\u201CArrendatario\u201D) para el alquiler de un/a {car} desde {pickup} hasta {returnDate}.",
        signedByTpl: "Firmado por {name}. Marca la casilla a continuaci\u00F3n para confirmar.",
        depositSlingshotIntroTpl: "Se incluye un <strong>dep\u00F3sito de seguridad reembolsable de ${amount}</strong> en el pago del alquiler y se devuelve despu\u00E9s de inspeccionar el veh\u00EDculo al regreso (t\u00EDpicamente dentro de 5\u20137 d\u00EDas h\u00E1biles). El dep\u00F3sito cubre da\u00F1os, p\u00E9rdida de uso, limpieza, peajes y combustible.",
        depositDppHtml: "<strong>Plan de Protecci\u00F3n contra Da\u00F1os ($13/d\u00EDa &bull; $85/semana &bull; $150/2\u00A0sem &bull; $295/mes):</strong> complemento opcional \u2014 reduce tu responsabilidad por da\u00F1os a $1,000",
        depositSlingshotRatesTpl: "<strong>Tarifas de Alquiler del Slingshot:</strong> {rates} \u2014 m\u00E1s ${deposit} de dep\u00F3sito de seguridad reembolsable (incluido en el pago)",
        depositNoDeposit: "No se requiere dep\u00F3sito de seguridad para este veh\u00EDculo.",
        lineRentalTpl: "Alquiler {label}",
        lineDeposit: "Dep\u00F3sito de seguridad (reembolsable)",
        lineDppDayTpl: "Plan de Protecci\u00F3n contra Da\u00F1os ({days} d\u00EDa \u00D7 ${rate}/d\u00EDa)",
        lineDppTpl: "Plan de Protecci\u00F3n contra Da\u00F1os ({days} d\u00EDas)",
        lineSalesTaxPctTpl: "Impuesto sobre ventas ({pct}%)",
        lineSalesTax: "Impuesto sobre ventas",
        lineWeekTpl: "Alquiler de {weeks} semana",
        lineBiweekTpl: "{count} \u00D7 alquiler de 2 semanas",
        lineMonthTpl: "Alquiler de {months} mes",
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
      // car.html rental agreement
      agreement: {
        heading:          "SLY TRANSPORTATION SERVICES \u2014 CONTRATO DE ALQUILER DE AUTO",
        partiesTitle:     "PARTES",
        ownerLabel:       "Propietario:",
        ownerDetails:     "SLY Transportation Services \u2014 (213) 916-6606 \u2014 info@slytrans.com",
        renterLabel:      "Arrendatario:",
        renterDetails:    "Nombre, direcci\u00F3n, tel\u00E9fono, correo electr\u00F3nico, n\u00FAmero de licencia de conducir y fecha de nacimiento seg\u00FAn se proporcionaron al momento de la reserva.",
        vehicleTitle:     "INFORMACI\u00D3N DEL VEH\u00CDCULO",
        makeLabel:        "Marca",
        modelLabel:       "Modelo",
        yearLabel:        "A\u00F1o",
        vinLabel:         "VIN / Placa",
        colorLabel:       "Color",
        fuelLine:         "Nivel de Combustible al Recoger: Lleno \u00A0 Medio \u00A0 Cuarto \u00A0\u00A0\u00A0 Fotos de Condici\u00F3n Adjuntas: S\u00ED",
        rentalPeriodTitle:"PER\u00CDODO DE ALQUILER",
        rentalPeriodBody: "Las fechas y horas de inicio y fin del alquiler son las especificadas al momento de la reserva. El veh\u00EDculo debe devolverse en el mismo lugar en la fecha y hora acordadas.",
        lateFee:          "Cargo por retraso: $50/d\u00EDa despu\u00E9s de un per\u00EDodo de gracia de 2 horas.",
        mileageFuelTitle: "MILLAJE Y COMBUSTIBLE",
        mileageLimit:     "L\u00EDmite de Millaje: Ilimitado.",
        fuelPolicy:       "Pol\u00EDtica de Combustible: Devuelve el veh\u00EDculo con el mismo nivel de combustible que al recogerlo, o paga una tarifa de reemplazo de $5/gal\u00F3n.",
        depositTitle:     "DEP\u00D3SITO DE SEGURIDAD (Reembolsable)",
        insuranceLiabilityTitle: "SEGURO Y RESPONSABILIDAD",
        insuranceProvide: "El arrendatario debe proporcionar <strong>una de las siguientes opciones</strong> antes de la entrega del veh\u00EDculo:",
        insuranceBullet1: "Seguro de auto personal v\u00E1lido que cubra veh\u00EDculos de alquiler (se requiere prueba), <strong>O</strong>",
        insuranceBullet2: "Compra del Plan de Protecci\u00F3n contra Da\u00F1os de SLY Transportation Services",
        dppOptional:      "Plan de Protecci\u00F3n contra Da\u00F1os (Opcional): $13/d\u00EDa \u2022 $85/semana \u2022 $150/2\u00A0semanas \u2022 $295/mes",
        dppReduces:       "Este plan reduce la responsabilidad financiera del arrendatario por da\u00F1os cubiertos al veh\u00EDculo a un m\u00E1ximo de <strong>$1,000 por incidente</strong>.",
        withoutDpp:       "<strong>Sin Plan de Protecci\u00F3n:</strong> El arrendatario es totalmente responsable de todos los da\u00F1os y costos asociados, incluyendo pero no limitado a:",
        withoutBullet1:   "Costo total de reparaci\u00F3n o reemplazo del veh\u00EDculo",
        withoutBullet2:   "P\u00E9rdida de uso (tiempo fuera de servicio)",
        withoutBullet3:   "Valor disminuido",
        withoutBullet4:   "Honorarios administrativos, de remolque y almacenamiento",
        withDpp:          "<strong>Con Plan de Protecci\u00F3n:</strong> La responsabilidad del arrendatario se limita al deducible establecido, siempre que se cumplan todos los t\u00E9rminos de este contrato.",
        exclusionsTitle:  "<strong>Exclusiones (Plan de Protecci\u00F3n Anulado Si):</strong>",
        exclusion1:       "El conductor est\u00E1 bajo la influencia de drogas o alcohol",
        exclusion2:       "Un conductor no autorizado opera el veh\u00EDculo",
        exclusion3:       "Uso imprudente, ilegal o negligente",
        exclusion4:       "Uso fuera de carretera o prohibido",
        exclusion5:       "No reportar da\u00F1os dentro de las 24 horas",
        exclusion6:       "Violaci\u00F3n de los t\u00E9rminos del contrato de alquiler",
        thirdParty:       "<strong>Responsabilidad ante Terceros:</strong> El arrendatario es el \u00FAnico responsable de cualquier reclamaci\u00F3n de terceros, incluyendo lesiones corporales, da\u00F1os a la propiedad o muerte. SLY Transportation Services no es responsable por negligencia del arrendatario. El arrendatario acepta indemnizar y eximir de responsabilidad a SLY Transportation Services de cualquier reclamaci\u00F3n, p\u00E9rdida o gasto derivado del uso del veh\u00EDculo.",
        useRestrictionsTitle: "RESTRICCIONES DE USO",
        useRestrictionsIntro: "El arrendatario acepta todas las siguientes restricciones:",
        useRestrictions1: "No fumar \u00A0 No mascotas \u00A0 No uso fuera de carretera \u00A0 No subarrendar",
        useRestrictions2: "Solo conductores aprobados \u00A0 No carreras ni remolque \u00A0 No transporte comercial",
        conditionTitle:   "INSPECCI\u00D3N DE CONDICI\u00D3N",
        conditionBody:    "El veh\u00EDculo se inspecciona y acepta tal como est\u00E1 al momento de la recogida. Se toman fotos de condici\u00F3n al recoger. El arrendatario debe reportar cualquier da\u00F1o preexistente dentro de las 24 horas de la recogida.",
        terminationTitle: "RESCISI\u00D3N",
        terminationBody:  "SLY Transportation Services puede rescindir este contrato de inmediato por incumplimiento de los t\u00E9rminos, tarifas impagadas, uso ilegal o violaciones de seguridad. El arrendatario es responsable de todos los costos para recuperar el veh\u00EDculo.",
        paymentTitle:     "T\u00C9RMINOS DE PAGO",
        paymentBody:      "Todas las tarifas se pagan al momento de la recogida. Los pagos atrasados acumulan intereses del 1.5% mensual. Cargo por cheque devuelto (NSF): $35.",
        noRefund:         "\u2757 <strong>Pol\u00EDtica de No Reembolso:</strong> Todos los pagos son definitivos una vez confirmada la reserva. Las cancelaciones o no presentaciones despu\u00E9s de la reserva no son elegibles para reembolso. Los reembolsos solo se emitir\u00E1n si SLY Transportation cancela o no puede cumplir con el alquiler.",
        chargebackTitle:  "AUTORIZACI\u00D3N DE PAGO Y POL\u00CDTICA DE CONTRACARGOS",
        chargebackIntro:  "Al firmar este contrato, el arrendatario autoriza expresamente a SLY Transportation Services a cargar el m\u00E9todo de pago registrado por todos los montos adeudados bajo este contrato, incluyendo pero no limitado a:",
        chargebackBullet1:"Cargos de alquiler y extensiones",
        chargebackBullet2:"Dep\u00F3sito de seguridad y deducciones aplicables",
        chargebackBullet3:"Costos de da\u00F1os, reparaci\u00F3n o reemplazo del veh\u00EDculo",
        chargebackBullet4:"P\u00E9rdida de uso y valor disminuido",
        chargebackBullet5:"Tarifas de combustible, limpieza, tabaco o desgaste excesivo",
        chargebackBullet6:"Remolque, almacenamiento, multas, peajes y honorarios administrativos",
        chargebackAfter:  "El arrendatario acepta que estos cargos pueden procesarse despu\u00E9s del per\u00EDodo de alquiler si se identifican costos adicionales en la inspecci\u00F3n o descubrimiento posterior.",
        chargebackAck:    "El arrendatario reconoce que todos los cargos son v\u00E1lidos, acordados y autorizados bajo este contrato. El arrendatario acepta no disputar, revertir ni iniciar un contracargo por ning\u00FAn cargo leg\u00EDtimo incurrido de acuerdo con este contrato.",
        chargebackDisputeTitle: "<strong>En caso de disputa de pago o contracargo, el arrendatario acepta que:</strong>",
        chargebackDispute1:"Este contrato firmado sirve como prueba vinculante de autorizaci\u00F3n",
        chargebackDispute2:"SLY Transportation Services puede presentar este contrato, junto con registros de alquiler, fotos, informes de inspecci\u00F3n y registros de comunicaci\u00F3n, como evidencia ante el procesador de pagos",
        chargebackDispute3:"El arrendatario sigue siendo financieramente responsable de todos los cargos, incluidas las tarifas resultantes de la disputa",
        chargebackAction: "Si se inicia un contracargo sin causa v\u00E1lida, SLY Transportation Services se reserva el derecho de emprender acciones de cobro, acciones legales y recuperar todos los costos asociados, incluidos los honorarios razonables de abogados donde lo permita la ley.",
        governingTitle:   "LEY APLICABLE",
        governingBody:    "Este contrato se rige por las leyes del Estado de California. Las disputas se resolver\u00E1n en los tribunales del Condado de Los \u00C1ngeles. Al firmar, el arrendatario reconoce haber le\u00EDdo, comprendido y acordado todos los t\u00E9rminos anteriores."
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
        emailError: "No pudimos enviar tu correo de confirmaci\u00F3n autom\u00E1ticamente. Por favor cont\u00E1ctanos en slyservices@supports-info.com para confirmar tu reserva.",
        pageTitle:  "Pago Exitoso | Sly Transportation Services LLC"
      },
      cancel: {
        title:   "\u274C Pago Cancelado",
        body:    "Tu pago no fue completado. No se realiz\u00F3 ning\u00FAn cargo. \u00A1Puedes intentarlo de nuevo en cualquier momento!",
        homeBtn: "Volver al Inicio",
        pageTitle: "Pago Cancelado | Sly Transportation Services LLC"
      },
      thankyou: {
        title:    "\uD83C\uDF89 \u00A1Gracias!",
        sub:      "\u00A1Tu solicitud ha sido recibida!",
        detail:   "Nuestro equipo en Sly Transportation Services LLC revisar\u00E1 tu informaci\u00F3n y se comunicar\u00E1 contigo pronto para completar tu aprobaci\u00F3n.",
        download: "📄 Descargar PDF",
        fillAgain:"🔄 Completar de Nuevo",
        questions:"¿Preguntas? Ll\u00E1manos:",
        pageTitle: "Gracias | Sly Transportation Services LLC"
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
        copy: "\u00A9 2026 Sly Transportation Services LLC. Todos los derechos reservados.",
        privacyPolicy: "Pol\u00EDtica de Privacidad"
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
    // Update <title> if a page-title key exists
    var titleKeyMap = {
      "success.html": "success.pageTitle",
      "cancel.html":  "cancel.pageTitle",
      "thank-you.html": "thankyou.pageTitle"
    };
    var pageName = window.location.pathname.split("/").pop();
    if (titleKeyMap[pageName]) {
      var titleVal = t(titleKeyMap[pageName]);
      if (titleVal && titleVal !== titleKeyMap[pageName]) {
        document.title = titleVal;
      }
    }
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
