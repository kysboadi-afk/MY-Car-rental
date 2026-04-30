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
//   • Core persistence is strict: customer upsert + booking upsert + revenue
//     upsert must all succeed, otherwise persistBooking throws.
//   • Idempotent — safe to call multiple times for the same booking because all
//     underlying helpers use upsert / insert-if-not-exists semantics.
//   • No silent failures — every error is logged with enough context to debug.

import crypto from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  autoCreateRevenueRecord,
  autoUpsertCustomer,
  autoUpsertBooking,
  autoCreateBlockedDate,
  parseTime12h,
} from "./_booking-automation.js";
import { normalizeVehicleId } from "./_vehicle-id.js";

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

function formatError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(`message=${err.message}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(err);
}

/**
 * Wraps a Supabase step with logging so every attempt and outcome is visible.
 *
 * @param {string}   traceId  - shared trace id for this booking
 * @param {string}   stepName - human-readable step name for log messages
 * @param {Function} fn       - async function to execute
 * @returns {{ ok: boolean, error: string|null }}
 */
async function runStep(traceId, stepName, fn, payload = null) {
  pipelineLog("info", traceId, "db_step_start", { step: stepName, ...(payload ? { payload } : {}) });
  try {
    await fn();
    pipelineLog("info", traceId, "db_step_success", { step: stepName });
    return { ok: true, error: null };
  } catch (err) {
    const formatted = formatError(err);
    pipelineLog("error", traceId, "db_step_error", {
      step: stepName,
      error: formatted,
      ...(payload ? { payload } : {}),
    });
    return { ok: false, error: formatted };
  }
}

const BOOKING_STATUS_MAP = {
  reserved_unpaid:  "pending",
  booked_paid:      "booked_paid",
  active_rental:    "active_rental",
  completed_rental: "completed_rental",
  cancelled_rental: "cancelled_rental",
};

function normalizeEmail(email) {
  if (!email || typeof email !== "string") return null;
  const value = email.trim().toLowerCase();
  return value || null;
}

function normalizeCustomerName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function buildAtomicPayload(booking) {
  const amountPaid = Number(booking.amountPaid || 0);
  const totalPrice = Number(booking.totalPrice || amountPaid);
  const remainingBalance = Math.max(0, totalPrice - amountPaid);

  const resolvedStatus = BOOKING_STATUS_MAP[booking.status] || booking.status || "pending";

  // Use the caller's explicit paymentStatus when provided (e.g. "partial" for
  // reservation_deposit); fall back to deriving it from amounts.  Then enforce
  // the DB constraint: status='reserved' always requires payment_status='partial'
  // regardless of arithmetic (guards the edge case where totalPrice equals
  // amountPaid, making remaining=0 and the derived value wrong).
  let paymentStatus = booking.paymentStatus ||
    (amountPaid > 0 ? (remainingBalance > 0 ? "partial" : "paid") : "unpaid");
  if (resolvedStatus === "reserved" && paymentStatus !== "partial") {
    paymentStatus = "partial";
  }

  return {
    p_customer_name: booking.name || "Unknown",
    p_customer_phone: booking.phone ? String(booking.phone).trim() : null,
    p_customer_email: normalizeEmail(booking.email),
    p_booking_ref: booking.bookingId,
    p_vehicle_id: normalizeVehicleId(booking.vehicleId) || null,
    p_pickup_date: booking.pickupDate || null,
    p_return_date: booking.returnDate || null,
    p_pickup_time: parseTime12h(booking.pickupTime || ""),
    p_return_time: parseTime12h(booking.returnTime || ""),
    p_status: resolvedStatus,
    p_total_price: totalPrice,
    p_deposit_paid: amountPaid,
    p_remaining_balance: remainingBalance,
    p_payment_status: paymentStatus,
    p_notes: booking.notes || null,
    p_payment_method: booking.paymentMethod || null,
    p_payment_intent_id: booking.paymentIntentId || null,
    p_stripe_customer_id: booking.stripeCustomerId || null,
    p_stripe_payment_method_id: booking.stripePaymentMethodId || null,
    p_booking_customer_email: normalizeEmail(booking.email),
    p_activated_at: booking.activatedAt || null,
    p_completed_at: booking.completedAt || null,
    p_revenue_vehicle_id: normalizeVehicleId(booking.vehicleId) || null,
    p_revenue_customer_name: booking.name || null,
    p_revenue_customer_phone: booking.phone || null,
    p_revenue_customer_email: normalizeEmail(booking.email),
    p_revenue_pickup_date: booking.pickupDate || null,
    p_revenue_return_date: booking.returnDate || null,
    p_gross_amount: amountPaid,
    p_stripe_fee: booking.stripeFee != null ? Number(booking.stripeFee) : null,
    p_payment_intent_id_revenue: booking.paymentIntentId || null,
    p_refund_amount: Number(booking.refundAmount || 0),
    p_revenue_payment_method: booking.paymentMethod || "stripe",
    p_revenue_notes: booking.notes || null,
  };
}

async function upsertBookingAndRevenueAtomic(traceId, booking) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client unavailable");
  const payload = buildAtomicPayload(booking);
  const { data, error } = await sb.rpc("upsert_booking_revenue_atomic", payload);
  if (error) {
    // Log the full raw error so every Supabase field (code, details, hint) is
    // visible in Vercel logs — critical for diagnosing FK failures, constraint
    // violations, and transaction rollbacks.
    pipelineLog("error", traceId, "db_atomic_error", {
      step: "upsert_booking_revenue_atomic",
      error: formatError(error),
      errorRaw: {
        message: error.message || null,
        code:    error.code    || null,
        details: error.details || null,
        hint:    error.hint    || null,
      },
      payload,
    });
    throw new Error(`upsert_booking_revenue_atomic failed: ${formatError(error)}`);
  }
  if (!data?.revenue_complete) {
    pipelineLog("error", traceId, "db_atomic_incomplete", {
      step: "upsert_booking_revenue_atomic",
      payload,
      result: data || null,
    });
    throw new Error("upsert_booking_revenue_atomic returned incomplete revenue data");
  }
  pipelineLog("info", traceId, "db_atomic_success", {
    step: "upsert_booking_revenue_atomic",
    bookingRef: booking.bookingId,
    customerId: data?.customer_id || null,
  });
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
 * @param {boolean} [opts.requireStripeFee] - when true, Stripe bookings fail if fee data is missing
 * @param {boolean} [opts.strictPersistence] - when true, throw on core persistence failure
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
  const strictPersistence = !!opts.strictPersistence;

  // ── 1. Log booking start ──────────────────────────────────────────────────
  pipelineLog("info", traceId, "booking_start", {
    vehicleId:           opts.vehicleId,
    vehicleIdNormalized: normalizeVehicleId(opts.vehicleId),
    pickupDate:  opts.pickupDate,
    returnDate:  opts.returnDate,
    amountPaid:  opts.amountPaid,
    source:      opts.source || "unknown",
  });

  const errors = [];
  const warnings = [];
  const fatalErrors = [];

  // ── 2. Build booking record ───────────────────────────────────────────────
  // Pre-flight: validate that the three fields now enforced as NOT NULL in
  // Supabase are present before we build the booking object.  Failing fast
  // here gives a clear, actionable error rather than a generic DB constraint
  // violation deep in autoUpsertBooking or the atomic RPC.
  const preflight = [];
  if (!opts.vehicleId)   preflight.push("vehicleId");
  if (!opts.pickupDate)  preflight.push("pickupDate");
  if (!opts.returnDate)  preflight.push("returnDate");
  if (preflight.length > 0) {
    const msg = `persistBooking: missing required booking fields: ${preflight.join(", ")} — ` +
      "all bookings must be created with vehicleId, pickupDate, and returnDate";
    pipelineLog("error", traceId, "booking_validation_failed", {
      missingFields: preflight,
      vehicleId:   opts.vehicleId || null,
      pickupDate:  opts.pickupDate || null,
      returnDate:  opts.returnDate || null,
    });
    throw new Error(msg);
  }

  const bookingId = opts.bookingId || crypto.randomBytes(16).toString("hex");

  const booking = {
    bookingId,
    name:            normalizeCustomerName(opts.name) || "",
    phone:           opts.phone           || "",
    email:           normalizeEmail(opts.email) || "",
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
    "requireStripeFee","strictPersistence",
  ]);
  for (const [key, val] of Object.entries(opts)) {
    if (!STANDARD_OPTS.has(key) && val !== undefined) {
      booking[key] = val;   // null is intentionally allowed (explicit absence)
    }
  }

  if (opts.requireStripeFee) {
    if (!booking.paymentIntentId) {
      throw new Error(`missing paymentIntentId for booking ${bookingId}`);
    }
    if (booking.stripeFee == null || !Number.isFinite(Number(booking.stripeFee))) {
      throw new Error(`missing stripeFee for booking ${bookingId} paymentIntentId=${booking.paymentIntentId}`);
    }
  }

  // ── 3. Supabase persistence (BEFORE emails) ───────────────────────────────
  const sbConfigured = isSupabaseConfigured();
  if (!sbConfigured) {
    const msg = strictPersistence
      ? "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — aborting booking persistence"
      : "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase sync";
    pipelineLog(strictPersistence ? "error" : "warn", traceId, "supabase_not_configured", {
      message: msg,
    });
    if (strictPersistence) throw new Error(msg);
  }

  let supabaseOk = true;

  if (sbConfigured) {
    const canUseAtomicRpc = typeof getSupabaseAdmin()?.rpc === "function";
    let atomicSucceeded = false;

    if (strictPersistence && canUseAtomicRpc) {
      pipelineLog("info", traceId, "atomic_rpc_attempt", {
        step: "upsert_booking_revenue_atomic",
        bookingId,
        vehicleId: booking.vehicleId || null,
        paymentIntentId: booking.paymentIntentId || null,
        stripeFee: booking.stripeFee != null ? booking.stripeFee : null,
      });
      const atomicResult = await runStep(traceId, "upsert_booking_revenue_atomic", () =>
        upsertBookingAndRevenueAtomic(traceId, booking)
      , buildAtomicPayload(booking));
      if (atomicResult.ok) {
        atomicSucceeded = true;
      } else {
        pipelineLog("warn", traceId, "atomic_rpc_failed_falling_back_to_legacy", {
          step: "upsert_booking_revenue_atomic",
          error: atomicResult.error,
          message: "Atomic RPC failed — retrying via individual legacy steps before marking as fatal",
        });
        // Do NOT push to fatalErrors here — the legacy fallback below determines
        // the final outcome.  Only if legacy also fails do we propagate the error.
      }
    }

    if (!atomicSucceeded) {
      // Runs when: (a) !strictPersistence || !canUseAtomicRpc (normal legacy path), or
      //            (b) strictPersistence + canUseAtomicRpc but atomic failed (fallback).
      if (strictPersistence && !canUseAtomicRpc) {
        pipelineLog("warn", traceId, "atomic_rpc_unavailable_fallback", {
          message: "Supabase client has no rpc() method; falling back to non-atomic strict path",
        });
      }

      // Step A: upsert customer (must come first so customer_id is available for booking)
      const custResult = await runStep(traceId, "upsert_customer", () =>
        autoUpsertCustomer(booking, false)
      , { email: booking.email || null, phone: booking.phone || null, name: booking.name || null });
      if (!custResult.ok) {
        const err = `upsert_customer: ${custResult.error}`;
        errors.push(err);
        if (strictPersistence) fatalErrors.push(err);
        supabaseOk = false;
      }

      // Step B: upsert booking row (links to customer_id)
      const bookingResult = await runStep(traceId, "upsert_booking", () =>
        autoUpsertBooking(booking, { strict: true })
      , {
        bookingId: booking.bookingId,
        paymentIntentId: booking.paymentIntentId || null,
        vehicleId: booking.vehicleId || null,
      });
      if (!bookingResult.ok) {
        const err = `upsert_booking: ${bookingResult.error}`;
        errors.push(err);
        if (strictPersistence) fatalErrors.push(err);
        supabaseOk = false;
      }

      // Step C: revenue record
      // Safety guard: never write revenue when the booking row failed to persist.
      if (!bookingResult.ok) {
        const err = "create_revenue_record: skipped because upsert_booking failed";
        pipelineLog("error", traceId, "db_step_skipped", {
          step: "create_revenue_record",
          reason: "upsert_booking_failed",
          bookingId: booking.bookingId,
        });
        errors.push(err);
        if (strictPersistence) fatalErrors.push(err);
        supabaseOk = false;
      } else {
        const revResult = await runStep(traceId, "create_revenue_record", () =>
          autoCreateRevenueRecord(booking, {
            strict: strictPersistence,
            requireStripeFee: !!opts.requireStripeFee,
          })
        , {
          bookingId: booking.bookingId,
          paymentIntentId: booking.paymentIntentId || null,
          grossAmount: booking.amountPaid || 0,
          stripeFee: booking.stripeFee ?? null,
          refundAmount: booking.refundAmount ?? 0,
        });
        if (!revResult.ok) {
          const err = `create_revenue_record: ${revResult.error}`;
          errors.push(err);
          if (strictPersistence) fatalErrors.push(err);
          supabaseOk = false;
        }
      }
    }

    // Step D: blocked_dates entry
    if (opts.pickupDate && opts.returnDate) {
      const blockResult = await runStep(traceId, "create_blocked_date", () =>
        autoCreateBlockedDate(opts.vehicleId, opts.pickupDate, opts.returnDate, "booking", bookingId, opts.returnTime || null)
      );
      if (!blockResult.ok) {
        const warn = `create_blocked_date: ${blockResult.error}`;
        warnings.push(warn);
        errors.push(warn);
        // Non-fatal for core booking + revenue persistence
      }
    }
  }

  if (strictPersistence && fatalErrors.length > 0) {
    pipelineLog("error", traceId, "booking_persist_result", {
      bookingId,
      ok: false,
      supabaseOk: false,
      errorCount: fatalErrors.length,
      errors: fatalErrors,
    });
    throw new Error(`booking persistence failed: ${fatalErrors.join("; ")}`);
  }

  // ── 4. Final status ───────────────────────────────────────────────────────
  const ok = strictPersistence ? errors.length === 0 : (errors.length === 0 || supabaseOk);
  pipelineLog(ok ? "info" : "error", traceId, "booking_persist_result", {
    bookingId,
    ok,
    supabaseOk,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    warningCount: warnings.length,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  return { ok, bookingId, booking, supabaseOk, errors };
}
