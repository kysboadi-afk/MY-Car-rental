// api/_booking-pipeline.js
// Centralised booking pipeline — the single source of truth for persisting a
// booking after a successful payment.
//
// Responsibilities (in order):
//   1. Log booking start with structured context.
//   2. Persist to Supabase (customer upsert → booking upsert → revenue record
//      → blocked_dates).  Logs every attempt and result.
//   3. Persist to bookings.json via appendBooking.
//
// Design principles:
//   • DB write happens BEFORE confirmation emails are sent so that a failed
//     persist is surfaced immediately and the customer is never emailed about a
//     booking that was not saved.
//   • All Supabase helpers remain non-fatal individually (errors are logged) but
//     the pipeline returns { ok, bookingId, errors } so callers can decide
//     whether to abort the email flow when Supabase is unavailable.
//   • Idempotent — safe to call multiple times for the same booking because all
//     underlying helpers use upsert / insert-if-not-exists semantics.
//   • No silent failures — every error is logged with enough context to debug.

import crypto from "crypto";
import { appendBooking } from "./_bookings.js";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  autoCreateRevenueRecord,
  autoUpsertCustomer,
  autoUpsertBooking,
  autoCreateBlockedDate,
} from "./_booking-automation.js";

/**
 * Structured logger for the booking pipeline.
 * All messages include a shared trace-id so related log lines can be correlated
 * in Vercel function logs.
 */
