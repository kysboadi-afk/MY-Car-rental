// api/send-contact-email.js
// Vercel serverless function — sends a contact-form submission to the owner
// and an auto-reply confirmation to the submitter.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OWNER_EMAIL  — business email that receives all contact submissions
//                  (defaults to slyservices@supports-info.com)
import nodemailer from "nodemailer";

const OWNER_EMAIL   = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const BUSINESS_PHONE = "(844) 511-4059";
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

// Generate a human-readable unique submission reference (e.g. SLY-1712345678901-A3F2)
function generateSubmissionId() {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SLY-${Date.now()}-${rand}`;
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

  const { name, email, phone, message, honeypot } = req.body || {};

  // Honeypot check — real users leave this blank; bots typically fill it in.
  // Reject silently without revealing which field triggered the block.
  if (honeypot) {
    return res.status(400).json({ error: "Submission rejected." });
  }

  if (!name || !email || !phone || !message) {
    return res.status(400).json({ error: "Missing required fields: name, email, phone, message." });
  }

  const submissionId = generateSubmissionId();

  // ── Owner notification ────────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from: `"Sly Transportation Services LLC Contact" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `📬 New Contact Form Submission – ${name} [#${submissionId}]`,
      replyTo: email,
      text: [
        "New Contact Form Submission – Sly Transportation Services LLC",
        "",
        "Someone has submitted the contact form on the website.",
        "",
        `Submission ID : ${submissionId}`,
        `Name          : ${name}`,
        `Email         : ${email}`,
        `Phone         : ${phone}`,
        `Message       : ${message}`,
      ].join("\n"),
      html: `
        <h2>📬 New Contact Form Submission</h2>
        <p>Someone has submitted the contact form on the Sly Transportation Services LLC website.</p>
        <table style="border-collapse:collapse;width:100%;max-width:560px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Submission ID</strong></td><td style="padding:8px;border:1px solid #ddd;font-family:monospace">${esc(submissionId)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;vertical-align:top"><strong>Message</strong></td><td style="padding:8px;border:1px solid #ddd;white-space:pre-wrap">${esc(message)}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666">Reply directly to this email to respond to the sender.</p>
      `,
    });
  } catch (err) {
    console.error("Contact email failed:", err);
    return res.status(500).json({ error: "Failed to send contact notification email." });
  }

  // ── Auto-reply to submitter ───────────────────────────────────────────────
  // Non-fatal: the owner already has the message so the submission is not lost.
  // Response time commitment: 5–15 minutes (business SLA — update if this changes).
  try {
    await transporter.sendMail({
      from: `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `✅ We received your message! [#${submissionId}]`,
      text: [
        `Hi ${name},`,
        "",
        "Thank you for reaching out to Sly Transportation Services LLC!",
        "We have received your message and will get back to you within 5–15 minutes.",
        "",
        `Your submission reference number is: ${submissionId}`,
        "Please keep this number handy in case you need to follow up.",
        "",
        `If you need immediate assistance, call us at ${BUSINESS_PHONE}.`,
        "",
        "– Sly Transportation Services LLC",
        "1200 S Figueroa St, Los Angeles, CA 90015",
      ].join("\n"),
      html: `
        <div style="font-family:sans-serif;max-width:520px">
          <h2 style="color:#ffb400">✅ Message Received!</h2>
          <p>Hi ${esc(name)},</p>
          <p>Thank you for reaching out to <strong>Sly Transportation Services LLC</strong>! We have received your message and will get back to you within <strong>5–15 minutes</strong>.</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Submission #</strong></td><td style="padding:8px;border:1px solid #ddd;font-family:monospace;color:#555">${esc(submissionId)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Expected Reply</strong></td><td style="padding:8px;border:1px solid #ddd">5–15 minutes</td></tr>
          </table>
          <p>If you need immediate assistance, please call us directly:</p>
          <p style="font-size:20px;font-weight:700"><a href="tel:+18445114059" style="color:#ffb400;text-decoration:none">${BUSINESS_PHONE}</a></p>
          <hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
          <p style="font-size:12px;color:#888">– Sly Transportation Services LLC · 1200 S Figueroa St, Los Angeles, CA 90015</p>
        </div>
      `,
    });
  } catch (autoReplyErr) {
    console.error("Contact auto-reply failed:", autoReplyErr);
    // Non-fatal — owner notification was sent successfully above.
  }

  return res.status(200).json({ success: true, submissionId });
}
