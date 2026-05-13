import nodemailer from "nodemailer";
import { sendSms } from "./_textmagic.js";
import {
  render,
  APPLICATION_RECEIVED,
  APPLICATION_REQUIRES_INPUT,
  APPLICATION_UNDER_REVIEW,
  APPLICATION_IDENTITY_FAILED,
  APPLICATION_IDENTITY_CANCELED,
  APPLICATION_APPROVED,
  APPLICATION_DENIED,
  APPLICATION_NEEDS_INFO,
} from "./_sms-templates.js";
import { normalizePhone } from "./_bookings.js";
import { buildResumeUrl } from "./_identity-resume-token.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveFieldAcrossConventions(application, camelKey, snakeKey, fallback = null) {
  if (application && application[camelKey] != null) return application[camelKey];
  if (application && application[snakeKey] != null) return application[snakeKey];
  return fallback;
}

function getFirstName(name) {
  return (String(name || "").trim().split(/\s+/)[0] || "there");
}

function isValidEmail(email) {
  return !!(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)));
}

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function getContext(application = {}) {
  const name = resolveFieldAcrossConventions(application, "name", "name", "");
  const phone = resolveFieldAcrossConventions(application, "phone", "phone", "");
  const email = resolveFieldAcrossConventions(application, "email", "email", "");
  const age = resolveFieldAcrossConventions(application, "age", "age");
  const experience = resolveFieldAcrossConventions(application, "experience", "experience", "");
  const apps = resolveFieldAcrossConventions(application, "apps", "apps", []);
  const hasInsurance = resolveFieldAcrossConventions(application, "hasInsurance", "has_insurance");
  const protectionPlanPref = resolveFieldAcrossConventions(application, "protectionPlanPref", "protection_plan_pref");
  const licenseFileName = resolveFieldAcrossConventions(application, "licenseFileName", "license_file_name");
  const insuranceFileName = resolveFieldAcrossConventions(application, "insuranceFileName", "insurance_file_name");
  const agreeTerms = !!resolveFieldAcrossConventions(application, "agreeTerms", "agree_terms");
  const precheckDecision = resolveFieldAcrossConventions(
    application,
    "precheckDecision",
    "precheck_decision",
    resolveFieldAcrossConventions(application, "decision", "decision")
  );
  const applicationStatus = resolveFieldAcrossConventions(application, "applicationStatus", "application_status");
  const identityStatus = resolveFieldAcrossConventions(application, "identityStatus", "identity_status");
  const applicationId = resolveFieldAcrossConventions(application, "applicationId", "id");
  const hasLicenseUpload = !!resolveFieldAcrossConventions(application, "hasLicenseUpload", "has_license_upload", licenseFileName);
  const hasInsuranceProof = !!resolveFieldAcrossConventions(application, "hasInsuranceProof", "has_insurance_proof", insuranceFileName);
  const appsLabel = Array.isArray(apps) && apps.length ? apps.join(", ") : "Not specified";
  const insuranceLabel = hasInsurance === "yes" ? "Yes" : hasInsurance === "no" ? "No" : "Not specified";
  const planLabels = {
    basic: "Basic Protection",
    standard: "Standard Protection",
    premium: "Premium Protection",
    none: "Declined",
  };
  const precheckLabels = {
    approved: "Approved",
    review: "Needs Review",
    declined: "Declined",
  };

  let verificationLink = null;
  if (applicationId) {
    try { verificationLink = buildResumeUrl(applicationId); } catch (urlErr) {
      console.warn("[_application-notifications.js] buildResumeUrl failed (verification link will be omitted from notification):", urlErr.message || urlErr);
    }
  }

  return {
    applicationId,
    name,
    firstName: getFirstName(name),
    phone,
    email,
    age,
    experience,
    appsLabel,
    hasInsuranceLabel: insuranceLabel,
    planLabel: planLabels[protectionPlanPref] || (protectionPlanPref ? String(protectionPlanPref) : "Not specified"),
    licenseFileName,
    insuranceFileName,
    agreeTerms,
    precheckDecision,
    precheckLabel: precheckLabels[precheckDecision] || "Not available",
    hasLicenseUpload,
    hasInsuranceProof,
    applicationStatus,
    identityStatus,
    verificationLink,
  };
}

