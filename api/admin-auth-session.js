// api/admin-auth-session.js
// Issues and verifies short-lived admin session tokens.
//
// POST /api/admin-auth-session
//   { action: "login", secret: "<ADMIN_SECRET>" } -> { token, expiresInSeconds }
//   { action: "verify", token?: "<token>" }      -> { ok, session }
//
// Rate limiting/lockout is applied to login attempts per identifier (IP + origin).

import {
  createAdminSessionToken,
  extractAdminSecret,
  isAdminAuthorized,
  isAdminConfigured,
  verifyAdminSessionToken,
} from "./_admin-auth.js";

const ALLOWED_ORIGINS = [
  "https://www.slytrans.com",
  "https://slytrans.com",
  "https://slycarrentals.com",
  "https://www.slycarrentals.com",
  "https://admin.slycarrentals.com",
];

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

// In-memory limiter (sufficient for serverless best-effort hardening).
const loginAttempts = new Map();

function getClientKey(req, origin) {
  const xfwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xfwd || String(req.socket?.remoteAddress || "unknown");
  return `${ip}|${origin || "no-origin"}`;
}

function readLoginState(key, now = Date.now()) {
  const entry = loginAttempts.get(key);
  if (!entry) return { attempts: [] };
  const attempts = (entry.attempts || []).filter((ts) => now - ts <= LOGIN_WINDOW_MS);
  const lockUntil = Number(entry.lockUntil || 0);
  if (!attempts.length && lockUntil <= now) {
    loginAttempts.delete(key);
    return { attempts: [] };
  }
  const normalized = { attempts, lockUntil };
  loginAttempts.set(key, normalized);
  return normalized;
}

function registerFailedLogin(key, now = Date.now()) {
  const state = readLoginState(key, now);
  const attempts = [...(state.attempts || []), now].filter((ts) => now - ts <= LOGIN_WINDOW_MS);
  const next = { attempts };
  if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
    next.lockUntil = now + LOGIN_LOCK_MS;
  }
  loginAttempts.set(key, next);
  return next;
}

function clearLoginState(key) {
  loginAttempts.delete(key);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const body = req.body || {};
  const action = String(body.action || "login").trim().toLowerCase();
  const now = Date.now();
  const clientKey = getClientKey(req, origin);

  if (action === "verify") {
    const supplied = String(body.token || extractAdminSecret(req) || "");
    const claims = verifyAdminSessionToken(supplied);
    if (!claims) return res.status(401).json({ error: "Invalid or expired session." });
    return res.status(200).json({
      ok: true,
      session: {
        role: claims.role || "admin",
        sub: claims.sub || "admin-dashboard",
        iat: claims.iat,
        exp: claims.exp,
      },
    });
  }

  if (action !== "login") {
    return res.status(400).json({ error: "Unsupported action." });
  }

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const state = readLoginState(clientKey, now);
  if (state.lockUntil && state.lockUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((state.lockUntil - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      error: "Too many login attempts. Try again later.",
      retryAfterSeconds,
    });
  }

  const supplied = String(body.secret || extractAdminSecret(req) || "");
  if (!isAdminAuthorized(supplied)) {
    const next = registerFailedLogin(clientKey, now);
    const remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - (next.attempts || []).length);
    return res.status(401).json({
      error: "Unauthorized",
      attemptsRemaining: remaining,
    });
  }

  clearLoginState(clientKey);
  const token = createAdminSessionToken({ role: "admin", authMethod: "admin_secret" });
  if (!token) {
    return res.status(500).json({ error: "Could not create session token." });
  }
  const claims = verifyAdminSessionToken(token);
  const expiresInSeconds = Math.max(
    60,
    Number(claims?.exp || 0) - Math.floor(Date.now() / 1000)
  );

  return res.status(200).json({
    ok: true,
    token,
    tokenType: "Bearer",
    expiresInSeconds,
    session: {
      role: claims?.role || "admin",
      sub: claims?.sub || "admin-dashboard",
      iat: claims?.iat || null,
      exp: claims?.exp || null,
    },
  });
}
