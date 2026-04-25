// api/bouncie-start.js
// Validates the admin secret and Bouncie credentials, then redirects to the
// Bouncie OAuth connect flow.  Returns a human-readable error page instead of
// silently forwarding to a broken OAuth URL when env vars are missing.

import { isAdminAuthorized } from "./_admin-auth.js";
import { adminHtmlErrorPage } from "./_error-helpers.js";

export default function handler(req, res) {
  const secret = req.query?.secret;
  if (!isAdminAuthorized(secret)) {
    return adminHtmlErrorPage(res, 401, "Unauthorized", "Invalid or missing admin secret.");
  }

  if (!process.env.BOUNCIE_CLIENT_ID) {
    return adminHtmlErrorPage(
      res,
      503,
      "Bouncie Not Configured",
      "The BOUNCIE_CLIENT_ID environment variable is not set in Vercel. " +
      "Add it in the Vercel dashboard under Settings → Environment Variables, then redeploy."
    );
  }

  res.redirect("/api/connectBouncie");
}
