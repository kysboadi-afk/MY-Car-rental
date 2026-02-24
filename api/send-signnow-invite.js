// api/send-signnow-invite.js
// Vercel serverless function — sends a SignNow e-signature invite for the rental agreement
//
// Required environment variables (set in Vercel dashboard):
//   SIGNNOW_API_TOKEN    — API access token from SignNow
//   SIGNNOW_DOCUMENT_ID  — ID of the rental agreement document/template in SignNow

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

  if (!process.env.SIGNNOW_API_TOKEN || !process.env.SIGNNOW_DOCUMENT_ID) {
    console.error("Missing SignNow environment variables (SIGNNOW_API_TOKEN, SIGNNOW_DOCUMENT_ID). Add them in your Vercel project → Settings → Environment Variables.");
    return res.status(500).json({ error: "Server configuration error: SignNow credentials are not set." });
  }

  const { name, email, car, pickup, returnDate } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required to send the signing invite." });
  }

  try {
    const inviteRes = await fetch(
      `${SIGNNOW_API_BASE}/document/${process.env.SIGNNOW_DOCUMENT_ID}/invite`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.SIGNNOW_API_TOKEN}`,
          "Content-Type": "application/json",
        },
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
      console.error("SignNow API error:", inviteRes.status, errorText);
      return res.status(502).json({ error: "Failed to send signing invite. Please try again." });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("SignNow invite error:", err);
    return res.status(500).json({ error: "Failed to send signing invite. Please try again." });
  }
}