async function sendMailIfPossible({ to, subject, text, html, attachments = [] }) {
  const transporter = getTransporter();
  if (!transporter || !to) return false;
  await transporter.sendMail({
    from: `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
  return true;
}

async function sendApplicantSms(template, vars, phone) {
  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY || !phone) return false;
  await sendSms(normalizePhone(phone), render(template, vars));
  return true;
}

export async function sendSubmittedApplicationNotifications(application = {}, { attachments = [] } = {}) {
  const ctx = getContext(application);

  await sendMailIfPossible({
    to: OWNER_EMAIL,
    subject: "🆕 New Application Submitted — Identity Verification Pending",
    text: [
      "New Application Submitted — Sly Transportation Services LLC",
      "",
      `Name                    : ${ctx.name}`,
      `Application ID          : ${ctx.applicationId || "Not available"}`,
      `Phone                   : ${ctx.phone}`,
      `Email                   : ${ctx.email || "Not provided"}`,
      `Age                     : ${ctx.age ?? "Not provided"}`,
      `Driving Experience      : ${ctx.experience || "Not provided"}`,
      `Delivery Platforms      : ${ctx.appsLabel}`,
      `Has Insurance           : ${ctx.hasInsuranceLabel}`,
      `Insurance Proof         : ${ctx.hasInsuranceProof ? ctx.insuranceFileName : "Not uploaded"}`,
      `Protection Plan         : ${ctx.planLabel}`,
      `Terms Agreed            : ${ctx.agreeTerms ? "Yes" : "No"}`,
      `License Attached        : ${ctx.hasLicenseUpload ? ctx.licenseFileName : "No"}`,
      "Lifecycle Stage         : submitted → identity verification pending",
      `Internal Pre-Screen     : ${ctx.precheckLabel}`,
    ].join("\n"),
    html: `
      <h2>&#x1F195; New Application Submitted</h2>
      <p>A new renter application was submitted. Identity verification is still pending.</p>
      <table style="border-collapse:collapse;width:100%;max-width:560px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Application ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.applicationId || "Not available")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.phone)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.email || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Age</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(ctx.age ?? "Not provided"))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driving Experience</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.experience || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Delivery Platforms</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.appsLabel)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Has Insurance</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.hasInsuranceLabel)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Proof</strong></td><td style="padding:8px;border:1px solid #ddd">${ctx.hasInsuranceProof ? `<em>See attached: ${esc(ctx.insuranceFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Protection Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.planLabel)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Terms Agreed</strong></td><td style="padding:8px;border:1px solid #ddd">${ctx.agreeTerms ? "Yes" : "No"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driver&#39;s License</strong></td><td style="padding:8px;border:1px solid #ddd">${ctx.hasLicenseUpload ? `<em>See attached: ${esc(ctx.licenseFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Lifecycle Stage</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">submitted &rarr; identity verification pending</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Internal Pre-Screen</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.precheckLabel)}</td></tr>
      </table>
      ${ctx.hasLicenseUpload ? "<p style=\"margin-top:12px\">The applicant&#39;s driver&#39;s license is attached.</p>" : ""}
      ${ctx.hasInsuranceProof ? "<p style=\"margin-top:4px\">The applicant&#39;s proof of insurance is attached.</p>" : ""}
    `,
    attachments,
  });

  if (isValidEmail(ctx.email)) {
    await sendMailIfPossible({
      to: ctx.email,
      subject: "Complete Identity Verification — SLY Transportation Services",
      text: [
        `Hi ${ctx.firstName},`,
        "",
        "We’ve received your application with Sly Transportation Services LLC.",
        "Your next step is to complete secure identity verification so we can move your application into review.",
        ...(ctx.verificationLink ? ["", "Complete your verification here:", ctx.verificationLink] : []),
        "",
        "After identity verification is completed, we’ll notify you when your application is under review.",
        "",
        `Questions? Call us at (844) 511-4059 or email ${OWNER_EMAIL}.`,
        "",
        "— Sly Transportation Services LLC Team",
      ].join("\n"),
      html: `
        <h2>Application Received</h2>
        <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
        <p>We’ve received your application with <strong>Sly Transportation Services LLC</strong>.</p>
        <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
          <strong>Next step:</strong> complete secure identity verification so we can move your application into review.
        </p>
        ${ctx.verificationLink ? `
        <p style="text-align:center;margin:20px 0">
          <a href="${esc(ctx.verificationLink)}"
             style="background:#ffb400;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
            &#x1F194; Complete Identity Verification &rarr;
          </a>
        </p>` : ""}
        <p>After identity verification is completed, we’ll notify you when your application is under review.</p>
        <p>Questions? Call us at <strong>(844) 511-4059</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
        <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
      `,
    });
  }

  await sendApplicantSms(APPLICATION_RECEIVED, { customer_name: ctx.firstName, verification_link: ctx.verificationLink || "" }, ctx.phone);
}

function buildIdentityIssueContent(kind, ctx) {
  if (kind === "requires_input") {
    return {
      ownerSubject: "⚠️ Identity Verification Requires Input",
      ownerLabel: "requires input",
      applicantSubject: "Action Needed: Retry Identity Verification — SLY Transportation Services",
      applicantText: [
        `Hi ${ctx.firstName},`,
        "",
        "Your identity verification needs more information before we can continue reviewing your application.",
        "Please retry the verification step and correct any missing or unclear details.",
        ...(ctx.verificationLink ? ["", "Resume your verification here:", ctx.verificationLink] : []),
        "",
        `If you need help, call us at (844) 511-4059 or email ${OWNER_EMAIL}.`,
        "",
        "— Sly Transportation Services LLC Team",
      ].join("\n"),
      applicantHtml: `
        <h2>Action Needed: Identity Verification</h2>
        <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
        <p>Your identity verification needs more information before we can continue reviewing your application.</p>
        <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
          <strong>Next step:</strong> retry the verification step and correct any missing or unclear details.
        </p>
        ${ctx.verificationLink ? `
        <p style="text-align:center;margin:20px 0">
          <a href="${esc(ctx.verificationLink)}"
             style="background:#ffb400;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
            &#x1F194; Retry Identity Verification &rarr;
          </a>
        </p>` : ""}
        <p>If you need help, call us at <strong>(844) 511-4059</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
        <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
      `,
      smsTemplate: APPLICATION_REQUIRES_INPUT,
    };
  }

  if (kind === "failed") {
    return {
      ownerSubject: "❌ Identity Verification Failed",
      ownerLabel: "failed",
      applicantSubject: "Identity Verification Issue — SLY Transportation Services",
      applicantText: [
        `Hi ${ctx.firstName},`,
        "",
        "We couldn’t complete your identity verification.",
        "Please retry the verification step or contact us if you need assistance.",
        ...(ctx.verificationLink ? ["", "Retry your verification here:", ctx.verificationLink] : []),
        "",
        `Support: (844) 511-4059 • ${OWNER_EMAIL}`,
        "",
        "— Sly Transportation Services LLC Team",
      ].join("\n"),
      applicantHtml: `
        <h2>Identity Verification Issue</h2>
        <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
        <p>We couldn’t complete your identity verification.</p>
        <p style="background:#f8d7da;padding:10px;border-left:4px solid #dc3545;margin-bottom:16px">
          <strong>Next step:</strong> retry the verification step or contact us if you need assistance.
        </p>
        ${ctx.verificationLink ? `
        <p style="text-align:center;margin:20px 0">
          <a href="${esc(ctx.verificationLink)}"
             style="background:#ffb400;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
            &#x1F194; Retry Identity Verification &rarr;
          </a>
        </p>` : ""}
        <p>Support: <strong>(844) 511-4059</strong> • <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a></p>
        <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
      `,
      smsTemplate: APPLICATION_IDENTITY_FAILED,
    };
  }

  return {
    ownerSubject: "🚫 Identity Verification Canceled",
    ownerLabel: "canceled",
    applicantSubject: "Identity Verification Canceled — SLY Transportation Services",
    applicantText: [
      `Hi ${ctx.firstName},`,
      "",
      "Your identity verification was canceled before completion.",
      "Please restart verification when you’re ready, or contact us if you need help.",
      ...(ctx.verificationLink ? ["", "Restart your verification here:", ctx.verificationLink] : []),
      "",
      `Support: (844) 511-4059 • ${OWNER_EMAIL}`,
      "",
      "— Sly Transportation Services LLC Team",
    ].join("\n"),
    applicantHtml: `
      <h2>Identity Verification Canceled</h2>
      <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
      <p>Your identity verification was canceled before completion.</p>
      <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
        <strong>Next step:</strong> restart verification when you’re ready, or contact us if you need help.
      </p>
      ${ctx.verificationLink ? `
      <p style="text-align:center;margin:20px 0">
        <a href="${esc(ctx.verificationLink)}"
           style="background:#ffb400;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
          &#x1F194; Restart Identity Verification &rarr;
        </a>
      </p>` : ""}
      <p>Support: <strong>(844) 511-4059</strong> • <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a></p>
      <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
    `,
    smsTemplate: APPLICATION_IDENTITY_CANCELED,
  };
}

export async function sendIdentityVerifiedNotifications(application = {}) {
  const ctx = getContext(application);

  await sendMailIfPossible({
    to: OWNER_EMAIL,
    subject: "✅ Identity Verified — Ready For Review",
    text: [
      "Identity Verified — Ready For Review",
      "",
      `Name            : ${ctx.name}`,
      `Application ID  : ${ctx.applicationId || "Not available"}`,
      `Phone           : ${ctx.phone}`,
      `Email           : ${ctx.email || "Not provided"}`,
      "Lifecycle Stage : identity verified → under review",
    ].join("\n"),
    html: `
      <h2>&#x2705; Identity Verified — Ready For Review</h2>
      <p>The applicant completed identity verification successfully and is ready for manual review.</p>
      <table style="border-collapse:collapse;width:100%;max-width:520px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Application ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.applicationId || "Not available")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.phone)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.email || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Lifecycle Stage</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">identity verified &rarr; under review</td></tr>
      </table>
    `,
  });

  if (isValidEmail(ctx.email)) {
    await sendMailIfPossible({
      to: ctx.email,
      subject: "Application Under Review — SLY Transportation Services",
      text: [
        `Hi ${ctx.firstName},`,
        "",
        "Your identity verification is complete.",
        "Your application is now under review and we’ll contact you with the next update.",
        "",
        `Questions? Call us at (844) 511-4059 or email ${OWNER_EMAIL}.`,
        "",
        "— Sly Transportation Services LLC Team",
      ].join("\n"),
      html: `
        <h2>Application Under Review</h2>
        <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
        <p>Your identity verification is complete.</p>
        <p style="background:#d1ecf1;padding:10px;border-left:4px solid #17a2b8;margin-bottom:16px">
          <strong>Status:</strong> your application is now under review.
        </p>
        <p>We’ll contact you with the next update.</p>
        <p>Questions? Call us at <strong>(844) 511-4059</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
        <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
      `,
    });
  }

  await sendApplicantSms(APPLICATION_UNDER_REVIEW, { customer_name: ctx.firstName }, ctx.phone);
}

export async function sendIdentityIssueNotifications(application = {}, kind = "requires_input") {
  const ctx = getContext(application);
  const copy = buildIdentityIssueContent(kind, ctx);

  await sendMailIfPossible({
    to: OWNER_EMAIL,
    subject: copy.ownerSubject,
    text: [
      copy.ownerSubject.replace(/^[^\w]+/, ""),
      "",
      `Name            : ${ctx.name}`,
      `Application ID  : ${ctx.applicationId || "Not available"}`,
      `Phone           : ${ctx.phone}`,
      `Email           : ${ctx.email || "Not provided"}`,
      `Identity Status : ${copy.ownerLabel}`,
    ].join("\n"),
    html: `
      <h2>${esc(copy.ownerSubject)}</h2>
      <p>The applicant identity verification status changed and needs operational attention.</p>
      <table style="border-collapse:collapse;width:100%;max-width:520px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Application ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.applicationId || "Not available")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.phone)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.email || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Identity Status</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">${esc(copy.ownerLabel)}</td></tr>
      </table>
    `,
  });

  if (isValidEmail(ctx.email)) {
    await sendMailIfPossible({
      to: ctx.email,
      subject: copy.applicantSubject,
      text: copy.applicantText,
      html: copy.applicantHtml,
    });
  }

  await sendApplicantSms(copy.smsTemplate, { customer_name: ctx.firstName, verification_link: ctx.verificationLink || "" }, ctx.phone);
}

/**
 * Send notifications when a manual reviewer approves, rejects, or requests
 * more information on an application.
 *
 * This is the ONLY place applicant-facing approval/rejection/needs-info messages
 * are sent.  It must only be called after a successful conditional state write.
 *
 * @param {object} application  — full application record (DB row or client shape)
 * @param {"approved"|"rejected"|"needs_info"} action
 * @param {{notes?:string}} [options]
 */
export async function sendReviewDecisionNotifications(application = {}, action, options = {}) {
  const ctx = getContext(application);
  const reviewerNotes = options.notes ? String(options.notes).trim() : "";

  if (action === "approved") {
    await sendMailIfPossible({
      to: OWNER_EMAIL,
      subject: "✅ Application Approved",
      text: [
        "Application Approved — Sly Transportation Services LLC",
        "",
        `Name            : ${ctx.name}`,
        `Application ID  : ${ctx.applicationId || "Not available"}`,
        `Phone           : ${ctx.phone}`,
        `Email           : ${ctx.email || "Not provided"}`,
        `Reviewer Notes  : ${reviewerNotes || "None"}`,
        "Lifecycle Stage : approved",
      ].join("\n"),
      html: `
        <h2>&#x2705; Application Approved</h2>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Application ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.applicationId || "Not available")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.email || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Reviewer Notes</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(reviewerNotes || "None")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Lifecycle Stage</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">approved</td></tr>
        </table>
      `,
    });

    if (isValidEmail(ctx.email)) {
      await sendMailIfPossible({
        to: ctx.email,
        subject: "You're Approved — SLY Transportation Services",
        text: [
          `Hi ${ctx.firstName},`,
          "",
          "Great news — your application has been approved!",
          "You can now proceed with booking.",
          "",
          `Questions? Call us at (844) 511-4059 or email ${OWNER_EMAIL}.`,
          "",
          "— Sly Transportation Services LLC Team",
        ].join("\n"),
        html: `
          <h2>&#x1F389; You're Approved!</h2>
          <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
          <p>Great news — your application has been <strong>approved</strong>.</p>
          <p style="background:#d4edda;padding:10px;border-left:4px solid #28a745;margin-bottom:16px">
            You can now proceed with booking.
          </p>
          <p>Questions? Call us at <strong>(844) 511-4059</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
          <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
        `,
      });
    }

    await sendApplicantSms(APPLICATION_APPROVED, { customer_name: ctx.firstName, waitlist_link: "" }, ctx.phone);
    return;
  }

  if (action === "rejected") {
    await sendMailIfPossible({
      to: OWNER_EMAIL,
      subject: "❌ Application Rejected",
      text: [
        "Application Rejected — Sly Transportation Services LLC",
        "",
        `Name            : ${ctx.name}`,
        `Application ID  : ${ctx.applicationId || "Not available"}`,
        `Phone           : ${ctx.phone}`,
        `Email           : ${ctx.email || "Not provided"}`,
        `Reviewer Notes  : ${reviewerNotes || "None"}`,
        "Lifecycle Stage : rejected",
      ].join("\n"),
      html: `
        <h2>&#x274C; Application Rejected</h2>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Application ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.applicationId || "Not available")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.email || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Reviewer Notes</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(reviewerNotes || "None")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Lifecycle Stage</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">rejected</td></tr>
        </table>
      `,
    });

    if (isValidEmail(ctx.email)) {
      await sendMailIfPossible({
        to: ctx.email,
        subject: "Application Status Update — SLY Transportation Services",
        text: [
          `Hi ${ctx.firstName},`,
          "",
          "Thank you for applying with Sly Transportation Services LLC.",
          "After reviewing your application, we're unable to approve it at this time.",
          "",
          `If you have questions, please call us at (844) 511-4059 or email ${OWNER_EMAIL}.`,
          "",
          "— Sly Transportation Services LLC Team",
        ].join("\n"),
        html: `
          <h2>Application Status Update</h2>
          <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
          <p>Thank you for applying with <strong>Sly Transportation Services LLC</strong>.</p>
          <p style="background:#f8d7da;padding:10px;border-left:4px solid #dc3545;margin-bottom:16px">
            After reviewing your application, we&rsquo;re unable to approve it at this time.
          </p>
          <p>If you have questions, please call us at <strong>(844) 511-4059</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
          <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
        `,
      });
    }

    await sendApplicantSms(APPLICATION_DENIED, { customer_name: ctx.firstName }, ctx.phone);
    return;
  }

  if (action === "needs_info") {
    await sendMailIfPossible({
      to: OWNER_EMAIL,
      subject: "⏸ Application — More Information Requested",
      text: [
        "Application Needs More Information — Sly Transportation Services LLC",
        "",
        `Name            : ${ctx.name}`,
        `Application ID  : ${ctx.applicationId || "Not available"}`,
        `Phone           : ${ctx.phone}`,
        `Email           : ${ctx.email || "Not provided"}`,
        `Reviewer Notes  : ${reviewerNotes || "None"}`,
        "Lifecycle Stage : needs_info",
      ].join("\n"),
      html: `
        <h2>&#x23F8; Application — More Information Requested</h2>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.name)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Application ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.applicationId || "Not available")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.phone)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ctx.email || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Reviewer Notes</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(reviewerNotes || "None")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Lifecycle Stage</strong></td><td style="padding:8px;border:1px solid #ddd;font-weight:bold">needs_info</td></tr>
        </table>
      `,
    });

    if (isValidEmail(ctx.email)) {
      await sendMailIfPossible({
        to: ctx.email,
        subject: "Additional Information Needed — SLY Transportation Services",
        text: [
          `Hi ${ctx.firstName},`,
          "",
          "We're reviewing your application and need a bit more information before we can make a decision.",
          "Please contact our team so we can help you complete your review.",
          "",
          "Call or text: (844) 511-4059",
          `Email: ${OWNER_EMAIL}`,
          "",
          "— Sly Transportation Services LLC Team",
        ].join("\n"),
        html: `
          <h2>Additional Information Needed</h2>
          <p>Hi <strong>${esc(ctx.firstName)}</strong>,</p>
          <p>We&rsquo;re reviewing your application and need a bit more information before we can make a decision.</p>
          <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
            Please contact our team so we can help you complete your review.
          </p>
          <p>Call or text: <strong>(844) 511-4059</strong></p>
          <p>Email: <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a></p>
          <p><strong>Sly Transportation Services LLC Team &#x1F697;</strong></p>
        `,
      });
    }

    await sendApplicantSms(APPLICATION_NEEDS_INFO, { customer_name: ctx.firstName }, ctx.phone);
    return;
  }
}
