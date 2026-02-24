// api/check-email.js
// Vercel serverless function — diagnostic endpoint for email configuration
//
// GET /api/check-email
//   Returns a JSON report showing which SMTP env vars are set, what address
//   owner notifications will be sent to, and whether the SMTP server connection
//   can actually be established.
//   No sensitive values are ever exposed — only "set" / "not set" / status strings.
//
// This endpoint is intentionally open (no authentication required) but exposes
// only configuration status, not credential values.
import nodemailer from "nodemailer";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const report = {
    timestamp: new Date().toISOString(),
    smtp: {},
    ownerEmail: {},
    connection: null,
    overall: null,
  };

  // ── SMTP variables ───────────────────────────────────────────────────────────
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || "587";
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  report.smtp = {
    SMTP_HOST: smtpHost ? `✅ set (${smtpHost})` : "❌ not set",
    SMTP_PORT: `✅ set (${smtpPort})`,
    SMTP_USER: smtpUser ? "✅ set" : "❌ not set",
    SMTP_PASS: smtpPass ? "✅ set" : "❌ not set",
  };

  // ── Owner email ──────────────────────────────────────────────────────────────
  report.ownerEmail = {
    value: OWNER_EMAIL,
    source: process.env.OWNER_EMAIL ? "OWNER_EMAIL env var" : "default (slyservices@supports-info.com)",
    hint: process.env.OWNER_EMAIL
      ? "Owner booking notifications will be sent to this address."
      : "⚠️  Using the default address. Set OWNER_EMAIL in Vercel → Settings → Environment Variables to use your work email.",
  };

  // ── SMTP connection test ─────────────────────────────────────────────────────
  if (smtpHost && smtpUser && smtpPass) {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort, 10),
      secure: smtpPort === "465",
      auth: { user: smtpUser, pass: smtpPass },
    });

    try {
      await transporter.verify();
      report.connection = {
        status: `✅ SMTP connection to ${smtpHost}:${smtpPort} succeeded — emails can be sent`,
      };
    } catch (err) {
      report.connection = {
        status: `❌ SMTP connection to ${smtpHost}:${smtpPort} failed: ${err.message}`,
        hint: smtpHost.includes("gmail")
          ? "For Gmail: make sure 2-Step Verification is ON and SMTP_PASS is an App Password (not your regular password). Generate one at https://myaccount.google.com/apppasswords"
          : "Check that SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS are all correct and the SMTP server allows external connections.",
      };
    }
  } else {
    const missing = [];
    if (!smtpHost) missing.push("SMTP_HOST");
    if (!smtpUser) missing.push("SMTP_USER");
    if (!smtpPass) missing.push("SMTP_PASS");
    report.connection = {
      status: `⏭ Skipped — missing required SMTP variable(s): ${missing.join(", ")}`,
    };
  }

  // ── Overall ──────────────────────────────────────────────────────────────────
  const smtpConfigured = !!(smtpHost && smtpUser && smtpPass);
  const connectionOk = report.connection && report.connection.status.startsWith("✅");
  const ownerEmailCustomised = !!process.env.OWNER_EMAIL;

  if (smtpConfigured && connectionOk && ownerEmailCustomised) {
    report.overall = "✅ All checks passed — email notifications are correctly configured";
  } else if (smtpConfigured && connectionOk && !ownerEmailCustomised) {
    report.overall = "⚠️  SMTP is working but OWNER_EMAIL is not set — notifications will go to the default address. Add OWNER_EMAIL in Vercel → Settings → Environment Variables to receive them at your work email.";
  } else if (!smtpConfigured) {
    report.overall = "❌ SMTP credentials not configured — no emails will be sent. Add SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT) in Vercel → Settings → Environment Variables, then Redeploy.";
  } else {
    report.overall = "❌ SMTP credentials are set but the connection failed — check the error above and confirm your App Password / server settings.";
  }

  return res.status(200).json(report);
}
