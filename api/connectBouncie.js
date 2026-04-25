// api/connectBouncie.js
// Initiates the Bouncie OAuth 2.0 authorization flow.
//
// GET /api/connectBouncie
//   Redirects the browser to the Bouncie authorization page.
//
// Required env vars:
//   BOUNCIE_CLIENT_ID

import { adminHtmlErrorPage } from "./_error-helpers.js";

export default function handler(req, res) {
  const clientId = process.env.BOUNCIE_CLIENT_ID;

  if (!clientId) {
    return adminHtmlErrorPage(
      res,
      503,
      "Bouncie Not Configured",
      "The BOUNCIE_CLIENT_ID environment variable is not set in Vercel. " +
      "Add it in the Vercel dashboard under Settings → Environment Variables, then redeploy."
    );
  }

  const redirectUri = process.env.BOUNCIE_REDIRECT_URI || "https://sly-rides.vercel.app/api/bouncie-callback";
  const url = `https://auth.bouncie.com/dialog/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(url);
}
