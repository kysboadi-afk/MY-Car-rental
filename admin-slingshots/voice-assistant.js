/**
 * voice-assistant.js
 * SLYTRANS Fleet Control — AI Voice Assistant
 *
 * Features:
 *  • speak(text, lang, priority) — TTS via /api/tts (cached, cancelable, priority-gated)
 *  • Page Guide                 — speaks tour steps for whichever page is currently visible;
 *                                  no forced navigation; skips invisible elements automatically
 *  • Full System Tour           — navigates dashboard → bookings → vehicles → customers →
 *                                  revenue → analytics; ideal for demos and onboarding
 *  • Ask Assistant              — text Q&A via /api/admin-chat, response spoken aloud
 *  • Context-Aware Click-Explain — opt-in; explains any actionable element with full
 *                                  section + session context; covers every page/modal
 *  • Universal Action Feedback  — hooks showToast; speaks every success toast aloud
 *  • Session Memory             — auto-tracks current section, open modal, active booking,
 *                                 customer, and last action via MutationObserver
 *  • Language Toggle            — EN / ES; all speech respects chosen language
 *
 * Depends on globals defined in index.html:
 *   API_BASE, adminSecret, currentPage
 *
 * Mounted automatically on DOMContentLoaded.
 */

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const PANEL_ID              = 'va-panel';
  const BUBBLE_ID             = 'va-bubble';
  const CURSOR_ID             = 'va-tour-cursor';
  const LANG_STORAGE          = 'va_lang';
  const MUTE_STORAGE          = 'va_mute';
  const HIDE_STORAGE          = 'va_hidden';
  const CLICK_EXPLAIN_DEBOUNCE_MS = 1500;   // minimum gap between click-explain triggers
  const MAX_MODAL_WAIT_MS     = 60000;      // max ms to wait for a modal to open during tour
  const STEP_GAP_MS           = 350;        // breathing-room pause between tour steps
  const SCROLL_SETTLE_MS      = 450;        // ms to wait after scrollIntoView before spotlighting
  const PAGE_SETTLE_MS        = 800;        // ms to wait for DOM after navigate() in full tour
  const SPOTLIGHT_ID          = 'va-spotlight-ring';
  const SPOTLIGHT_CSS_ID      = 'va-spotlight-css';
  const TTS_CACHE_MAX         = 80;         // max cached TTS entries before eviction
  const VALID_LANGS           = ['en', 'es'];
  const CURSOR_TRAVEL_MS      = 650;        // ms for cursor glide animation between elements

  // Speech priority levels — higher number wins.
  // Guide audio is never interrupted; assistant and action feedback beat click-explain.
  const PRIORITY = { explain: 1, assistant: 2, guide: 3 };

  // Shared voice persona injected into every AI prompt to ensure a consistent tone
  // across click-explain, ask-assistant, and any future AI paths.
  const VOICE_PERSONA =
    'You are a concise, professional voice assistant for a car rental business admin dashboard. ' +
    'Always respond in plain spoken English (no markdown, no lists, no bullet points). ' +
    'Keep replies to 1-2 short sentences unless otherwise instructed.';

  // Keywords that indicate an element is actionable and worth explaining.
  // Matched case-insensitively against the button's cleaned label text.
  // Covers every action type across all admin sections.
  const EXPLAIN_KEYWORDS = [
    'extend', 'extension', 'fix', 'create', 'add', 'new',
    'view', 'open', 'mark', 'cancel', 'approve', 'decline',
    'charge', 'waive', 'save', 'delete', 'remove', 'edit',
    'upload', 'sync', 'resend', 'return', 'block', 'unblock',
    'complete', 'confirm', 'submit', 'flag', 'unflag',
    'refresh', 'resolve', 'dismiss', 'apply', 'update',
    // Additional actions across all sections
    'connect', 'disconnect', 'run', 'reset', 'clear', 'relink',
    'reconcile', 'heal', 'generate', 'send', 'enable', 'disable',
    'download', 'export', 'import', 'recompute', 'compute',
    'diagnose', 'check', 'search', 'filter', 'assign', 'transfer',
    'archive', 'restore', 'duplicate', 'merge', 'split',
  ];

  // Human-readable section labels for each dashboard page (EN and ES).
  const SECTION_LABELS = {
    dashboard:          { en: 'Dashboard',          es: 'Tablero' },
    bookings:           { en: 'Bookings',           es: 'Reservas' },
    'bookings-raw':     { en: 'Raw Bookings',       es: 'Reservas Sin Procesar' },
    vehicles:           { en: 'Vehicles',           es: 'Vehículos' },
    'vehicle-profile':  { en: 'Vehicle Profile',    es: 'Perfil del Vehículo' },
    expenses:           { en: 'Expenses',           es: 'Gastos' },
    revenue:            { en: 'Revenue',            es: 'Ingresos' },
    analytics:          { en: 'Analytics',          es: 'Analítica' },
    customers:          { en: 'Customers',          es: 'Clientes' },
    'fleet-status':     { en: 'Fleet Status',       es: 'Estado de Flota' },
    gps:                { en: 'GPS Tracking',       es: 'Rastreo GPS' },
    'block-dates':      { en: 'Block Dates',        es: 'Bloquear Fechas' },
    sms:                { en: 'SMS Templates',      es: 'Plantillas SMS' },
    'late-fees':        { en: 'Late Fees',          es: 'Cargos por Mora' },
    ai:                 { en: 'AI Assistant',       es: 'Asistente IA' },
    'system-health':    { en: 'System Health',      es: 'Salud del Sistema' },
    'system-settings':  { en: 'System Settings',   es: 'Configuración del Sistema' },
    'manual-booking':   { en: 'Manual Booking',     es: 'Reserva Manual' },
    'protection-plans': { en: 'Protection Plans',  es: 'Planes de Protección' },
    'vehicle-pricing':  { en: 'Vehicle Pricing',   es: 'Precios de Vehículos' },
    settings:           { en: 'Site Settings',      es: 'Configuración del Sitio' },
  };

  // Modal section overrides: when a modal is open, use this section name instead
  // of the underlying page.  Covers every modal in the admin dashboard.
  const MODAL_SECTION = {
    'booking-detail-modal':   { en: 'Booking Detail modal',     es: 'modal de Detalle de Reserva' },
    'booking-edit-modal':     { en: 'Booking Edit modal',       es: 'modal de Edición de Reserva' },
    'edit-vehicle-modal':     { en: 'Vehicle Edit modal',       es: 'modal de Edición de Vehículo' },
    'add-vehicle-modal':      { en: 'Add Vehicle modal',        es: 'modal de Agregar Vehículo' },
    'add-expense-modal':      { en: 'Add Expense modal',        es: 'modal de Agregar Gasto' },
    'lf-charge-modal':        { en: 'Charge Late Fee modal',    es: 'modal de Cobrar Cargo por Mora' },
    'lf-waive-modal':         { en: 'Waive Late Fee modal',     es: 'modal de Eximir Cargo por Mora' },
    'lf-edit-modal':          { en: 'Edit Late Fee modal',      es: 'modal de Editar Cargo por Mora' },
    'resend-extension-modal': { en: 'Extend Rental modal',      es: 'modal de Extender Alquiler' },
    'customer-edit-modal':    { en: 'Customer Edit modal',      es: 'modal de Edición de Cliente' },
    'customer-detail-modal':  { en: 'Customer Detail modal',    es: 'modal de Detalle de Cliente' },
    'plan-modal':             { en: 'Protection Plan modal',    es: 'modal de Plan de Protección' },
    'sms-edit-modal':         { en: 'SMS Template modal',       es: 'modal de Plantilla SMS' },
    'revenue-modal':          { en: 'Revenue Record modal',     es: 'modal de Registro de Ingresos' },
  };

  // Per-page tour scripts (EN / ES).
  // Each key maps to the page name used in navigate() / currentPage.
  // Steps are spoken only for the page that is currently visible,
  // so the guide always matches the UI in real time.
  const PAGE_TOUR_STEPS = {
    dashboard: [
      {
        sel: '#page-dashboard',
        en:  'Welcome to the Dashboard — your command center.',
        es:  'Bienvenido al Tablero, su centro de mando.',
      },
      {
        sel: '#kpi-grid',
        en:  'These live KPI tiles show total revenue, active rentals, bookings this month, and more. Click any card to drill into that section.',
        es:  'Estos indicadores clave muestran en tiempo real ingresos totales, rentas activas, reservas del mes y más. Haga clic en cualquier tarjeta para ir a esa sección.',
      },
      {
        sel: '#action-required-card',
        en:  'The Action Required panel shows items needing immediate attention: pending approvals, pickups today, returns today, and overdue rentals.',
        es:  'El panel de Acción Requerida muestra elementos que necesitan atención inmediata: aprobaciones pendientes, recogidas hoy, devoluciones hoy y rentas vencidas.',
      },
      {
        sel: '.charts-grid',
        en:  'The Revenue Over Time chart shows your monthly income trend, and the Bookings by Vehicle chart breaks down paid bookings per car.',
        es:  'El gráfico de Ingresos en el Tiempo muestra su tendencia mensual, y el de Reservas por Vehículo desglosa las reservas pagadas por auto.',
      },
      {
        sel: '.alerts-grid',
        en:  'At the bottom you have the Alerts and Actions feed with live notifications, and the Recent Bookings list showing your latest reservations at a glance.',
        es:  'En la parte inferior está el panel de Alertas y Acciones con notificaciones en vivo, y la lista de Reservas Recientes con sus últimas reservaciones.',
      },
      {
        sel: null,
        en:  'That is the full Dashboard overview.',
        es:  'Eso es el resumen completo del Tablero.',
      },
    ],
    vehicles: [
      {
        sel: '#page-vehicles',
        en:  'The Vehicles page lists every car in your fleet.',
        es:  'La página de Vehículos lista todos los autos de su flota.',
      },
      {
        sel: '#vehicles-content .btn-primary',
        en:  'The Add Vehicle button creates a new vehicle entry in your fleet.',
        es:  'El botón Agregar Vehículo crea una nueva entrada de vehículo en su flota.',
      },
      {
        sel: '.vehicles-grid',
        en:  'Your fleet grid shows one card per vehicle.',
        es:  'La cuadrícula de flota muestra una tarjeta por vehículo.',
      },
      {
        sel: '.vehicle-card',
        en:  'Each card shows the car image, name, status badge, and key financial stats.',
        es:  'Cada tarjeta muestra la imagen del auto, nombre, distintivo de estado y estadísticas financieras clave.',
      },
      {
        sel: '.vehicle-card-name',
        en:  'The vehicle name is shown here.',
        es:  'El nombre del vehículo se muestra aquí.',
      },
      {
        sel: '.vehicle-card .badge',
        en:  'The status badge shows whether this vehicle is Active, in Maintenance, or Inactive.',
        es:  'El distintivo de estado muestra si el vehículo está Activo, en Mantenimiento o Inactivo.',
      },
      {
        sel: '.vehicle-stats-row',
        en:  'These three stat tiles show the vehicle\'s total Revenue, Net Profit, and current Odometer reading.',
        es:  'Estos tres indicadores muestran los Ingresos totales, Ganancia Neta y lectura actual del Odómetro.',
      },
      {
        sel:          '.vehicle-card .btn-secondary',
        action:       () => { const btn = document.querySelector('.vehicle-card .btn-secondary'); if (btn) btn.click(); },
        waitForModal: '#edit-vehicle-modal',
        en:  'The Edit button opens the vehicle details form. Opening it now.',
        es:  'El botón Editar abre el formulario de detalles del vehículo. Abriéndolo ahora.',
      },
      {
        sel: '#ev-name',
        en:  'Vehicle Name — the display name shown to customers and in all reports.',
        es:  'Nombre del Vehículo — el nombre mostrado a los clientes y en todos los reportes.',
      },
      {
        sel: '#ev-type',
        en:  'Type — sets the vehicle category: Economy, Luxury, SUV, Truck, Van, or Other.',
        es:  'Tipo — establece la categoría: Económico, Lujo, SUV, Camioneta, Van u Otro.',
      },
      {
        sel: '#ev-status',
        en:  'Status — Active means the car is bookable. Maintenance hides it from new reservations.',
        es:  'Estado — Activo significa que el auto está disponible. Mantenimiento lo oculta de nuevas reservas.',
      },
      {
        sel: '#ev-year',
        en:  'Vehicle Year — the model year used in reporting and vehicle profiles.',
        es:  'Año del Vehículo — el año del modelo usado en reportes y perfiles de vehículos.',
      },
      {
        sel: '#ev-purchase-price',
        en:  'Purchase Price — used to calculate your return on investment in Fleet Analytics.',
        es:  'Precio de Compra — usado para calcular el retorno de inversión en Analítica de Flota.',
      },
      {
        sel: '#ev-cover-image',
        en:  'Cover Image — the photo shown on your public booking website. Paste a URL or click Upload.',
        es:  'Imagen de Portada — la foto mostrada en su sitio de reservas público. Pegue una URL o haga clic en Subir.',
      },
      {
        sel: '#ev-bouncie-id',
        en:  'Bouncie Device ID — links this vehicle to live GPS tracking. Enter the 15-digit IMEI from the tracker.',
        es:  'ID del Dispositivo Bouncie — vincula este vehículo al rastreo GPS en vivo. Ingrese el IMEI de 15 dígitos del rastreador.',
      },
      {
        sel:        '#edit-vehicle-modal .modal-footer',
        closeModal: 'edit-vehicle-modal',
        en:  'Save Changes applies your edits instantly. Cancel discards them. Closing this form now.',
        es:  'Guardar Cambios aplica sus ediciones al instante. Cancelar las descarta. Cerrando este formulario ahora.',
      },
      {
        sel: '.vehicle-card .btn-primary',
        en:  'The View Profile button opens the full vehicle history page with financial KPIs, GPS data, and maintenance records.',
        es:  'El botón Ver Perfil abre la página completa del historial del vehículo con KPIs financieros, datos GPS y registros de mantenimiento.',
      },
      {
        sel: null,
        en:  'That covers the Vehicles section — every button and field is now familiar.',
        es:  'Eso cubre la sección de Vehículos — cada botón y campo es ahora familiar.',
      },
    ],
    'vehicle-profile': [
      {
        sel: '#page-vehicle-profile',
        en:  'The Vehicle Profile page shows the complete performance and maintenance record for one specific vehicle.',
        es:  'La página de Perfil del Vehículo muestra el rendimiento completo y el registro de mantenimiento de un vehículo específico.',
      },
      {
        sel: '.back-btn',
        en:  'The Back to Vehicles button returns you to the fleet list.',
        es:  'El botón Regresar a Vehículos lo lleva de vuelta a la lista de flota.',
      },
      {
        sel: '.profile-header .btn-secondary',
        en:  'The Edit Vehicle button opens the edit form to update name, type, status, year, purchase price, and Bouncie device ID.',
        es:  'El botón Editar Vehículo abre el formulario para actualizar nombre, tipo, estado, año, precio de compra e ID del dispositivo Bouncie.',
      },
      {
        sel: '.fin-grid',
        en:  'These financial KPI cards give you a complete profitability snapshot of this vehicle.',
        es:  'Estas tarjetas de KPI financiero ofrecen un resumen completo de rentabilidad de este vehículo.',
      },
      {
        sel: '.fin-grid .fin-card:nth-child(1)',
        en:  'Purchase Price — what you originally paid for this car.',
        es:  'Precio de Compra — lo que pagó originalmente por este auto.',
      },
      {
        sel: '.fin-grid .fin-card:nth-child(2)',
        en:  'Total Bookings — the number of completed rental bookings for this vehicle.',
        es:  'Reservas Totales — el número de reservas completadas para este vehículo.',
      },
      {
        sel: '.fin-grid .fin-card:nth-child(3)',
        en:  'Lifetime Revenue — total gross income this vehicle has generated.',
        es:  'Ingresos de por Vida — ingresos brutos totales generados por este vehículo.',
      },
      {
        sel: '.fin-grid .fin-card:nth-child(4)',
        en:  'Total Expenses — the sum of all recorded maintenance, fuel, insurance, and repair costs.',
        es:  'Gastos Totales — la suma de todos los costos registrados de mantenimiento, combustible, seguro y reparaciones.',
      },
      {
        sel: '.fin-grid .fin-card:nth-child(5)',
        en:  'Net Profit — revenue minus expenses. Green means you are profitable; red means costs exceed income.',
        es:  'Ganancia Neta — ingresos menos gastos. Verde significa ganancias; rojo significa que los costos superan los ingresos.',
      },
      {
        sel: '.fin-grid .fin-card:nth-child(6)',
        en:  'Return on Investment — the percentage of the purchase price you have earned back as profit.',
        es:  'Retorno de Inversión — el porcentaje del precio de compra que ha recuperado como ganancia.',
      },
      {
        sel: '[onclick*="triggerBouncieSync"]',
        en:  'The Sync Now button forces an immediate GPS data pull from Bouncie for this vehicle.',
        es:  'El botón Sincronizar Ahora fuerza una actualización inmediata de los datos GPS de Bouncie para este vehículo.',
      },
      {
        sel: '[onclick*="oil"]',
        en:  'Oil Done — tap this after every oil change to reset the oil change mileage counter.',
        es:  'Aceite Listo — tóquelo después de cada cambio de aceite para reiniciar el contador de kilometraje.',
      },
      {
        sel: '[onclick*="brakes"]',
        en:  'Brakes Done — records the current mileage as the last brake inspection.',
        es:  'Frenos Listos — registra el kilometraje actual como la última inspección de frenos.',
      },
      {
        sel: '[onclick*="tires"]',
        en:  'Tires Done — records the current mileage as the last tire replacement.',
        es:  'Llantas Listas — registra el kilometraje actual como el último reemplazo de llantas.',
      },
      {
        sel: null,
        en:  'That is the Vehicle Profile section.',
        es:  'Esa es la sección de Perfil del Vehículo.',
      },
    ],
    bookings: [
      {
        sel: '#page-bookings',
        en:  'The Bookings section is the main hub for all reservations.',
        es:  'La sección de Reservas es el centro principal de todas las reservaciones.',
      },
      {
        sel: '#booking-filter-vehicle',
        en:  'This dropdown filters bookings by vehicle.',
        es:  'Este menú desplegable filtra las reservas por vehículo.',
      },
      {
        sel: '#booking-filter-status',
        en:  'This dropdown filters by booking status — reserved, active, returned, or cancelled.',
        es:  'Este menú desplegable filtra por estado de reserva — reservado, activo, devuelto o cancelado.',
      },
      {
        sel: '#booking-filter-payment',
        en:  'Filter by payment type — online Stripe, cash, Zelle, or other.',
        es:  'Filtre por tipo de pago — Stripe en línea, efectivo, Zelle u otro.',
      },
      {
        sel: '#booking-filter-risk',
        en:  'Filter by risk level to quickly review high-risk or flagged bookings.',
        es:  'Filtre por nivel de riesgo para revisar rápidamente las reservas de alto riesgo o marcadas.',
      },
      {
        sel: '#booking-search',
        en:  'Use the search box to find a booking by customer name or booking ID.',
        es:  'Use la búsqueda para encontrar una reserva por nombre del cliente o ID de reserva.',
      },
      {
        sel:          '#bookings-table-wrap',
        action:       () => { const btn = document.querySelector('#bookings-table-wrap [onclick*="viewBooking"]'); if (btn) btn.click(); },
        waitForModal: '#booking-detail-modal',
        en:  'Please click the View button on any booking row to open the Booking Detail panel — the guide will continue once it opens.',
        es:  'Haga clic en el botón Ver de cualquier fila para abrir el panel de Detalle de Reserva. El recorrido continuará cuando se abra.',
        // fullTourText: used by the Full System Tour instead of the interactive
        // waitForModal prompt, so the tour can cover this content hands-free.
        fullTourEn:
          'Each booking row has a View button that opens the full Booking Detail panel. ' +
          'Inside you can see complete customer info, vehicle assignment, rental dates, payment breakdown, and status history. ' +
          'Action buttons let you Approve, Mark as Active, Mark Returned, Extend, or Cancel the booking. ' +
          'Additional actions include Flag Issue, Resend Email, Edit Booking, and Delete Booking.',
        fullTourEs:
          'Cada fila tiene un botón Ver que abre el panel completo de Detalle de Reserva. ' +
          'Dentro puede ver información del cliente, vehículo, fechas, desglose de pagos e historial. ' +
          'Los botones de acción permiten Aprobar, Marcar como Activa, Marcar como Devuelta, Extender o Cancelar la reserva. ' +
          'Acciones adicionales incluyen Marcar Problema, Reenviar Correo, Editar y Eliminar Reserva.',
      },
      {
        sel:          '#booking-detail-modal',
        skipIfHidden: true,
        en:  'Inside the Booking Detail panel you can see the full customer info, vehicle assignment, rental dates, payment breakdown, and status history.',
        es:  'Dentro del panel de Detalle de Reserva puede ver la información completa del cliente, vehículo, fechas de renta, desglose de pagos e historial de estados.',
      },
      {
        sel:          '#booking-detail-actions',
        skipIfHidden: true,
        en:  'The primary action buttons depend on booking status: Approve confirms payment, Mark Active starts the rental, Mark Returned ends it, Extend Rental adds more days, and Cancel voids the booking.',
        es:  'Los botones de acción dependen del estado: Aprobar confirma el pago, Marcar Activa inicia la renta, Marcar Devuelta la termina, Extender Alquiler agrega días y Cancelar anula la reserva.',
      },
      {
        sel:          '#booking-detail-actions',
        skipIfHidden: true,
        en:  'Additional actions always available: Flag Issue marks the booking for attention, Resend Email sends a fresh confirmation, Edit Booking changes dates or amounts, and Delete Booking permanently removes the record.',
        es:  'Acciones adicionales siempre disponibles: Marcar Problema señala la reserva, Reenviar Correo envía una nueva confirmación, Editar Reserva cambia fechas o montos y Eliminar Reserva borra el registro permanentemente.',
      },
      {
        sel: null,
        en:  'That covers the Bookings section.',
        es:  'Eso cubre la sección de Reservas.',
      },
    ],
    'bookings-raw': [
      {
        sel: '#page-bookings-raw',
        en:  'Raw Bookings shows every booking record exactly as stored in the database — no filters, no grouping. Useful for auditing payment data or debugging webhook issues.',
        es:  'Reservas Sin Procesar muestra cada registro exactamente como está en la base de datos, sin filtros ni agrupaciones. Útil para auditar pagos o depurar problemas con webhooks.',
      },
      {
        sel: '#raw-bookings-table-wrap',
        en:  'The table shows every booking with its reference ID, customer name, vehicle, pickup and return dates, amount paid, status, and data source — Supabase or local JSON fallback.',
        es:  'La tabla muestra cada reserva con su ID de referencia, nombre, vehículo, fechas, monto pagado, estado y fuente de datos — Supabase o respaldo JSON local.',
      },
      {
        sel: null,
        en:  'That is the Raw Bookings section.',
        es:  'Esa es la sección de Reservas Sin Procesar.',
      },
    ],
    'manual-booking': [
      {
        sel: '#page-manual-booking',
        en:  'Manual Booking lets you create a reservation directly without an online payment — perfect for cash, Zelle, or phone-in bookings.',
        es:  'Reserva Manual le permite crear una reservación directamente sin pago en línea, ideal para pagos en efectivo, Zelle o reservas por teléfono.',
      },
      {
        sel: '#mb-name',
        en:  'Customer Name — enter the renter\'s full name here.',
        es:  'Nombre del Cliente — ingrese el nombre completo del arrendatario aquí.',
      },
      {
        sel: '#mb-phone',
        en:  'Phone — the renter\'s mobile number, used for SMS reminders.',
        es:  'Teléfono — el número de móvil del arrendatario, utilizado para recordatorios SMS.',
      },
      {
        sel: '#mb-email',
        en:  'Email — used to send the booking confirmation.',
        es:  'Correo — usado para enviar la confirmación de reserva.',
      },
      {
        sel: '#mb-vehicle',
        en:  'Vehicle — select which car this booking is for.',
        es:  'Vehículo — seleccione para qué auto es esta reserva.',
      },
      {
        sel: '#mb-payment-method',
        en:  'Payment Method — choose Cash, Zelle, Stripe, or Other to record how the customer paid.',
        es:  'Método de Pago — elija Efectivo, Zelle, Stripe u Otro para registrar cómo pagó el cliente.',
      },
      {
        sel: '#mb-pickup-date',
        en:  'Pickup Date — the day the customer takes the car.',
        es:  'Fecha de Recogida — el día en que el cliente recoge el auto.',
      },
      {
        sel: '#mb-return-date',
        en:  'Return Date — the scheduled return day. The system auto-calculates the price from pickup to return.',
        es:  'Fecha de Devolución — el día de devolución programado. El sistema calcula el precio automáticamente.',
      },
      {
        sel: '#mb-auto-price',
        en:  'The auto-calculated price appears here based on the vehicle and dates selected.',
        es:  'El precio calculado automáticamente aparece aquí según el vehículo y las fechas seleccionadas.',
      },
      {
        sel: '#mb-amount-paid',
        en:  'Amount Paid — override the auto price here if the customer paid a different amount.',
        es:  'Monto Pagado — sobrescriba el precio automático aquí si el cliente pagó una cantidad diferente.',
      },
      {
        sel: '#mb-notes',
        en:  'Notes — add any relevant info: cash receipt number, agreement reference, or special instructions.',
        es:  'Notas — agregue información relevante: número de recibo en efectivo, referencia de acuerdo o instrucciones especiales.',
      },
      {
        sel: '#mb-submit-btn',
        en:  'Save Booking creates the reservation immediately and adds it to the Bookings table.',
        es:  'Guardar Reserva crea la reservación de inmediato y la agrega a la tabla de Reservas.',
      },
      {
        sel: null,
        en:  'That is the Manual Booking section.',
        es:  'Esa es la sección de Reserva Manual.',
      },
    ],
    'fleet-status': [
      {
        sel: '#page-fleet-status',
        en:  'Fleet Status shows the availability toggle for each vehicle. Toggle it ON to show the car on the public website; toggle it OFF to hide it during maintenance or when a car is out of service.',
        es:  'Estado de Flota muestra el interruptor de disponibilidad de cada vehículo. Actívelo para mostrarlo en el sitio público; desactívelo para ocultarlo durante mantenimiento o cuando el auto está fuera de servicio.',
      },
      {
        sel: '#fleet-status-list',
        en:  'The availability toggles for each vehicle are listed here.',
        es:  'Los interruptores de disponibilidad para cada vehículo se muestran aquí.',
      },
      {
        sel: null,
        en:  'That is the Fleet Status section.',
        es:  'Esa es la sección de Estado de Flota.',
      },
    ],
    gps: [
      {
        sel: '#page-gps',
        en:  'GPS Tracking shows the live location of each vehicle via Bouncie integration.',
        es:  'Rastreo GPS muestra la ubicación en vivo de cada vehículo mediante la integración con Bouncie.',
      },
      {
        sel: '#gps-sync-now-btn',
        en:  'The Sync Now button pulls the latest GPS data from Bouncie immediately.',
        es:  'El botón Sincronizar Ahora obtiene los datos GPS más recientes de Bouncie de inmediato.',
      },
      {
        sel: '#gps-auto-refresh-btn',
        en:  'The Auto-Refresh toggle keeps the map and vehicle cards updating automatically every minute.',
        es:  'El interruptor Auto-Actualizar mantiene el mapa y las tarjetas actualizados automáticamente cada minuto.',
      },
      {
        sel: '#gps-vehicle-list',
        en:  'Each vehicle card here shows its last known address, odometer reading, and when it was last updated.',
        es:  'Cada tarjeta de vehículo muestra su última dirección conocida, lectura del odómetro y la última actualización.',
      },
      {
        sel: '#gps-not-connected',
        en:  'If Bouncie is not yet connected, a prompt appears here. Go to System Settings to enter your Bouncie credentials.',
        es:  'Si Bouncie no está conectado todavía, aparece un aviso aquí. Vaya a Configuración del Sistema para ingresar sus credenciales de Bouncie.',
      },
      {
        sel: null,
        en:  'That is the GPS Tracking section.',
        es:  'Esa es la sección de Rastreo GPS.',
      },
    ],
    'block-dates': [
      {
        sel: '#page-block-dates',
        en:  'Block Dates lets you prevent bookings on specific date ranges for any vehicle — perfect for scheduled maintenance or planned downtime.',
        es:  'Bloquear Fechas le permite evitar reservas en rangos de fechas específicos para cualquier vehículo, ideal para mantenimiento programado o tiempo de inactividad planificado.',
      },
      {
        sel: '#bd-block-btn',
        en:  'The Block Dates button locks the selected vehicle and date range — no new bookings will be accepted during that period.',
        es:  'El botón Bloquear Fechas bloquea el vehículo y rango de fechas seleccionados — no se aceptarán nuevas reservas durante ese período.',
      },
      {
        sel: '#bd-unblock-btn',
        en:  'The Unblock Dates button re-opens availability for the selected vehicle and date range.',
        es:  'El botón Desbloquear Fechas reabre la disponibilidad para el vehículo y rango de fechas seleccionados.',
      },
      {
        sel: null,
        en:  'That is the Block Dates section.',
        es:  'Esa es la sección de Bloquear Fechas.',
      },
    ],
    expenses: [
      {
        sel: '#page-expenses',
        en:  'The Expenses page lets you record and track all costs: maintenance, fuel, insurance, repairs, registration fees, and more.',
        es:  'La página de Gastos le permite registrar y rastrear todos los costos: mantenimiento, combustible, seguros, reparaciones, registros y más.',
      },
      {
        sel: '#exp-kpi-grid',
        en:  'These KPI tiles summarize your total expenses broken down by vehicle and by category — so you instantly see where your money is going.',
        es:  'Estos mosaicos KPI resumen sus gastos totales desglosados por vehículo y categoría — para que vea de inmediato a dónde va su dinero.',
      },
      {
        sel: '#page-expenses .btn-primary',
        en:  'The Add Expense button opens a form to choose the vehicle, category, amount, date, and an optional note. Categories include maintenance, insurance, repair, fuel, registration, and other.',
        es:  'El botón Agregar Gasto abre un formulario para elegir vehículo, categoría, monto, fecha y nota opcional. Las categorías incluyen mantenimiento, seguros, reparación, combustible, registro y otro.',
      },
      {
        sel: '#expense-filter-vehicle',
        en:  'Use this filter to narrow the expense list by vehicle.',
        es:  'Use este filtro para reducir la lista de gastos por vehículo.',
      },
      {
        sel: null,
        en:  'That is the Expenses section.',
        es:  'Esa es la sección de Gastos.',
      },
    ],
    revenue: [
      {
        sel: '#page-revenue',
        en:  'The Revenue page tracks every income record. Each row shows the customer, vehicle, dates, gross amount, Stripe fees, refunds, net revenue, payment method, and status.',
        es:  'La página de Ingresos rastrea cada registro de ingreso. Cada fila muestra el cliente, vehículo, fechas, monto bruto, comisiones de Stripe, reembolsos, ingreso neto, método de pago y estado.',
      },
      {
        sel: '#rev-filter-vehicle',
        en:  'Filter revenue records by vehicle.',
        es:  'Filtre los registros de ingresos por vehículo.',
      },
      {
        sel: '#rev-filter-status',
        en:  'Filter by status to see paid, refunded, or failed records.',
        es:  'Filtre por estado para ver registros pagados, reembolsados o fallidos.',
      },
      {
        sel: '#btn-stripe-reconcile',
        en:  'Sync from Stripe pulls in any payments from Stripe not yet recorded here — use this after a payment appears in Stripe but is missing from the list.',
        es:  'Sincronizar desde Stripe importa los pagos de Stripe que aún no están registrados aquí. Úselo cuando un pago aparezca en Stripe pero falte en la lista.',
      },
      {
        sel: '#btn-dedup',
        en:  'Fix Duplicates removes duplicate revenue records that may have been created during a Stripe sync.',
        es:  'Corregir Duplicados elimina los registros de ingreso duplicados creados durante una sincronización de Stripe.',
      },
      {
        sel: '#btn-cleanup-orphans',
        en:  'Fix Unknown resolves revenue records with a missing or unrecognized vehicle — it matches them to bookings and corrects the assignment automatically.',
        es:  'Corregir Desconocidos resuelve los registros de ingresos con vehículo faltante o no reconocido, emparejándolos con reservas y corrigiendo la asignación automáticamente.',
      },
      {
        sel: '#btn-revenue-heal',
        en:  'Relink Orphans reconnects revenue records that lost their link to a booking, fixing undercounts in Fleet Analytics.',
        es:  'Revincular Huérfanos reconecta los registros de ingresos que perdieron su vínculo con una reserva, corrigiendo los conteos bajos en Analítica de Flota.',
      },
      {
        sel: null,
        en:  'That is the Revenue section.',
        es:  'Esa es la sección de Ingresos.',
      },
    ],
    analytics: [
      {
        sel: '#page-analytics',
        en:  'Fleet Analytics gives you a complete financial performance overview of your entire operation.',
        es:  'Analítica de Flota le brinda una visión completa del rendimiento financiero de toda su operación.',
      },
      {
        sel: '#analytics-kpi-grid',
        en:  'The KPI cards at the top summarize total bookings, gross revenue, net revenue after fees, total expenses, and overall profit.',
        es:  'Las tarjetas KPI en la parte superior resumen el total de reservas, ingresos brutos, ingresos netos después de comisiones, gastos totales y ganancia general.',
      },
      {
        sel: '.charts-grid',
        en:  'The Revenue Trend chart shows your monthly income over the last twelve months. The Fleet Utilization chart shows the percentage of available days each vehicle was rented.',
        es:  'El gráfico de Tendencia de Ingresos muestra sus ingresos mensuales de los últimos doce meses. El de Utilización de Flota muestra el porcentaje de días disponibles que fue rentado cada vehículo.',
      },
      {
        sel: '#analytics-tbody',
        en:  'The Vehicle Performance table breaks down every vehicle individually: bookings count, gross and net revenue, expenses, profit, return on investment, monthly profit, payback period, utilization rate, and average revenue per booking.',
        es:  'La tabla de Rendimiento por Vehículo desglosa cada vehículo individualmente: conteo de reservas, ingresos brutos y netos, gastos, ganancia, retorno de inversión, ganancia mensual, período de recuperación, tasa de utilización e ingreso promedio por reserva.',
      },
      {
        sel: null,
        en:  'That is the Fleet Analytics section.',
        es:  'Esa es la sección de Analítica de Flota.',
      },
    ],
    customers: [
      {
        sel: '#page-customers',
        en:  'The Customers page shows every renter who has ever booked with you.',
        es:  'La página de Clientes muestra a todos los arrendatarios que alguna vez han reservado con usted.',
      },
      {
        sel: '#cust-search',
        en:  'Use the search bar to find someone by name, phone, or email.',
        es:  'Use la barra de búsqueda para encontrar a alguien por nombre, teléfono o correo.',
      },
      {
        sel: '#page-customers .btn-secondary',
        en:  'The Recompute Totals button recalculates all customer KPI figures — total spent, profit, bookings count — from the revenue records.',
        es:  'El botón Recalcular Totales recalcula todas las cifras KPI de los clientes — total gastado, ganancia, conteo de reservas — a partir de los registros de ingresos.',
      },
      {
        sel: '#page-customers .btn-primary',
        en:  'The Add Customer button creates a customer record manually without requiring an online booking first.',
        es:  'El botón Agregar Cliente crea un registro de cliente manualmente sin necesidad de que hagan una reserva en línea primero.',
      },
      {
        sel: '#cust-kpi-grid',
        en:  'These KPI tiles summarize fleet-wide customer metrics: total customers, average revenue per customer, total flagged, and total banned.',
        es:  'Estos mosaicos KPI resumen las métricas de clientes de toda la flota: clientes totales, ingreso promedio por cliente, total marcados y total prohibidos.',
      },
      {
        sel: null,
        en:  'That is the Customers section.',
        es:  'Esa es la sección de Clientes.',
      },
    ],
    'protection-plans': [
      {
        sel: '#page-protection-plans',
        en:  'Protection Plans lets you configure the insurance and coverage options offered to customers during checkout.',
        es:  'Planes de Protección le permite configurar las opciones de seguro y cobertura ofrecidas a los clientes durante el proceso de reserva.',
      },
      {
        sel: '#page-protection-plans .btn-primary',
        en:  'The Add Plan button opens a form to define a plan name, description, daily price, and what is covered. Customers will see and select these plans when booking a vehicle.',
        es:  'El botón Agregar Plan abre un formulario para definir nombre del plan, descripción, precio diario y cobertura. Los clientes verán y seleccionarán estos planes al reservar un vehículo.',
      },
      {
        sel: null,
        en:  'Each existing plan has an Edit button to update its details and a Delete button to remove it from the checkout options.',
        es:  'Cada plan existente tiene un botón Editar para actualizar sus detalles y un botón Eliminar para quitarlo de las opciones de reserva.',
      },
      {
        sel: null,
        en:  'That is the Protection Plans section.',
        es:  'Esa es la sección de Planes de Protección.',
      },
    ],
    'vehicle-pricing': [
      {
        sel: '#page-vehicle-pricing',
        en:  'Vehicle Pricing is where you control exactly what customers pay.',
        es:  'Precios de Vehículos es donde controla exactamente lo que pagan los clientes.',
      },
      {
        sel: '#vp-content',
        en:  'Each vehicle has its own pricing card with fields for the daily rate, weekly rate, security deposit, and tax rate. Each vehicle is saved individually.',
        es:  'Cada vehículo tiene su propia tarjeta de precios con campos para la tarifa diaria, semanal, depósito de seguridad y tasa de impuesto. Cada vehículo se guarda de forma individual.',
      },
      {
        sel: null,
        en:  'After updating the values, click the Save Pricing button on that vehicle\'s card. The new rates take effect immediately on the very next booking — no restart needed.',
        es:  'Después de actualizar los valores, haga clic en el botón Guardar Precios de esa tarjeta. Las nuevas tarifas surten efecto inmediatamente en la próxima reserva, sin necesidad de reinicio.',
      },
      {
        sel: null,
        en:  'That is the Vehicle Pricing section.',
        es:  'Esa es la sección de Precios de Vehículos.',
      },
    ],
    'system-settings': [
      {
        sel: '#page-system-settings',
        en:  'System Settings is where you configure the global behavior of the entire platform.',
        es:  'Configuración del Sistema es donde configura el comportamiento global de toda la plataforma.',
      },
      {
        sel: '#sys-settings-content',
        en:  'The automation section lets you toggle whether the system automatically sends booking confirmation SMS messages, pickup reminders, return reminders, and late fee alerts.',
        es:  'La sección de automatización permite activar o desactivar el envío automático de SMS de confirmación, recordatorios de recogida, recordatorios de devolución y alertas de cargo por mora.',
      },
      {
        sel: '#bouncie-auth-content',
        en:  'The Bouncie GPS section lets you connect your Bouncie account using your client ID and secret. Once connected, GPS Tracking shows live vehicle locations.',
        es:  'La sección de GPS Bouncie le permite conectar su cuenta de Bouncie usando su ID de cliente y clave secreta. Una vez conectado, el Rastreo GPS mostrará las ubicaciones en vivo.',
      },
      {
        sel: null,
        en:  'That is the System Settings section.',
        es:  'Esa es la sección de Configuración del Sistema.',
      },
    ],
    'late-fees': [
      {
        sel: '#page-late-fees',
        en:  'The Late Fees section tracks all overdue charges automatically calculated when a rental runs past its return date.',
        es:  'La sección de Cargos por Mora rastrea todos los cargos calculados automáticamente cuando una renta supera su fecha de devolución.',
      },
      {
        sel: '#lf-filter-status',
        en:  'Filter late fees by status — Pending, Approved, Paid, Failed, or Dismissed.',
        es:  'Filtre los cargos por mora por estado — Pendiente, Aprobado, Pagado, Fallido o Descartado.',
      },
      {
        sel: '#lf-filter-vehicle',
        en:  'Filter by vehicle to see late fees for a specific car.',
        es:  'Filtre por vehículo para ver los cargos por mora de un auto específico.',
      },
      {
        sel: null,
        en:  'Each row has action buttons: Approve marks the fee ready to collect, Charge bills via Stripe, Waive cancels it, Edit adjusts the amount, and Dismiss removes it from the active list.',
        es:  'Cada fila tiene botones: Aprobar marca el cargo listo, Cobrar factura vía Stripe, Eximir lo cancela, Editar ajusta el monto y Descartar lo elimina de la lista activa.',
      },
      {
        sel: null,
        en:  'That is the Late Fees section.',
        es:  'Esa es la sección de Cargos por Mora.',
      },
    ],
    sms: [
      {
        sel: '#page-sms',
        en:  'SMS Automation shows all the automated text message templates sent to customers throughout their rental journey.',
        es:  'Automatización de SMS muestra todas las plantillas de mensajes de texto automáticos enviados a los clientes durante su proceso de renta.',
      },
      {
        sel: '#page-sms',
        en:  'Templates include: the booking confirmation SMS sent after payment, the pickup reminder sent the day before rental starts, the return reminder sent the day before scheduled return, and the late fee notice sent when a vehicle is overdue.',
        es:  'Las plantillas incluyen: el SMS de confirmación enviado después del pago, el recordatorio de recogida el día anterior al inicio, el recordatorio de devolución el día antes de la fecha programada y el aviso de cargo por mora cuando el vehículo está vencido.',
      },
      {
        sel: null,
        en:  'Each template has an Edit button to rewrite the message and insert variables like customer name, vehicle name, pickup date, or return date — filled in automatically when the SMS is sent.',
        es:  'Cada plantilla tiene un botón Editar para reescribir el mensaje e insertar variables como nombre del cliente, nombre del vehículo, fecha de recogida o devolución — completadas automáticamente al enviar el SMS.',
      },
      {
        sel: null,
        en:  'That is the SMS Automation section.',
        es:  'Esa es la sección de Automatización de SMS.',
      },
    ],
    ai: [
      {
        sel: '#page-ai',
        en:  'The AI Assistant is a full conversational interface powered by artificial intelligence. Type any question or command and the assistant responds with detailed, intelligent answers.',
        es:  'El Asistente IA es una interfaz conversacional completa impulsada por inteligencia artificial. Escriba cualquier pregunta o comando y el asistente responde con respuestas detalladas e inteligentes.',
      },
      {
        sel: '#ai-chips',
        en:  'These quick-action chips give you one-tap shortcuts to common questions: This week\'s revenue, Booking analysis, Active rentals, Fraud check, and Fleet mileage. Tap any chip and the AI answers immediately.',
        es:  'Estos chips de acceso rápido dan atajos de un toque para preguntas comunes: Ingresos de esta semana, Análisis de reservas, Rentas activas, Verificación de fraude y Estado de kilometraje. Toque cualquier chip y la IA responde de inmediato.',
      },
      {
        sel: '#ai-side-panel',
        en:  'On the right side are three auto-loading insight panels: Revenue Snapshot for this week\'s income, Detected Problems for data anomalies, and Fraud Monitor for suspicious booking patterns.',
        es:  'En el lado derecho hay tres paneles de insights: Resumen de Ingresos, Problemas Detectados para anomalías de datos y Monitor de Fraude para patrones sospechosos de reserva.',
      },
      {
        sel: null,
        en:  'That is the AI Assistant section.',
        es:  'Esa es la sección del Asistente IA.',
      },
    ],
    'system-health': [
      {
        sel: '#page-system-health',
        en:  'System Health is your diagnostic center — it verifies the integrity of your entire platform: payments, bookings, revenue records, agreement PDFs, and active rental counts.',
        es:  'Salud del Sistema es su centro de diagnóstico — verifica la integridad de toda la plataforma: pagos, reservas, registros de ingresos, PDFs de acuerdos y conteos de rentas activas.',
      },
      {
        sel: '#health-run-btn',
        en:  'The Run Checks button triggers all diagnostic checks at once. Each check shows a green pass, yellow warning, or red failure with a description of the issue.',
        es:  'El botón Ejecutar Comprobaciones activa todos los diagnósticos a la vez. Cada comprobación muestra un resultado verde, amarillo de advertencia o rojo de falla con descripción del problema.',
      },
      {
        sel: '#health-checks-grid',
        en:  'The diagnostics results grid appears here after running — covering payments, bookings, revenue records, PDFs, and active rental counts.',
        es:  'La cuadrícula de resultados de diagnóstico aparece aquí al ejecutar — cubre pagos, reservas, registros de ingresos, PDFs y conteos de rentas activas.',
      },
      {
        sel: null,
        en:  'That is the System Health section.',
        es:  'Esa es la sección de Salud del Sistema.',
      },
    ],
    settings: [
      {
        sel: '#page-settings',
        en:  'The Settings page has three main sections: Admin Access, Site Content, and System Diagnostics.',
        es:  'La página de Configuración tiene tres secciones principales: Acceso de Administrador, Contenido del Sitio y Diagnósticos del Sistema.',
      },
      {
        sel: '#site-content-form',
        en:  'The Site Content section controls everything visible on your public website. You can update your business name, phone, WhatsApp, email, and logo here — changes appear on every public page immediately.',
        es:  'La sección de Contenido del Sitio controla todo lo visible en su sitio web público. Puede actualizar el nombre del negocio, teléfono, WhatsApp, correo y logo — los cambios aparecen en cada página pública de inmediato.',
      },
      {
        sel: '#site-content-form',
        en:  'Further down you can edit the hero title, About Us paragraph, social media links, a promotional banner, and your cancellation, damage, fuel, and age policies.',
        es:  'Más abajo puede editar el título hero, el párrafo de Acerca de Nosotros, enlaces de redes sociales, un banner promocional y sus políticas de cancelación, daños, combustible y edad.',
      },
      {
        sel: '#site-content-save-btn',
        en:  'The Save All Changes button publishes all your site content edits to the live website instantly.',
        es:  'El botón Guardar Todos los Cambios publica todas sus ediciones al sitio web en vivo de inmediato.',
      },
      {
        sel: '#run-diagnostics-btn',
        en:  'The Run Check button in System Diagnostics verifies all required environment variables and Supabase tables exist. Run this if you ever see errors in the admin panel.',
        es:  'El botón Ejecutar Comprobación en Diagnósticos del Sistema verifica que todas las variables de entorno requeridas y las tablas de Supabase existan. Úselo si ve errores en el panel de administración.',
      },
      {
        sel: null,
        en:  'That is the Settings section.',
        es:  'Esa es la sección de Configuración.',
      },
    ],
  };

  // Pages visited (in order) during the Full System Tour.
  // Matches the sidebar order: Dashboard → Vehicles → Bookings → Raw Bookings →
  // Manual Booking → Fleet Status → GPS → Block Dates → Expenses → Revenue →
  // Fleet Analytics → Customers → Protection Plans → Vehicle Pricing →
  // System Settings → Late Fees → SMS Automation → AI Assistant →
  // System Health → Settings
  const FULL_TOUR_PAGES = [
    'dashboard',
    'vehicles',
    'bookings',
    'bookings-raw',
    'manual-booking',
    'fleet-status',
    'gps',
    'block-dates',
    'expenses',
    'revenue',
    'analytics',
    'customers',
    'protection-plans',
    'vehicle-pricing',
    'system-settings',
    'late-fees',
    'sms',
    'ai',
    'system-health',
    'settings',
  ];

  // Closing line spoken at the end of the Full System Tour.
  const FULL_TOUR_CLOSING = {
    en: `That completes the full system tour — all ${FULL_TOUR_PAGES.length} sections covered, from Dashboard to Settings. ` +
        'You can revisit any section guide from the Voice Assistant panel, or ask a question using Ask Assistant.',
    es: `Eso completa el recorrido completo del sistema — las ${FULL_TOUR_PAGES.length} secciones cubiertas, desde el Tablero hasta Configuración. ` +
        'Puede revisar la guía de cualquier sección desde el Panel del Asistente de Voz, o hacer una pregunta usando Preguntar al Asistente.',
  };

  // ── Runtime state ─────────────────────────────────────────────────────────
  let currentAudio    = null;     // HTMLAudioElement currently playing
  let currentBlobUrl  = null;     // blob URL for the current audio (to revoke)
  let isSpeaking      = false;
  let isPaused        = false;
  let tourActive      = false;
  let tourStepIndex   = 0;
  let tourAborted     = false;
  let clickExplain    = false;    // context-aware click-explain toggle
  let lastClickTime   = 0;        // debounce tracker for click-explain
  // AbortController for the currently in-flight click-explain fetch.
  // A new eligible click aborts the previous one before starting fresh.
  let explainController = null;
  // Resolve callback exposed so stopTour() can immediately unblock waitForModalOpen.
  let tourWaitResolve = null;
  // Numeric priority of the audio currently playing (0 = nothing playing).
  let currentSpeakPriority = 0;
  // Session-level memory: updated by vaUpdateContext() whenever the admin opens a booking.
  // Persists across modal open/close cycles so AI prompts stay contextually aware of the
  // last booking the admin focused on, even after the detail modal is dismissed.
  // Also auto-updated by initContextObservers() via MutationObserver.
  const sessionCtx = {
    bookingId:  null,   // last viewed booking ID
    vehicle:    null,   // vehicle name from last viewed booking
    status:     null,   // booking status from last viewed booking
    customer:   null,   // customer name from last viewed customer detail
    lastAction: null,   // text of the most recent successful action toast
  };
  let lang            = VALID_LANGS.includes(localStorage.getItem(LANG_STORAGE))
                          ? localStorage.getItem(LANG_STORAGE)
                          : 'en';
  let muted           = localStorage.getItem(MUTE_STORAGE) === 'true';
  let panelHidden     = localStorage.getItem(HIDE_STORAGE) === 'true';

  // TTS cache: Map<`${lang}:${text}`, ArrayBuffer>
  // Used for both fixed tour phrases (pre-warmed) and repeated assistant replies.
  const ttsCache = new Map();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getApiBase() {
    return (typeof API_BASE !== 'undefined') ? API_BASE : '';
  }

  function getAdminSecret() {
    return (typeof adminSecret !== 'undefined') ? adminSecret : '';
  }

  /** Evict the oldest TTS cache entry when capacity is reached. */
  function evictOldestCacheEntry() {
    if (ttsCache.size >= TTS_CACHE_MAX) {
      ttsCache.delete(ttsCache.keys().next().value);
    }
  }

  /** Returns the currently active section label (prefers an open modal). */
  function getCurrentSection() {
    // Check if any known modal is open
    for (const [modalId, labels] of Object.entries(MODAL_SECTION)) {
      const el = document.getElementById(modalId);
      if (el && el.classList.contains('open')) {
        return labels[lang] || labels.en;
      }
    }
    // Fall back to the current page
    const page = (typeof currentPage !== 'undefined') ? currentPage : '';
    const entry = SECTION_LABELS[page];
    if (entry) return entry[lang] || entry.en;
    // Last-resort: read the live page title element so future sections are always named
    const titleEl = document.getElementById('page-title');
    if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();
    return page || 'Admin Dashboard';
  }

  /**
   * Return the currently active page key (matches navigate() / currentPage global).
   * Reads the `currentPage` global first; falls back to inspecting the active .page element.
   */
  function getActivePage() {
    if (typeof currentPage !== 'undefined' && currentPage && currentPage !== 'undefined') return currentPage;
    const active = document.querySelector('.page.active');
    if (active && active.id) return active.id.replace(/^page-/, '');
    return 'dashboard';
  }

  /**
   * Returns true when `el` exists and has a non-zero bounding box.
   * Used to skip tour steps whose target element is not rendered yet.
   */
  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  /**
   * Scrape vehicle name and booking status from the open booking-detail-modal.
   * Returns an object with `vehicle` and/or `status` strings, or null if the
   * modal is not open or the detail grid cannot be found.
   */
  function getBookingContext() {
    const modal = document.getElementById('booking-detail-modal');
    if (!modal || !modal.classList.contains('open')) return null;

    const grid = modal.querySelector('.detail-grid');
    if (!grid) return null;

    const ctx = {};
    const cells = grid.querySelectorAll(':scope > div');

    for (const cell of cells) {
      const children = cell.children;
      if (children.length < 2) continue;
      const labelText = children[0].textContent.trim().toLowerCase();
      // Use textContent so HTML badges (spans) are reduced to plain text.
      const valueText = children[children.length - 1].textContent
        .replace(/\s+/g, ' ').trim();
      if (!valueText) continue;

      if (labelText === 'vehicle')  ctx.vehicle = valueText;
      else if (labelText === 'status')  ctx.status  = valueText;
    }

    return (ctx.vehicle || ctx.status) ? ctx : null;
  }

  /**
   * Build a compact session-context suffix for AI prompts.
   * Uses the persisted sessionCtx object (auto-updated by MutationObserver whenever
   * the admin navigates, opens a modal, or completes an action) so the AI always
   * knows what the admin last did and was looking at.
   */
  function buildSessionContextLine() {
    const parts = [];
    if (sessionCtx.section)    parts.push(`current section: ${sessionCtx.section}`);
    if (sessionCtx.vehicle)    parts.push(`vehicle: ${sessionCtx.vehicle}`);
    if (sessionCtx.status)     parts.push(`status: ${sessionCtx.status}`);
    if (sessionCtx.bookingId)  parts.push(`booking: ${sessionCtx.bookingId}`);
    if (sessionCtx.customer)   parts.push(`customer: ${sessionCtx.customer}`);
    if (sessionCtx.lastAction) parts.push(`last action: ${sessionCtx.lastAction}`);
    return parts.length ? ` Session context — ${parts.join(', ')}.` : '';
  }

  function setLang(l) {
    lang = VALID_LANGS.includes(l) ? l : 'en';
    localStorage.setItem(LANG_STORAGE, lang);
    updatePanelState();
  }

  function setMuted(m) {
    muted = m;
    localStorage.setItem(MUTE_STORAGE, String(m));
    if (m) stopAudio();
    updatePanelState();
  }

  function setPanelHidden(hidden) {
    panelHidden = hidden;
    localStorage.setItem(HIDE_STORAGE, String(hidden));
    const panel  = document.getElementById(PANEL_ID);
    const bubble = document.getElementById(BUBBLE_ID);
    if (panel)  panel.style.display  = hidden ? 'none'  : 'flex';
    if (bubble) bubble.style.display = hidden ? 'flex'  : 'none';
  }

  function updatePanelState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const langBtn      = panel.querySelector('#va-lang-btn');
    const muteBtn      = panel.querySelector('#va-mute-btn');
    const explBtn      = panel.querySelector('#va-expl-btn');
    const stopBtn      = panel.querySelector('#va-stop-btn');
    const pauseBtn     = panel.querySelector('#va-pause-btn');
    const tourBtn      = panel.querySelector('#va-tour-btn');
    const fullTourBtn  = panel.querySelector('#va-fulltour-btn');

    if (langBtn)     langBtn.textContent     = lang === 'en' ? '🌎 EN' : '🌎 ES';
    if (muteBtn)     muteBtn.textContent     = muted ? '🔇 Muted' : '🔊 Sound On';
    if (explBtn)     explBtn.style.opacity   = clickExplain ? '1' : '0.55';
    if (stopBtn)     stopBtn.disabled        = !isSpeaking && !tourActive;
    if (pauseBtn) {
      pauseBtn.disabled    = !isSpeaking;
      pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
      pauseBtn.style.color = isSpeaking ? '#fff' : '#9ca3af';
    }
    if (tourBtn)     tourBtn.textContent     = tourActive ? '⏹ Stop Guide'  : '📍 Page Guide';
    if (fullTourBtn) fullTourBtn.textContent = tourActive ? '⏹ Stop Tour'   : '🚀 Full Tour';
  }

  // ── Audio stop ─────────────────────────────────────────────────────────────
  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = '';
      currentAudio = null;
    }
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    isSpeaking = false;
    isPaused   = false;
    currentSpeakPriority = 0;
    updatePanelState();
  }

  // ── Audio pause / resume ───────────────────────────────────────────────────
  function pauseAudio() {
    if (isSpeaking && !isPaused) {
      if (currentAudio) {
        currentAudio.pause();
      } else if (window.speechSynthesis && window.speechSynthesis.speaking) {
        // Demo-mode fallback: TTS uses SpeechSynthesis instead of the API
        window.speechSynthesis.pause();
      }
      isPaused = true;
      updatePanelState();
    }
  }

  function resumeAudio() {
    if (isSpeaking && isPaused) {
      if (currentAudio) {
        currentAudio.play().catch(() => {});
      } else if (window.speechSynthesis && window.speechSynthesis.paused) {
        // Demo-mode fallback: resume SpeechSynthesis
        window.speechSynthesis.resume();
      }
      isPaused = false;
      updatePanelState();
    }
  }

  function togglePause() {
    if (isPaused) resumeAudio();
    else          pauseAudio();
  }

  // ── Core TTS ───────────────────────────────────────────────────────────────
  /**
   * Fetch TTS audio into the cache without playing it.
   * Silently ignores errors — cache misses just cause a live fetch at speak() time.
   */
  async function prefetchTts(text, speakLang) {
    speakLang = speakLang || lang;
    const cacheKey = `${speakLang}:${text}`;
    if (ttsCache.has(cacheKey)) return;

    try {
      const res = await fetch(`${getApiBase()}/api/tts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, lang: speakLang, secret: getAdminSecret() }),
      });
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      evictOldestCacheEntry();
      ttsCache.set(cacheKey, buf);
    } catch (_) { /* ignore */ }
  }

  /**
   * Pre-warm the TTS cache for the current page's tour steps and all Full Tour
   * step scripts in both languages.  Called eagerly on init so tour playback
   * is nearly instant.
   */
  async function prewarmTourCache() {
    const secret = getAdminSecret();
    if (!secret) return; // not authenticated yet; tour will fetch live
    const texts = [];

    // Pre-warm steps for the page the admin is currently on
    const pageSteps = PAGE_TOUR_STEPS[getActivePage()] || [];
    for (const step of pageSteps) {
      if (step.en) texts.push([step.en, 'en']);
      if (step.es) texts.push([step.es, 'es']);
    }

    // Pre-warm first step of each Full Tour page (the introductory line)
    for (const page of FULL_TOUR_PAGES) {
      const steps = PAGE_TOUR_STEPS[page] || [];
      if (steps.length) {
        if (steps[0].en) texts.push([steps[0].en, 'en']);
        if (steps[0].es) texts.push([steps[0].es, 'es']);
      }
    }

    // Pre-warm the Full Tour closing line
    if (FULL_TOUR_CLOSING.en) texts.push([FULL_TOUR_CLOSING.en, 'en']);
    if (FULL_TOUR_CLOSING.es) texts.push([FULL_TOUR_CLOSING.es, 'es']);

    // Fire all fetches concurrently; failures are silently ignored
    await Promise.allSettled(texts.map(([t, l]) => prefetchTts(t, l)));
  }

  /**
   * Speak text aloud using /api/tts.
   * Returns a Promise that resolves when playback finishes.
   *
   * @param {string}  text
   * @param {string}  [speakLang]    — defaults to current `lang`
   * @param {number}  [priority]     — one of PRIORITY.*; lower-priority calls are
   *                                   silently dropped when something higher is playing
   */
  async function speak(text, speakLang, priority) {
    if (muted || !text) return;

    const p = (priority !== undefined) ? priority : PRIORITY.assistant;
    // Respect priority — never interrupt a higher-priority stream.
    if (isSpeaking && p < currentSpeakPriority) return;

    speakLang = speakLang || lang;
    const cacheKey = `${speakLang}:${text}`;

    stopAudio();
    isSpeaking = true;
    currentSpeakPriority = p;
    updatePanelState();

    try {
      let audioBuffer;

      if (ttsCache.has(cacheKey)) {
        audioBuffer = ttsCache.get(cacheKey);
      } else {
        const res = await fetch(`${getApiBase()}/api/tts`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text, lang: speakLang, secret: getAdminSecret() }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `TTS error ${res.status}`);
        }

        audioBuffer = await res.arrayBuffer();
        evictOldestCacheEntry();
        ttsCache.set(cacheKey, audioBuffer);
      }

      const blob     = new Blob([audioBuffer], { type: 'audio/mpeg' });
      const blobUrl  = URL.createObjectURL(blob);
      currentBlobUrl = blobUrl;
      const audio    = new Audio(blobUrl);
      currentAudio   = audio;

      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = reject;
        audio.play().catch(reject);
      });
    } catch (err) {
      // Fall back to the browser's built-in SpeechSynthesis when the TTS API is
      // unavailable (e.g. in demo mode where /api/tts is intentionally disabled).
      if (window.speechSynthesis && text) {
        await new Promise((resolve) => {
          const utt  = new SpeechSynthesisUtterance(text);
          utt.lang   = speakLang === 'es' ? 'es-US' : 'en-US';
          utt.onend  = resolve;
          utt.onerror = resolve; // resolve so the tour can continue after cancel()
          window.speechSynthesis.speak(utt);
        });
      } else {
        console.warn('[VoiceAssistant] speak error:', err);
      }
    } finally {
      stopAudio();
    }
  }

  // ── Presentation Spotlight ─────────────────────────────────────────────────
  /**
   * Inject the CSS keyframes and shared spotlight styles once per page load.
   * The spotlight ring dims everything outside the target element and pulses
   * gently to draw the presenter's audience attention to the right UI element.
   */
  function injectSpotlightStyles() {
    if (document.getElementById(SPOTLIGHT_CSS_ID)) return;
    const style = document.createElement('style');
    style.id = SPOTLIGHT_CSS_ID;
    style.textContent = `
      @keyframes va-spotlight-pulse {
        0%, 100% { box-shadow: 0 0 0 9999px rgba(0,0,0,0.55),
                               0 0 0 2px #2563eb,
                               0 0 18px rgba(37,99,235,0.55); }
        50%       { box-shadow: 0 0 0 9999px rgba(0,0,0,0.55),
                               0 0 0 3px #60a5fa,
                               0 0 32px rgba(96,165,250,0.85); }
      }
      #${SPOTLIGHT_ID} {
        position:       fixed;
        border-radius:  8px;
        pointer-events: none;
        z-index:        100000;
        opacity:        0;
        transition:     opacity 0.25s ease,
                        top    0.3s  ease,
                        left   0.3s  ease,
                        width  0.3s  ease,
                        height 0.3s  ease;
        animation:      va-spotlight-pulse 2s ease-in-out infinite;
      }
      #${SPOTLIGHT_ID}.va-visible { opacity: 1; }
      #va-step-label {
        text-align:    center;
        font-size:     10px;
        color:         #6b7280;
        padding-top:   2px;
        display:       none;
        font-variant-numeric: tabular-nums;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Show a pulsing spotlight ring around `el` that dims everything outside it.
   * The ring persists until `clearSpotlight()` is called — it stays visible for
   * the ENTIRE duration of the spoken audio for each tour step, keeping cursor
   * and voice perfectly in sync.
   *
   * @param {Element} el         — DOM element to spotlight
   * @param {string}  [caption]  — optional "Step X of Y" label shown below ring
   */
  function showSpotlight(el, caption) {
    if (!el) return;
    injectSpotlightStyles();

    const PAD  = 10;
    const rect = el.getBoundingClientRect();

    let ring = document.getElementById(SPOTLIGHT_ID);
    if (!ring) {
      ring = document.createElement('div');
      ring.id = SPOTLIGHT_ID;
      document.body.appendChild(ring);
    }

    // Position ring to exactly surround the target element
    ring.style.top    = `${rect.top    - PAD}px`;
    ring.style.left   = `${rect.left   - PAD}px`;
    ring.style.width  = `${rect.width  + PAD * 2}px`;
    ring.style.height = `${rect.height + PAD * 2}px`;

    // Optional step badge below the ring
    const oldBadge = ring.querySelector('.va-step-badge');
    if (oldBadge) oldBadge.remove();
    if (caption) {
      const badge = document.createElement('div');
      badge.className = 'va-step-badge';
      badge.style.cssText =
        'position:absolute;bottom:-22px;left:50%;transform:translateX(-50%);' +
        'background:#2563eb;color:#fff;font-size:10px;font-family:system-ui,sans-serif;' +
        'font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;' +
        'pointer-events:none;letter-spacing:0.3px;';
      badge.textContent = caption;
      ring.appendChild(badge);
    }

    // Trigger fade-in via class (transition is on #va-spotlight-ring base rule)
    requestAnimationFrame(() => requestAnimationFrame(() => ring.classList.add('va-visible')));
  }

  /** Fade out and remove the spotlight ring. */
  function clearSpotlight() {
    const ring = document.getElementById(SPOTLIGHT_ID);
    if (!ring) return;
    ring.classList.remove('va-visible');
    setTimeout(() => { if (ring.parentNode) ring.remove(); }, 260);
  }

  /**
   * Scroll `el` smoothly into the viewport center and wait for the scroll to settle.
   * Returns a Promise that resolves after SCROLL_SETTLE_MS.
   */
  function scrollAndSettle(el) {
    if (!el) return Promise.resolve();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    moveCursorTo(el);
    setTimeout(clickCursor, 300);
    return new Promise(r => setTimeout(r, SCROLL_SETTLE_MS));
  }

  // ── Tour Cursor ────────────────────────────────────────────────────────────
  function createTourCursor() {
    if (document.getElementById(CURSOR_ID)) return;

    const style = document.createElement('style');
    style.textContent = `
      #va-tour-cursor {
        position: fixed;
        top: 0; left: 0;
        width: 26px; height: 30px;
        pointer-events: none;
        z-index: 2147483647;
        display: none;
        transform: translate(-200px, -200px);
        transition: transform ${CURSOR_TRAVEL_MS}ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
        will-change: transform;
        filter: drop-shadow(0 2px 8px rgba(37,99,235,0.65)) drop-shadow(0 1px 3px rgba(0,0,0,0.5));
      }
      #va-tour-cursor.va-cursor-active { display: block; }
      #va-cursor-ripple {
        position: absolute;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: rgba(37, 99, 235, 0.4);
        top: 2px; left: 2px;
        transform: scale(0); opacity: 0;
        pointer-events: none;
      }
      #va-cursor-ripple.va-clicking {
        animation: va-cursor-click 0.45s ease-out forwards;
      }
      @keyframes va-cursor-click {
        0%   { transform: scale(0);   opacity: 0.9; }
        55%  { transform: scale(2.0); opacity: 0.5; }
        100% { transform: scale(3.0); opacity: 0;   }
      }
    `;
    document.head.appendChild(style);

    const cursor = document.createElement('div');
    cursor.id = CURSOR_ID;
    cursor.innerHTML = `
      <div id="va-cursor-ripple"></div>
      <svg width="26" height="30" viewBox="0 0 26 30" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 2L4.5 24L9.5 18.5L13 26.5L15.8 25.2L12.3 17H19.5L4.5 2Z"
              fill="white"
              stroke="#1e3a8a"
              stroke-width="1.8"
              stroke-linejoin="round"
              stroke-linecap="round"/>
      </svg>
    `;
    document.body.appendChild(cursor);
  }

  function showCursor() {
    createTourCursor();
    const c = document.getElementById(CURSOR_ID);
    if (c) c.classList.add('va-cursor-active');
  }

  function hideCursor() {
    const c = document.getElementById(CURSOR_ID);
    if (c) c.classList.remove('va-cursor-active');
  }

  function moveCursorTo(el) {
    if (!el) return;
    const cursor = document.getElementById(CURSOR_ID);
    if (!cursor) return;
    const rect = el.getBoundingClientRect();
    // Tip of the arrow points to top-left quadrant of the element
    const x = rect.left + Math.min(rect.width  * 0.2, 18);
    const y = rect.top  + Math.min(rect.height * 0.2, 14);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }

  function clickCursor() {
    const ripple = document.getElementById('va-cursor-ripple');
    if (!ripple) return;
    ripple.classList.remove('va-clicking');
    void ripple.offsetWidth; // force reflow to restart CSS animation
    ripple.classList.add('va-clicking');
  }

  // ── Modal wait helper (MutationObserver) ───────────────────────────────────
  /**
   * Returns a Promise that resolves when the element matching `selector` has
   * the class `open` added to it, or rejects after `timeoutMs`.
   * The tour calls this to pause until the user clicks "View" and the modal opens.
   */
  function waitForModalOpen(selector, timeoutMs = MAX_MODAL_WAIT_MS) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (!el) { reject(new Error(`Element not found: ${selector}`)); return; }

      // Already open
      if (el.classList.contains('open')) { tourWaitResolve = null; resolve(); return; }

      const cleanup = () => {
        clearTimeout(timer);
        obs.disconnect();
        tourWaitResolve = null;
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for modal'));
      }, timeoutMs);

      const obs = new MutationObserver(() => {
        if (el.classList.contains('open')) {
          cleanup();
          resolve();
        }
      });

      // Expose a resolve hook so stopTour() can unblock this wait immediately.
      tourWaitResolve = () => { cleanup(); resolve(); };

      obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // ── Guided Tour (current page) ─────────────────────────────────────────────
  /**
   * Start a guide for the page the admin is currently viewing.
   * No forced navigation — the tour always matches the visible UI.
   *
   * Presentation sequencing per step:
   *   1. Clear previous spotlight (fade-out)
   *   2. Scroll target element into view and wait for settle
   *   3. Show spotlight (ring persists for entire audio duration)
   *   4. Speak the step text (spotlight stays on element while voice is active)
   *   5. Brief inter-step pause before moving on
   */
  async function startTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    showCursor();
    updatePanelState();

    const page  = getActivePage();
    const steps = PAGE_TOUR_STEPS[page] || buildGenericPageSteps(page);
    const total = steps.filter(s => !s.sel || isElementVisible(document.querySelector(s.sel))).length;
    let   shown = 0;

    for (let i = 0; i < steps.length; i++) {
      if (tourAborted) break;
      tourStepIndex = i;

      const step = steps[i];
      const el   = step.sel ? document.querySelector(step.sel) : null;

      // Skip any step whose target element is specified but not visible
      if (step.sel && !isElementVisible(el)) continue;

      shown++;

      // Clear previous spotlight before moving to the next element
      clearSpotlight();

      // Scroll to element and wait for viewport to settle
      if (el) await scrollAndSettle(el);
      if (tourAborted) break;

      // Show spotlight ring (stays on for full audio duration of this step)
      const caption = lang === 'es' ? `Paso ${shown} / ${total}` : `Step ${shown} / ${total}`;
      if (el) showSpotlight(el, caption);
      updateStepLabel(shown, total);

      await speak(lang === 'es' ? step.es : step.en, undefined, PRIORITY.guide);
      if (tourAborted) break;

      // Programmatic action (e.g. open a modal) — fires after speaking
      if (step.action && !tourAborted) {
        try { step.action(); } catch (err) { console.warn('[VoiceAssistant] tour action failed:', err); }
        await new Promise(r => setTimeout(r, step.actionDelay ?? 500));
        if (tourAborted) break;
      }

      // Auto-close a modal after explaining it, then wait for animation
      if (step.closeModal && !tourAborted) {
        if (typeof closeModal === 'function') {
          try { closeModal(step.closeModal); } catch (err) { console.warn('[VoiceAssistant] closeModal failed:', err); }
        }
        await new Promise(r => setTimeout(r, 650));
        if (tourAborted) break;
      }

      // If this step requires a user action (e.g. click View to open modal),
      // keep the spotlight on the element and wait for the modal to open.
      if (step.waitForModal && !tourAborted) {
        try {
          await waitForModalOpen(step.waitForModal);
        } catch (_) {
          // Timeout or element missing — continue tour anyway
        }
        if (tourAborted) break;
        // Small delay so the modal animation finishes before spotlighting next element
        await new Promise(r => setTimeout(r, 400));
      }

      // Breathing-room pause between steps
      if (!tourAborted) await new Promise(r => setTimeout(r, STEP_GAP_MS));
    }

    clearSpotlight();
    tourActive    = false;
    tourStepIndex = 0;
    updateStepLabel(0, 0);
    hideCursor();
    updatePanelState();
  }

  // ── Full System Tour ───────────────────────────────────────────────────────
  /**
   * Navigate through all major pages in order, speaking each page's tour steps.
   * Designed for demos and onboarding.  The tour moves to the next page once all
   * visible steps for the current page have been spoken.
   *
   * Presentation sequencing per step (same as startTour):
   *   clear spotlight → scroll + settle → showSpotlight → speak → gap → next
   */
  async function startFullTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    showCursor();
    updatePanelState();

    // Pre-compute total step count for the global progress badge
    let globalTotal = 0;
    for (const pg of FULL_TOUR_PAGES) {
      const s = PAGE_TOUR_STEPS[pg] || [];
      globalTotal += s.length;
    }
    let globalStep = 0;

    // Opening announcement
    await speak(
      lang === 'es'
        ? 'Iniciando el Recorrido Completo. Navegando por todas las secciones principales.'
        : 'Starting the Full System Tour. Navigating through all major sections.',
      undefined,
      PRIORITY.guide
    );

    for (let p = 0; p < FULL_TOUR_PAGES.length; p++) {
      if (tourAborted) break;
      const page = FULL_TOUR_PAGES[p];

      // Navigate to this page and give the DOM time to render
      clearSpotlight();
      if (typeof navigate === 'function') navigate(page);
      await new Promise(r => setTimeout(r, PAGE_SETTLE_MS));
      if (tourAborted) break;

      const steps = PAGE_TOUR_STEPS[page] || [];
      for (let i = 0; i < steps.length; i++) {
        if (tourAborted) break;
        tourStepIndex = i;
        globalStep++;

        const step = steps[i];

        // In the full tour, skip the per-page closing null-sel step so transitions
        // feel fluid (the next page's intro immediately follows).
        if (!step.sel && i === steps.length - 1 && p < FULL_TOUR_PAGES.length - 1) continue;

        // Steps that require user interaction (waitForModal) are replaced by their
        // fullTourEn/fullTourEs narration text so the automated tour flows hands-free.
        // We still spotlight the step's sel element while speaking the alternate text.
        if (step.waitForModal) {
          const fullText = lang === 'es' ? step.fullTourEs : step.fullTourEn;
          if (fullText) {
            clearSpotlight();
            const el = step.sel ? document.querySelector(step.sel) : null;
            if (el && isElementVisible(el)) {
              await scrollAndSettle(el);
              if (!tourAborted) {
                const caption = lang === 'es'
                  ? `Paso ${globalStep} / ${globalTotal}`
                  : `Step ${globalStep} / ${globalTotal}`;
                showSpotlight(el, caption);
                updateStepLabel(globalStep, globalTotal);
              }
            }
            if (!tourAborted) await speak(fullText, undefined, PRIORITY.guide);
            if (!tourAborted) await new Promise(r => setTimeout(r, STEP_GAP_MS));
          }
          continue;
        }

        const el = step.sel ? document.querySelector(step.sel) : null;
        if (step.sel && !isElementVisible(el)) continue;

        // Presentation sequence: clear → scroll → spotlight → speak → pause
        clearSpotlight();
        if (el) {
          await scrollAndSettle(el);
          if (tourAborted) break;
          const caption = lang === 'es'
            ? `Paso ${globalStep} / ${globalTotal}`
            : `Step ${globalStep} / ${globalTotal}`;
          showSpotlight(el, caption);
          updateStepLabel(globalStep, globalTotal);
        }

        await speak(lang === 'es' ? step.es : step.en, undefined, PRIORITY.guide);
        if (tourAborted) break;

        // Programmatic action (e.g. open a modal)
        if (step.action && !tourAborted) {
          try { step.action(); } catch (err) { console.warn('[VoiceAssistant] tour action failed:', err); }
          await new Promise(r => setTimeout(r, step.actionDelay ?? 500));
          if (tourAborted) break;
        }

        // Auto-close a modal after explaining it
        if (step.closeModal && !tourAborted) {
          if (typeof closeModal === 'function') {
            try { closeModal(step.closeModal); } catch (err) { console.warn('[VoiceAssistant] closeModal failed:', err); }
          }
          await new Promise(r => setTimeout(r, 650));
          if (tourAborted) break;
        }

        if (!tourAborted) await new Promise(r => setTimeout(r, STEP_GAP_MS));
      }
    }

    // Closing words
    clearSpotlight();
    if (!tourAborted) {
      await speak(
        lang === 'es' ? FULL_TOUR_CLOSING.es : FULL_TOUR_CLOSING.en,
        undefined,
        PRIORITY.guide
      );
    }

    tourActive    = false;
    tourStepIndex = 0;
    updateStepLabel(0, 0);
    hideCursor();
    updatePanelState();
  }

  /**
   * Build a minimal one-step tour for pages not listed in PAGE_TOUR_STEPS.
   * Always matches whatever section the admin is on.
   */
  function buildGenericPageSteps(page) {
    const label = (SECTION_LABELS[page] && SECTION_LABELS[page][lang]) || page;
    return [
      {
        sel: `#page-${page}`,
        en:  `You are currently in the ${label} section.`,
        es:  `Actualmente se encuentra en la sección de ${label}.`,
      },
    ];
  }

  function stopTour() {
    tourAborted = true;
    // Immediately release any pending waitForModalOpen so the tour loop exits
    // without waiting up to MAX_MODAL_WAIT_MS.
    if (tourWaitResolve) { tourWaitResolve(); tourWaitResolve = null; }
    clearSpotlight();
    stopAudio();
    tourActive  = false;
    updateStepLabel(0, 0);
    hideCursor();
    updatePanelState();
  }

  /** Show or hide the step-progress label inside the panel. */
  function updateStepLabel(current, total) {
    const el = document.getElementById('va-step-label');
    if (!el) return;
    if (total > 0 && current > 0) {
      el.textContent  = lang === 'es' ? `Paso ${current} / ${total}` : `Step ${current} / ${total}`;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  // ── Context-Aware Click-Explain ────────────────────────────────────────────
  /**
   * Build a context object describing what the user clicked and where.
   * Returns null if the element should not be explained.
   */
  function buildClickContext(target) {
    // Find the nearest actionable element
    const el = target.closest(
      'button, [role="button"], .btn, [data-explain], a[onclick]'
    ) || target;

    // Must have data-explain attribute OR match the keyword allow-list
    const hasAttr = el.hasAttribute('data-explain');

    const rawLabel = (el.getAttribute('data-explain') ||
                      el.textContent || el.title || el.ariaLabel || '')
      .trim()
      // Keep printable ASCII and Latin extended (U+00C0–U+024F). Strip emojis,
      // control characters, and other non-Latin Unicode to avoid sending unexpected
      // characters to the TTS API.
      .replace(/[^\x20-\x7E\u00C0-\u024F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);

    if (!rawLabel || rawLabel.length < 2) return null;
    if (/^[✕×✖⊗•·]$/.test(rawLabel)) return null;

    const labelLower = rawLabel.toLowerCase();

    if (!hasAttr) {
      const matches = EXPLAIN_KEYWORDS.some(kw => labelLower.includes(kw));
      if (!matches) return null;
    }

    const section = getCurrentSection();
    // Enrich with vehicle / status from the open booking-detail-modal when available.
    const bookingCtx = getBookingContext();
    return { element: rawLabel, section, ...bookingCtx };
  }

  /**
   * Ask the AI for a concise explanation of the clicked element in context,
   * then speak the response.
   * @param {object} context - { element, section, vehicle?, status? }
   * @param {AbortSignal} [signal] - optional AbortSignal to cancel the fetch
   */
  async function explainWithContext(context, signal) {
    const secret = getAdminSecret();
    if (!secret) return;
    // Never fire a click-explain during a guided tour — guide has absolute priority.
    if (tourActive) return;

    const langName = lang === 'es' ? 'Spanish' : 'English';

    // Build optional context lines so the AI can give a richer, specific answer.
    const extras = [];
    if (context.vehicle) extras.push(`Vehicle: ${context.vehicle}`);
    if (context.status)  extras.push(`Booking status: ${context.status}`);
    const extraLine = extras.length ? ` Additional context — ${extras.join(', ')}.` : '';

    const prompt =
      `${VOICE_PERSONA} ` +
      `The admin just clicked "${context.element}" in the "${context.section}" section.` +
      `${extraLine}` +
      `${buildSessionContextLine()} ` +
      `In exactly 1 short sentence, explain what this action does. ` +
      `Respond in ${langName}. Do not start with "This button".`;

    const messages = [{ role: 'user', content: prompt }];

    try {
      const res = await fetch(`${getApiBase()}/api/admin-chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ secret, messages }),
        signal:  signal || AbortSignal.timeout(20000),
      });

      if (!res.ok) return;
      const data  = await res.json();
      const reply = (data.reply || '').trim().slice(0, 200);
      if (reply) await speak(reply, undefined, PRIORITY.explain);
    } catch (err) {
      // AbortError is expected when a new click interrupts the previous one.
      if (err.name !== 'AbortError') {
        console.warn('[VoiceAssistant] explainWithContext error:', err);
      }
    }
  }

  // ── Click-Explain event listener ──────────────────────────────────────────
  function handleClickExplain(e) {
    if (!clickExplain || muted) return;

    // Skip clicks inside the voice panel or the ask dialog
    const panel = document.getElementById(PANEL_ID);
    if (panel && panel.contains(e.target)) return;
    const dialog = document.getElementById('va-ask-dialog');
    if (dialog && dialog.contains(e.target)) return;

    // Debounce — prevents trivial double-clicks from firing twice
    const now = Date.now();
    if (now - lastClickTime < CLICK_EXPLAIN_DEBOUNCE_MS) return;
    lastClickTime = now;

    const context = buildClickContext(e.target);
    if (!context) return;

    // Interrupt any currently in-flight explanation (fetch + audio) before
    // starting the new one.  stopAudio() cancels playback; the AbortController
    // cancels the pending fetch so the previous explain doesn't speak over the
    // new one after its network round-trip completes.
    if (explainController) {
      explainController.abort();
      stopAudio();
    }
    explainController = new AbortController();
    const { signal } = explainController;

    explainWithContext(context, signal).finally(() => {
      // Clear the controller reference once this explain finishes or is aborted.
      if (explainController && explainController.signal === signal) {
        explainController = null;
      }
    });
  }

  // ── Ask Assistant ─────────────────────────────────────────────────────────
  async function askAssistant(question) {
    if (!question || !question.trim()) return;

    const secret = getAdminSecret();
    if (!secret) {
      alert('Please sign in to the admin dashboard first.');
      return;
    }

    const section  = getCurrentSection();
    const langName = lang === 'es' ? 'Spanish' : 'English';

    const messages = [
      {
        role:    'user',
        content: `${VOICE_PERSONA} ` +
                 `The admin is currently in the "${section}" section.` +
                 `${buildSessionContextLine()} ` +
                 `Answer in 1-2 short sentences. Respond in ${langName}. ` +
                 `Question: ${question.trim()}`,
      },
    ];

    try {
      const res = await fetch(`${getApiBase()}/api/admin-chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ secret, messages }),
        signal:  AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error(`AI error ${res.status}`);

      const data  = await res.json();
      const reply = data.reply || '';
      if (reply) await speak(reply, undefined, PRIORITY.assistant);
    } catch (err) {
      console.warn('[VoiceAssistant] askAssistant error:', err);
      await speak(
        lang === 'es'
          ? 'Lo siento, no pude obtener una respuesta. Por favor intente de nuevo.'
          : 'Sorry, I could not get a response. Please try again.',
        undefined,
        PRIORITY.assistant
      );
    }
  }

  // ── Ask Assistant dialog ───────────────────────────────────────────────────
  function openAskDialog() {
    const existing = document.getElementById('va-ask-dialog');
    if (existing) { existing.remove(); return; }

    const dialog = document.createElement('div');
    dialog.id    = 'va-ask-dialog';
    Object.assign(dialog.style, {
      position:     'fixed',
      bottom:       '220px',
      right:        '20px',
      background:   '#1a1d27',
      border:       '1px solid #2a2d3a',
      borderRadius: '12px',
      padding:      '16px',
      width:        '280px',
      zIndex:       '10000',
      boxShadow:    '0 8px 32px rgba(0,0,0,0.4)',
    });

    const placeholder = lang === 'es' ? 'Escribe tu pregunta…' : 'Type your question…';
    const btnLabel    = lang === 'es' ? 'Preguntar' : 'Ask';
    const title       = lang === 'es' ? 'Preguntar al Asistente' : 'Ask Assistant';

    dialog.innerHTML = `
      <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:10px;">
        🎙️ ${title}
      </div>
      <textarea id="va-ask-input"
        placeholder="${placeholder}"
        rows="3"
        style="width:100%;background:#111318;border:1px solid #2d3141;border-radius:8px;
               color:#fff;font-size:13px;padding:8px;resize:none;font-family:inherit;
               box-sizing:border-box;"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button id="va-ask-submit"
          style="flex:1;background:#2563eb;color:#fff;border:none;border-radius:8px;
                 padding:8px;font-size:13px;font-weight:600;cursor:pointer;">
          ${btnLabel}
        </button>
        <button id="va-ask-cancel"
          style="background:#374151;color:#fff;border:none;border-radius:8px;
                 padding:8px 12px;font-size:13px;cursor:pointer;">✕</button>
      </div>
    `;

    document.body.appendChild(dialog);

    const input  = dialog.querySelector('#va-ask-input');
    const submit = dialog.querySelector('#va-ask-submit');
    const cancel = dialog.querySelector('#va-ask-cancel');

    input.focus();

    submit.addEventListener('click', async () => {
      const q = input.value.trim();
      dialog.remove();
      if (q) await askAssistant(q);
    });

    cancel.addEventListener('click', () => dialog.remove());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit.click();
      }
    });
  }

  // ── Floating Panel ────────────────────────────────────────────────────────
  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id    = PANEL_ID;
    Object.assign(panel.style, {
      position:      'fixed',
      bottom:        '20px',
      right:         '20px',
      background:    '#1a1d27',
      border:        '1px solid #2a2d3a',
      borderRadius:  '14px',
      padding:       '14px 12px',
      zIndex:        '9999',
      boxShadow:     '0 8px 32px rgba(0,0,0,0.45)',
      display:       'flex',
      flexDirection: 'column',
      gap:           '7px',
      width:         '170px',
      userSelect:    'none',
    });

    const btnStyle = `
      display:block;width:100%;padding:7px 10px;border:none;border-radius:8px;
      font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;
      text-align:left;transition:opacity 0.2s;
    `;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
        <span style="color:#9ca3af;font-size:10px;font-weight:700;letter-spacing:0.8px;
                     text-transform:uppercase;">
          Voice Assistant
        </span>
        <button id="va-hide-btn"
          title="Hide panel"
          style="background:none;border:none;cursor:pointer;color:#6b7280;font-size:14px;
                 line-height:1;padding:0 2px;font-family:inherit;">
          ✕
        </button>
      </div>
      <button id="va-tour-btn"     style="${btnStyle}background:#2563eb;color:#fff;">
        📍 Page Guide
      </button>
      <button id="va-fulltour-btn" style="${btnStyle}background:#1d4ed8;color:#fff;">
        🚀 Full Tour
      </button>
      <button id="va-ask-btn"   style="${btnStyle}background:#374151;color:#fff;">
        🎙️ Ask Assistant
      </button>
      <button id="va-expl-btn"  style="${btnStyle}background:#374151;color:#fff;opacity:0.55;">
        🖱️ Click Explain
      </button>
      <button id="va-stop-btn"  style="${btnStyle}background:#374151;color:#9ca3af;" disabled>
        ⏹ Stop
      </button>
      <button id="va-pause-btn" style="${btnStyle}background:#374151;color:#9ca3af;" disabled>
        ⏸ Pause
      </button>
      <div id="va-step-label" style="text-align:center;font-size:10px;color:#6b7280;
                                     padding:2px 0;display:none;font-variant-numeric:tabular-nums;">
      </div>
      <div style="display:flex;gap:6px;margin-top:2px;">
        <button id="va-lang-btn"
          style="${btnStyle}flex:1;background:#111318;color:#d1d5db;
                 padding:6px 6px;font-size:11px;text-align:center;">
          🌎 EN
        </button>
        <button id="va-mute-btn"
          style="${btnStyle}flex:1;background:#111318;color:#d1d5db;
                 padding:6px 6px;font-size:11px;text-align:center;">
          🔊 Sound On
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Restore bubble (shown when panel is hidden) ──────────────────────────
    const bubble = document.createElement('button');
    bubble.id    = BUBBLE_ID;
    bubble.title = 'Show Voice Assistant';
    bubble.textContent = '🎙️';
    Object.assign(bubble.style, {
      position:     'fixed',
      bottom:       '20px',
      right:        '20px',
      width:        '42px',
      height:       '42px',
      borderRadius: '50%',
      background:   '#2563eb',
      border:       'none',
      color:        '#fff',
      fontSize:     '18px',
      cursor:       'pointer',
      zIndex:       '9999',
      boxShadow:    '0 4px 16px rgba(0,0,0,0.4)',
      display:      'none',
      alignItems:   'center',
      justifyContent: 'center',
    });
    document.body.appendChild(bubble);
    bubble.addEventListener('click', () => setPanelHidden(false));

    // Honour persisted hidden state on load
    if (panelHidden) {
      panel.style.display  = 'none';
      bubble.style.display = 'flex';
    }

    panel.querySelector('#va-hide-btn').addEventListener('click', () => setPanelHidden(true));

    panel.querySelector('#va-tour-btn').addEventListener('click', () => {
      if (tourActive) stopTour();
      else            startTour();
    });

    panel.querySelector('#va-fulltour-btn').addEventListener('click', () => {
      if (tourActive) stopTour();
      else            startFullTour();
    });

    panel.querySelector('#va-ask-btn').addEventListener('click', openAskDialog);

    panel.querySelector('#va-expl-btn').addEventListener('click', () => {
      clickExplain = !clickExplain;
      updatePanelState();
    });

    panel.querySelector('#va-stop-btn').addEventListener('click', () => {
      stopTour();
      stopAudio();
    });

    panel.querySelector('#va-pause-btn').addEventListener('click', togglePause);

    panel.querySelector('#va-lang-btn').addEventListener('click', () => {
      setLang(lang === 'en' ? 'es' : 'en');
    });

    panel.querySelector('#va-mute-btn').addEventListener('click', () => {
      setMuted(!muted);
    });

    updatePanelState();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    mountPanel();
    document.addEventListener('click', handleClickExplain);
    // Expose speak() globally for optional use by other scripts
    window.vaSpeak = speak;

    /**
     * Update session-level memory.  Call this whenever the admin opens a booking
     * or customer record, so subsequent AI prompts have rich context.
     * Also called automatically by initContextObservers() via MutationObserver.
     * @param {{ bookingId?: string, vehicle?: string, status?: string, customer?: string }} ctx
     */
    window.vaUpdateContext = (ctx) => {
      if (ctx && typeof ctx === 'object') Object.assign(sessionCtx, ctx);
    };

    /**
     * Speak any arbitrary confirmation text after a successful admin action.
     * Called automatically by the showToast() hook in index.html for every
     * success toast, covering all admin actions universally.
     * Strips emojis, checkmarks, and markdown before sending to TTS.
     * Also stores the cleaned text as sessionCtx.lastAction so the AI knows
     * what the most recent operation was.
     * Plays at PRIORITY.assistant — never interrupts the guided tour.
     * @param {string} text  — raw toast message
     */
    window.vaActionSpeak = (text) => {
      if (!text) return;
      // Strip leading emoji/symbols and common markdown characters; keep spoken words only.
      const clean = String(text)
        .replace(/[\u2000-\u3300\uD800-\uDFFF\u00A9\u00AE\u2122\u2139\u2194-\u2199\u21A9-\u21AA\u231A-\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA-\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614-\u2615\u2618\u261D\u2620\u2622-\u2623\u2626\u262A\u262E-\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F-\u2660\u2663\u2665-\u2666\u2668\u267B\u267E-\u267F\u2692-\u2697\u2699\u269B-\u269C\u26A0-\u26A1\u26AA-\u26AB\u26B0-\u26B1\u26BD-\u26BE\u26C4-\u26C5\u26CE-\u26CF\u26D1\u26D3-\u26D4\u26E9-\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733-\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763-\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934-\u2935\u2B05-\u2B07\u2B1B-\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]/g, '')
        .replace(/✅|✓|🚩|❌|⚠️|🔊|📧|🔁|🔄/g, '')
        .replace(/[*_`#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      if (clean.length < 3) return;
      // Always record the last action in session memory regardless of mute state.
      sessionCtx.lastAction = clean;
      if (muted) return;
      speak(clean, undefined, PRIORITY.assistant).catch((_e) => { /* non-blocking; TTS errors are silent */ });
    };

    // Pre-warm tour cache in the background; errors are silently swallowed
    prewarmTourCache().catch(() => {});
    // Start self-contained context observers so sessionCtx stays current automatically
    initContextObservers();
  }

  // ── Self-contained context observers ─────────────────────────────────────────
  /**
   * Observe the DOM for modal open/close events and navigation changes.
   * This makes the voice assistant self-contained — it automatically tracks what
   * the admin is looking at without requiring explicit vaUpdateContext() calls
   * from every action handler.  Also ensures future pages and modals added to
   * the admin are picked up immediately with no code changes required.
   */
  function initContextObservers() {
    // ── 1. Watch every .modal-overlay for class changes ───────────────────────
    // When any modal gains the `open` class, scrape its content into sessionCtx.
    const observeModal = (el) => {
      if (!el || el._vaObserved) return;
      el._vaObserved = true;
      new MutationObserver(() => {
        const isOpen = el.classList.contains('open');
        if (!isOpen) return;
        const id = el.id;

        // Booking detail: scrape vehicle, status, and booking ID
        if (id === 'booking-detail-modal') {
          const ctx = getBookingContext();
          if (ctx) Object.assign(sessionCtx, ctx);
          // Also try to read the booking ID from the modal heading or hidden field
          const refEl = el.querySelector('[data-booking-ref], #bd-booking-ref, .modal-booking-ref');
          if (refEl) sessionCtx.bookingId = refEl.textContent.trim() || refEl.value || sessionCtx.bookingId;
        }

        // Customer detail: scrape customer name
        if (id === 'customer-detail-modal') {
          const nameEl = el.querySelector('.modal-title, h2, h3, .customer-name, [data-customer-name]');
          if (nameEl) {
            const name = nameEl.textContent.replace(/Customer Details?/i, '').replace(/[*_`#]/g, '').trim();
            if (name.length > 1) sessionCtx.customer = name;
          }
        }

        // Vehicle edit / add: scrape vehicle name for context
        if (id === 'edit-vehicle-modal' || id === 'add-vehicle-modal') {
          const nameEl = el.querySelector('#ev-name, #av-name, [id$="-name"]');
          if (nameEl && nameEl.value) sessionCtx.vehicle = nameEl.value.trim();
        }
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    };

    // Observe all modals currently in the DOM
    document.querySelectorAll('.modal-overlay[id]').forEach(observeModal);

    // ── 2. Watch for future modals added dynamically ───────────────────────────
    // A lightweight top-level observer that only looks at direct children of body
    // being added — catches any modals injected after page load.
    new MutationObserver((mutations) => {
      for (const mut of mutations) {
        mut.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('modal-overlay') && node.id) {
            observeModal(node);
          }
          // Also catch modals nested inside added containers
          node.querySelectorAll && node.querySelectorAll('.modal-overlay[id]').forEach(observeModal);
        });
      }
    }).observe(document.body, { childList: true, subtree: false });

    // ── 3. Watch #page-title for navigation changes ────────────────────────────
    // Any time the admin navigates to a new section, #page-title text updates.
    // We store it so getCurrentSection() always has a live fallback, and the
    // AI knows which area of the dashboard the admin is working in right now.
    const titleEl = document.getElementById('page-title');
    if (titleEl) {
      new MutationObserver(() => {
        // currentPage global is updated by navigate() — getCurrentSection() reads it live.
        // Watching page-title ensures we catch any programmatic navigation too.
        const title = titleEl.textContent.trim();
        if (title) sessionCtx.section = title;
      }).observe(titleEl, { characterData: true, childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
