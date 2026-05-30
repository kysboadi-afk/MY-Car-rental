// api/_customer-ledger.js
// Phase C — shadow-mode additive customer ledger appends.
//
// Guardrails:
//   • Non-blocking: callers should treat all failures as observational only.
//   • Additive only: never mutates or replaces legacy booking/revenue flows.
//   • Idempotent: relies on customer_ledger(source_type, source_id) uniqueness.
//   • Auditable duplicates: duplicate attempts are written to ledger_idempotency_log.

import { normalizeEmailForLinking, normalizePhoneForLinking } from "./_customer-identity.js";
import { logFinancialConsistencyAlert, logParityDrift } from "./_org-rollout-observability.js";

const DUAL_WRITE_MODES = new Set(["parallel"]);

export function parseCustomerLedgerMode(rawValue, fallback = "shadow") {
  if (rawValue == null) return fallback;

  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) return fallback;

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.trim()) {
        return parsed.trim().toLowerCase();
      }
    } catch {
      // Non-JSON plain string; continue below.
    }

    return trimmed.replace(/^"+|"+$/g, "").toLowerCase();
  }

  if (typeof rawValue === "boolean") {
    return rawValue ? "parallel" : "shadow";
  }

  return fallback;
}

export function isCustomerLedgerDualWriteEnabled(mode) {
  return DUAL_WRITE_MODES.has(String(mode || "").toLowerCase());
}

export async function loadCustomerLedgerMode(supabase, fallback = "shadow") {
  try {
    const { data, error } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "customer_ledger_mode")
      .maybeSingle();
    if (error) return fallback;
    return parseCustomerLedgerMode(data?.value, fallback);
  } catch {
    return fallback;
  }
}

async function logIdempotencyAttempt(supabase, { sourceType, sourceId, caller, bookingRef, customerId, metadata }) {
  try {
    await supabase
      .from("ledger_idempotency_log")
      .insert({
        source_type: sourceType,
        source_id: sourceId,
        caller: caller || null,
        booking_ref: bookingRef || null,
        customer_id: customerId || null,
        metadata: metadata || {},
      });
  } catch (logErr) {
    console.warn("[customer-ledger] idempotency log insert failed (non-fatal):", logErr?.message || String(logErr));
  }
}

async function resolveCustomerIdFromBooking(supabase, bookingRef, fallbackIdentity = {}) {
  const { data: bookingRow, error: bookingErr } = await supabase
    .from("bookings")
    .select("customer_id, stripe_customer_id, customer_email, customer_phone, organization_id")
    .eq("booking_ref", bookingRef)
    .maybeSingle();

  if (bookingErr) {
    return {
      customerId: null,
      bookingOrgId: null,
      reason: `booking_lookup_failed:${bookingErr.message}`,
    };
  }

  if (!bookingRow) {
    return {
      customerId: null,
      bookingOrgId: null,
      reason: "booking_not_found",
    };
  }

  if (bookingRow.customer_id) {
    return {
      customerId: bookingRow.customer_id,
      bookingOrgId: bookingRow.organization_id || null,
      reason: "booking_customer_id",
    };
  }

  const stripeId = bookingRow.stripe_customer_id || fallbackIdentity.stripeCustomerId || null;
  if (stripeId) {
    const { data: byStripe, error: stripeErr } = await supabase
      .from("customers")
      .select("id")
      .eq("stripe_customer_id", stripeId)
      .maybeSingle();
    if (byStripe?.id) return { customerId: byStripe.id, bookingOrgId: bookingRow.organization_id || null, reason: "stripe_customer_id" };
    if (stripeErr?.code === "PGRST116") {
      return { customerId: null, bookingOrgId: bookingRow.organization_id || null, reason: "ambiguous_stripe_customer_id" };
    }
  }

  const normalizedEmail = normalizeEmailForLinking(bookingRow.customer_email || fallbackIdentity.email);
  if (normalizedEmail) {
    const { data: byEmail, error: emailErr } = await supabase
      .from("customers")
      .select("id")
      .eq("normalized_email", normalizedEmail)
      .maybeSingle();
    if (byEmail?.id) return { customerId: byEmail.id, bookingOrgId: bookingRow.organization_id || null, reason: "normalized_email" };
    if (emailErr?.code === "PGRST116") {
      return { customerId: null, bookingOrgId: bookingRow.organization_id || null, reason: "ambiguous_normalized_email" };
    }
  }

  const normalizedPhone = normalizePhoneForLinking(bookingRow.customer_phone || fallbackIdentity.phone);
  if (normalizedPhone) {
    const { data: byPhone, error: phoneErr } = await supabase
      .from("customers")
      .select("id")
      .eq("normalized_phone", normalizedPhone)
      .maybeSingle();
    if (byPhone?.id) return { customerId: byPhone.id, bookingOrgId: bookingRow.organization_id || null, reason: "normalized_phone" };
    if (phoneErr?.code === "PGRST116") {
      return { customerId: null, bookingOrgId: bookingRow.organization_id || null, reason: "ambiguous_normalized_phone" };
    }
  }

  return {
    customerId: null,
    bookingOrgId: bookingRow.organization_id || null,
    reason: "no_deterministic_customer_link",
  };
}

