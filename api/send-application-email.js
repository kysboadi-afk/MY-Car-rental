// api/send-application-email.js
// Vercel serverless function — emails the owner a new driver application
// containing the applicant's name, phone, driving experience, and a copy of
// their driver's license as an email attachment.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OWNER_EMAIL  — business email that receives all applications
//                  (defaults to slyservices@supports-info.com)
import nodemailer from "nodemailer";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
// ~10 MB decoded — guard against oversized payloads
const MAX_LICENSE_B64_LEN = 14_000_000;

// Escape special HTML characters to prevent XSS in email templates
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_PORT === "465",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("Missing SMTP environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS).");
    return res.status(500).json({ error: "Server configuration error: SMTP credentials are not set." });
  }

  const { name, phone, experience, licenseFileName, licenseMimeType, licenseBase64 } =
    req.body || {};

  if (!name || !phone || !experience) {
    return res
      .status(400)
      .json({ error: "Missing required fields: name, phone, experience." });
  }

  // Build attachment if a license image/PDF was provided
  const attachments = [];
  if (licenseBase64 && licenseFileName && licenseMimeType) {
    if (licenseBase64.length > MAX_LICENSE_B64_LEN) {
      return res.status(400).json({ error: "License file is too large." });
    }
    attachments.push({
      filename: licenseFileName,
      content: Buffer.from(licenseBase64, "base64"),
      contentType: licenseMimeType,
    });
  }

  const hasLicense = attachments.length > 0;

  try {
    await transporter.sendMail({
      from: `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `🆕 New Driver Application – ${esc(name)}`,
      text: [
        "New Driver Application – Sly Transportation Services LLC",
        "",
        `Name              : ${name}`,
        `Phone             : ${phone}`,
        `Driving Experience: ${experience}`,
        `License Attached  : ${hasLicense ? licenseFileName : "No"}`,
      ].join("\n"),
      html: `
        <h2>&#x1F195; New Driver Application</h2>
        <p>A new applicant has submitted their information on the Sly Transportation Services LLC website.</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driving Experience</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(experience)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driver's License</strong></td><td style="padding:8px;border:1px solid #ddd">${hasLicense ? `<em>See attached: ${esc(licenseFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
        </table>
        ${hasLicense ? "<p style=\"margin-top:12px\">The applicant&#39;s driver&#39;s license is attached to this email.</p>" : ""}
      `,
      attachments,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Application email failed:", err);
    return res.status(500).json({ error: "Failed to send application email." });
  }
}
