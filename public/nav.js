/* Mobile hamburger navigation — injected dynamically so all pages share one script */
(function () {
  function initMobileNav() {
    var header = document.querySelector('.site-header');
    if (!header) return;

    /* Avoid double-init */
    if (header.querySelector('.nav-hamburger')) return;

    var nav = header.querySelector('.site-nav');
    if (!nav) return;

    /* ── Inject hamburger button ── */
    var btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.setAttribute('aria-label', 'Toggle navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('type', 'button');
    btn.innerHTML = '&#9776;'; /* ☰ */

    /* Place it as the last child of header (CSS order will position it) */
    header.appendChild(btn);

    /* ── Inject phone call link at the bottom of the mobile nav ── */
    var phoneEl = header.querySelector('.header-phone');
    if (phoneEl) {
      var mobilePhone = document.createElement('a');
      mobilePhone.href = phoneEl.href || 'tel:+18445114059';
      mobilePhone.className = 'mobile-phone-link';
      mobilePhone.textContent = '\uD83D\uDCDE (844) 511-4059';
      nav.appendChild(mobilePhone);
    }

    /* ── Toggle open/close ── */
    function openNav() {
      header.classList.add('nav-open');
      btn.setAttribute('aria-expanded', 'true');
      btn.innerHTML = '&#10005;'; /* ✕ */
    }

    function closeNav() {
      header.classList.remove('nav-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '&#9776;'; /* ☰ */
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (header.classList.contains('nav-open')) {
        closeNav();
      } else {
        openNav();
      }
    });

    /* Close when any nav link is clicked */
    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        closeNav();
      });
    });

    /* Close when clicking outside the header */
    document.addEventListener('click', function (e) {
      if (!header.contains(e.target)) {
        closeNav();
      }
    });

    /* Close on Escape key */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeNav();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileNav);
  } else {
    initMobileNav();
  }
})();
