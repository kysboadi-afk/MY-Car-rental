// api/_admin-auth.js
// Shared admin authentication helper.
// Uses constant-time comparison to prevent timing attacks.
// Checks ADMIN_SECRET (primary) or ADMIN_PASSWORD (alias) env var.

import crypto from "crypto";

function normalizeSecret(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

/**
 * Extracts the admin secret from a Vercel/Node request object.
 * Checks (in order):
 *   1. Authorization: Bearer <secret> header
 *   2. req.query.secret   (GET query-string, kept for legacy callers)
 *   3. req.body.secret    (POST body, kept for legacy callers)
 *
 * @param {object} req - Vercel/Node HTTP request
 * @returns {string} The extracted secret, or an empty string if not present.
 */
export function extractAdminSecret(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return String(req.query?.secret || req.body?.secret || "");
}

/**
 * Returns true when the supplied secret matches the configured admin password.
 * Always uses constant-time comparison — never short-circuits.
 *
 * @param {string|undefined} supplied  - Value from request body / header
 * @returns {boolean}
 */
export function isAdminAuthorized(supplied) {
  const expected = normalizeSecret(process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || "");
  if (!expected) return false; // env var not configured → deny all
  const suppliedNormalized = normalizeSecret(String(supplied || ""));
  if (!suppliedNormalized) return false;

  // Constant-time compare — both buffers padded to the longer length so
  // timingSafeEqual never throws on length mismatch.
  const a = Buffer.from(suppliedNormalized);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const bPadded = Buffer.concat([b, Buffer.alloc(len - b.length)]);

  if (typeof crypto.timingSafeEqual === "function") {
    return crypto.timingSafeEqual(aPadded, bPadded) && a.length === b.length;
  }
  return Buffer.compare(aPadded, bPadded) === 0 && a.length === b.length;
}

/**
 * Returns true when the ADMIN_SECRET / ADMIN_PASSWORD env var is configured.
 */
export function isAdminConfigured() {
  return Boolean(process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD);
}
