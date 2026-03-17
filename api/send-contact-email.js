// api/send-contact-email.js
// Vercel serverless function — sends a contact-form submission to the owner.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OWNER_EMAIL  — business email that receives all contact submissions
//                  (defaults to slyservices@supports-info.com)
import nodemailer from "nodemailer";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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

  const { name, email, phone, message } = req.body || {};

  if (!name || !email || !phone || !message) {
    return res.status(400).json({ error: "Missing required fields: name, email, phone, message." });
  }

  try {
    await transporter.sendMail({
      from: `"Sly Transportation Services LLC Contact" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `📬 New Contact Form Submission – ${name}`,
      replyTo: email,
      text: [
        "New Contact Form Submission – Sly Transportation Services LLC",
        "",
        "Someone has submitted the contact form on the website.",
        "",
        `Name    : ${name}`,
        `Email   : ${email}`,
        `Phone   : ${phone}`,
        `Message : ${message}`,
      ].join("\n"),
      html: `
        <h2>📬 New Contact Form Submission</h2>
        <p>Someone has submitted the contact form on the Sly Transportation Services LLC website.</p>
        <table style="border-collapse:collapse;width:100%;max-width:560px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;vertical-align:top"><strong>Message</strong></td><td style="padding:8px;border:1px solid #ddd;white-space:pre-wrap">${esc(message)}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666">Reply directly to this email to respond to the sender.</p>
      `,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Contact email failed:", err);
    return res.status(500).json({ error: "Failed to send contact notification email." });
  }
}
