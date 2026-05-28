function pruneFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

export function logOrgRolloutEvent(event, fields = {}, level = "info") {
  const logger = level === "error"
    ? console.error
    : level === "warn"
      ? console.warn
      : console.info;

  logger("[org-rollout]", {
    event,
    ...pruneFields(fields),
  });
}

export function getRequestAuthMode(req) {
  return req?.adminAuth?.type || "unknown";
}

export function logDefaultOrgFallback(req, { endpoint, action, table } = {}) {
  if (req?.tenantContext?.organizationId) return;
  logOrgRolloutEvent("default_org_fallback", {
    endpoint: endpoint || req?.url || null,
    action: action || null,
    table: table || null,
    authMode: getRequestAuthMode(req),
  }, "warn");
}

export function logCompatibilityFallback({ endpoint, action, fallback, reason, detail } = {}) {
  logOrgRolloutEvent("compatibility_fallback", {
    endpoint: endpoint || null,
    action: action || null,
    fallback: fallback || null,
    reason: reason || null,
    detail: detail || null,
  }, "warn");
}

/**
 * Logs a webhook-path org fallback event.
 *
 * Called from webhook handlers (e.g. stripe-webhook) that run outside the
 * withAdminAuth middleware and therefore never have req.tenantContext attached.
 * Every webhook write to an organization-aware table should call this so the
 * rollout dashboard can track how many webhook-driven financial rows are being
 * written without a resolved tenant.
 *
 * @param {{ endpoint?: string, action?: string, table?: string, bookingRef?: string, paymentIntentId?: string }} fields
 */
export function logWebhookOrgFallback({ endpoint, action, table, bookingRef, paymentIntentId } = {}) {
  logOrgRolloutEvent("webhook_default_org_fallback", {
    endpoint: endpoint || null,
    action: action || null,
    table: table || null,
    bookingRef: bookingRef || null,
    paymentIntentId: paymentIntentId || null,
    authMode: "webhook",
  }, "warn");
}

/**
 * Logs an auth mode mismatch — when a Supabase-authenticated user's resolved
 * organization differs from what would be inferred from the legacy
 * ADMIN_SECRET / session auth path.
 *
 * @param {{ endpoint?: string, supabaseOrgId?: string|null, legacyOrgId?: string|null, userId?: string|null, detail?: string }} fields
 */
export function logAuthMismatch({ endpoint, supabaseOrgId, legacyOrgId, userId, detail } = {}) {
  logOrgRolloutEvent("auth_mismatch", {
    endpoint: endpoint || null,
    supabaseOrgId: supabaseOrgId || null,
    legacyOrgId: legacyOrgId || null,
    userId: userId || null,
    detail: detail || null,
  }, "warn");
}

/**
 * Logs a parity drift event — when the same logical record (identified by
 * bookingRef, customerId, etc.) is associated with different organization_id
 * values depending on which code path resolved it.
 *
 * Typical cases:
 *   - A booking's organization_id does not match the revenue_records org for
 *     the same booking_ref (post-backfill join gap).
 *   - A customer's organization_id differs from their bookings' organization_id.
 *
 * @param {{ table?: string, recordId?: string, bookingRef?: string, expectedOrgId?: string|null, actualOrgId?: string|null, source?: string, detail?: string }} fields
 */
export function logParityDrift({ table, recordId, bookingRef, expectedOrgId, actualOrgId, source, detail } = {}) {
  logOrgRolloutEvent("parity_drift", {
    table: table || null,
    recordId: recordId || null,
    bookingRef: bookingRef || null,
    expectedOrgId: expectedOrgId || null,
    actualOrgId: actualOrgId || null,
    source: source || null,
    detail: detail || null,
  }, "warn");
}

/**
 * Logs a financial consistency concern — when a reconciliation path detects
 * that financial rows (charges, revenue_records, ledger entries, tickets) do
 * not agree on organization_id, indicating potential cross-tenant financial
 * data contamination.
 *
 * @param {{ endpoint?: string, table?: string, bookingRef?: string, orgId?: string|null, inconsistency?: string, detail?: string }} fields
 */
export function logFinancialConsistencyAlert({ endpoint, table, bookingRef, orgId, inconsistency, detail } = {}) {
  logOrgRolloutEvent("financial_consistency_alert", {
    endpoint: endpoint || null,
    table: table || null,
    bookingRef: bookingRef || null,
    orgId: orgId || null,
    inconsistency: inconsistency || null,
    detail: detail || null,
  }, "error");
}

/**
 * Logs a tenant isolation gap — when application logic detects that a row
 * accessible to the current request belongs to a different organization than
 * the authenticated tenant context.  This is the application-layer equivalent
 * of what RLS will enforce at the DB layer once enforcement is activated.
 *
 * @param {{ endpoint?: string, table?: string, recordId?: string, requestOrgId?: string|null, rowOrgId?: string|null, userId?: string|null, detail?: string }} fields
 */
export function logTenantIsolationGap({ endpoint, table, recordId, requestOrgId, rowOrgId, userId, detail } = {}) {
  logOrgRolloutEvent("tenant_isolation_gap", {
    endpoint: endpoint || null,
    table: table || null,
    recordId: recordId || null,
    requestOrgId: requestOrgId || null,
    rowOrgId: rowOrgId || null,
    userId: userId || null,
    detail: detail || null,
  }, "error");
}
