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
  const LANG_STORAGE          = 'va_lang';
  const MUTE_STORAGE          = 'va_mute';
  const CLICK_EXPLAIN_DEBOUNCE_MS = 1500;   // minimum gap between click-explain triggers
  const MAX_HIGHLIGHT         = 4000;       // ms to keep highlight ring visible
  const MAX_MODAL_WAIT_MS     = 60000;      // max ms to wait for a modal to open during tour
  const TTS_CACHE_MAX         = 80;         // max cached TTS entries before eviction
  const VALID_LANGS           = ['en', 'es'];

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
        en:  'The Dashboard gives you a live overview: KPIs, revenue chart, ' +
             'recent bookings, and any action items that need your attention.',
        es:  'El Tablero le da una vista en vivo: KPIs, gráfico de ingresos, ' +
             'reservas recientes y cualquier elemento de acción que requiera su atención.',
      },
      {
        sel: null,
        en:  'That is the Dashboard. Use Ask Assistant to ask any question, ' +
             'or click Full Tour to walk through every section.',
        es:  'Ese es el Tablero. Use Preguntar al Asistente para hacer cualquier pregunta, ' +
             'o haga clic en Recorrido Completo para recorrer todas las secciones.',
      },
    ],
    bookings: [
      {
        sel: '#page-bookings',
        en:  'Welcome to the Bookings table. Here you can see every reservation, ' +
             'filter by status or vehicle, and search by customer name or ID.',
        es:  'Bienvenido a la tabla de Reservas. Aquí puede ver cada reserva, ' +
             'filtrar por estado o vehículo, y buscar por nombre o ID del cliente.',
      },
      {
        sel:          '#bookings-table-wrap',
        waitForModal: '#booking-detail-modal',
        en:  'Each row represents one booking. Please click the View button on any ' +
             'row — the guide will continue once the booking detail panel opens.',
        es:  'Cada fila representa una reserva. Haga clic en el botón Ver de cualquier ' +
             'fila — el recorrido continuará cuando se abra el panel de detalle.',
      },
      {
        sel:          '#booking-detail-modal',
        skipIfHidden: true,
        en:  'This is the Booking Detail panel. It shows customer information, ' +
             'vehicle, dates, payment status, and all available actions.',
        es:  'Este es el panel de Detalle de Reserva. Muestra la información del ' +
             'cliente, vehículo, fechas, estado de pago y todas las acciones disponibles.',
      },
      {
        sel:          '#booking-detail-actions',
        skipIfHidden: true,
        en:  'The action bar lets you mark a booking as active, return the vehicle, ' +
             'extend the rental, or cancel the booking.',
        es:  'La barra de acciones le permite marcar una reserva como activa, ' +
             'devolver el vehículo, extender el alquiler o cancelar la reserva.',
      },
      {
        sel: null,
        en:  'That covers the Bookings section. Use Ask Assistant for follow-up questions.',
        es:  'Eso cubre la sección de Reservas. Use Preguntar al Asistente para preguntas de seguimiento.',
      },
    ],
    'bookings-raw': [
      {
        sel: '#page-bookings-raw',
        en:  'Raw Bookings shows unprocessed booking records exactly as stored — ' +
             'useful for auditing and debugging payment data.',
        es:  'Reservas Sin Procesar muestra los registros sin procesar tal como fueron almacenados, ' +
             'útil para auditoría y depuración de datos de pago.',
      },
      {
        sel: null,
        en:  'That is the Raw Bookings section.',
        es:  'Esa es la sección de Reservas Sin Procesar.',
      },
    ],
    vehicles: [
      {
        sel: '#page-vehicles',
        en:  'The Vehicles page lists all cars in your fleet. You can edit details, ' +
             'upload photos, view the vehicle profile, and manage availability.',
        es:  'La página de Vehículos lista todos los autos de su flota. Puede editar detalles, ' +
             'subir fotos, ver el perfil del vehículo y administrar la disponibilidad.',
      },
      {
        sel: null,
        en:  'That is the Vehicles section. Ask the assistant anything about managing your fleet.',
        es:  'Esa es la sección de Vehículos. Pregunte al asistente cualquier duda sobre la gestión de su flota.',
      },
    ],
    'vehicle-profile': [
      {
        sel: '#page-vehicle-profile',
        en:  'The Vehicle Profile shows detailed stats, trip history, and settings for a single vehicle.',
        es:  'El Perfil del Vehículo muestra estadísticas detalladas, historial de viajes y ajustes de un vehículo.',
      },
      {
        sel: null,
        en:  'That is the Vehicle Profile section.',
        es:  'Esa es la sección de Perfil del Vehículo.',
      },
    ],
    expenses: [
      {
        sel: '#page-expenses',
        en:  'The Expenses page lets you log and track costs like maintenance, fuel, ' +
             'insurance, and repairs. Filter by vehicle or category to review spending.',
        es:  'La página de Gastos le permite registrar y rastrear costos como mantenimiento, combustible, ' +
             'seguros y reparaciones. Filtre por vehículo o categoría para revisar el gasto.',
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
        en:  'The Revenue page tracks all income records. You can view, add, or edit entries, ' +
             'reconcile Stripe payments, and filter by vehicle or date range.',
        es:  'La página de Ingresos registra todos los registros de ingresos. Puede ver, agregar o editar entradas, ' +
             'conciliar pagos de Stripe y filtrar por vehículo o rango de fechas.',
      },
      {
        sel: null,
        en:  'That is the Revenue section. Use Ask Assistant to diagnose any missing or mismatched records.',
        es:  'Esa es la sección de Ingresos. Use Preguntar al Asistente para diagnosticar registros faltantes o incorrectos.',
      },
    ],
    analytics: [
      {
        sel: '#page-analytics',
        en:  'The Analytics page breaks down performance metrics: revenue trends, booking counts, ' +
             'utilization rates, and top customers.',
        es:  'La página de Analítica desglosa métricas de rendimiento: tendencias de ingresos, conteos de reservas, ' +
             'tasas de utilización y principales clientes.',
      },
      {
        sel: null,
        en:  'That is the Analytics section.',
        es:  'Esa es la sección de Analítica.',
      },
    ],
    customers: [
      {
        sel: '#page-customers',
        en:  'The Customers page shows every renter on record. You can search, view rental history, ' +
             'flag or ban customers, and edit contact details.',
        es:  'La página de Clientes muestra a todos los arrendatarios registrados. Puede buscar, ver historial de rentas, ' +
             'marcar o prohibir clientes, y editar datos de contacto.',
      },
      {
        sel: null,
        en:  'That is the Customers section.',
        es:  'Esa es la sección de Clientes.',
      },
    ],
    'fleet-status': [
      {
        sel: '#page-fleet-status',
        en:  'Fleet Status gives you a real-time view of each vehicle — ' +
             'whether it is available, rented, overdue, or blocked.',
        es:  'Estado de Flota le da una vista en tiempo real de cada vehículo: ' +
             'si está disponible, rentado, vencido o bloqueado.',
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
        en:  'GPS Tracking shows the live location of your vehicles via Bouncie integration. ' +
             'You can sync, view odometer readings, and track trips.',
        es:  'Rastreo GPS muestra la ubicación en vivo de sus vehículos mediante la integración con Bouncie. ' +
             'Puede sincronizar, ver lecturas del odómetro y rastrear viajes.',
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
        en:  'Block Dates lets you mark specific date ranges as unavailable for a vehicle — ' +
             'useful for maintenance windows or planned downtime.',
        es:  'Bloquear Fechas le permite marcar rangos de fechas como no disponibles para un vehículo, ' +
             'útil para mantenimiento o tiempos de inactividad planificados.',
      },
      {
        sel: null,
        en:  'That is the Block Dates section.',
        es:  'Esa es la sección de Bloquear Fechas.',
      },
    ],
    sms: [
      {
        sel: '#page-sms',
        en:  'SMS Templates lets you customize the automated texts sent to customers — ' +
             'booking confirmations, reminders, and late fee notices.',
        es:  'Plantillas SMS le permite personalizar los mensajes automáticos enviados a clientes, ' +
             'como confirmaciones de reserva, recordatorios y avisos de cargos por mora.',
      },
      {
        sel: null,
        en:  'That is the SMS Templates section.',
        es:  'Esa es la sección de Plantillas SMS.',
      },
    ],
    'late-fees': [
      {
        sel: '#page-late-fees',
        en:  'Late Fees shows all overdue charges. You can approve, adjust, waive, ' +
             'or charge late fees directly from this page.',
        es:  'Cargos por Mora muestra todos los cargos vencidos. Puede aprobar, ajustar, eximir ' +
             'o cobrar cargos por mora directamente desde esta página.',
      },
      {
        sel: null,
        en:  'That is the Late Fees section.',
        es:  'Esa es la sección de Cargos por Mora.',
      },
    ],
    ai: [
      {
        sel: '#page-ai',
        en:  'The AI Assistant lets you type any question or command and get an intelligent response — ' +
             'from looking up a booking to creating one or diagnosing issues.',
        es:  'El Asistente IA le permite escribir cualquier pregunta o comando y obtener una respuesta inteligente, ' +
             'desde buscar una reserva hasta crear una o diagnosticar problemas.',
      },
      {
        sel: null,
        en:  'That is the AI Assistant page. You can also use Ask Assistant in the Voice Panel for spoken replies.',
        es:  'Esa es la página del Asistente IA. También puede usar Preguntar al Asistente en el Panel de Voz para respuestas habladas.',
      },
    ],
    'system-health': [
      {
        sel: '#page-system-health',
        en:  'System Health shows diagnostic checks, webhook logs, SMS delivery logs, ' +
             'and any issues that need attention.',
        es:  'Salud del Sistema muestra verificaciones de diagnóstico, registros de webhooks, ' +
             'registros de entrega de SMS y cualquier problema que necesite atención.',
      },
      {
        sel: null,
        en:  'That is the System Health section.',
        es:  'Esa es la sección de Salud del Sistema.',
      },
    ],
    'system-settings': [
      {
        sel: '#page-system-settings',
        en:  'System Settings lets you configure global options like tax rates, automation toggles, ' +
             'notification settings, Bouncie GPS connection, and pricing tiers.',
        es:  'Configuración del Sistema le permite configurar opciones globales como tasas de impuestos, ' +
             'interruptores de automatización, ajustes de notificación, conexión GPS de Bouncie y niveles de precios.',
      },
      {
        sel: null,
        en:  'That is the System Settings section.',
        es:  'Esa es la sección de Configuración del Sistema.',
      },
    ],
    'manual-booking': [
      {
        sel: '#page-manual-booking',
        en:  'Manual Booking lets you create a reservation directly — useful for cash payments, ' +
             'phone bookings, or customers whose online booking was not recorded.',
        es:  'Reserva Manual le permite crear una reserva directamente, útil para pagos en efectivo, ' +
             'reservas por teléfono o clientes cuya reserva en línea no fue registrada.',
      },
      {
        sel: null,
        en:  'That is the Manual Booking section.',
        es:  'Esa es la sección de Reserva Manual.',
      },
    ],
    'protection-plans': [
      {
        sel: '#page-protection-plans',
        en:  'Protection Plans lets you configure the insurance and coverage options ' +
             'offered to customers during checkout.',
        es:  'Planes de Protección le permite configurar las opciones de seguro y cobertura ' +
             'ofrecidas a los clientes durante el pago.',
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
        en:  'Vehicle Pricing lets you set daily rates, weekly rates, deposits, ' +
             'and tax for each vehicle in your fleet.',
        es:  'Precios de Vehículos le permite establecer tarifas diarias, semanales, depósitos ' +
             'e impuestos para cada vehículo de su flota.',
      },
      {
        sel: null,
        en:  'That is the Vehicle Pricing section.',
        es:  'Esa es la sección de Precios de Vehículos.',
      },
    ],
    settings: [
      {
        sel: '#page-settings',
        en:  'Site Settings lets you update your business name, phone number, logo, ' +
             'about text, and other public-facing content on the website.',
        es:  'Configuración del Sitio le permite actualizar el nombre de su negocio, número de teléfono, ' +
             'logo, texto de descripción y otro contenido público del sitio web.',
      },
      {
        sel: null,
        en:  'That is the Site Settings section.',
        es:  'Esa es la sección de Configuración del Sitio.',
      },
    ],
  };

  // Pages visited (in order) during the Full System Tour.
  const FULL_TOUR_PAGES = [
    'dashboard', 'bookings', 'vehicles', 'customers', 'revenue', 'analytics',
  ];

  // Closing line spoken at the end of the Full System Tour.
  const FULL_TOUR_CLOSING = {
    en: 'That completes the full system tour. You can start any page guide from the ' +
        'Voice Assistant panel, or ask a question using Ask Assistant.',
    es: 'Eso completa el recorrido completo del sistema. Puede iniciar la guía de cualquier ' +
        'página desde el panel del Asistente de Voz, o hacer una pregunta usando Preguntar al Asistente.',
  };

  // ── Runtime state ─────────────────────────────────────────────────────────
  let currentAudio    = null;     // HTMLAudioElement currently playing
  let currentBlobUrl  = null;     // blob URL for the current audio (to revoke)
  let isSpeaking      = false;
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

  function updatePanelState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const langBtn      = panel.querySelector('#va-lang-btn');
    const muteBtn      = panel.querySelector('#va-mute-btn');
    const explBtn      = panel.querySelector('#va-expl-btn');
    const stopBtn      = panel.querySelector('#va-stop-btn');
    const tourBtn      = panel.querySelector('#va-tour-btn');
    const fullTourBtn  = panel.querySelector('#va-fulltour-btn');

    if (langBtn)     langBtn.textContent     = lang === 'en' ? '🌎 EN' : '🌎 ES';
    if (muteBtn)     muteBtn.textContent     = muted ? '🔇 Muted' : '🔊 Sound On';
    if (explBtn)     explBtn.style.opacity   = clickExplain ? '1' : '0.55';
    if (stopBtn)     stopBtn.disabled        = !isSpeaking && !tourActive;
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
    isSpeaking = false;
    currentSpeakPriority = 0;
    updatePanelState();
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
      console.warn('[VoiceAssistant] speak error:', err);
    } finally {
      stopAudio();
    }
  }

  // ── Highlight helper ───────────────────────────────────────────────────────
  function highlightElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline       = '3px solid #2563eb';
    el.style.outlineOffset = '3px';
    el.style.borderRadius  = '6px';
    el.style.transition    = 'outline 0.3s';
    setTimeout(() => {
      el.style.outline       = '';
      el.style.outlineOffset = '';
    }, MAX_HIGHLIGHT);
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
   * For each step: the target element must exist and be visible; otherwise the
   * step is skipped automatically.
   */
  async function startTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    updatePanelState();

    const page  = getActivePage();
    const steps = PAGE_TOUR_STEPS[page] || buildGenericPageSteps(page);

    for (let i = 0; i < steps.length; i++) {
      if (tourAborted) break;
      tourStepIndex = i;

      const step = steps[i];
      const el   = step.sel ? document.querySelector(step.sel) : null;

      // Skip any step whose target element is specified but not visible
      if (step.sel && !isElementVisible(el)) continue;

      if (el) highlightElement(el);
      await speak(lang === 'es' ? step.es : step.en, undefined, PRIORITY.guide);

      if (tourAborted) break;

      // If this step requires a user action (e.g. click View to open modal),
      // pause here and wait for the target modal to gain the .open class.
      if (step.waitForModal && !tourAborted) {
        try {
          await waitForModalOpen(step.waitForModal);
        } catch (_) {
          // Timeout or element missing — continue tour anyway
        }
        if (tourAborted) break;
        // Small delay so the modal animation finishes before highlighting
        await new Promise(r => setTimeout(r, 400));
      }
    }

    tourActive    = false;
    tourStepIndex = 0;
    updatePanelState();
  }

  // ── Full System Tour ───────────────────────────────────────────────────────
  /**
   * Navigate through all major pages in order, speaking each page's tour steps.
   * Designed for demos and onboarding.  The tour moves to the next page once all
   * visible steps for the current page have been spoken.
   */
  async function startFullTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    updatePanelState();

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

      // Navigate to this page and give the DOM a moment to render
      if (typeof navigate === 'function') navigate(page);
      await new Promise(r => setTimeout(r, 500));
      if (tourAborted) break;

      const steps = PAGE_TOUR_STEPS[page] || [];
      for (let i = 0; i < steps.length; i++) {
        if (tourAborted) break;
        tourStepIndex = i;

        const step = steps[i];

        // In the full tour, skip the per-page closing null-sel step so transitions
        // feel fluid (the next page's intro immediately follows).
        if (!step.sel && i === steps.length - 1 && p < FULL_TOUR_PAGES.length - 1) continue;

        const el = step.sel ? document.querySelector(step.sel) : null;
        if (step.sel && !isElementVisible(el)) continue;

        if (el) highlightElement(el);
        await speak(lang === 'es' ? step.es : step.en, undefined, PRIORITY.guide);
        if (tourAborted) break;

        if (step.waitForModal && !tourAborted) {
          try {
            await waitForModalOpen(step.waitForModal);
          } catch (_) {
            // Timeout or missing — advance anyway
          }
          if (tourAborted) break;
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }

    // Closing words
    if (!tourAborted) {
      await speak(
        lang === 'es' ? FULL_TOUR_CLOSING.es : FULL_TOUR_CLOSING.en,
        undefined,
        PRIORITY.guide
      );
    }

    tourActive    = false;
    tourStepIndex = 0;
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
    stopAudio();
    tourActive  = false;
    updatePanelState();
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
      <div style="color:#9ca3af;font-size:10px;font-weight:700;letter-spacing:0.8px;
                  text-transform:uppercase;margin-bottom:2px;">
        Voice Assistant
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
