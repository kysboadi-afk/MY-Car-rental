// api/oil-check-cron.js
// Vercel cron — Oil Check Compliance trigger and escalation system.
//
// GET  /api/oil-check-cron  — Vercel cron trigger (no auth required from Vercel)
// POST /api/oil-check-cron  — Manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Run schedule (vercel.json):  0 17 * * *  (10 AM PDT / 9 AM PST — within 8 AM–7 PM LA window)
//
// Logic per active booking:
//   1. Look up the vehicle's vehicle_state for current mileage and last check info.
//   2. Compute days_since_check and miles_since_check.
//   3. Trigger if: rental_duration >= 3 days AND (days_since_check >= 5 OR miles_since_check >= 1200)
//   4. Anti-spam: max 1 SMS per booking per 24 h.
//   5. Escalation:
//        oil_check_missed_count = 0 + no reply after 24 h → send 24h reminder, set missed_count = 1
//        oil_check_missed_count = 1 + no reply after 24 h → send 48h final notice, set missed_count = 2
//        oil_check_missed_count >= 2 → stop messaging
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TEXTMAGIC_USERNAME, TEXTMAGIC_API_KEY

import { sendSms } from "./_textmagic.js";
import { getSupabaseAdmin } from "./_supabase.js";

// ── SMS copy ──────────────────────────────────────────────────────────────────

const MSG_OIL_CHECK_REQUEST =
  "SLY RENTALS: Oil check required.\n\n" +
  "Park on level ground. Pull the engine dipstick, wipe it, reinsert, then check the oil level.\n\n" +
  "Send a photo and reply:\n\n" +
  "FULL (near top line)\n" +
  "MID (between lines)\n" +
  "LOW (below safe line)";

const MSG_OIL_CHECK_REMINDER =
  "Reminder: Oil check still required.\n\n" +
  "Reply FULL, MID, or LOW with photo.\n\n" +
  "This is required to keep your rental active.";

const MSG_OIL_CHECK_FINAL =
  "Final notice: Oil check not confirmed.\n\n" +
  "Reply FULL, MID, or LOW with photo now to avoid interruption.";

// ── Thresholds ────────────────────────────────────────────────────────────────

const MIN_RENTAL_DAYS      = 3;    // trigger only for rentals >= 3 days
const DAYS_SINCE_CHECK     = 5;    // trigger if >= 5 days since last check
const MILES_SINCE_CHECK    = 1200; // trigger if >= 1200 miles since last check
const COOLDOWN_HOURS       = 24;   // minimum hours between any two oil check SMS
const WINDOW_START_HOUR    = 8;    // 8:00 AM LA — start of send window
const WINDOW_END_HOUR      = 19;   // 7:00 PM LA — end of send window (exclusive)
const ESCALATE_AFTER_HOURS = 24;   // hours of no-reply before escalating

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the current hour (0–23) in America/Los_Angeles.
 */
function laHour() {
  return parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      hour:     "numeric",
      hour12:   false,
    }),
    10
  );
}

/**
 * Elapsed hours between two ISO timestamps.
 * @param {string} earlier
 * @param {string} later  defaults to now
 */
