// la-date.js — Los Angeles timezone date utilities
// Single source of truth for all customer-facing date/time logic on the
// SLY RIDES frontend.  Load this script BEFORE car.js, cars.js, and
// chatbot.js so that window.SlyLA is available when those scripts run.
//
// All helpers are intentionally timezone-explicit so that:
//   • "today" is always LA calendar day, not the browser's UTC day.
//   • Displayed dates/times always show Los Angeles local time.
//   • Pure date arithmetic (addDaysToISO) uses UTC midnight so no
//     DST shift can accidentally skip or repeat a day.
(function () {
  "use strict";

  var BUSINESS_TZ = "America/Los_Angeles";

  /**
   * Return the "YYYY-MM-DD" string for any Date (or timestamp) in LA time.
   * Falls back to UTC if Intl.DateTimeFormat is unavailable (very old browsers).
   */
  function isoDateInLA(dateInput) {
    var date = (dateInput instanceof Date) ? dateInput
             : new Date(dateInput != null ? dateInput : Date.now());
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: BUSINESS_TZ,
        year:  "numeric",
        month: "2-digit",
        day:   "2-digit"
      }).formatToParts(date);
      var y = (parts.find(function (p) { return p.type === "year";  }) || {}).value;
      var m = (parts.find(function (p) { return p.type === "month"; }) || {}).value;
      var d = (parts.find(function (p) { return p.type === "day";   }) || {}).value;
      return y + "-" + m + "-" + d;
    } catch (_) {
      return date.toISOString().slice(0, 10);
    }
  }

  /**
   * Add N whole calendar days to an ISO date-only string ("YYYY-MM-DD").
   * Uses UTC arithmetic so DST transitions never shift the result.
   */
  function addDaysToISO(isoDate, days) {
    var parts = String(isoDate || "").split("-").map(Number);
    var y = parts[0], m = parts[1], d = parts[2];
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  window.SlyLA = {
    /** IANA timezone identifier used throughout the frontend. */
    tz: BUSINESS_TZ,

    /** Today's date in Los Angeles as "YYYY-MM-DD". */
    todayISO: function () { return isoDateInLA(new Date()); },

    /** Convert any Date or timestamp to "YYYY-MM-DD" in LA time. */
    isoDateInLA: isoDateInLA,

    /** Pure calendar-day arithmetic: add N days to a "YYYY-MM-DD" string. */
    addDaysToISO: addDaysToISO
  };
}());
