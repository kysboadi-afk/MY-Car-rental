// api/_extension-risk.js
// Extension risk gating — Phase 2.
// Evaluates whether a booking is allowed to create a new partial-payment
// extension based on configurable system-wide limits and per-booking
// admin overrides.
//
// System settings consumed (category: "extension_policy"):
//   extension_partial_block_enabled — master on/off (boolean, default true)
//   extension_max_unpaid_exposure   — max total unpaid balance from partial
//                                     extensions for one booking (USD, default 500)
//   extension_max_partial_count     — max number of partial extensions per
//                                     booking (default 3)
//   extension_partial_min_pct       — min % of extension cost required upfront
//                                     for partial payments (default 50)
//   extension_overdue_block_partial — block partial extensions when booking is
//                                     overdue (boolean, default true)
//   extension_allow_override        — whether admin extension_risk_override is
//                                     respected (boolean, default true)
//
// The booking_extensions table is expected to have columns:
//   payment_type               — "full" | "partial"
//   extension_remaining_balance — USD amount still owed for this extension row

import { loadNumericSetting, loadBooleanSetting } from "./_settings.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

export const EXTENSION_RISK_DEFAULTS = {
  extension_partial_block_enabled: true,
  extension_max_unpaid_exposure:   500,
  extension_max_partial_count:     3,
  extension_partial_min_pct:       50,
  extension_overdue_block_partial: true,
  extension_allow_override:        true,
};

/**
 * Loads all extension-risk settings from Supabase in parallel.
 * Falls back to EXTENSION_RISK_DEFAULTS for any missing / unreachable key.
 *
 * @returns {Promise<typeof EXTENSION_RISK_DEFAULTS>}
 */
export async function loadExtensionRiskSettings() {
  const [
    blockEnabled,
    maxExposure,
    maxCount,
    minPct,
    overdueBlock,
    allowOverride,
  ] = await Promise.all([
    loadBooleanSetting("extension_partial_block_enabled", EXTENSION_RISK_DEFAULTS.extension_partial_block_enabled),
    loadNumericSetting("extension_max_unpaid_exposure",   EXTENSION_RISK_DEFAULTS.extension_max_unpaid_exposure),
    loadNumericSetting("extension_max_partial_count",     EXTENSION_RISK_DEFAULTS.extension_max_partial_count),
    loadNumericSetting("extension_partial_min_pct",       EXTENSION_RISK_DEFAULTS.extension_partial_min_pct),
    loadBooleanSetting("extension_overdue_block_partial", EXTENSION_RISK_DEFAULTS.extension_overdue_block_partial),
    loadBooleanSetting("extension_allow_override",        EXTENSION_RISK_DEFAULTS.extension_allow_override),
  ]);

  return {
    extension_partial_block_enabled: blockEnabled,
    extension_max_unpaid_exposure:   maxExposure,
    extension_max_partial_count:     maxCount,
    extension_partial_min_pct:       minPct,
    extension_overdue_block_partial: overdueBlock,
    extension_allow_override:        allowOverride,
  };
}

/**
 * Evaluates whether a booking is allowed to make a new partial-payment
 * extension.
 *
 * The caller must pass `proposedNewExposure` — the additional unpaid amount
 * this extension would add (i.e. extensionTotal - amountPaidNow).
 *
 * When Supabase is unavailable or the booking reference is missing the gate
 * fails open (returns allowed: true) so the renter is never blocked by a
 * service outage.
 *
 * @param {object|null} sb               - Supabase admin client
 * @param {string}      bookingRef       - canonical booking_ref (e.g. "bk-...")
 * @param {number}      proposedNewExposure - additional unpaid USD for this extension
 * @param {object}      riskSettings     - result of loadExtensionRiskSettings()
 * @returns {Promise<{
 *   allowed:        boolean,
 *   reason:         string|null,
 *   partialCount:   number,
 *   exposureAmount: number,
 *   riskOverride:   "allow"|"block"|null,
 * }>}
 */
export async function evaluateExtensionRisk(sb, bookingRef, proposedNewExposure, riskSettings) {
  const result = {
    allowed:        true,
    reason:         null,
    partialCount:   0,
    exposureAmount: 0,
    riskOverride:   null,
  };

  // Gate is disabled — always allow.
  if (!riskSettings.extension_partial_block_enabled) {
    return result;
  }

  // Cannot evaluate without Supabase — fail open.
  if (!sb || !bookingRef) {
    return result;
  }

  // ── Admin override ────────────────────────────────────────────────────────
  if (riskSettings.extension_allow_override) {
    try {
      const { data: bkRow } = await sb
        .from("bookings")
        .select("extension_risk_override")
        .eq("booking_ref", bookingRef)
        .maybeSingle();

      const override = bkRow?.extension_risk_override || null;
      result.riskOverride = override;

      if (override === "allow") {
        // Admin explicitly allows — skip all further checks.
        return result;
      }
      if (override === "block") {
        result.allowed = false;
        result.reason  = "Partial extensions have been disabled for this booking by the administrator. Please contact us to resolve your balance.";
        return result;
      }
    } catch (_) {
      // Non-fatal — proceed with default evaluation.
    }
  }

  // ── Query existing partial extensions ────────────────────────────────────
  try {
    const { data: partialExts } = await sb
      .from("booking_extensions")
      .select("extension_remaining_balance")
      .eq("booking_id", bookingRef)
      .eq("payment_type", "partial");

    if (Array.isArray(partialExts)) {
      result.partialCount   = partialExts.length;
      result.exposureAmount = partialExts.reduce(
        (sum, r) => sum + Math.max(0, Number(r.extension_remaining_balance) || 0),
        0
      );
    }
  } catch (_) {
    // Cannot read booking_extensions — fail open.
    return result;
  }

  // ── Partial count limit ───────────────────────────────────────────────────
  const maxCount = riskSettings.extension_max_partial_count;
  if (result.partialCount >= maxCount) {
    result.allowed = false;
    result.reason  = `You have reached the maximum number of partial extensions (${maxCount}). Please pay your outstanding extension balance before requesting another extension.`;
    return result;
  }

  // ── Unpaid exposure limit ─────────────────────────────────────────────────
  const totalExposureAfter = Math.round((result.exposureAmount + proposedNewExposure) * 100) / 100;
  const maxExposure = riskSettings.extension_max_unpaid_exposure;
  if (totalExposureAfter > maxExposure) {
    result.allowed = false;
    result.reason  = `Adding this extension would bring your unpaid extension balance to $${totalExposureAfter.toFixed(2)}, which exceeds the $${maxExposure.toFixed(2)} limit. Please pay your outstanding balance first.`;
    return result;
  }

  return result;
}
