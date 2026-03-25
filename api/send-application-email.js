// api/send-application-email.js
// Vercel serverless function — emails the owner a new driver application
// containing the applicant's name, phone, age, driving experience, delivery
// apps, and a copy of their driver's license as an email attachment.
// Evaluates the application against pre-approval rules and sends the
// applicant both an email and an SMS (via TextMagic) with the appropriate outcome.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST          — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT          — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER          — sending email address
//   SMTP_PASS          — email password or app password
//   OWNER_EMAIL        — business email that receives all applications
//                        (defaults to slyservices@supports-info.com)
//   TEXTMAGIC_USERNAME — TextMagic account username (optional; SMS skipped if absent)
//   TEXTMAGIC_API_KEY  — TextMagic API key
import nodemailer from "nodemailer";
import { sendSms } from "./_textmagic.js";
import { render, APPLICATION_RECEIVED, APPLICATION_APPROVED, APPLICATION_DENIED } from "./_sms-templates.js";
import { normalizePhone } from "./_bookings.js";
import { upsertContact } from "./_contacts.js";

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

// SMS templates are defined in _sms-templates.js.
// approved  → APPLICATION_APPROVED  (with waitlist_link)
// review    → APPLICATION_RECEIVED already sent; no second SMS at this stage
// declined  → APPLICATION_DENIED

const EMAIL_SUBJECTS = {
  approved: `\u2705 You\u2019re Approved! \u2014 SLY Transportation Services`,
  review:   `\u23F3 Application Under Review \u2014 SLY Transportation Services`,
  declined: `Application Update \u2014 SLY Transportation Services`,
};

function buildApplicantEmailHtml(decision, firstName) {
  if (decision === "approved") {
    return `
      <h2>&#x1F389; Congratulations, ${esc(firstName)}!</h2>
      <p>Your application to rent with <strong>Sly Transportation Services LLC</strong> has been reviewed and you are <strong>approved</strong>!</p>
      <p style="background:#d4edda;padding:10px;border-left:4px solid #28a745;margin-bottom:16px">
        <strong>&#x2705; Status: Approved</strong> &mdash; You are cleared to book a vehicle.
      </p>
      <h3 style="color:#333">Next steps:</h3>
      <ul>
        <li>Visit <a href="https://www.slytrans.com/cars">www.slytrans.com/cars</a> to browse available vehicles.</li>
        <li>Select your preferred car and complete your booking online.</li>
        <li>Our team will reach out if we need anything else before your rental begins.</li>
      </ul>
      <p>Questions? Call us at <strong>(213) 916-6606</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
      <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
    `;
  }
  if (decision === "review") {
    return `
      <h2>&#x23F3; Application Under Review</h2>
      <p>Hi <strong>${esc(firstName)}</strong>,</p>
      <p>Thank you for applying with <strong>Sly Transportation Services LLC</strong>! We have received your application and it is currently under review.</p>
      <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
        <strong>&#x26A0;&#xFE0F; Status: Under Review</strong> &mdash; Our team will get back to you within <strong>24 hours</strong>.
      </p>
      <p>Please keep an eye on your email and phone for updates from us.</p>
      <p>Questions? Call us at <strong>(213) 916-6606</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
      <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
    `;
  }
  // declined
  return `
    <h2>Application Update</h2>
    <p>Hi <strong>${esc(firstName)}</strong>,</p>
    <p>Thank you for your interest in renting with <strong>Sly Transportation Services LLC</strong>.</p>
    <p>After reviewing your application, we are unable to approve your request at this time as it does not meet our current rental requirements.</p>
    <p>If you have questions or believe this was an error, please contact us at <strong>(213) 916-6606</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
    <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
  `;
}

