// shared-page-context.js
// Shared pages must always render the default SLY Transportation branding.
// Slingshot-specific pages own their own branding directly and should not rely
// on shared-session state to override shared headers, nav, or logo targets.
(function () {
  'use strict';

  // ── Logo ─────────────────────────────────────────────────────────────────
  var logoImg = document.querySelector('img.site-logo');
  if (logoImg) {
    logoImg.src = 'images/logo.jpg';
    logoImg.alt = 'SLY Transportation Logo';
  }

  // ── Logo link ─────────────────────────────────────────────────────────────
  var logoLink = document.querySelector('a.logo-link');
  if (logoLink) {
    logoLink.href = 'index.html';
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  var nav = document.querySelector('.site-nav');
  if (nav) {
    var homeLink = nav.querySelector('a[data-i18n="nav.homeLink"], a:first-child');
    if (homeLink) homeLink.href = 'index.html';
  }
}());
