// api/_renter-auth.js
// Signed renter session tokens (stateless).
//
// These tokens complement manage_token links:
// - manage_token remains supported for backwards compatibility
// - renter session tokens enable authenticated renter actions without repeatedly
//   passing manage_token in every request.

import crypto from "crypto";

const SESSION_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 60 * 60 * 8; // 8h
const MAX_TTL_SECONDS = 60 * 60 * 24; // 24h

function normalize(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function getRenterSessionSecret() {
  return normalize(
    process.env.RENTER_SESSION_SECRET ||
    process.env.AUTH_SESSION_SECRET ||
    process.env.OTP_SECRET ||
    ""
  );
}

function safeEqual(aRaw, bRaw) {
  const a = Buffer.from(String(aRaw || ""), "utf8");
  const b = Buffer.from(String(bRaw || ""), "utf8");
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const bPadded = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  if (typeof crypto.timingSafeEqual === "function") {
    return crypto.timingSafeEqual(aPadded, bPadded) && a.length === b.length;
  }
  return Buffer.compare(aPadded, bPadded) === 0 && a.length === b.length;
}

function sign(payload) {
  const secret = getRenterSessionSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createRenterSessionToken(opts = {}) {
  const secret = getRenterSessionSecret();
  if (!secret) return "";
  const bookingRef = normalize(opts.bookingRef || "");
  if (!bookingRef) return "";
  const now = Math.floor(Date.now() / 1000);
  const ttlCandidate = Number.parseInt(
    String(opts.ttlSeconds ?? process.env.RENTER_SESSION_TTL_SECONDS ?? DEFAULT_TTL_SECONDS),
    10
  );
  const ttlSeconds = Number.isFinite(ttlCandidate)
    ? Math.max(60, Math.min(MAX_TTL_SECONDS, ttlCandidate))
    : DEFAULT_TTL_SECONDS;
  const claims = {
    typ: "renter_session",
    ver: SESSION_VERSION,
    role: "renter",
    sub: normalize(opts.subject || bookingRef),
    booking_ref: bookingRef,
    email: normalize((opts.email || "").toLowerCase()),
    phone: normalize(opts.phone || ""),
    auth_method: normalize(opts.authMethod || "manage_token_verify"),
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = sign(payload);
  if (!sig) return "";
  return `${payload}.${sig}`;
}

export function verifyRenterSessionToken(token) {
  const raw = normalize(token);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (!expected || !safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object") return null;
    if (claims.typ !== "renter_session" || claims.ver !== SESSION_VERSION) return null;
    if (String(claims.role || "").toLowerCase() !== "renter") return null;
    if (!normalize(claims.booking_ref)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(claims.exp) || now >= Number(claims.exp)) return null;
    if (!Number.isFinite(claims.iat) || Number(claims.iat) <= 0) return null;
    return claims;
  } catch {
    return null;
  }
}

export function extractBearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
}

