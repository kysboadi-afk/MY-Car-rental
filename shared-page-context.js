// shared-page-context.js
// Applies context-aware branding on shared pages (manage-booking, contact, etc.)
// based on the slyCategory set in sessionStorage by the fleet page the user
// visited most recently (cars.js → 'car', slingshots.js → 'slingshot').
//
// Rule: shared pages must NEVER default to slingshot.
// Default (no context): car / neutral branding.
(function () {
  'use strict';

  var cat;
  try { cat = sessionStorage.getItem('slyCategory'); } catch (_) { cat = null; }

  var isSlingshot = cat === 'slingshot';

  // ── Logo ─────────────────────────────────────────────────────────────────
  var logoImg = document.querySelector('img.site-logo');
  if (logoImg) {
    if (isSlingshot) {
      logoImg.src = 'images/slingshot-logo.png';
      logoImg.alt = 'LA Slingshot Rentals Logo';
    } else {
      logoImg.src = 'images/logo.jpg';
      logoImg.alt = 'SLY Transportation Logo';
    }
  }

  // ── Logo link ─────────────────────────────────────────────────────────────
  var logoLink = document.querySelector('a.logo-link');
  if (logoLink) {
    logoLink.href = isSlingshot ? 'slingshots.html' : 'index.html';
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  var nav = document.querySelector('.site-nav');
  if (nav) {
    if (isSlingshot) {
      nav.innerHTML =
        '<a href="slingshots.html">Home</a>' +
        '<a href="slingshots.html">Slingshots</a>' +
        '<a href="manage-booking.html">Manage Booking</a>';
    } else {
      // Car / neutral: keep existing car nav (already set in HTML)
      // Update only the Home link in case HTML had a stale href
      var homeLink = nav.querySelector('a[data-i18n="nav.homeLink"], a:first-child');
      if (homeLink) homeLink.href = 'index.html';
    }
  }
}());
