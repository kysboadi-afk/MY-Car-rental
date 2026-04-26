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

  /**
   * Format a "YYYY-MM-DD" date and optional "HH:MM" time as a human-readable
   * Los Angeles local time string (e.g. "Jun 15, 2024, 8:00 AM").
   *
   * Always treats the supplied date/time values as Los Angeles wall-clock
   * time so that the displayed value exactly matches what the user selected —
   * no UTC conversion, no timezone shift.
   *
   * @param {string} dateStr - "YYYY-MM-DD"
   * @param {string} [timeStr] - "HH:MM" (24-hour); defaults to "00:00"
   * @returns {string}
   */
  function formatLocalDateTime(dateStr, timeStr) {
    if (!dateStr) return "";

    var parts = String(dateStr).split("-");
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var d = Number(parts[2]);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return dateStr;

    var timeParts = String(timeStr || "").split(":");
    var h   = Number(timeParts[0]) || 0;
    var min = Number(timeParts[1]) || 0;

    // Use the multi-argument constructor so the Date is created in the
    // browser's local timezone without any ISO-string UTC interpretation.
    var date = new Date(y, m - 1, d, h, min);

    return date.toLocaleString("en-US", {
      timeZone: BUSINESS_TZ,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  }

  /**
   * Format an ISO timestamp string as "Apr 27, 2026 at 8:00 AM" in LA timezone.
   * Returns null when the value is falsy or unparseable.
   *
   * @param {string} isoTimestamp - ISO 8601 string, e.g. "2026-04-27T08:00:00-07:00"
   * @returns {string|null}
   */
  function formatTimestamp(isoTimestamp) {
    if (!isoTimestamp) return null;
    var d = new Date(isoTimestamp);
    if (!isFinite(d.getTime())) return null;
    var dateStr = d.toLocaleDateString("en-US", {
      timeZone: BUSINESS_TZ,
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    var timeStr = d.toLocaleTimeString("en-US", {
      timeZone: BUSINESS_TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return dateStr + " at " + timeStr;
  }

  window.SlyLA = {
    /** IANA timezone identifier used throughout the frontend. */
    tz: BUSINESS_TZ,

    /** Today's date in Los Angeles as "YYYY-MM-DD". */
    todayISO: function () { return isoDateInLA(new Date()); },

    /** Convert any Date or timestamp to "YYYY-MM-DD" in LA time. */
    isoDateInLA: isoDateInLA,

    /** Pure calendar-day arithmetic: add N days to a "YYYY-MM-DD" string. */
    addDaysToISO: addDaysToISO,

    /**
     * Format a date+time for display in Los Angeles local time.
     * @param {string} dateStr - "YYYY-MM-DD"
     * @param {string} [timeStr] - "HH:MM" (24-hour)
     * @returns {string} e.g. "Jun 15, 2024, 8:00 AM"
     */
    /**
     * Format an ISO timestamp as "Apr 27, 2026 at 8:00 AM" in LA timezone.
     * Returns null when the value is falsy or unparseable.
     * @param {string} isoTimestamp - ISO 8601 string
     * @returns {string|null}
     */
    formatTimestamp: formatTimestamp
  };
}());
