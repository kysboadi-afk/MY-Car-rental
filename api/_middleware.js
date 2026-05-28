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
import { getSupabaseAdmin } from "./_supabase.js";
import { resolveTenantContext } from "./_tenant-context.js";

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

function extractBearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
}

function isSupabaseOperatorAuthConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function authenticateAdminRequest(req) {
  const credential = extractAdminSecret(req);

  if (isAdminAuthorized(credential)) {
    return {
      kind: "legacy",
      tenantContext: null,
      authUser: null,
      adminAuth: { type: "legacy_admin_secret" },
    };
  }

  const bearerToken = extractBearerToken(req);
  if (!bearerToken) {
    if (!isAdminConfigured() && !isSupabaseOperatorAuthConfigured()) {
      return { error: { status: 500, message: "Server configuration error: admin auth is not configured." } };
    }
    return { error: { status: 401, message: "Unauthorized" } };
  }

  if (!isSupabaseOperatorAuthConfigured()) {
    return { error: { status: 401, message: "Unauthorized" } };
  }

  const supabase = getSupabaseAdmin();
  if (!supabase?.auth?.getUser) {
    return { error: { status: 500, message: "Server configuration error: Supabase auth is unavailable." } };
  }

  const { data, error } = await supabase.auth.getUser(bearerToken);
  const authUser = data?.user || null;
  if (error || !authUser?.id) {
    console.warn("[middleware] Supabase operator auth rejected:", error?.message || "missing user");
    return { error: { status: 401, message: "Unauthorized" } };
  }

  const tenantContext = await resolveTenantContext(supabase, authUser.id);
  if (!tenantContext?.organizationId) {
    console.warn("[middleware] Supabase operator missing active organization:", authUser.id);
    return {
      error: {
        status: 403,
        message: "Operator is not assigned to an active organization.",
      },
    };
  }

  return {
    kind: "supabase_user",
    tenantContext,
    authUser,
    adminAuth: {
      type: "supabase_user",
      userId: authUser.id,
      role: tenantContext.role,
      organizationId: tenantContext.organizationId,
    },
  };
}

// ─── withAdminAuth wrapper ────────────────────────────────────────────────────

/**
 * Wraps a Vercel serverless handler with the full admin request lifecycle:
 *
 *   1. CORS headers applied unconditionally
 *   2. OPTIONS preflight handled with 200
 *   3. Non-POST methods rejected with 405
 *   4. Legacy admin secret/session OR Supabase operator identity validated
 *   5. req.tenantContext attached when org membership is resolved
 *   6. Unhandled throws caught and returned as structured 500s
 *
 * Usage:
 *   export default withAdminAuth(async (req, res) => {
 *     const { action } = req.body || {};
 *     // ...
 *   });
 *
 * req.tenantContext remains null for legacy ADMIN_SECRET/session requests so
 * existing single-tenant handlers stay compatibility-safe during rollout.
 *
 * @param {(req: import('http').IncomingMessage & { tenantContext: import('./_tenant-context.js').TenantContext|null, authUser?: object|null, adminAuth?: object|null }, res: import('http').ServerResponse) => Promise<void>} handler
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function withAdminAuth(handler) {
  return async function middlewareHandler(req, res) {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

    try {
      const authResult = await authenticateAdminRequest(req);
      if (authResult?.error) {
        return sendError(res, authResult.error.status, authResult.error.message);
      }

      req.tenantContext = authResult?.tenantContext ?? null;
      req.authUser = authResult?.authUser ?? null;
      req.adminAuth = authResult?.adminAuth ?? null;

      return await handler(req, res);
    } catch (err) {
      console.error("[middleware] Unhandled handler error:", err?.message ?? err);
      return sendError(res, 500, "Internal server error");
    }
  };
}