function hoursSince(earlier, later = new Date().toISOString()) {
  return (new Date(later) - new Date(earlier)) / 3_600_000;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Manual POST requires ADMIN_SECRET or CRON_SECRET
  if (req.method === "POST") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Enforce 8 AM – 7 PM LA send window for cron-triggered runs.
  // Manual POST bypasses the window to allow out-of-hours testing.
  if (req.method === "GET") {
    const hour = laHour();
    if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) {
      return res.status(200).json({
        skipped: true,
        reason:  `Outside send window (${WINDOW_START_HOUR}:00–${WINDOW_END_HOUR}:00 LA). Current LA hour: ${hour}.`,
      });
    }
  }

  const startedAt = Date.now();

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(200).json({
      skipped:     true,
      reason:      "Supabase not configured",
      duration_ms: Date.now() - startedAt,
    });
  }

  // ── Load all active bookings ───────────────────────────────────────────────
  const { data: bookings, error: bookingsErr } = await sb
    .from("bookings")
    .select(
      "id, booking_ref, vehicle_id, customer_phone, " +
      "pickup_date, return_date, " +
      "oil_check_required, oil_check_last_request, oil_check_missed_count"
    )
    .eq("status", "active")
    .not("customer_phone", "is", null);

  if (bookingsErr) {
    console.error("oil-check-cron: bookings query failed:", bookingsErr.message);
    return res.status(200).json({
      skipped:     true,
      reason:      bookingsErr.message,
      duration_ms: Date.now() - startedAt,
    });
  }

  if (!bookings || bookings.length === 0) {
    return res.status(200).json({
      triggered:   0,
      escalated:   0,
      skipped:     false,
      duration_ms: Date.now() - startedAt,
    });
  }

  // ── Load vehicle_state for all relevant vehicles ──────────────────────────
  const vehicleIds = [...new Set(bookings.map((b) => b.vehicle_id).filter(Boolean))];

  const { data: vStates, error: vsErr } = await sb
    .from("vehicle_state")
    .select("vehicle_id, last_oil_check_at, last_oil_check_mileage, current_mileage")
    .in("vehicle_id", vehicleIds);

  if (vsErr) {
    console.error("oil-check-cron: vehicle_state query failed:", vsErr.message);
    return res.status(200).json({
      skipped:     true,
      reason:      vsErr.message,
      duration_ms: Date.now() - startedAt,
    });
  }

  const stateByVehicle = {};
  for (const vs of vStates || []) {
    stateByVehicle[vs.vehicle_id] = vs;
  }

  // ── Dedup: track phones contacted this run (max 1 SMS per phone per 24 h) ─
  const phonesContactedThisRun = new Set();

  const results = {
    triggered:  0,
    escalated:  0,
    skipped_spam:    0,
    skipped_window:  0,
    skipped_no_trigger: 0,
    errors:     [],
  };

  for (const booking of bookings) {
    const {
      id:                     bookingId,
      booking_ref:            bookingRef,
      vehicle_id:             vehicleId,
      customer_phone:         phone,
      pickup_date:            pickupDate,
      return_date:            returnDate,
      oil_check_required:     oilCheckRequired,
      oil_check_last_request: lastRequest,
      oil_check_missed_count: missedCount,
    } = booking;

    if (!phone || !vehicleId) continue;

    // ── Anti-spam: skip if already contacted this run ──────────────────────
    if (phonesContactedThisRun.has(phone)) {
      results.skipped_spam++;
      continue;
    }

    // ── Anti-spam: skip if last message was < 24 h ago ────────────────────
    if (lastRequest && hoursSince(lastRequest) < COOLDOWN_HOURS) {
      results.skipped_spam++;
      continue;
    }

    // ── Compute rental duration ────────────────────────────────────────────
    const rentalDays = pickupDate && returnDate
      ? Math.round((new Date(returnDate) - new Date(pickupDate)) / 86_400_000)
      : 0;

    if (rentalDays < MIN_RENTAL_DAYS) {
      results.skipped_no_trigger++;
      continue;
    }

    const vs = stateByVehicle[vehicleId];

    // ── Escalation path (oil_check_required = true, no reply received) ────
    if (oilCheckRequired) {
      if (missedCount >= 2) {
        // Already sent final notice — stop messaging
        results.skipped_no_trigger++;
        continue;
      }

      // Check if enough time has passed since the last request to escalate
      if (!lastRequest || hoursSince(lastRequest) < ESCALATE_AFTER_HOURS) {
        results.skipped_spam++;
        continue;
      }

      const escalateMsg = missedCount === 0
        ? MSG_OIL_CHECK_REMINDER
        : MSG_OIL_CHECK_FINAL;

      try {
        await sendSms(phone, escalateMsg);
        phonesContactedThisRun.add(phone);

        const newMissedCount = missedCount + 1;
        const nowTs = new Date().toISOString();
        await sb
          .from("bookings")
          .update({
            oil_check_last_request:  nowTs,
            oil_check_missed_count:  newMissedCount,
            updated_at:              nowTs,
          })
          .eq("id", bookingId);

        results.escalated++;
        console.log(`oil-check-cron: escalated booking ${bookingRef || bookingId} (missed=${newMissedCount})`);
      } catch (err) {
        results.errors.push(`${bookingRef || bookingId}: ${err.message}`);
        console.error("oil-check-cron: escalation SMS failed:", err.message);
      }
      continue;
    }

    // ── Initial trigger path ──────────────────────────────────────────────
    // Compute days and miles since last oil check (from vehicle_state)
    const lastCheckAt      = vs?.last_oil_check_at      || null;
    const lastCheckMileage = vs?.last_oil_check_mileage  ?? null;
    const currentMileage   = vs?.current_mileage         ?? null;

    const daysSinceCheck = lastCheckAt
      ? hoursSince(lastCheckAt) / 24
      : Infinity; // never checked — treat as overdue

    const milesSinceCheck = (currentMileage !== null && lastCheckMileage !== null)
      ? currentMileage - lastCheckMileage
      : Infinity; // no mileage data — treat as overdue

    const triggerByDays  = daysSinceCheck  >= DAYS_SINCE_CHECK;
    const triggerByMiles = milesSinceCheck >= MILES_SINCE_CHECK;

    if (!triggerByDays && !triggerByMiles) {
      results.skipped_no_trigger++;
      continue;
    }

    // Send initial oil check request
    try {
      await sendSms(phone, MSG_OIL_CHECK_REQUEST);
      phonesContactedThisRun.add(phone);

      const nowTs = new Date().toISOString();
      await sb
        .from("bookings")
        .update({
          oil_check_required:     true,
          oil_check_last_request: nowTs,
          updated_at:             nowTs,
        })
        .eq("id", bookingId);

      results.triggered++;
      console.log(
        `oil-check-cron: triggered booking ${bookingRef || bookingId} ` +
        `(days_since=${daysSinceCheck.toFixed(1)}, miles_since=${milesSinceCheck === Infinity ? "N/A" : milesSinceCheck.toFixed(0)})`
      );
    } catch (err) {
      results.errors.push(`${bookingRef || bookingId}: ${err.message}`);
      console.error("oil-check-cron: trigger SMS failed:", err.message);
    }
  }

  return res.status(200).json({
    ...results,
    duration_ms: Date.now() - startedAt,
  });
}
