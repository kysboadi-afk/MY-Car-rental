// api/_final-return-date.js
// Shared helper for computing the "final return date" of a booking.
//
// finalReturnDate = max(
//   booking.return_date,
//   latest paid, non-cancelled extension's return_date from revenue_records
// )
//
// Extensions are matched by:
//   type            = 'extension'
//   payment_status  = 'paid'
//   is_cancelled    = false
//   booking_id      = bookingRef   (Stripe-paid extensions)
//   OR
//   original_booking_id = bookingRef  (manually-created extensions via v2-revenue.js)
//
// All public helpers use America/Los_Angeles timezone so that return-time
// comparisons are always anchored to Los Angeles wall-clock time.

export const BUSINESS_TZ    = "America/Los_Angeles";

// 2-hour vehicle preparation buffer, consistent with _availability.js.
export const PREP_BUFFER_MS = 2 * 60 * 60 * 1000;

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Normalise a mixed-format time string into "HH:MM:SS" (24-hour, zero-padded).
 * Returns "00:00:00" when the input is absent or unparseable.
 * Accepts "H:MM AM/PM" (12-hour), "HH:MM", and "HH:MM:SS".
 *
 * @param {string} time
 * @returns {string}  e.g. "17:00:00"
 */
function normalizeTimeToISO(time) {
  if (!time) return "00:00:00";
  const t = String(time).trim();

  // 12-hour format: "3:00 PM", "03:00:00 PM"
  const ampm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let h   = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    const s = parseInt(ampm[3] || "0", 10);
    const p = ampm[4].toUpperCase();
    if (p === "PM" && h !== 12) h += 12;
    if (p === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  // 24-hour format: "15:00" or "15:00:00"
  const h24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24) {
    return `${String(parseInt(h24[1],10)).padStart(2,"0")}:${String(parseInt(h24[2],10)).padStart(2,"0")}:${String(parseInt(h24[3]||"0",10)).padStart(2,"0")}`;
  }

  return "00:00:00";
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Convert a booking date + time string to an absolute Date anchored to
 * Los Angeles wall-clock time.
 *
 * This is the canonical timezone-safe datetime builder for all return-time
 * comparisons.  It determines the true UTC offset for `date` in the LA
 * timezone (honouring DST), so "10:00 AM" on a PDT day becomes 17:00 UTC
 * and on a PST day becomes 18:00 UTC — exactly correct.
 *
 * @param {string} dateStr  - YYYY-MM-DD
 * @param {string} [timeStr] - "H:MM AM/PM" or "HH:MM" or "HH:MM:SS"; defaults to midnight
 * @returns {Date}
 */
export function buildDateTimeLA(dateStr, timeStr) {
  if (!dateStr) return new Date(NaN);

  const datePart = String(
    dateStr instanceof Date ? dateStr.toISOString() : dateStr
  ).trim().split("T")[0];

  const timePart = normalizeTimeToISO(timeStr);

  // Build an approximate UTC date (ignoring offset) so we can ask Intl what
  // the real LA offset is at that point in time.
  const approxUtc = new Date(`${datePart}T${timePart}Z`);

  let tzOffset = "-08:00"; // PST fallback
  try {
    const tzPart = new Intl.DateTimeFormat("en-US", {
      timeZone:     BUSINESS_TZ,
      timeZoneName: "longOffset",
    }).formatToParts(approxUtc).find((p) => p.type === "timeZoneName")?.value || "";
    const m = tzPart.match(/GMT([+-]\d{1,2}:\d{2})/);
    if (m) tzOffset = m[1];
  } catch {
    // Keep the PST fallback on environments without Intl support.
  }

  return new Date(`${datePart}T${timePart}${tzOffset}`);
}

/**
 * Compute the effective (final) return date + time for a booking by
 * taking the maximum of the booking's own return_date and the latest
 * paid, non-cancelled extension return_date in revenue_records.
 *
 * Non-fatal: any Supabase error or null client returns the base values.
 *
 * @param {object|null} sb          - Supabase admin client (from getSupabaseAdmin())
 * @param {string}      bookingRef  - booking_ref / booking_id (e.g. "bk-...")
 * @param {string}      baseDate    - YYYY-MM-DD  — booking's current return_date
 * @param {string}      baseTime    - current return_time (any accepted format)
 * @returns {Promise<{date: string, time: string}>}
 */
export async function computeFinalReturnDate(sb, bookingRef, baseDate, baseTime) {
  const fallback = { date: baseDate || "", time: baseTime || "" };

  if (!sb || !bookingRef) return fallback;

  try {
    const { data: extRecords, error } = await sb
      .from("revenue_records")
      .select("return_date, return_time")
      .or(`booking_id.eq.${bookingRef},original_booking_id.eq.${bookingRef}`)
      .eq("type",           "extension")
      .eq("payment_status", "paid")
      .eq("is_cancelled",   false);

    if (error) {
      console.warn("computeFinalReturnDate: revenue_records query failed (non-fatal):", error.message);
      return fallback;
    }

    let maxDate = baseDate || "";
    let maxTime = baseTime || "";

    for (const rec of (extRecords || [])) {
      const rd = rec.return_date ? String(rec.return_date).split("T")[0] : "";
      if (!rd) continue;
      const rt = rec.return_time ? String(rec.return_time).substring(0, 5) : maxTime;
      if (rd > maxDate) {
        maxDate = rd;
        maxTime = rt;
      } else if (rd === maxDate && rt > maxTime) {
        maxTime = rt;
      }
    }

    return { date: maxDate, time: maxTime };
  } catch (err) {
    console.warn("computeFinalReturnDate: unexpected error (non-fatal):", err.message);
    return fallback;
  }
}
