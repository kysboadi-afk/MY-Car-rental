// api/_middleware.js
// Centralized request middleware for Vercel serverless handlers.
//
// Provides:
//   withAdminAuth(handler)              — CORS + admin auth wrapper for POST endpoints
//   setCorsHeaders(req, res)            — applies CORS headers from the canonical origin list
//   sendError(res, status, msg, detail) — standardized JSON error response
//   ALLOWED_ORIGINS                     — single canonical CORS origin list
//
// Design goals:
//   - Single source of truth for ALLOWED_ORIGINS (replaces per-file duplication)
//   - Eliminate copy-pasted CORS + auth boilerplate across 170+ endpoints
//   - Attach tenant context to req.tenantContext for Phase 1 org-scoped queries
//   - Never swallow errors silently — unhandled throws produce structured 500s
//
// Migration strategy (compatibility-safe):
//   Existing endpoints continue to work unchanged; adoption is incremental.
//   New endpoints should use withAdminAuth() from the start.
//   During Phase 1, withAdminAuth will begin populating req.tenantContext
//   without requiring any changes to handlers that already adopted it.

import { extractAdminSecret, isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";

// ─── Canonical CORS origin list ───────────────────────────────────────────────
// All admin-facing API endpoints should use this list.
// Add new allowed origins here — never inline them in individual endpoint files.

export const ALLOWED_ORIGINS = [
  "https://www.slytrans.com",
  "https://slytrans.com",
  "https://slycarrentals.com",
  "https://www.slycarrentals.com",
  "https://admin.slycarrentals.com",
];

// ─── CORS helper ─────────────────────────────────────────────────────────────

/**
 * Sets Access-Control-Allow-* headers on the response.
 * Only sets Allow-Origin when the request origin is in ALLOWED_ORIGINS.
 * Safe to call on every request — does not echo arbitrary origins.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 */
export function setCorsHeaders(req, res) {
  const origin = req.headers?.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ─── Standardized error response ─────────────────────────────────────────────

/**
 * Sends a structured JSON error response and returns the result so handlers
 * can `return sendError(...)` cleanly.
 *
 * @param {import('http').ServerResponse} res
 * @param {number}  status   — HTTP status code
 * @param {string}  message  — human-readable error message
 * @param {*}      [details] — optional machine-readable details (omitted when undefined)
 */
export function sendError(res, status, message, details = undefined) {
  const body = { error: message };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

// ─── withAdminAuth wrapper ────────────────────────────────────────────────────

/**
 * Wraps a Vercel serverless handler with the full admin request lifecycle:
 *
 *   1. CORS headers applied unconditionally
 *   2. OPTIONS preflight handled with 200
 *   3. Non-POST methods rejected with 405
 *   4. Admin secret validated (ADMIN_SECRET env var)
 *   5. req.tenantContext attached (null in Phase 0; populated in Phase 1)
 *   6. Unhandled throws caught and returned as structured 500s
 *
 * Usage:
 *   export default withAdminAuth(async (req, res) => {
 *     const { action } = req.body || {};
 *     // ...
 *   });
 *
 * Phase 1 note:
 *   req.tenantContext will be populated with { organizationId, role, userId }
 *   once the organizations/organization_users tables are live. All handlers that
 *   already use withAdminAuth() will get tenant context for free — no code changes
 *   needed in individual endpoint files.
 *
 * @param {(req: import('http').IncomingMessage & { tenantContext: null }, res: import('http').ServerResponse) => Promise<void>} handler
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function withAdminAuth(handler) {
  return async function middlewareHandler(req, res) {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

    if (!isAdminConfigured()) {
      return sendError(res, 500, "Server configuration error: ADMIN_SECRET is not set.");
    }

    const adminSecret = extractAdminSecret(req);
    if (!isAdminAuthorized(adminSecret)) {
      return sendError(res, 401, "Unauthorized");
    }

    // Phase 0: tenant context is always null.
    // Phase 1: this will call resolveTenantContext(supabase, userId) and attach
    // { organizationId, role, userId } so all downstream queries can be org-scoped.
    req.tenantContext = null;

    try {
      return await handler(req, res);
    } catch (err) {
      console.error("[middleware] Unhandled handler error:", err?.message ?? err);
      return sendError(res, 500, "Internal server error");
    }
  };
}
