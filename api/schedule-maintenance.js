// api/schedule-maintenance.js
// Driver maintenance appointment scheduling endpoint.
//
// POST /api/schedule-maintenance
//   Body (JSON or form-encoded): { vehicleId, serviceType, scheduledAt, bookingId?, notes? }
//   Stores appointment in maintenance_appointments table.
//   Notifies owner via SMS.
//   In MAINTENANCE_APPROVAL_MODE=approval: status starts as "pending_approval" and
//     owner gets an email with approve/decline buttons.
//   In default (auto) mode: status is immediately "scheduled".
//   Returns HTML confirmation page (mobile-friendly).
//
// GET /api/schedule-maintenance?action=approve|decline&id=<apptId>&token=<hmac>
//   Owner approval/decline link sent in email.
//   token = HMAC-SHA256("appt-approval:<base64url-payload>", OTP_SECRET)
//   payload = base64url({ id, action, exp })
//   Responds with HTML result page.
//
// Required environment variables:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   OWNER_PHONE              — default +12139166606
//   OWNER_EMAIL              — default slyservices@supports-info.com
//   TEXTMAGIC_USERNAME + TEXTMAGIC_API_KEY — for owner SMS
//   SMTP_HOST/PORT/USER/PASS — for approval emails
//   OTP_SECRET               — HMAC secret for approval tokens
//   MAINTENANCE_APPROVAL_MODE — "auto" (default) | "approval"
//   VERCEL_URL               — used to build self links in emails

import crypto     from "crypto";
import nodemailer from "nodemailer";
import { getSupabaseAdmin }  from "./_supabase.js";
import { sendSms }           from "./_textmagic.js";
import { normalizePhone, loadBookings } from "./_bookings.js";
import { adminErrorMessage } from "./_error-helpers.js";

const OWNER_PHONE = process.env.OWNER_PHONE || "+12139166606";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

const SERVICE_LABELS = {
  oil:    "oil change",
  brakes: "brake inspection",
  tires:  "tire replacement",
};

