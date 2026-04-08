// api/bouncie-connect.js
// force redeploy check
console.log("bouncie-connect live");
// Initiates the Bouncie OAuth 2.0 authorization flow.
//
// Redirects the browser to the Bouncie authorize URL so the account owner can
// grant access.  After the owner approves, Bouncie redirects back to
// /api/bouncie-callback which exchanges the code for tokens and stores them.
//
// GET /api/bouncie-connect
//
// Required env vars:
//   BOUNCIE_CLIENT_ID   — registered Bouncie application client ID

const BOUNCIE_AUTHORIZE_URL = "https://auth.bouncie.com/oauth/authorize";
const BOUNCIE_REDIRECT_URI  = "https://sly-rides.vercel.app/api/bouncie-callback";

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

  const clientId = process.env.BOUNCIE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send(
      htmlPage(
        "Bouncie Config Error",
        "<h2>⚠️ Server configuration error</h2>" +
        "<p><code>BOUNCIE_CLIENT_ID</code> must be set in your Vercel environment variables " +
        "before the OAuth flow can be initiated.</p>"
      )
    );
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  BOUNCIE_REDIRECT_URI,
    response_type: "code",
  });

  const authorizeUrl = `${BOUNCIE_AUTHORIZE_URL}?${params.toString()}`;
  return res.redirect(302, authorizeUrl);
}
