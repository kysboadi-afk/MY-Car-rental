import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const ALLOWED_ORIGINS = [
  "https://www.slytrans.com",
  "https://slytrans.com",
  "https://slycarrentals.com",
  "https://www.slycarrentals.com",
  "https://admin.slycarrentals.com",
];

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clean(value, maxLen = 240) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeEmail(value) {
  return clean(value, 180).toLowerCase();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizePositiveInteger(value) {
  if (value === "" || value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function sendOwnerNotification(entry, leadId) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number.parseInt(process.env.SMTP_PORT || "587", 10),
    secure: Number.parseInt(process.env.SMTP_PORT || "587", 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: `"Fleet Control" <${process.env.SMTP_USER}>`,
    to: OWNER_EMAIL,
    replyTo: entry.work_email,
    subject: `Fleet Control operator lead — ${entry.contact_name} [${leadId}]`,
    text: [
      "New Fleet Control onboarding lead captured.",
      "",
      `Lead ID                : ${leadId}`,
      `Contact Name           : ${entry.contact_name}`,
      `Company Name           : ${entry.company_name || "Not provided"}`,
      `Work Email             : ${entry.work_email}`,
      `Phone                  : ${entry.phone}`,
      `Fleet Size             : ${entry.fleet_size}`,
      `Active Vehicles        : ${entry.active_vehicles ?? "Not provided"}`,
      `Operational Priority   : ${entry.operational_priority}`,
      `Onboarding Readiness   : ${entry.onboarding_readiness || "Not provided"}`,
      `Integration Setup      : ${entry.integration_setup_status || "Not provided"}`,
      `Stripe Readiness       : ${entry.stripe_readiness || "Not provided"}`,
      `Walkthrough Requested  : ${entry.walkthrough_requested ? "Yes" : "No"}`,
      `Current Tools          : ${entry.current_tools || "Not provided"}`,
      `Source Page            : ${entry.source_page}`,
      "",
      "Notes:",
      entry.notes,
    ].join("\n"),
    html: `
      <h2>Fleet Control operator lead</h2>
      <p>A new operator onboarding lead was captured through the dedicated Fleet Control flow.</p>
      <table style="border-collapse:collapse;width:100%;max-width:720px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Lead ID</strong></td><td style="padding:8px;border:1px solid #ddd;font-family:monospace">${esc(leadId)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Contact Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.contact_name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Company Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.company_name || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Work Email</strong></td><td style="padding:8px;border:1px solid #ddd"><a href="mailto:${esc(entry.work_email)}">${esc(entry.work_email)}</a></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.phone)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Fleet Size</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.fleet_size)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Active Vehicles</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.active_vehicles ?? "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Operational Priority</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.operational_priority)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Onboarding Readiness</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.onboarding_readiness || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Integration Setup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.integration_setup_status || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Stripe Readiness</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.stripe_readiness || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Walkthrough Requested</strong></td><td style="padding:8px;border:1px solid #ddd">${entry.walkthrough_requested ? "Yes" : "No"}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Current Tools</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.current_tools || "Not provided")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Source Page</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.source_page)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd;vertical-align:top"><strong>Notes</strong></td><td style="padding:8px;border:1px solid #ddd;white-space:pre-wrap">${esc(entry.notes)}</td></tr>
      </table>
    `,
  });

  return true;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const {
    companyName,
    contactName,
    workEmail,
    phone,
    fleetSize,
    activeVehicles,
    currentTools,
    operationalPriority,
    onboardingReadiness,
    integrationSetupStatus,
    stripeReadiness,
    notes,
    walkthroughRequested,
    honeypot,
    sourcePage,
  } = req.body || {};

  if (clean(honeypot, 80)) {
    return res.status(400).json({ error: "Submission rejected." });
  }

  const entry = {
    company_name: clean(companyName, 160),
    contact_name: clean(contactName, 120),
    work_email: normalizeEmail(workEmail),
    phone: clean(phone, 60),
    fleet_size: clean(fleetSize, 80),
    active_vehicles: normalizePositiveInteger(activeVehicles),
    current_tools: clean(currentTools, 240),
    operational_priority: clean(operationalPriority, 160),
    onboarding_readiness: clean(onboardingReadiness, 80),
    integration_setup_status: clean(integrationSetupStatus, 80),
    stripe_readiness: clean(stripeReadiness, 80),
    walkthrough_requested: normalizeBoolean(walkthroughRequested, true),
    notes: clean(notes, 4000),
    source_page: clean(sourcePage || "fleet-control", 120),
    subscription_state: "lead",
    status: "new_lead",
    metadata: {
      capture_channel: "fleet_control_onboarding",
    },
  };

  if (!entry.contact_name || !entry.work_email || !entry.phone || !entry.fleet_size || !entry.operational_priority || !entry.notes) {
    return res.status(400).json({ error: "Missing required operator lead fields." });
  }
  if (!isValidEmail(entry.work_email)) {
    return res.status(400).json({ error: "A valid work email is required." });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).json({ error: "Operator onboarding is temporarily unavailable." });
  }

  const { data, error } = await supabase
    .from("operator_leads")
    .insert(entry)
    .select("id,status")
    .single();

  if (error || !data?.id) {
    console.error("operator-leads insert failed:", error);
    return res.status(500).json({ error: "Unable to save operator lead right now." });
  }

  try {
    await sendOwnerNotification(entry, data.id);
  } catch (err) {
    console.error("operator-leads owner email failed:", err);
  }

  return res.status(200).json({
    success: true,
    leadId: data.id,
    status: data.status || "new_lead",
  });
}