const VALID_SERVICE_TYPES = new Set(Object.keys(SERVICE_LABELS));

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(title, color, heading, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — SLY Rides</title>
  <style>
    body { font-family: sans-serif; max-width: 560px; margin: 60px auto; padding: 24px; text-align: center; }
    h1   { color: ${color}; }
    p    { color: #555; line-height: 1.6; }
    a    { color: #1a73e8; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  ${body}
  <p style="margin-top:32px"><a href="https://www.slytrans.com">← Return to SLY Rides</a></p>
</body>
</html>`;
}

// ── Approval token (HMAC, 48-hour TTL) ───────────────────────────────────────

const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;

function getSecret() {
  return process.env.OTP_SECRET || "sly-rides-otp-dev-secret-change-in-production";
}

function createApprovalToken(id, action) {
  const secret  = getSecret();
  const payload = Buffer.from(JSON.stringify({ id, action, exp: Date.now() + APPROVAL_TTL_MS }))
    .toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`appt-approval:${payload}`)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function verifyApprovalToken(token, expectedId, expectedAction) {
  if (!token) return false;
  try {
    const secret = getSecret();
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx < 0) return false;
    const payload = token.slice(0, dotIdx);
    const sig     = token.slice(dotIdx + 1);
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`appt-approval:${payload}`)
      .digest("base64url");
    const sigBuf      = Buffer.from(sig,         "base64url");
    const expectedBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (data.id !== expectedId || data.action !== expectedAction) return false;
    if (Date.now() > data.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

async function safeSendSms(phone, text) {
  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) return false;
  try {
    const normalized = normalizePhone(phone);
    if (!normalized) return false;
    await sendSms(normalized, text);
    return true;
  } catch (err) {
    console.warn("schedule-maintenance: SMS failed:", err.message);
    return false;
  }
}

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({ from: process.env.SMTP_USER, to, subject, html });
    return true;
  } catch (err) {
    console.warn("schedule-maintenance: email failed:", err.message);
    return false;
  }
}

function apiBase() {
  return process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://www.slytrans.com";
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone:     "America/Los_Angeles",
      weekday:      "short",
      month:        "short",
      day:          "numeric",
      year:         "numeric",
      hour:         "numeric",
      minute:       "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

// ── GET handler: approve / decline ────────────────────────────────────────────

async function handleApproval(req, res) {
  const { action, id: rawId, token } = req.query;
  const id = Number(rawId);
  if (!["approve", "decline"].includes(action) || !id || !token) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(htmlPage("Error", "#c62828", "❌ Invalid link",
      `<p>This approval link is malformed. Please contact the fleet administrator.</p>`));
  }

  if (!verifyApprovalToken(token, id, action)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send(htmlPage("Error", "#c62828", "❌ Link expired or invalid",
      `<p>This approval link has expired or is invalid. Please check the latest alert email.</p>`));
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(503).send(htmlPage("Error", "#c62828", "❌ Service unavailable",
      `<p>Service temporarily unavailable. Please try again later.</p>`));
  }

  // Fetch the appointment
  const { data: appt, error: fetchErr } = await sb
    .from("maintenance_appointments")
    .select("id, vehicle_id, service_type, scheduled_at, status, booking_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !appt) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(404).send(htmlPage("Error", "#c62828", "❌ Appointment not found",
      `<p>This appointment could not be found. It may have already been processed.</p>`));
  }

  if (appt.status !== "pending_approval") {
    const label = appt.status === "scheduled" ? "already approved" :
                  appt.status === "cancelled"  ? "already declined" : appt.status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(htmlPage("Already processed", "#555", "ℹ️ Already processed",
      `<p>This appointment was ${esc(label)}.</p>`));
  }

  const newStatus  = action === "approve" ? "scheduled" : "cancelled";
  const serviceLabel = SERVICE_LABELS[appt.service_type] || appt.service_type;
  const dt         = formatDateTime(appt.scheduled_at);

  const { error: updateErr } = await sb
    .from("maintenance_appointments")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (updateErr) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(htmlPage("Error", "#c62828", "❌ Update failed",
      `<p>Could not update the appointment. Please try again.</p>`));
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (action === "approve") {
    return res.status(200).send(htmlPage("Appointment Approved", "#2e7d32", "✅ Appointment approved",
      `<p>The ${esc(serviceLabel)} appointment for <strong>${esc(appt.vehicle_id)}</strong> on <strong>${esc(dt)}</strong> has been confirmed.</p>
       <p>The driver will proceed as scheduled.</p>`));
  } else {
    return res.status(200).send(htmlPage("Appointment Declined", "#c62828", "❌ Appointment declined",
      `<p>The ${esc(serviceLabel)} appointment for <strong>${esc(appt.vehicle_id)}</strong> on <strong>${esc(dt)}</strong> has been cancelled.</p>`));
  }
}

// ── POST handler: create appointment ─────────────────────────────────────────

async function handleCreate(req, res) {
  // Parse body (JSON or url-encoded from HTML form)
  let body = req.body;
  if (typeof body === "string") {
    try { body = Object.fromEntries(new URLSearchParams(body)); } catch { body = {}; }
  }
  body = body || {};

  const vehicleId   = String(body.vehicleId   || "").trim();
  const serviceType = String(body.serviceType  || "").trim().toLowerCase();
  const scheduledAt = String(body.scheduledAt  || "").trim();
  const bookingId   = String(body.bookingId    || "").trim() || null;
  const notes       = String(body.notes        || "").trim().slice(0, 500) || null;

  // Validate
  if (!vehicleId) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(htmlPage("Error", "#c62828", "❌ Missing vehicle",
      `<p>No vehicle specified. Please use the link from your maintenance alert.</p>`));
  }
  if (!VALID_SERVICE_TYPES.has(serviceType)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(htmlPage("Error", "#c62828", "❌ Invalid service type",
      `<p>Unknown service type. Please use the link from your maintenance alert.</p>`));
  }
  const scheduledDate = new Date(scheduledAt);
  if (!scheduledAt || isNaN(scheduledDate.getTime())) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(htmlPage("Error", "#c62828", "❌ Invalid date/time",
      `<p>Please select a valid appointment date and time.</p>`));
  }
  // Must be in the future
  if (scheduledDate.getTime() <= Date.now()) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(htmlPage("Error", "#c62828", "❌ Date must be in the future",
      `<p>Please select an appointment date and time in the future.</p>`));
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(503).send(htmlPage("Error", "#c62828", "❌ Service unavailable",
      `<p>Service temporarily unavailable. Please try again later.</p>`));
  }

  // Resolve vehicle name + driver info
  let vehicleName = vehicleId;
  let resolvedBookingId = bookingId;
  let driverPhone = null;
  let driverName  = null;
  try {
    const { data: vRow } = await sb
      .from("vehicles")
      .select("data")
      .eq("vehicle_id", vehicleId)
      .maybeSingle();
    if (vRow?.data?.vehicle_name) vehicleName = vRow.data.vehicle_name;

    if (!resolvedBookingId) {
      const { data: allBookingsRaw } = await loadBookings();
      const bookings = allBookingsRaw?.[vehicleId];
      const active   = Array.isArray(bookings)
        ? bookings.find((b) => b.status === "active_rental")
        : null;
      if (active) {
        resolvedBookingId = active.bookingId || active.paymentIntentId || null;
        driverPhone = active.phone   || null;
        driverName  = active.name    || null;
      }
    }
  } catch (err) {
    console.warn("schedule-maintenance: could not resolve vehicle/booking:", err.message);
  }

  // Approval mode
  const approvalMode = (process.env.MAINTENANCE_APPROVAL_MODE || "auto").toLowerCase() === "approval";
  const status       = approvalMode ? "pending_approval" : "scheduled";
  const serviceLabel = SERVICE_LABELS[serviceType];
  const dt           = formatDateTime(scheduledAt);

  // Insert appointment
  const { data: inserted, error: insertErr } = await sb
    .from("maintenance_appointments")
    .insert({
      vehicle_id:   vehicleId,
      booking_id:   resolvedBookingId,
      service_type: serviceType,
      scheduled_at: scheduledDate.toISOString(),
      status,
      notes,
    })
    .select("id")
    .single();

  if (insertErr) {
    console.error("schedule-maintenance: insert failed:", insertErr.message);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(htmlPage("Error", "#c62828", "❌ Could not save appointment",
      `<p>An error occurred saving the appointment. Please try again or contact us directly.</p>`));
  }

  const apptId = inserted.id;

  // Owner SMS
  await safeSendSms(OWNER_PHONE,
    `📅 ${driverName || "Driver"} scheduled ${serviceLabel} for ${vehicleName} on ${dt}.${approvalMode ? " Approval required — check your email." : ""}`
  );

  if (approvalMode) {
    // Owner email with approve / decline buttons
    const approveToken  = createApprovalToken(apptId, "approve");
    const declineToken  = createApprovalToken(apptId, "decline");
    const base          = apiBase();
    const approveUrl    = `${base}/api/schedule-maintenance?action=approve&id=${apptId}&token=${encodeURIComponent(approveToken)}`;
    const declineUrl    = `${base}/api/schedule-maintenance?action=decline&id=${apptId}&token=${encodeURIComponent(declineToken)}`;

    await sendEmail(
      OWNER_EMAIL,
      `📅 Maintenance Appointment Needs Approval — ${vehicleName}`,
      `<p>A driver has scheduled a maintenance appointment that requires your approval.</p>
<p><strong>Vehicle:</strong> ${esc(vehicleName)}</p>
<p><strong>Service:</strong> ${esc(serviceLabel)}</p>
<p><strong>Date/Time:</strong> ${esc(dt)}</p>
${resolvedBookingId ? `<p><strong>Booking:</strong> ${esc(resolvedBookingId)}</p>` : ""}
${driverName  ? `<p><strong>Driver:</strong> ${esc(driverName)}</p>` : ""}
${driverPhone ? `<p><strong>Driver phone:</strong> ${esc(driverPhone)}</p>` : ""}
${notes       ? `<p><strong>Notes:</strong> ${esc(notes)}</p>` : ""}
<p>
  <a href="${approveUrl}" style="display:inline-block;padding:10px 20px;background:#2e7d32;color:#fff;border-radius:4px;text-decoration:none;margin-right:12px">✅ Approve</a>
  <a href="${declineUrl}" style="display:inline-block;padding:10px 20px;background:#c62828;color:#fff;border-radius:4px;text-decoration:none">❌ Decline</a>
</p>
<p style="font-size:12px;color:#888">Approval links expire in 48 hours.</p>`
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(htmlPage("Appointment Requested", "#1565c0", "📅 Appointment request submitted",
      `<p>Your ${esc(serviceLabel)} appointment for <strong>${esc(dt)}</strong> has been submitted.</p>
       <p>The owner will review and confirm shortly. You'll be notified if it's declined.</p>`));
  }

  // Auto-approved
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(htmlPage("Appointment Scheduled", "#2e7d32", "✅ Appointment scheduled",
    `<p>Your ${esc(serviceLabel)} appointment for <strong>${esc(vehicleName)}</strong> has been confirmed for <strong>${esc(dt)}</strong>.</p>
     <p>Please arrive on time. The owner has been notified.</p>`));
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { action } = req.query;
    if (action === "approve" || action === "decline") {
      return handleApproval(req, res);
    }
    // GET without action — should not happen; redirect to schedule page
    res.setHeader("Location", "/maintenance-schedule.html");
    return res.status(302).send("");
  }

  if (req.method === "POST") {
    try {
      return await handleCreate(req, res);
    } catch (err) {
      console.error("schedule-maintenance error:", err);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(htmlPage("Error", "#c62828", "❌ Unexpected error",
        `<p>${esc(adminErrorMessage(err))}</p>`));
    }
  }

  return res.status(405).send("Method Not Allowed");
}
