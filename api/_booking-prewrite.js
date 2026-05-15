import { isSchemaError } from "./_error-helpers.js";

function isLegacyPendingStatusConstraintError(err, attemptedRow) {
  if (!err || !attemptedRow || attemptedRow.status !== "pending_checkout") return false;
  const code = String(err.code || "");
  const msg = String(err.message || "");
  return (
    code === "23514" ||
    /violates check constraint/i.test(msg) ||
    /bookings_status_check/i.test(msg)
  );
}

function cloneWithoutCategory(row) {
  const next = { ...row };
  delete next.category;
  return next;
}

/**
 * Upsert a booking pre-write row with backward-compatible retries for older
 * Supabase schemas.
 *
 * Fallbacks:
 *  1. Drop `category` when the live DB is missing that newer column.
 *  2. Downgrade pre-payment `pending_checkout` to legacy `pending` when the
 *     bookings.status constraint has not yet been expanded.
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

  while (attempts < 3) {
    attempts += 1;
    let query = sb.from("bookings").upsert(attemptedRow, { onConflict: "booking_ref" });
    if (select) query = query.select(select);
    const result = await query;
    if (!result.error) {
      return { ...result, attemptedRow, fallbacksApplied };
    }

    if (Object.prototype.hasOwnProperty.call(attemptedRow, "category") && isSchemaError(result.error)) {
      console.warn(`[${context}] retrying without category after schema error:`, result.error.message);
      attemptedRow = cloneWithoutCategory(attemptedRow);
      fallbacksApplied.push("drop_category");
      continue;
    }

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
