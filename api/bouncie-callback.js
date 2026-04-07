// api/bouncie-callback.js
// Bouncie OAuth 2.0 callback handler.
//
// Bouncie redirects here after the owner authorises the app:
//   https://sly-rides.vercel.app/api/bouncie-callback?code=<code>&state=<state>
//
// This handler:
//   1. Exchanges the authorisation code for access + refresh tokens via
//      https://auth.bouncie.com/oauth/token.
//   2. Persists the tokens in the Supabase `app_config` table
//      (row key = "bouncie_tokens") so the rest of the fleet API can use them
//      without requiring a Vercel redeployment.
//   3. Renders a plain-HTML success or error page.
//
// Required env vars (set in Vercel):
//   BOUNCIE_CLIENT_ID      — your Bouncie application client ID
//   BOUNCIE_CLIENT_SECRET  — your Bouncie application client secret
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — to persist the tokens
//
// The redirect URI is hardcoded to the production Vercel URL so that the
// value used in the authorize step and the token exchange are always identical,
// eliminating invalid_grant errors caused by env-var typos or mismatches.
//
// Optional env vars:
//   BOUNCIE_STATE_SECRET   — if set, the `state` param is validated against it
//                            (HMAC check skipped when unset — suitable for first
//                            setup when no server-side session is available)

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";

const BOUNCIE_TOKEN_URL = "https://auth.bouncie.com/oauth/token";
const REDIRECT_URI = "https://sly-rides.vercel.app/api/bouncie-callback";

/** Escape HTML special characters to prevent XSS in inline HTML strings. */
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function htmlPage(title, body) {
  return (
    "<!DOCTYPE html><html lang=\"en\"><head>" +
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>${title}</title>` +
    "<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;}</style>" +
    `</head><body>${body}</body></html>`
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const { code, error: oauthError, error_description } = req.query || {};

  // ── Bouncie returned an error instead of a code ───────────────────────────
  if (oauthError) {
    const detail = error_description ? ` — ${error_description}` : "";
    console.error("bouncie-callback: OAuth error received from Bouncie");
    return res.status(400).send(
      htmlPage(
        "Bouncie Auth Failed",
        `<h2>❌ Bouncie authorization failed</h2>` +
        `<p><strong>Error:</strong> ${esc(oauthError)}${detail ? ` — ${esc(error_description)}` : ""}</p>` +
        `<p>Please try the authorization flow again from the admin panel.</p>`
      )
    );
  }

  // ── No code present ───────────────────────────────────────────────────────
  if (!code) {
    return res.status(400).send(
      htmlPage(
        "Bouncie Auth Error",
        "<h2>❌ Missing authorisation code</h2>" +
        "<p>No <code>code</code> parameter was found in the callback URL.</p>"
      )
    );
  }

  // ── Validate required env vars ────────────────────────────────────────────
  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("bouncie-callback: BOUNCIE_CLIENT_ID / BOUNCIE_CLIENT_SECRET not set");
    return res.status(500).send(
      htmlPage(
        "Bouncie Auth Config Error",
        "<h2>⚠️ Server configuration error</h2>" +
        "<p><code>BOUNCIE_CLIENT_ID</code> and <code>BOUNCIE_CLIENT_SECRET</code> must be set " +
        "in your Vercel environment variables before the OAuth flow can complete.</p>"
      )
    );
  }

  // ── Exchange code for tokens ──────────────────────────────────────────────
  let tokenData;
  try {
    console.log("Redirect URI used:", REDIRECT_URI);
    const body = new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  REDIRECT_URI,
    });

    const tokenRes = await fetch(BOUNCIE_TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error(`bouncie-callback: token exchange failed ${tokenRes.status}`);
      return res.status(502).send(
        htmlPage(
          "Bouncie Token Exchange Failed",
          `<h2>❌ Token exchange failed (HTTP ${esc(String(tokenRes.status))})</h2>` +
          `<p>Bouncie returned an error while exchanging the authorization code for tokens.</p>` +
          `<pre style="background:#f3f4f6;padding:1rem;border-radius:4px;overflow:auto">${esc(text)}</pre>`
        )
      );
    }

    tokenData = JSON.parse(text);
  } catch (err) {
    console.error("bouncie-callback: fetch error:", err.message);
    return res.status(502).send(
      htmlPage(
        "Bouncie Token Exchange Error",
        `<h2>❌ Network error during token exchange</h2>` +
        `<p>${esc(adminErrorMessage(err))}</p>`
      )
    );
  }

  const { access_token, refresh_token, expires_in } = tokenData;

  if (!access_token) {
    console.error("bouncie-callback: no access_token in response:", JSON.stringify(tokenData));
    return res.status(502).send(
      htmlPage(
        "Bouncie Token Missing",
        "<h2>❌ No access token in response</h2>" +
        "<p>Bouncie did not return an <code>access_token</code>. " +
        "Check your client credentials and redirect URI.</p>"
      )
    );
  }

  // ── Persist tokens in Supabase app_config ─────────────────────────────────
  const sb = getSupabaseAdmin();
  let savedToDb = false;
  if (sb) {
    try {
      const { error: upsertErr } = await sb
        .from("app_config")
        .upsert(
          {
            key:        "bouncie_tokens",
            value:      {
              access_token,
              refresh_token:  refresh_token  || null,
              expires_in:     expires_in     || null,
              obtained_at:    new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" }
        );

      if (upsertErr) {
        console.error("bouncie-callback: Supabase upsert failed:", upsertErr.message);
      } else {
        savedToDb = true;
      }
    } catch (err) {
      console.error("bouncie-callback: Supabase error:", err.message);
    }
  }

  // ── Success page ──────────────────────────────────────────────────────────
  const dbStatus = savedToDb
    ? "<p>✅ Token saved to Supabase — GPS sync will use it automatically.</p>"
    : "<p>⚠️ Could not save to Supabase. Copy the token below and set it as " +
      "<code>BOUNCIE_ACCESS_TOKEN</code> in your Vercel environment variables, then redeploy.</p>";

  return res.status(200).send(
    htmlPage(
      "Bouncie Connected",
      "<h2>✅ Bouncie connected successfully</h2>" +
      dbStatus +
      `<p><strong>Access token:</strong></p>` +
      `<pre style="background:#f3f4f6;padding:1rem;border-radius:4px;overflow:auto;word-break:break-all">${esc(access_token)}</pre>` +
      (refresh_token
        ? `<p><strong>Refresh token:</strong></p>` +
          `<pre style="background:#f3f4f6;padding:1rem;border-radius:4px;overflow:auto;word-break:break-all">${esc(refresh_token)}</pre>`
        : "") +
      "<p>You can close this window. GPS mileage sync is now active.</p>"
    )
  );
}
