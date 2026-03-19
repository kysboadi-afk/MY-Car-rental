// api/send-application-email.js
// Vercel serverless function — emails the owner a new driver application
// containing the applicant's name, phone, age, driving experience, delivery
// apps, and a copy of their driver's license as an email attachment.
// Evaluates the application against pre-approval rules and sends the
// applicant an SMS (via Twilio) with the appropriate outcome message.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OWNER_EMAIL  — business email that receives all applications
//                  (defaults to slyservices@supports-info.com)
//   TWILIO_ACCOUNT_SID  — Twilio Account SID (optional; SMS skipped if absent)
//   TWILIO_AUTH_TOKEN   — Twilio Auth Token
//   TWILIO_PHONE_NUMBER — Twilio sending phone number (E.164, e.g. +18773155034)
import nodemailer from "nodemailer";
import twilio from "twilio";

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

// ─── Pre-approval logic ───────────────────────────────────────────────────────

/**
 * Evaluate a driver application.
 * @returns {"approved"|"review"|"declined"}
 */
function evaluateApplication({ age, experience, licenseAttached, agreeTerms }) {
  const ageNum = parseInt(age, 10);

  // Hard declines — applicant does not meet minimum requirements
  if (!isNaN(ageNum) && ageNum < 21) return "declined";
  if (experience === "Less than 3 months") return "declined";

  // Needs review — essential information is missing or incomplete
  if (!licenseAttached) return "review";
  if (!agreeTerms) return "review";
  if (isNaN(ageNum) || ageNum < 18) return "review";
  if (!experience) return "review";

  // All checks passed
  return "approved";
}

const SMS_MESSAGES = {
  approved: (firstName) =>
    `\uD83C\uDF89 Congratulations! You\u2019re approved to rent with SLY Transportation.\n\n` +
    `Choose your car and complete your booking here:\n` +
    `\uD83D\uDC49 www.slytrans.com/cars\n\n` +
    `$350/week \u2022 Unlimited miles \uD83D\uDE97\uD83D\uDCA8\n\n` +
    `Start driving today! Reply STOP to opt out.`,

  review: (firstName) =>
    `Hi ${firstName}, thanks for applying with SLY Transportation.\n\n` +
    `Your application is currently under review. Our team will get back to you within 24 hours.\n\n` +
    `Please keep an eye on your messages. Reply STOP to opt out.`,

  declined: (firstName) =>
    `Hi ${firstName}, thank you for your interest in SLY Transportation.\n\n` +
    `Unfortunately, your application does not meet our current rental requirements.\n\n` +
    `If you have any questions, feel free to reply to this message.`,
};

const DECISION_LABELS = {
  approved: "\u2705 Approved",
  review:   "\u26A0\uFE0F Needs Review",
  declined: "\u274C Declined",
};

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

  const {
    name, phone, email, age, experience, apps, agreeTerms,
    licenseFileName, licenseMimeType, licenseBase64,
  } = req.body || {};

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

  // ─── Pre-approval decision ──────────────────────────────────────────────────
  const decision = evaluateApplication({
    age,
    experience,
    licenseAttached: hasLicense,
    agreeTerms: !!agreeTerms,
  });

  const firstName = (name || "").split(" ")[0] || "there";
  const appsLabel = Array.isArray(apps) && apps.length ? apps.join(", ") : "Not specified";

  try {
    // ─── Owner notification email ─────────────────────────────────────────────
    await transporter.sendMail({
      from: `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `🆕 New Driver Application – ${esc(name)} [${DECISION_LABELS[decision]}]`,
      text: [
        "New Driver Application – Sly Transportation Services LLC",
        "",
        `Name              : ${name}`,
        `Phone             : ${phone}`,
        `Email             : ${email || "Not provided"}`,
        `Age               : ${age ?? "Not provided"}`,
        `Driving Experience: ${experience}`,
        `Delivery Apps     : ${appsLabel}`,
        `Terms Agreed      : ${agreeTerms ? "Yes" : "No"}`,
        `License Attached  : ${hasLicense ? licenseFileName : "No"}`,
        `Decision          : ${DECISION_LABELS[decision]}`,
      ].join("\n"),
      html: `
        <h2>&#x1F195; New Driver Application</h2>
        <p>A new applicant has submitted their information on the Sly Transportation Services LLC website.</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Age</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(age ?? "Not provided"))}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driving Experience</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(experience)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Delivery Apps</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(appsLabel)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Terms Agreed</strong></td><td style="padding:8px;border:1px solid #ddd">${agreeTerms ? "Yes" : "No"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driver's License</strong></td><td style="padding:8px;border:1px solid #ddd">${hasLicense ? `<em>See attached: ${esc(licenseFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Decision</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">${esc(DECISION_LABELS[decision])}</td></tr>
        </table>
        ${hasLicense ? "<p style=\"margin-top:12px\">The applicant&#39;s driver&#39;s license is attached to this email.</p>" : ""}
      `,
      attachments,
    });

    // ─── Applicant SMS ────────────────────────────────────────────────────────
    if (
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
    ) {
      try {
        const client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );
        await client.messages.create({
          body: SMS_MESSAGES[decision](firstName),
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        });
      } catch (smsErr) {
        // SMS failure is non-fatal — log it but don't fail the whole request
        console.error("Application SMS send failed:", smsErr);
      }
    }

    return res.status(200).json({ success: true, decision });
  } catch (err) {
    console.error("Application email failed:", err);
    return res.status(500).json({ error: "Failed to send application email." });
  }
}
