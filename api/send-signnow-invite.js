// api/send-signnow-invite.js
// Vercel serverless function — sends a SignNow e-signature invite for the rental agreement
//
// Authentication — set ONE of the following in Vercel → Settings → Environment Variables:
//
//   Option A — OAuth credentials (RECOMMENDED — never expires):
//     SIGNNOW_CLIENT_ID      — application client ID from SignNow API dashboard
//     SIGNNOW_CLIENT_SECRET  — application client secret from SignNow API dashboard
//     SIGNNOW_EMAIL          — SignNow account email (used as OAuth username)
//     SIGNNOW_PASSWORD       — SignNow account password
//
//   Option B — static access token (will expire after ~30–60 minutes):
//     SIGNNOW_API_TOKEN      — access token copied from SignNow
//
// Required in both cases:
//   SIGNNOW_TEMPLATE_ID  — ID of the rental agreement *template* in SignNow
//                          (previously SIGNNOW_DOCUMENT_ID — both are accepted)
//
// Optional:
//   SIGNNOW_ROLE_NAME    — Role name used in the invite (default: "Signer 1").
//                          Must exactly match the role defined in your SignNow template.
//
// Each booking creates a *fresh copy* of the template so every renter signs
// their own blank document and can never see a previous renter's filled-in data.

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const SIGNNOW_API_BASE = "https://api.signnow.com";

/**
 * Get a SignNow access token.
 *
 * Preferred — if all four OAuth env vars are set (SIGNNOW_CLIENT_ID,
 * SIGNNOW_CLIENT_SECRET, SIGNNOW_EMAIL, SIGNNOW_PASSWORD), authenticates via
 * SignNow's OAuth 2.0 password grant to obtain a fresh short-lived access token
 * on every invocation. This prevents silent failures caused by an expired token.
 *
 * Fallback — uses SIGNNOW_API_TOKEN as a static Bearer token. This works
 * initially but will stop working once the token expires (typically within
 * 30–60 minutes of generation).
 */

/** Returns true when all four OAuth credential env vars are set. */
function hasOAuthConfig() {
  return !!(
    process.env.SIGNNOW_CLIENT_ID &&
    process.env.SIGNNOW_CLIENT_SECRET &&
    process.env.SIGNNOW_EMAIL &&
    process.env.SIGNNOW_PASSWORD
  );
}

async function getAuthToken() {
  if (hasOAuthConfig()) {
    const { SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_EMAIL, SIGNNOW_PASSWORD } = process.env;
    const credentials = Buffer.from(`${SIGNNOW_CLIENT_ID}:${SIGNNOW_CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetch(`${SIGNNOW_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "password",
        username: SIGNNOW_EMAIL,
        password: SIGNNOW_PASSWORD,
        scope: "*",
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("SignNow OAuth token error:", tokenRes.status, errText);
      throw new Error(`SignNow OAuth authentication failed: ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();
    return tokenData.access_token;
  }

  // Static token fallback (may expire)
  return process.env.SIGNNOW_API_TOKEN;
}

function buildInviteMessage(name, car, pickup, returnDate) {
  const greeting = `Hi ${name || "there"}`;
  const vehicle = car || "vehicle";
  const dates = pickup && returnDate ? `${pickup} – ${returnDate}` : pickup || "";
  const rentalPart = dates ? `the ${vehicle} rental (${dates})` : `the ${vehicle} rental`;
  return `${greeting}, your rental agreement for ${rentalPart} is ready. Please sign it at your earliest convenience.`;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Accept SIGNNOW_TEMPLATE_ID (preferred) or SIGNNOW_DOCUMENT_ID (legacy)
  const templateId = process.env.SIGNNOW_TEMPLATE_ID || process.env.SIGNNOW_DOCUMENT_ID;

  if ((!hasOAuthConfig() && !process.env.SIGNNOW_API_TOKEN) || !templateId) {
    console.error(
      "Missing SignNow environment variables. Set either:\n" +
      "  Option A (recommended): SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_EMAIL, SIGNNOW_PASSWORD\n" +
      "  Option B (static token — expires): SIGNNOW_API_TOKEN\n" +
      "And always set: SIGNNOW_TEMPLATE_ID"
    );
    return res.status(500).json({ error: "Server configuration error: SignNow credentials are not set." });
  }

  const { name, email, car, pickup, returnDate } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required to send the signing invite." });
  }

  // Role name must exactly match the role defined in the SignNow template.
  // Override with SIGNNOW_ROLE_NAME if your template uses a different name.
  const roleName = process.env.SIGNNOW_ROLE_NAME || "Signer 1";

  try {
    // Get a fresh access token (via OAuth if credentials are set, else static token)
    const accessToken = await getAuthToken();
    const authHeader = { "Authorization": `Bearer ${accessToken}` };

    // Step 1: Copy the template to create a fresh blank document for this renter.
    // This ensures each renter signs their own private copy and cannot see any
    // previously filled-in data from another renter.
    const docName = `Sly Transportation Services LLC Rental Agreement – ${name || email} – ${pickup || new Date().toISOString().slice(0, 10)}`;
    const copyRes = await fetch(
      `${SIGNNOW_API_BASE}/template/${templateId}/copy`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ document_name: docName }),
      }
    );

    if (!copyRes.ok) {
      const errorText = await copyRes.text();
      console.error("SignNow template copy error:", copyRes.status, errorText);
      return res.status(502).json({ error: "Failed to prepare the rental agreement. Please try again." });
    }

    const copyData = await copyRes.json();
    const newDocId = copyData.id;

    if (!newDocId) {
      console.error("SignNow template copy returned no document id:", copyData);
      return res.status(502).json({ error: "Failed to prepare the rental agreement. Please try again." });
    }

    // Step 2: Send an invite for the newly created blank document.
    const inviteRes = await fetch(
      `${SIGNNOW_API_BASE}/document/${newDocId}/invite`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [{ email, role: roleName, order: 1 }],
          from: process.env.SMTP_USER || "slyservices@supports-info.com",
          cc: [],
          subject: "Please sign your Sly Transportation Services LLC Rental Agreement",
          message: buildInviteMessage(name, car, pickup, returnDate),
        }),
      }
    );

    if (!inviteRes.ok) {
      const errorText = await inviteRes.text();
      console.error(
        `SignNow invite error (role: "${roleName}" — if this is wrong, set SIGNNOW_ROLE_NAME to match your template):`,
        inviteRes.status, errorText
      );
      return res.status(502).json({ error: "Failed to send signing invite. Please try again." });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("SignNow invite error:", err);
    return res.status(500).json({ error: "Failed to send signing invite. Please try again." });
  }
}
