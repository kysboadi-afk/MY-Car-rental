// lib/ai/fraud.js
// Booking risk scoring engine — pure computation, no I/O.
// Assigns a risk score to each booking based on behavioural signals.

/**
 * Risk thresholds.
 * 0–30  → low    (not flagged)
 * 31–60 → medium (flagged, manual review recommended)
 * 61+   → high   (flagged, block or escalate)
 */
const RISK_MEDIUM_THRESHOLD = 31;
const RISK_HIGH_THRESHOLD   = 61;

/**
 * Score a single booking for fraud risk.
 *
 * @param {object} booking   - booking object
 * @param {Array}  allBookings - full bookings array (for recency analysis)
 * @returns {{ risk_score: number, risk_level: string, flagged: boolean, reasons: string[] }}
 */
export function scoreBooking(booking, allBookings = []) {
  let score   = 0;
  const reasons = [];

  const createdAt = new Date(booking.createdAt || Date.now());
  const pickupDate = booking.pickupDate ? new Date(booking.pickupDate) : null;

  // ── 1. Multiple bookings from same phone within 24 hours ─────────────────
  if (booking.phone) {
    const windowMs = 24 * 60 * 60 * 1000;
    const samePhone = allBookings.filter(
      (b) =>
        b.bookingId !== booking.bookingId &&
        b.phone === booking.phone &&
        Math.abs(new Date(b.createdAt || 0) - createdAt) < windowMs
    );
    if (samePhone.length >= 2) {
      score += 40;
      reasons.push(`${samePhone.length} other bookings from same phone within 24 hours`);
    } else if (samePhone.length === 1) {
      score += 20;
      reasons.push("1 other booking from same phone within 24 hours");
    }
  }

  // ── 2. Multiple bookings from same email within 24 hours ─────────────────
  if (booking.email) {
    const windowMs = 24 * 60 * 60 * 1000;
    const sameEmail = allBookings.filter(
      (b) =>
        b.bookingId !== booking.bookingId &&
        b.email === booking.email &&
        Math.abs(new Date(b.createdAt || 0) - createdAt) < windowMs
    );
    if (sameEmail.length >= 2) {
      score += 30;
      reasons.push(`${sameEmail.length} other bookings from same email within 24 hours`);
    } else if (sameEmail.length === 1) {
      score += 15;
      reasons.push("1 other booking from same email within 24 hours");
    }
  }

  // ── 3. High-value booking (> $500) ────────────────────────────────────────
  const amount = booking.amountPaid || 0;
  if (amount > 1000) {
    score += 20;
    reasons.push(`High-value booking ($${amount.toFixed(2)})`);
  } else if (amount > 500) {
    score += 10;
    reasons.push(`Elevated-value booking ($${amount.toFixed(2)})`);
  }

  // ── 4. Very long rental (> 14 days) ──────────────────────────────────────
  if (booking.pickupDate && booking.returnDate) {
    const days = Math.round(
      (new Date(booking.returnDate) - new Date(booking.pickupDate)) / 86400000
    );
    if (days > 14) {
      score += 15;
      reasons.push(`Unusually long rental period (${days} days)`);
    }
  }

  // ── 5. Last-minute booking (pickup within 12 hours of creation) ────────────
  if (pickupDate && createdAt) {
    const hoursUntilPickup = (pickupDate - createdAt) / 3600000;
    if (hoursUntilPickup >= 0 && hoursUntilPickup < 12) {
      score += 10;
      reasons.push(`Last-minute booking (pickup in ${Math.round(hoursUntilPickup)}h)`);
    }
  }

  // ── 6. Booking created outside business hours (11pm–5am PT) ──────────────
  const hourUTC = createdAt.getUTCHours();
  // PT is UTC-7 (PDT) or UTC-8 (PST); approximate as UTC-7
  const hourPT = (hourUTC - 7 + 24) % 24;
  if (hourPT >= 23 || hourPT < 5) {
    score += 5;
    reasons.push("Booking created outside business hours");
  }

  score = Math.min(100, score);

  let risk_level = "low";
  if (score >= RISK_HIGH_THRESHOLD)   risk_level = "high";
  else if (score >= RISK_MEDIUM_THRESHOLD) risk_level = "medium";

  return {
    risk_score: score,
    risk_level,
    flagged: score >= RISK_MEDIUM_THRESHOLD,
    reasons,
  };
}

/**
 * Score all bookings in a flat array.
 *
 * @param {Array} allBookings
 * @returns {Array<{ bookingId: string, risk_score: number, risk_level: string, flagged: boolean, reasons: string[] }>}
 */
export function scoreAllBookings(allBookings) {
  return allBookings.map((b) => ({
    bookingId: b.bookingId,
    name:      b.name || "",
    vehicleId: b.vehicleId || "",
    ...scoreBooking(b, allBookings),
  }));
}
