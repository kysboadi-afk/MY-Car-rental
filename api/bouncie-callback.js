// api/bouncie-callback.js
// Stub — OAuth authentication has been replaced by API key authentication.
//
// Bouncie GPS sync now uses the BOUNCIE_API_KEY environment variable
// (set in the Vercel dashboard) with the api.bouncie.dev/v1 API.
// No OAuth flow or token exchange is required.

export default function handler(req, res) {
  return res.status(200).send(
    "<!DOCTYPE html><html lang=\"en\"><head>" +
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Bouncie</title>" +
    "<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem;}</style>" +
    "</head><body>" +
    "<h2>ℹ️ Bouncie — API Key Authentication</h2>" +
    "<p>Bouncie GPS sync uses API key authentication. " +
    "Set the <code>BOUNCIE_API_KEY</code> environment variable in your Vercel dashboard to enable mileage sync.</p>" +
    "</body></html>"
  );
}
