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
