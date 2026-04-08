// api/bouncie-connect.js
// Initiates the Bouncie OAuth 2.0 authorization flow.
//
// GET /api/bouncie-connect
//   Redirects the browser to the Bouncie authorization page.
//
// Required env vars:
//   BOUNCIE_CLIENT_ID

export default function handler(req, res) {
  const clientId     = process.env.BOUNCIE_CLIENT_ID;
  const redirectUri  = "https://sly-rides.vercel.app/api/bouncie-callback";
  const url          = `https://auth.bouncie.com/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(url);
}
