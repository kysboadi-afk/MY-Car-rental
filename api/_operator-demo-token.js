import crypto from "crypto";

function getSecret() {
  if (!process.env.OTP_SECRET) {
    console.warn("[_operator-demo-token] OTP_SECRET missing; using fallback secret.");
  }
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

export function createOperatorDemoActionToken(payload = {}, ttlMs = 72 * 60 * 60 * 1000) {
  const exp = Date.now() + Math.max(60_000, Number(ttlMs) || 0);
  const encodedPayload = Buffer.from(JSON.stringify({ ...payload, exp })).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(`operator-demo:${encodedPayload}`)
    .digest("base64url");
  return `${encodedPayload}.${sig}`;
}

export function verifyOperatorDemoActionToken(token) {
  if (!token || typeof token !== "string") return null;
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  const encodedPayload = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);
  const expectedSig = crypto
    .createHmac("sha256", getSecret())
    .update(`operator-demo:${encodedPayload}`)
    .digest("base64url");

  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (!sigBuf.length || sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!decoded?.demoId || !decoded?.leadId || !decoded?.action || !decoded?.exp) return null;
    if (Date.now() > Number(decoded.exp)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function hashOperatorDemoToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}
