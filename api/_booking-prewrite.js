import { isSchemaError } from "./_error-helpers.js";

// Optional columns added in later migrations that may not exist on older production schemas.
// Dropped one at a time on schema errors.
const OPTIONAL_SCHEMA_FALLBACK_COLUMNS = ["category", "identity_session_id"];

function isStatusConstraintError(err) {
  const code = String(err?.code || "").trim();
  const message = String(err?.message || "").toLowerCase();
  return code === "23514" || message.includes("bookings_status_check");
}

function isLegacyPendingStatusConstraintError(err, attemptedRow) {
  return String(attemptedRow?.status || "").trim() === "pending_checkout" && isStatusConstraintError(err);
}

function isBookingConflictTriggerError(err) {
  return String(err?.code || "").trim() === "P0001";
}

/**
 * Upsert a booking pre-write row with backward-compatible retries for older
 * Supabase schemas.
 *
 * Fallbacks (applied in order, one per retry):
 *  1. Drop `category` when the live DB is missing that newer column.
 *  2. Drop `identity_session_id` when the live DB is missing that column
 *     (migration 0158 not yet applied).
 *  3. Downgrade pre-payment `pending_checkout` to legacy `pending` when the
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

  // Max retries: one per optional column drop + legacy pending + final attempt.
  while (attempts < 4) {
    attempts += 1;
    let query = sb.from("bookings").upsert(attemptedRow, { onConflict: "booking_ref" });
    if (select) query = query.select(select);
    const result = await query;
    if (!result.error) {
      return { ...result, attemptedRow, fallbacksApplied };
    }

    // Conflict trigger (P0001): a confirmed booking already occupies this slot.
    // Do not retry — this is a real business constraint, not a schema issue.
    if (isBookingConflictTriggerError(result.error)) {
      console.warn(`[${context}] booking conflict trigger fired:`, result.error.message);
      return { ...result, attemptedRow, fallbacksApplied, isConflict: true };
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
