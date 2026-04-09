// api/bouncieCallback.js
// Handles the Bouncie OAuth 2.0 callback after user authorization.
//
// Exchanges the authorization code for access + refresh tokens and stores
// them in the bouncie_tokens Supabase table (singleton row id=1).
//
// GET /api/bouncieCallback?code=<authorization_code>
//
// Required env vars:
//   BOUNCIE_CLIENT_ID
//   BOUNCIE_CLIENT_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { getSupabaseAdmin } from "./_supabase.js";
import { adminHtmlErrorPage } from "./_error-helpers.js";

export default async function handler(req, res) {
  const code = req.query.code;

  if (!code) return res.status(400).send("Missing code");

  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  const redirectUri  = process.env.BOUNCIE_REDIRECT_URI || "https://sly-rides.vercel.app/api/bouncieCallback";

  let response;
  try {
    response = await fetch("https://auth.bouncie.com/oauth/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  redirectUri,
      }).toString(),
    });
  } catch (fetchErr) {
    return adminHtmlErrorPage(res, 502, "Bouncie Unreachable",
      `Could not reach the Bouncie token endpoint: ${fetchErr.message}`);
  }

  const data = await response.json();

  if (!response.ok) {
    return adminHtmlErrorPage(res, 500, "Bouncie Token Exchange Failed",
      `Bouncie returned an error: ${data.error || response.status} — ${data.error_description || JSON.stringify(data)}`);
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return adminHtmlErrorPage(res, 503, "Database Not Configured",
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in your Vercel environment variables.");
  }

  const { error: upsertError } = await supabase.from("bouncie_tokens").upsert({
    id:            1,
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    obtained_at:   new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  });

  if (upsertError) {
    return adminHtmlErrorPage(res, 500, "Token Storage Failed",
      `Bouncie authorized successfully but the token could not be saved to the database: ${upsertError.message}. Check your Supabase configuration and ensure the bouncie_tokens table exists (run migration 0037).`);
  }

  res.redirect("https://www.slytrans.com/public/admin-v2/?bouncie=connected");
}
