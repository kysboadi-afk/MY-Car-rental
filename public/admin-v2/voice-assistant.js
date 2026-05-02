/**
 * voice-assistant.js
 * SLYTRANS Fleet Control — AI Voice Assistant
 *
 * Features:
 *  • speak(text, lang)          — TTS via /api/tts (cached, cancelable)
 *  • Guided Tour                — step-by-step onboarding with element highlights;
 *                                 pauses after "Click View" step and waits for the
 *                                 booking-detail modal to actually open before resuming
 *  • Ask Assistant              — text Q&A via /api/admin-chat, response spoken aloud
 *  • Context-Aware Click-Explain — opt-in; sends element + section context to
 *                                  /api/admin-chat for an intelligent 1-sentence
 *                                  explanation; only fires for scoped actionable
 *                                  elements (data-explain attribute or allow-list keywords)
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

  // Canned EN/ES voice confirmations for key admin actions.
  const ACTION_FEEDBACK = {
    return:                  { en: 'Vehicle marked as returned.',     es: 'Vehículo marcado como devuelto.' },
    extend:                  { en: 'Rental extension applied.',       es: 'Extensión de alquiler aplicada.' },
    return_date:             { en: 'Return date updated.',            es: 'Fecha de devolución actualizada.' },
    resend_email:            { en: 'Confirmation email sent.',        es: 'Correo de confirmación enviado.' },
    status_booked_paid:      { en: 'Booking marked as paid.',         es: 'Reserva marcada como pagada.' },
    status_active_rental:    { en: 'Booking set to active.',          es: 'Reserva activada.' },
    status_cancelled_rental: { en: 'Booking cancelled.',              es: 'Reserva cancelada.' },
  };

  // Shared voice persona injected into every AI prompt to ensure a consistent tone
  // across click-explain, ask-assistant, and any future AI paths.
  const VOICE_PERSONA =
    'You are a concise, professional voice assistant for a car rental business admin dashboard. ' +
    'Always respond in plain spoken English (no markdown, no lists, no bullet points). ' +
    'Keep replies to 1-2 short sentences unless otherwise instructed.';

  // Keywords that indicate an element is actionable and worth explaining.
  // Matched case-insensitively against the button's cleaned label text.
  const EXPLAIN_KEYWORDS = [
    'extend', 'extension', 'fix', 'create', 'add', 'new',
    'view', 'open', 'mark', 'cancel', 'approve', 'decline',
    'charge', 'waive', 'save', 'delete', 'remove', 'edit',
    'upload', 'sync', 'resend', 'return', 'block', 'unblock',
    'complete', 'confirm', 'submit', 'flag', 'unflag',
    'refresh', 'resolve', 'dismiss', 'apply', 'update',
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
    'system-settings':  { en: 'System Settings',   es: 'Configuración' },
    'manual-booking':   { en: 'Manual Booking',     es: 'Reserva Manual' },
    'protection-plans': { en: 'Protection Plans',  es: 'Planes de Protección' },
    'vehicle-pricing':  { en: 'Vehicle Pricing',   es: 'Precios de Vehículos' },
  };

  // Modal section overrides: when a modal is open, use this section name instead
  // of the underlying page.
  const MODAL_SECTION = {
    'booking-detail-modal': { en: 'Booking Detail modal',  es: 'modal de Detalle de Reserva' },
    'booking-edit-modal':   { en: 'Booking Edit modal',    es: 'modal de Edición de Reserva' },
    'edit-vehicle-modal':   { en: 'Vehicle Edit modal',    es: 'modal de Edición de Vehículo' },
    'add-vehicle-modal':    { en: 'Add Vehicle modal',     es: 'modal de Agregar Vehículo' },
    'add-expense-modal':    { en: 'Add Expense modal',     es: 'modal de Agregar Gasto' },
    'lf-charge-modal':      { en: 'Charge Late Fee modal', es: 'modal de Cobrar Cargo por Mora' },
    'lf-waive-modal':       { en: 'Waive Late Fee modal',  es: 'modal de Eximir Cargo por Mora' },
    'lf-edit-modal':        { en: 'Edit Late Fee modal',   es: 'modal de Editar Cargo por Mora' },
    'resend-extension-modal':{ en: 'Extend Rental modal',  es: 'modal de Extender Alquiler' },
    'customer-edit-modal':  { en: 'Customer Edit modal',   es: 'modal de Edición de Cliente' },
    'plan-modal':           { en: 'Protection Plan modal', es: 'modal de Plan de Protección' },
    'sms-edit-modal':       { en: 'SMS Template modal',    es: 'modal de Plantilla SMS' },
  };

  // Fixed tour scripts (EN / ES).  Stored separately from runtime state so that
  // prewarmTourCache() can enqueue TTS fetches before the tour begins.
  const TOUR_STEPS = [
    {
      sel:  '#page-bookings',
      en:   'Welcome to the Bookings table. Here you can see every reservation, ' +
            'filter by status or vehicle, and search by customer name or ID.',
      es:   'Bienvenido a la tabla de Reservas. Aquí puede ver cada reserva, ' +
            'filtrar por estado o vehículo, y buscar por nombre o ID del cliente.',
    },
    {
      // After speaking, tour PAUSES and waits for the booking-detail-modal to open.
      sel:          '#bookings-table-wrap',
      waitForModal: '#booking-detail-modal',
      en:   'Each row represents one booking. Please click the View button on any ' +
            'row — the guide will continue once the booking detail panel opens.',
      es:   'Cada fila representa una reserva. Haga clic en el botón Ver de cualquier ' +
            'fila — el recorrido continuará cuando se abra el panel de detalle.',
    },
    {
      sel:          '#booking-detail-modal',
      skipIfHidden: true,
      en:   'This is the Booking Detail panel. It shows customer information, ' +
            'vehicle, dates, payment status, and all available actions.',
      es:   'Este es el panel de Detalle de Reserva. Muestra la información del ' +
            'cliente, vehículo, fechas, estado de pago y todas las acciones disponibles.',
    },
    {
      sel:          '#booking-detail-actions',
      skipIfHidden: true,
      en:   'The action bar lets you mark a booking as active, return the vehicle, ' +
            'extend the rental, or cancel the booking.',
      es:   'La barra de acciones le permite marcar una reserva como activa, ' +
            'devolver el vehículo, extender el alquiler o cancelar la reserva.',
    },
    {
      sel:  '#page-dashboard',
      en:   'The Dashboard gives you a live overview: KPIs, revenue chart, ' +
            'recent bookings, and any action items that need your attention.',
      es:   'El Tablero le da una vista en vivo: KPIs, gráfico de ingresos, ' +
            'reservas recientes y cualquier elemento de acción que requiera su atención.',
    },
    {
      sel:  null,
      en:   'That completes the guided tour. You can start the tour again any time ' +
            'from the Voice Assistant panel, or ask a question using Ask Assistant.',
      es:   'Eso completa el recorrido guiado. Puede iniciar el recorrido de nuevo ' +
            'en cualquier momento desde el panel del Asistente de Voz, o hacer una ' +
            'pregunta usando Preguntar al Asistente.',
    },
  ];

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
  const sessionCtx = { bookingId: null, vehicle: null, status: null };
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
    return page || 'Admin Dashboard';
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
   * Uses the persisted sessionCtx object (updated whenever a booking is viewed)
   * so the AI knows which booking and vehicle the admin is working on even after
   * a modal has been closed.
   */
  function buildSessionContextLine() {
    const parts = [];
    if (sessionCtx.vehicle)   parts.push(`vehicle: ${sessionCtx.vehicle}`);
    if (sessionCtx.status)    parts.push(`status: ${sessionCtx.status}`);
    if (sessionCtx.bookingId) parts.push(`booking: ${sessionCtx.bookingId}`);
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

    const langBtn  = panel.querySelector('#va-lang-btn');
    const muteBtn  = panel.querySelector('#va-mute-btn');
    const explBtn  = panel.querySelector('#va-expl-btn');
    const stopBtn  = panel.querySelector('#va-stop-btn');

    if (langBtn)  langBtn.textContent   = lang === 'en' ? '🌎 EN' : '🌎 ES';
    if (muteBtn)  muteBtn.textContent   = muted ? '🔇 Muted' : '🔊 Sound On';
    if (explBtn)  explBtn.style.opacity = clickExplain ? '1' : '0.55';
    if (stopBtn)  stopBtn.disabled      = !isSpeaking && !tourActive;
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
   * Pre-warm the TTS cache for all fixed tour step scripts in both languages.
   * Called eagerly on init so tour playback is nearly instant.
   */
  async function prewarmTourCache() {
    const secret = getAdminSecret();
    if (!secret) return; // not authenticated yet; tour will fetch live
    const texts = [];
    for (const step of TOUR_STEPS) {
      if (step.en) texts.push([step.en, 'en']);
      if (step.es) texts.push([step.es, 'es']);
    }
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

  // ── Guided Tour ────────────────────────────────────────────────────────────
  async function startTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    updatePanelState();

    // Navigate to bookings page to anchor the tour
    if (typeof navigate === 'function') navigate('bookings');

    for (let i = 0; i < TOUR_STEPS.length; i++) {
      if (tourAborted) break;
      tourStepIndex = i;

      const step = TOUR_STEPS[i];
      const el   = step.sel ? document.querySelector(step.sel) : null;

      // Skip hidden steps
      if (step.skipIfHidden && el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
      }

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
      // Keep printable ASCII, Latin-1 supplement, and extended Latin. Strip
      // emojis, control characters, and other non-Latin Unicode to avoid
      // sending unexpected characters to the TTS API.
      .replace(/[^\x20-\x7E\u00C0-\u024F\u00A0-\u00FF]/g, ' ')
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
      <button id="va-tour-btn"  style="${btnStyle}background:#2563eb;color:#fff;">
        🔊 Start Guide
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
     * Update session-level memory.  Call this whenever the admin opens a booking,
     * so subsequent AI prompts have rich context even after the modal closes.
     * @param {{ bookingId?: string, vehicle?: string, status?: string }} ctx
     */
    window.vaUpdateContext = (ctx) => {
      if (ctx && typeof ctx === 'object') Object.assign(sessionCtx, ctx);
    };

    /**
     * Speak a canned confirmation phrase after a key admin action succeeds.
     * Plays at PRIORITY.assistant so it never interrupts the guided tour.
     * @param {string} key  — key from ACTION_FEEDBACK (e.g. 'return', 'extend')
     */
    window.vaActionFeedback = (key) => {
      if (muted) return;
      const entry = ACTION_FEEDBACK[key];
      if (!entry) return;
      const text = lang === 'es' ? entry.es : entry.en;
      speak(text, undefined, PRIORITY.assistant).catch(() => {});
    };

    // Pre-warm tour cache in the background; errors are silently swallowed
    prewarmTourCache().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
