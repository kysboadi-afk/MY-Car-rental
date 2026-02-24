// api/send-signnow-invite.js
// Vercel serverless function — sends a SignNow e-signature invite for the rental agreement
//
// Required environment variables (set in Vercel dashboard):
//   SIGNNOW_API_TOKEN    — API access token from SignNow
//   SIGNNOW_TEMPLATE_ID  — ID of the rental agreement *template* in SignNow
//                          (previously SIGNNOW_DOCUMENT_ID — both are accepted)
//
// Each booking creates a *fresh copy* of the template so every renter signs
// their own blank document and can never see a previous renter's filled-in data.

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const SIGNNOW_API_BASE = "https://api.signnow.com";

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

  if (!process.env.SIGNNOW_API_TOKEN || !templateId) {
    console.error("Missing SignNow environment variables (SIGNNOW_API_TOKEN, SIGNNOW_TEMPLATE_ID). Add them in your Vercel project → Settings → Environment Variables.");
    return res.status(500).json({ error: "Server configuration error: SignNow credentials are not set." });
  }

  const { name, email, car, pickup, returnDate } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required to send the signing invite." });
  }

  const authHeader = { "Authorization": `Bearer ${process.env.SIGNNOW_API_TOKEN}` };

  try {
    // Step 1: Copy the template to create a fresh blank document for this renter.
    // This ensures each renter signs their own private copy and cannot see any
    // previously filled-in data from another renter.
    const docName = `SLY Rides Rental Agreement – ${name || email} – ${pickup || new Date().toISOString().slice(0, 10)}`;
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
          to: [{ email, role: "Signer 1", order: 1 }],
          from: process.env.SMTP_USER || "slyservices@supports-info.com",
          cc: [],
          subject: "Please sign your SLY Rides Rental Agreement",
          message: buildInviteMessage(name, car, pickup, returnDate),
        }),
      }
    );

    if (!inviteRes.ok) {
      const errorText = await inviteRes.text();
      console.error("SignNow invite error:", inviteRes.status, errorText);
      return res.status(502).json({ error: "Failed to send signing invite. Please try again." });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("SignNow invite error:", err);
    return res.status(500).json({ error: "Failed to send signing invite. Please try again." });
  }
}