function pipelineLog(level, traceId, event, detail = {}) {
  const entry = {
    ts:      new Date().toISOString(),
    level,
    trace:   traceId,
    event,
    ...detail,
  };
  if (level === "error") {
    console.error("[booking-pipeline]", JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn("[booking-pipeline]", JSON.stringify(entry));
  } else {
    console.log("[booking-pipeline]", JSON.stringify(entry));
  }
}

/**
 * Wraps a Supabase step with logging so every attempt and outcome is visible.
 *
 * @param {string}   traceId  - shared trace id for this booking
 * @param {string}   stepName - human-readable step name for log messages
 * @param {Function} fn       - async function to execute
 * @returns {{ ok: boolean, error: string|null }}
 */
async function runStep(traceId, stepName, fn) {
  pipelineLog("info", traceId, "db_step_start", { step: stepName });
  try {
    await fn();
    pipelineLog("info", traceId, "db_step_success", { step: stepName });
    return { ok: true, error: null };
  } catch (err) {
    pipelineLog("error", traceId, "db_step_error", { step: stepName, error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Checks whether Supabase is reachable and configured.
 * Returns true when a valid admin client can be obtained.
 */
function isSupabaseConfigured() {
  try {
    return !!getSupabaseAdmin();
  } catch {
    return false;
  }
}

/**
 * Persist a new booking through the full pipeline.
 *
 * @param {object} opts
 * @param {string}  opts.vehicleId       - vehicle key (e.g. "camry")
 * @param {string}  opts.vehicleName     - human-readable vehicle label
 * @param {string}  opts.name            - renter name
 * @param {string}  opts.phone           - renter phone
 * @param {string}  opts.email           - renter email
 * @param {string}  opts.pickupDate      - YYYY-MM-DD
 * @param {string}  [opts.pickupTime]    - "H:MM AM/PM"
 * @param {string}  opts.returnDate      - YYYY-MM-DD
 * @param {string}  [opts.returnTime]    - "H:MM AM/PM"
 * @param {number}  opts.amountPaid      - amount charged (dollars)
 * @param {number}  [opts.totalPrice]    - full rental cost (for deposit bookings)
 * @param {string}  [opts.paymentMethod] - "stripe" | "cash" | etc.
 * @param {string}  [opts.paymentIntentId]
 * @param {string}  [opts.paymentLink]   - balance payment URL
 * @param {string}  [opts.status]        - override default status
 * @param {string}  [opts.notes]
 * @param {string}  [opts.source]        - "public_booking" | "admin_v2" | etc.
 * @param {string}  [opts.location]
 * @param {string}  [opts.stripeCustomerId]
 * @param {string}  [opts.stripePaymentMethodId]
 * @param {string}  [opts.protectionPlanTier]
 * @param {object}  [opts.*]             - any extra fields are passed through into the booking record
 *
 * @returns {Promise<{
 *   ok:        boolean,
 *   bookingId: string,
 *   booking:   object,
 *   supabaseOk: boolean,
 *   errors:    string[],
 * }>}
 */
export async function persistBooking(opts) {
  const traceId = crypto.randomBytes(6).toString("hex");

  // ── 1. Log booking start ──────────────────────────────────────────────────
  pipelineLog("info", traceId, "booking_start", {
    vehicleId:   opts.vehicleId,
    pickupDate:  opts.pickupDate,
    returnDate:  opts.returnDate,
    amountPaid:  opts.amountPaid,
    source:      opts.source || "unknown",
  });

  const errors = [];

  // ── 2. Build booking record ───────────────────────────────────────────────
  const bookingId = opts.bookingId || crypto.randomBytes(16).toString("hex");

  const booking = {
    bookingId,
    name:            opts.name            || "",
    phone:           opts.phone           || "",
    email:           opts.email           || "",
    vehicleId:       opts.vehicleId,
    vehicleName:     opts.vehicleName     || opts.vehicleId,
    pickupDate:      opts.pickupDate      || "",
    pickupTime:      opts.pickupTime      || "",
    returnDate:      opts.returnDate      || "",
    returnTime:      opts.returnTime      || "",
    location:        opts.location        || "",
    status:          opts.status          || (opts.totalPrice && opts.totalPrice > opts.amountPaid ? "reserved_unpaid" : "booked_paid"),
    amountPaid:      opts.amountPaid      || 0,
    totalPrice:      opts.totalPrice      || opts.amountPaid || 0,
    paymentIntentId: opts.paymentIntentId || "",
    paymentLink:     opts.paymentLink     || "",
    paymentMethod:   opts.paymentMethod   || "stripe",
    notes:           opts.notes           || "",
    smsSentAt:       {},
    createdAt:       new Date().toISOString(),
    source:          opts.source          || "public_booking",
  };

  // Pass through any extra caller-provided fields not covered above
  // (e.g. stripeCustomerId, stripePaymentMethodId, protectionPlanTier, paymentLinkToken).
  // IMPORTANT: keep STANDARD_OPTS in sync with the booking fields built above; any field
  // listed here is handled explicitly and will not be double-written via the loop below.
  const STANDARD_OPTS = new Set([
    "vehicleId","vehicleName","name","phone","email","pickupDate","pickupTime",
    "returnDate","returnTime","amountPaid","totalPrice","paymentMethod",
    "paymentIntentId","paymentLink","status","notes","source","location","bookingId",
  ]);
  for (const [key, val] of Object.entries(opts)) {
    if (!STANDARD_OPTS.has(key) && val !== undefined) {
      booking[key] = val;   // null is intentionally allowed (explicit absence)
    }
  }

  // ── 3. Supabase persistence (BEFORE emails) ───────────────────────────────
  const sbConfigured = isSupabaseConfigured();
  if (!sbConfigured) {
    pipelineLog("warn", traceId, "supabase_not_configured", {
      message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase sync",
    });
  }

  let supabaseOk = true;

  if (sbConfigured) {
    // Step A: upsert customer (must come first so customer_id is available for booking)
    const custResult = await runStep(traceId, "upsert_customer", () =>
      autoUpsertCustomer(booking, false)
    );
    if (!custResult.ok) {
      errors.push(`upsert_customer: ${custResult.error}`);
      supabaseOk = false;
    }

    // Step B: upsert booking row (links to customer_id)
    const bookingResult = await runStep(traceId, "upsert_booking", () =>
      autoUpsertBooking(booking, { strict: true })
    );
    if (!bookingResult.ok) {
      errors.push(`upsert_booking: ${bookingResult.error}`);
      supabaseOk = false;
    }

    // Step C: revenue record
    const revResult = await runStep(traceId, "create_revenue_record", () =>
      autoCreateRevenueRecord(booking)
    );
    if (!revResult.ok) {
      errors.push(`create_revenue_record: ${revResult.error}`);
      // Non-fatal for availability — continue
    }

    // Step D: blocked_dates entry
    if (opts.pickupDate && opts.returnDate) {
      const blockResult = await runStep(traceId, "create_blocked_date", () =>
        autoCreateBlockedDate(opts.vehicleId, opts.pickupDate, opts.returnDate, "booking")
      );
      if (!blockResult.ok) {
        errors.push(`create_blocked_date: ${blockResult.error}`);
        // Non-fatal for core booking persistence
      }
    }
  }

  // ── 4. bookings.json persistence ─────────────────────────────────────────
  pipelineLog("info", traceId, "json_save_start", { bookingId });
  try {
    await appendBooking(booking);
    pipelineLog("info", traceId, "json_save_success", { bookingId });
  } catch (err) {
    pipelineLog("error", traceId, "json_save_error", { bookingId, error: err.message });
    errors.push(`json_save: ${err.message}`);
    // JSON save failure is non-fatal when Supabase succeeded; the Supabase row
    // is the authoritative source of truth.  Log and continue.
  }

  // ── 5. Final status ───────────────────────────────────────────────────────
  const ok = errors.length === 0 || supabaseOk; // ok as long as Supabase saved
  pipelineLog(ok ? "info" : "error", traceId, "booking_persist_result", {
    bookingId,
    ok,
    supabaseOk,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
  });

  return { ok, bookingId, booking, supabaseOk, errors };
}
