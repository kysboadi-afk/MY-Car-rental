// api/contact-info.js
// Vercel serverless function — returns public contact details for the frontend.
//
// GET /api/contact-info
//   Returns the owner's contact email (from OWNER_EMAIL env var) and phone
//   number so that static GitHub Pages files (success.html, chatbot.js) can
//   display the correct, dynamically-configured contact address.
//   No sensitive data is exposed — only the public contact email that is
//   already shown in emails sent to renters.

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const CONTACT_PHONE = process.env.CONTACT_PHONE || "+1 213-916-6606";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache for 5 minutes — the value only changes on a full Vercel redeploy
  res.setHeader("Cache-Control", "public, max-age=300");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  return res.status(200).json({ email: OWNER_EMAIL, phone: CONTACT_PHONE });
}
