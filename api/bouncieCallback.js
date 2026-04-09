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

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const code = req.query.code;

  if (!code) return res.status(400).send("Missing code");

  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  const redirectUri  = process.env.BOUNCIE_REDIRECT_URI || "https://sly-rides.vercel.app/api/bouncieCallback";

  const response = await fetch("https://auth.bouncie.com/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    "authorization_code",
      code,
      redirect_uri:  redirectUri,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(500).json(data);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  await supabase.from("bouncie_tokens").upsert({
    id:            1,
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    obtained_at:   new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  });

  res.redirect("https://www.slytrans.com/public/admin-v2/?bouncie=connected");
}
