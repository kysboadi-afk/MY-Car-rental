// api/_admin-auth.js
// Shared admin authentication helper.
// Uses constant-time comparison to prevent timing attacks.
// Checks ADMIN_SECRET (primary) or ADMIN_PASSWORD (alias) env var.

import crypto from "crypto";

/**
 * Returns true when the supplied secret matches the configured admin password.
 * Always uses constant-time comparison — never short-circuits.
 *
 * @param {string|undefined} supplied  - Value from request body / header
 * @returns {boolean}
 */
export function isAdminAuthorized(supplied) {
  const expected = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || "";
  if (!expected) return false; // env var not configured → deny all
  if (!supplied) return false;

  // Constant-time compare — both buffers padded to the longer length so
  // timingSafeEqual never throws on length mismatch.
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const bPadded = Buffer.concat([b, Buffer.alloc(len - b.length)]);

  return crypto.timingSafeEqual(aPadded, bPadded) && a.length === b.length;
}

/**
 * Returns true when the ADMIN_SECRET / ADMIN_PASSWORD env var is configured.
 */
export function isAdminConfigured() {
  return Boolean(process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD);
}