function buildApplicantEmailText(decision, firstName) {
  if (decision === "approved") {
    return [
      `Congratulations, ${firstName}!`,
      "",
      "Your application to rent with Sly Transportation Services LLC has been reviewed and you are APPROVED!",
      "",
      "Next steps:",
      "• Visit www.slytrans.com/cars to browse available vehicles.",
      "• Select your preferred car and complete your booking online.",
      "• Our team will reach out if we need anything else before your rental begins.",
      "",
      `Questions? Call us at (213) 916-6606 or email ${OWNER_EMAIL}.`,
      "",
      "— Sly Transportation Services LLC Team",
    ].join("\n");
  }
  if (decision === "review") {
    return [
      `Hi ${firstName},`,
      "",
      "Thank you for applying with Sly Transportation Services LLC! We have received your application and it is currently under review.",
      "",
      "Our team will get back to you within 24 hours. Please keep an eye on your email and phone for updates.",
      "",
      `Questions? Call us at (213) 916-6606 or email ${OWNER_EMAIL}.`,
      "",
      "— Sly Transportation Services LLC Team",
    ].join("\n");
  }
  // declined
  return [
    `Hi ${firstName},`,
    "",
    "Thank you for your interest in renting with Sly Transportation Services LLC.",
    "After reviewing your application, we are unable to approve your request at this time as it does not meet our current rental requirements.",
    "",
    `If you have questions, please contact us at (213) 916-6606 or email ${OWNER_EMAIL}.`,
    "",
    "— Sly Transportation Services LLC Team",
  ].join("\n");
}

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
    hasInsurance, insuranceBase64, insuranceFileName, insuranceMimeType,
    protectionPlanPref,
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

  // Attach insurance proof if provided
  if (insuranceBase64 && insuranceFileName && insuranceMimeType) {
    if (insuranceBase64.length > MAX_LICENSE_B64_LEN) {
      return res.status(400).json({ error: "Insurance file is too large." });
    }
    attachments.push({
      filename: insuranceFileName,
      content: Buffer.from(insuranceBase64, "base64"),
      contentType: insuranceMimeType,
    });
  }

  const hasLicense = attachments.length > 0;

  // ─── Pre-approval decision ──────────────────────────────────────────────────
  const decision = evaluateApplication({
    age, experience, licenseAttached: hasLicense, agreeTerms: !!agreeTerms,
  });

  const firstName = (name || "").split(" ")[0] || "there";
  const appsLabel = Array.isArray(apps) && apps.length ? apps.join(", ") : "Not specified";

  const PLAN_LABELS = { basic: "Basic Protection", standard: "Standard Protection", premium: "Premium Protection", none: "Declined" };
  const planLabel = PLAN_LABELS[protectionPlanPref] || (protectionPlanPref ? esc(String(protectionPlanPref)) : "Not specified");
  const insuranceLabel = hasInsurance === "yes" ? "Yes" : hasInsurance === "no" ? "No" : "Not specified";
  const hasInsuranceProof = !!(insuranceBase64 && insuranceFileName && insuranceMimeType);

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
        `Has Insurance     : ${insuranceLabel}`,
        `Insurance Proof   : ${hasInsuranceProof ? insuranceFileName : "Not uploaded"}`,
        `Protection Plan   : ${planLabel}`,
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
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Has Insurance</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(insuranceLabel)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Proof</strong></td><td style="padding:8px;border:1px solid #ddd">${hasInsuranceProof ? `<em>See attached: ${esc(insuranceFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Protection Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(planLabel)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Terms Agreed</strong></td><td style="padding:8px;border:1px solid #ddd">${agreeTerms ? "Yes" : "No"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driver's License</strong></td><td style="padding:8px;border:1px solid #ddd">${hasLicense ? `<em>See attached: ${esc(licenseFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Decision</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">${esc(DECISION_LABELS[decision])}</td></tr>
        </table>
        ${hasLicense ? "<p style=\"margin-top:12px\">The applicant&#39;s driver&#39;s license is attached to this email.</p>" : ""}
        ${hasInsuranceProof ? "<p style=\"margin-top:4px\">The applicant&#39;s proof of insurance is attached to this email.</p>" : ""}
      `,
      attachments,
    });

    // ─── Applicant email ──────────────────────────────────────────────────────
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      try {
        await transporter.sendMail({
          from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
          to:      email,
          subject: EMAIL_SUBJECTS[decision],
          text:    buildApplicantEmailText(decision, firstName),
          html:    buildApplicantEmailHtml(decision, firstName),
        });
      } catch (applicantEmailErr) {
        // Applicant email failure is non-fatal — log it but don't fail the request
        console.error("Applicant decision email failed:", applicantEmailErr);
      }
    }

    // ─── Applicant SMS ────────────────────────────────────────────────────────
    if (
      process.env.TEXTMAGIC_USERNAME &&
      process.env.TEXTMAGIC_API_KEY
    ) {
      const normalizedPhone = normalizePhone(phone);
      try {
        // Send a single decision SMS: approved, declined, or review (received).
        if (decision === "approved") {
          await sendSms(normalizedPhone, render(APPLICATION_APPROVED, {
            customer_name: firstName,
            vehicle:       "",
            waitlist_link: "https://www.slytrans.com/cars",
          }));
        } else if (decision === "declined") {
          await sendSms(normalizedPhone, render(APPLICATION_DENIED, { customer_name: firstName }));
        } else {
          // "review" → application received / under review acknowledgment
          await sendSms(normalizedPhone, render(APPLICATION_RECEIVED, { customer_name: firstName }));
        }
      } catch (smsErr) {
        // SMS failure is non-fatal — log it but don't fail the whole request
        console.error(`Application SMS send failed for ${normalizedPhone}:`, smsErr);
      }
    }

    // ─── TextMagic contact upsert ─────────────────────────────────────────────
    if (phone) {
      try {
        const addTags = decision === "approved"
          ? ["application", "approved"]
          : ["application"];
        await upsertContact(normalizePhone(phone), name || "", { addTags });
      } catch (contactErr) {
        console.error("TextMagic contact upsert failed:", contactErr);
      }
    }

    return res.status(200).json({ success: true, decision });
  } catch (err) {
    console.error("Application email failed:", err);
    return res.status(500).json({ error: "Failed to send application email." });
  }
}
