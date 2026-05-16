import { isSchemaError } from "./_error-helpers.js";

// Optional columns added in later migrations that may not exist on older production schemas.
// Dropped one at a time on schema errors.
const OPTIONAL_SCHEMA_FALLBACK_COLUMNS = ["category", "identity_session_id"];

// Slingshot lifecycle statuses added in migration 0159 that older DB schemas
// may not yet recognise in the bookings_status_check constraint.
const SLINGSHOT_LIFECYCLE_STATUSES = new Set([
  "inquiry_received",
  "identity_pending",
  "identity_verified",
  "agreement_pending",
  "agreement_signed",
  "pending_manual_payment",
  "ready_for_pickup",
]);

function isStatusConstraintError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg  = String(err.message || "");
  return (
    code === "23514" ||
    /violates check constraint/i.test(msg) ||
    /bookings_status_check/i.test(msg)
  );
}

function isLegacyPendingStatusConstraintError(err, attemptedRow) {
  return attemptedRow?.status === "pending_checkout" && isStatusConstraintError(err);
}

function isSlingshotStatusConstraintError(err, attemptedRow) {
  return SLINGSHOT_LIFECYCLE_STATUSES.has(attemptedRow?.status) && isStatusConstraintError(err);
}

/**
 * Upsert a booking pre-write row with backward-compatible retries for older
 * Supabase schemas.
 *
 * Fallbacks (applied in order, one per retry):
 *  1. Drop `category` when the live DB is missing that newer column.
 *  2. Drop `identity_session_id` when the live DB is missing that column
 *     (migration 0158 not yet applied).
 *  3. Downgrade slingshot lifecycle statuses (e.g. `agreement_pending`) to
 *     `pending_checkout` when the bookings.status constraint hasn't been
 *     expanded (migration 0159 not yet applied).
 *  4. Downgrade pre-payment `pending_checkout` to legacy `pending` when the
 *     bookings.status constraint has not yet been expanded (migration 0081).
 *
 * @param {object} sb
 * @param {object} row
 * @param {{ select?: string|null, context?: string }} [options]
 * @returns {Promise<{ data?: any, error?: any, attemptedRow: object, fallbacksApplied: string[] }>}
 */
export async function upsertBookingPrewrite(sb, row, options = {}) {
  const select = typeof options.select === "string" && options.select.trim() ? options.select.trim() : "";
  const context = options.context || "BOOKING_PREWRITE";
  const fallbacksApplied = [];
  let attemptedRow = { ...row };
  let attempts = 0;

  // Max retries: one per optional column drop + slingshot status + legacy pending + final attempt.
  while (attempts < 5) {
    attempts += 1;
    let query = sb.from("bookings").upsert(attemptedRow, { onConflict: "booking_ref" });
    if (select) query = query.select(select);
    const result = await query;
    if (!result.error) {
      return { ...result, attemptedRow, fallbacksApplied };
    }

    // Schema error: drop the next optional column that is still present in the row.
    if (isSchemaError(result.error)) {
      const colToDrop = OPTIONAL_SCHEMA_FALLBACK_COLUMNS.find(
        (col) => Object.prototype.hasOwnProperty.call(attemptedRow, col),
      );
      if (colToDrop) {
        console.warn(`[${context}] retrying without ${colToDrop} after schema error:`, result.error.message);
        attemptedRow = { ...attemptedRow };
        delete attemptedRow[colToDrop];
        fallbacksApplied.push(`drop_${colToDrop}`);
        continue;
      }
    }

    // Slingshot lifecycle status not yet in the DB constraint: fall back to pending_checkout.
    if (isSlingshotStatusConstraintError(result.error, attemptedRow)) {
      console.warn(`[${context}] retrying with pending_checkout after slingshot status constraint error:`, result.error.message);
      attemptedRow = { ...attemptedRow, status: "pending_checkout" };
      fallbacksApplied.push("slingshot_status_to_pending_checkout");
      continue;
    }

    // Legacy pending_checkout not yet in the constraint: fall back to "pending".
    if (isLegacyPendingStatusConstraintError(result.error, attemptedRow)) {
      console.warn(`[${context}] retrying with legacy pending status after constraint error:`, result.error.message);
      attemptedRow = { ...attemptedRow, status: "pending" };
      fallbacksApplied.push("legacy_pending_status");
      continue;
    }

    return { ...result, attemptedRow, fallbacksApplied };
  }

  return {
    data: null,
    error: new Error(`${context} exhausted compatibility retries`),
    attemptedRow,
    fallbacksApplied,
  };
}