export async function appendCustomerLedgerShadowEntry(supabase, {
  caller,
  bookingRef,
  transactionType,
  direction,
  amountCents,
  sourceType,
  sourceId,
  description,
  metadata = {},
  recordedBy = "system",
  fallbackIdentity = {},
} = {}) {
  try {
    if (!supabase) return { written: false, skipped: true, reason: "supabase_unavailable" };
    if (!bookingRef || !sourceType || !sourceId) {
      return { written: false, skipped: true, reason: "missing_required_fields" };
    }
    const cents = Number(amountCents);
    if (!Number.isFinite(cents) || cents < 0) {
      return { written: false, skipped: true, reason: "invalid_amount_cents" };
    }

    const mode = await loadCustomerLedgerMode(supabase, "shadow");
    if (!isCustomerLedgerDualWriteEnabled(mode)) {
      return { written: false, skipped: true, reason: `dual_write_disabled:${mode}` };
    }

    const customerResolution = await resolveCustomerIdFromBooking(supabase, bookingRef, fallbackIdentity);
    if (!customerResolution.customerId) {
      return {
        written: false,
        skipped: true,
        reason: customerResolution.reason,
      };
    }

    const { data: existing } = await supabase
      .from("customer_ledger")
      .select("id")
      .eq("source_type", sourceType)
      .eq("source_id", sourceId)
      .maybeSingle();

    if (existing?.id) {
      await logIdempotencyAttempt(supabase, {
        sourceType,
        sourceId,
        caller,
        bookingRef,
        customerId: customerResolution.customerId,
        metadata: {
          ...metadata,
          duplicate_reason: "precheck_existing_source",
        },
      });
      return { written: false, skipped: true, reason: "duplicate_source" };
    }

    const { error: insertErr } = await supabase
      .from("customer_ledger")
      .insert({
        customer_id: customerResolution.customerId,
        booking_ref: bookingRef,
        transaction_type: transactionType,
        direction,
        amount_cents: Math.round(cents),
        source_type: sourceType,
        source_id: sourceId,
        description: description || null,
        metadata: metadata || {},
        recorded_by: recordedBy || null,
      });

    if (insertErr) {
      const isDup = insertErr.code === "23505" || String(insertErr.message || "").toLowerCase().includes("duplicate");
      if (isDup) {
        await logIdempotencyAttempt(supabase, {
          sourceType,
          sourceId,
          caller,
          bookingRef,
          customerId: customerResolution.customerId,
          metadata: {
            ...metadata,
            duplicate_reason: "insert_unique_conflict",
          },
        });
        return { written: false, skipped: true, reason: "duplicate_source" };
      }
      return { written: false, skipped: true, reason: `insert_failed:${insertErr.message}` };
    }

    const { data: customerOrgLookup } = await supabase
      .from("customers")
      .select("organization_id")
      .eq("id", customerResolution.customerId)
      .maybeSingle();

    const bookingOrgId = customerResolution.bookingOrgId || null;
    const customerOrgId = customerOrgLookup?.organization_id || null;
    const endpoint = "customer-ledger-shadow";
    const source = "appendCustomerLedgerShadowEntry";

    if (bookingOrgId && customerOrgId && bookingOrgId !== customerOrgId) {
      logParityDrift({
        table: "customer_ledger",
        recordId: null,
        bookingRef,
        expectedOrgId: bookingOrgId,
        actualOrgId: customerOrgId,
        source,
        detail: "customer_ledger source org mismatch: booking and customer organizations differ before write",
      });
      logFinancialConsistencyAlert({
        endpoint,
        table: "customer_ledger",
        bookingRef,
        orgId: customerOrgId,
        inconsistency: "booking_vs_customer_org_mismatch_before_customer_ledger_write",
        detail: `booking org ${bookingOrgId}, customer org ${customerOrgId}`,
      });
    }

    return { written: true, customerId: customerResolution.customerId };
  } catch (err) {
    return { written: false, skipped: true, reason: `unexpected:${err.message}` };
  }
}
