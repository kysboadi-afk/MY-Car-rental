// site-settings.js
// Fetches /api/site-content and dynamically applies admin-controlled settings
// (logo, phone, business name, about text) to every public page.
// Falls back gracefully — if the fetch fails, the hard-coded HTML values remain.
(function () {
  'use strict';

  var CACHE_KEY = 'slySiteSettingsCache';
  var CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  var API_URL   = '/api/site-content';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function normalizePhoneHref(raw) {
    if (!raw) return null;
    var digits = raw.replace(/[^\d]/g, '');
    if (!digits) return null;
    return 'tel:+' + digits;
  }

  function formatPhoneDisplay(raw) {
    if (!raw) return null;
    var digits = raw.replace(/[^\d]/g, '');
    if (digits.length === 11 && digits[0] === '1') {
      return '(' + digits.slice(1, 4) + ') ' + digits.slice(4, 7) + '-' + digits.slice(7);
    }
    if (digits.length === 10) {
      return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    }
    return raw;
  }

  // ── Apply settings to DOM ─────────────────────────────────────────────────

  function applySettings(s) {
    // --- Logo ---
    if (s.logo_url) {
      document.querySelectorAll('img.site-logo, img.ty-logo').forEach(function (img) {
        img.src = s.logo_url;
        img.onerror = null; // don't chain error handlers on updates
      });
      var favicon = document.querySelector('link[rel="icon"]');
      if (favicon) favicon.href = s.logo_url;
    }

    // --- Phone ---
    if (s.phone) {
      var telHref    = normalizePhoneHref(s.phone);
      var displayNum = formatPhoneDisplay(s.phone);
      if (!telHref) return;

      // header-phone: update href; update visible text node for simple variants
      document.querySelectorAll('a.header-phone').forEach(function (a) {
        a.href = telHref;
        // Only update text when there are no child <span>/<svg> elements
        // (those contain translatable "Call Now" copy we don't want to wipe)
        var hasChildren = !!a.querySelector('span, svg');
        if (!hasChildren) {
          a.textContent = '\uD83D\uDCDE ' + displayNum;
        } else {
          // Replace the bare text node that shows the phone digits
          var nodes = a.childNodes;
          for (var i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i].nodeType === 3 && /\d{3}/.test(nodes[i].textContent)) {
              nodes[i].textContent = nodes[i].textContent.replace(
                /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/,
                displayNum
              );
              break;
            }
          }
        }
      });

      // footer-phone tel: links — only update the ones that are pure phone links
      document.querySelectorAll('a.footer-phone[href^="tel:"]').forEach(function (a) {
        a.href = telHref;
        if (!a.querySelector('*')) {
          a.textContent = displayNum;
        }
      });

      // Other inline tel: links in the page body (e.g. contact page, thank-you page)
      document.querySelectorAll('a[href^="tel:"]:not(.header-phone):not(.footer-phone)').forEach(function (a) {
        a.href = telHref;
        if (!a.querySelector('*') && /\d{3}/.test(a.textContent)) {
          a.textContent = a.textContent.replace(
            /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/,
            displayNum
          );
        }
      });
    }

    // --- Business name (footer copyright) ---
    if (s.business_name) {
      document.querySelectorAll('[data-i18n="footer.copy"]').forEach(function (el) {
        var year = new Date().getFullYear();
        el.textContent = '\u00A9 ' + year + ' ' + s.business_name + '. All rights reserved.';
      });
    }

    // --- About text ---
    if (s.about_text) {
      var aboutEl = document.querySelector('[data-i18n="about.body"]');
      if (aboutEl) aboutEl.textContent = s.about_text;
    }

    // --- Promo banner ---
    if (s.promo_banner_enabled === true || s.promo_banner_enabled === 'true') {
      var banner = document.getElementById('promo-banner');
      if (banner) {
        banner.textContent = s.promo_banner_text || '';
        banner.style.display = '';
      }
    }
  }

  // ── Fetch and apply ───────────────────────────────────────────────────────

  function loadAndApply() {
    // Check sessionStorage cache first
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        var cached = JSON.parse(raw);
        if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL && cached.settings) {
          applySettings(cached.settings);
          return;
        }
      }
    } catch (_) { /* ignore parse errors */ }

    // Fetch from API
    fetch(API_URL)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var settings = data.settings || {};
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), settings: settings }));
        } catch (_) {}
        applySettings(settings);
      })
      .catch(function () {
        // Fail silently — HTML default values remain intact
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAndApply);
  } else {
    loadAndApply();
  }
}());
