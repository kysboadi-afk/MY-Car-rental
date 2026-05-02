/**
 * voice-assistant.js
 * SLYTRANS Fleet Control — AI Voice Assistant
 *
 * Features:
 *  • speak(text, lang)  — TTS via /api/tts  (cached, cancelable)
 *  • Guided Tour        — step-by-step onboarding with element highlights
 *  • Ask Assistant      — text Q&A via /api/admin-chat, response spoken aloud
 *  • Click-Explain      — auto-explain any clicked button (opt-in, debounced)
 *  • Language Toggle    — EN / ES; all speech respects chosen language
 *
 * Depends on globals defined in index.html:
 *   API_BASE, adminSecret
 *
 * Mounted automatically on DOMContentLoaded.
 */

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const PANEL_ID      = 'va-panel';
  const LANG_STORAGE  = 'va_lang';
  const MUTE_STORAGE  = 'va_mute';
  const DEBOUNCE_MS   = 1200;   // click-explain minimum gap
  const MAX_HIGHLIGHT = 4000;   // ms to keep highlight ring visible

  // Tour steps: each defines an element selector, heading, and EN/ES script
  const TOUR_STEPS = [
    {
      sel:  '#page-bookings',
      en:   'Welcome to the Bookings table. Here you can see every reservation, ' +
            'filter by status or vehicle, and search by customer name or ID.',
      es:   'Bienvenido a la tabla de Reservas. Aquí puede ver cada reserva, ' +
            'filtrar por estado o vehículo, y buscar por nombre o ID del cliente.',
    },
    {
      sel:  '#bookings-table-wrap',
      en:   'Each row in the table represents one booking. Click the View button ' +
            'at the end of any row to open the booking detail panel.',
      es:   'Cada fila de la tabla representa una reserva. Haga clic en el botón ' +
            'Ver al final de cualquier fila para abrir el panel de detalle.',
    },
    {
      sel:  '#booking-detail-modal',
      en:   'This is the Booking Detail modal. It shows customer information, ' +
            'vehicle, dates, payment status, and all available actions.',
      es:   'Este es el modal de Detalle de Reserva. Muestra la información del ' +
            'cliente, vehículo, fechas, estado de pago y todas las acciones disponibles.',
      skipIfHidden: true,
    },
    {
      sel:  '#booking-detail-actions',
      en:   'The action bar lets you mark a booking as active, return the vehicle, ' +
            'extend the rental, or cancel the booking.',
      es:   'La barra de acciones le permite marcar una reserva como activa, ' +
            'devolver el vehículo, extender el alquiler o cancelar la reserva.',
      skipIfHidden: true,
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
  let clickExplain    = false;    // auto click-explain toggle
  let lastClickTime   = 0;        // debounce tracker
  const VALID_LANGS   = ['en', 'es'];
  let lang            = VALID_LANGS.includes(localStorage.getItem(LANG_STORAGE))
                          ? localStorage.getItem(LANG_STORAGE)
                          : 'en';
  let muted           = localStorage.getItem(MUTE_STORAGE) === 'true';

  // Simple phrase cache: Map<`${lang}:${text}`, ArrayBuffer>
  const ttsCache = new Map();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getApiBase() {
    return (typeof API_BASE !== 'undefined') ? API_BASE : '';
  }

  function getAdminSecret() {
    return (typeof adminSecret !== 'undefined') ? adminSecret : '';
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

    if (langBtn)  langBtn.textContent  = lang === 'en' ? '🌎 EN' : '🌎 ES';
    if (muteBtn)  muteBtn.textContent  = muted ? '🔇 Muted' : '🔊 Sound On';
    if (explBtn)  explBtn.style.opacity = clickExplain ? '1' : '0.55';
    if (stopBtn)  stopBtn.disabled     = !isSpeaking && !tourActive;
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
    updatePanelState();
  }

  // ── Core TTS ───────────────────────────────────────────────────────────────
  /**
   * Speak text aloud using /api/tts.
   * Returns a Promise that resolves when playback finishes (or rejects on error).
   */
  async function speak(text, speakLang) {
    if (muted || !text) return;

    speakLang = speakLang || lang;
    const cacheKey = `${speakLang}:${text}`;

    stopAudio();
    isSpeaking = true;
    updatePanelState();

    try {
      let audioBuffer;

      if (ttsCache.has(cacheKey)) {
        audioBuffer = ttsCache.get(cacheKey);
      } else {
        const res = await fetch(`${getApiBase()}/api/tts`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text,
            lang: speakLang,
            secret: getAdminSecret(),
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `TTS error ${res.status}`);
        }

        audioBuffer = await res.arrayBuffer();
        // Cache up to 50 entries to avoid unbounded growth
        if (ttsCache.size >= 50) {
          const firstKey = ttsCache.keys().next().value;
          ttsCache.delete(firstKey);
        }
        ttsCache.set(cacheKey, audioBuffer);
      }

      const blob       = new Blob([audioBuffer], { type: 'audio/mpeg' });
      const blobUrl    = URL.createObjectURL(blob);
      currentBlobUrl   = blobUrl;

      const audio      = new Audio(blobUrl);
      currentAudio     = audio;

      await new Promise((resolve, reject) => {
        audio.onended  = resolve;
        audio.onerror  = reject;
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
    el.style.outline        = '3px solid #2563eb';
    el.style.outlineOffset  = '3px';
    el.style.borderRadius   = '6px';
    el.style.transition     = 'outline 0.3s';
    setTimeout(() => {
      el.style.outline       = '';
      el.style.outlineOffset = '';
    }, MAX_HIGHLIGHT);
  }

  // ── Guided Tour ────────────────────────────────────────────────────────────
  async function startTour() {
    if (tourActive) return;
    tourActive    = true;
    tourAborted   = false;
    tourStepIndex = 0;
    updatePanelState();

    for (let i = 0; i < TOUR_STEPS.length; i++) {
      if (tourAborted) break;
      tourStepIndex = i;

      const step = TOUR_STEPS[i];
      const el   = step.sel ? document.querySelector(step.sel) : null;

      // Skip hidden steps when element is not visible
      if (step.skipIfHidden && el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
      }

      if (el) highlightElement(el);
      await speak(lang === 'es' ? step.es : step.en);

      if (tourAborted) break;
    }

    tourActive    = false;
    tourStepIndex = 0;
    updatePanelState();
  }

  function stopTour() {
    tourAborted = true;
    stopAudio();
    tourActive  = false;
    updatePanelState();
  }

  // ── Ask Assistant ─────────────────────────────────────────────────────────
  async function askAssistant(question) {
    if (!question || !question.trim()) return;

    const secret = getAdminSecret();
    if (!secret) {
      alert('Please sign in to the admin dashboard first.');
      return;
    }

    const messages = [
      {
        role:    'user',
        content: `[Dashboard Voice Assistant] Answer in 1-2 short sentences. ` +
                 `Respond in ${lang === 'es' ? 'Spanish' : 'English'}. ` +
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
      if (reply) await speak(reply);
    } catch (err) {
      console.warn('[VoiceAssistant] askAssistant error:', err);
      await speak(
        lang === 'es'
          ? 'Lo siento, no pude obtener una respuesta. Por favor intente de nuevo.'
          : 'Sorry, I could not get a response. Please try again.'
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
      position:    'fixed',
      bottom:      '220px',
      right:       '20px',
      background:  '#1a1d27',
      border:      '1px solid #2a2d3a',
      borderRadius:'12px',
      padding:     '16px',
      width:       '280px',
      zIndex:      '10000',
      boxShadow:   '0 8px 32px rgba(0,0,0,0.4)',
    });

    const placeholder = lang === 'es'
      ? 'Escribe tu pregunta…'
      : 'Type your question…';
    const btnLabel = lang === 'es' ? 'Preguntar' : 'Ask';

    dialog.innerHTML = `
      <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:10px;">
        🎙️ ${lang === 'es' ? 'Preguntar al Asistente' : 'Ask Assistant'}
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

  // ── Click-Explain listener ─────────────────────────────────────────────────
  function handleClickExplain(e) {
    if (!clickExplain || muted) return;

    // Skip clicks inside the voice panel itself
    const panel = document.getElementById(PANEL_ID);
    if (panel && panel.contains(e.target)) return;

    // Debounce
    const now = Date.now();
    if (now - lastClickTime < DEBOUNCE_MS) return;
    lastClickTime = now;

    const el    = e.target.closest('button, [role="button"], .btn, a[onclick]') || e.target;
    const label = (el.textContent || el.title || el.ariaLabel || '')
                    .trim()
                    // Strip non-printable characters and collapse whitespace
                    .replace(/[^\x20-\x7E\u00C0-\u024F\u00A0-\u00FF]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 80);

    if (!label || label.length < 2) return;

    // Skip if it looks like a close / icon-only button
    if (/^[✕×✖⊗•·]$/.test(label)) return;

    const text = lang === 'es'
      ? `Este botón le permite ${label.toLowerCase()}.`
      : `This button lets you ${label.toLowerCase()}.`;

    speak(text);
  }

  // ── Floating Panel ────────────────────────────────────────────────────────
  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id    = PANEL_ID;
    Object.assign(panel.style, {
      position:    'fixed',
      bottom:      '20px',
      right:       '20px',
      background:  '#1a1d27',
      border:      '1px solid #2a2d3a',
      borderRadius:'14px',
      padding:     '14px 12px',
      zIndex:      '9999',
      boxShadow:   '0 8px 32px rgba(0,0,0,0.45)',
      display:     'flex',
      flexDirection:'column',
      gap:         '7px',
      width:       '170px',
      userSelect:  'none',
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
        <button id="va-lang-btn" style="${btnStyle}flex:1;background:#111318;color:#d1d5db;
                                         padding:6px 6px;font-size:11px;text-align:center;">
          🌎 EN
        </button>
        <button id="va-mute-btn" style="${btnStyle}flex:1;background:#111318;color:#d1d5db;
                                         padding:6px 6px;font-size:11px;text-align:center;">
          🔊 Sound On
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    // Wire events
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
