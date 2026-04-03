// api/bouncie-auth.js
// Bouncie OAuth one-time setup endpoint.
//
// Usage (run ONCE after obtaining the OAuth authorization code from Bouncie):
//
//   POST https://www.slytrans.com/api/bouncie-auth
//   Body: {
//     "secret":       "<ADMIN_SECRET>",
//     "code":         "<bouncie_authorization_code>",
//     "redirect_uri": "https://www.slytrans.com"   ← must match your Bouncie app settings
//   }
//
// The endpoint exchanges the code for access_token + refresh_token and stores
// both in the Supabase app_config table (key = "bouncie_tokens").
// After this, bouncie-sync and bouncie-webhook work automatically.
// Tokens are auto-refreshed by _bouncie.js on every sync.
//
// A GET request (authenticated with the same secret) returns the current token
// status without exposing the token values.
//
// Required env vars (set once in Vercel, never change):
//   ADMIN_SECRET            — protects this endpoint
//   BOUNCIE_CLIENT_ID       — from Bouncie Developer Portal
//   BOUNCIE_CLIENT_SECRET   — from Bouncie Developer Portal
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { exchangeAuthCode, getBouncieTokens } from "./_bouncie.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Authentication ─────────────────────────────────────────────────────────
  const secret =
    req.method === "GET"
      ? req.query?.secret
      : req.body?.secret;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  // ── GET: return current token status ────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const tokens = await getBouncieTokens(sb).catch(() => null);
      const hasAccess  = !!(tokens?.access_token);
      const hasRefresh = !!(tokens?.refresh_token);

      const clientId    = process.env.BOUNCIE_CLIENT_ID;
      const redirectUri = "https://www.slytrans.com/api/_bouncie";
      const authUrl = clientId
        ? `https://auth.bouncie.com/dialog/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`
        : null;

      return res.status(200).json({
        configured:        hasAccess,
        has_refresh_token: hasRefresh,
        updated_at:        tokens?.updated_at || null,
        auth_url:          authUrl,
        message:           hasAccess
          ? "Bouncie tokens are configured. Sync should be running."
          : "No Bouncie tokens found. POST to this endpoint with your authorization code.",
      });
    } catch (err) {
      return res.status(500).json({ error: adminErrorMessage(err) });
    }
  }

  // ── POST: exchange auth code for tokens ─────────────────────────────────────
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const { code, redirect_uri } = req.body || {};

  if (!code || typeof code !== "string" || code.trim().length < 10) {
    return res.status(400).json({
      error: "code is required. Obtain it by visiting the Bouncie OAuth authorization URL.",
    });
  }

  if (!redirect_uri || typeof redirect_uri !== "string") {
    return res.status(400).json({
      error: "redirect_uri is required and must match your Bouncie application settings.",
    });
  }

  if (!process.env.BOUNCIE_CLIENT_ID || !process.env.BOUNCIE_CLIENT_SECRET) {
    return res.status(500).json({
      error: "BOUNCIE_CLIENT_ID and BOUNCIE_CLIENT_SECRET must be set in Vercel env vars before running this endpoint.",
    });
  }

  try {
    const result = await exchangeAuthCode(sb, code.trim(), redirect_uri.trim());

    return res.status(200).json({
      success:           true,
      message:           "Tokens stored in Supabase. Bouncie sync will start on the next cron run (within 5 minutes).",
      has_access_token:  !!(result.access_token),
      has_refresh_token: !!(result.refresh_token),
      expires_in:        result.expires_in || null,
    });
  } catch (err) {
    console.error("bouncie-auth error:", err);
    // Don't expose token values in error messages
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
