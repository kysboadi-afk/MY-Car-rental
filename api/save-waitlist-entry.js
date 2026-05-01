// api/save-waitlist-entry.js
// Saves a confirmed waitlist entry to waitlist.json on GitHub and sends
// confirmation emails to the admin and the customer.
//
// Called by success.html after a waitlist deposit payment succeeds.
//
// Required environment variables:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   OWNER_EMAIL
//   GITHUB_TOKEN  (contents:write — to update waitlist.json)
//   GITHUB_REPO   (defaults to kysboadi-afk/SLY-RIDES)
import crypto from "crypto";
import nodemailer from "nodemailer";
import { createDecisionToken } from "./_waitlist-token.js";
import { getVehicleById } from "./_vehicles.js";
import { sendSms } from "./_textmagic.js";
import { render, WAITLIST_JOINED } from "./_sms-templates.js";
import { normalizePhone } from "./_bookings.js";
import { upsertContact, vehicleTag } from "./_contacts.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const OWNER_EMAIL   = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO   = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const WAITLIST_PATH = "waitlist.json";
const WAITLIST_DEPOSIT = 50;

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Appends a new entry to waitlist.json in the GitHub repo.
 * Returns the queue position (1-based) for the new entry.
 */
async function appendWaitlistEntry(vehicleId, entry) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("GITHUB_TOKEN not set — waitlist.json will not be updated");
    return 1;
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${WAITLIST_PATH}`;
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const EMPTY_WAITLIST = { camry: [], camry2013: [] };

  async function loadWaitlist() {
    const resp = await fetch(apiUrl, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: { ...EMPTY_WAITLIST }, sha: null };
      return { data: { ...EMPTY_WAITLIST }, sha: null }; // non-fatal
    }
    const file = await resp.json();
    let data = { ...EMPTY_WAITLIST };
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch (parseErr) {
      console.error("waitlist: malformed JSON:", parseErr);
    }
    return { data, sha: file.sha };
  }

  async function saveWaitlist(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method:  "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT waitlist.json failed: ${resp.status} ${text}`);
    }
  }

  let position = 1;
  await updateJsonFileWithRetry({
    load:  loadWaitlist,
    apply: (data) => {
      if (!data[vehicleId]) data[vehicleId] = [];
      // Idempotent: if entry already present (retry), find its position
      const existing = data[vehicleId].find((e) => e.entryId === entry.entryId);
      if (existing) {
        position = existing.position;
        return;
      }
      position = data[vehicleId].length + 1;
      data[vehicleId].push({ ...entry, position, joinedAt: new Date().toISOString() });
    },
    save:    saveWaitlist,
    message: `Add waitlist entry for ${vehicleId}: ${entry.name}`,
  });

  return position;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const {
      vehicleId, name, email, phone,
      preferredPickup, preferredReturn,
      paymentIntentId,
      idBase64, idFileName, idMimeType,
      hasInsurance, insuranceBase64, insuranceFileName, insuranceMimeType,
      protectionPlanPref,
    } = req.body;

    const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
    if (!vehicleData) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email" });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!idBase64) {
      return res.status(400).json({ error: "Driver's license upload is required" });
    }

    const trimmedName = name.trim();

    // Generate a unique entry ID used for approve/decline token binding
    const entryId = crypto.randomBytes(16).toString("hex");

    const entry = {
      entryId,
      name:                trimmedName,
      email,
      phone:               phone || "",
      preferredPickup:     preferredPickup || "",
      preferredReturn:     preferredReturn || "",
      depositPaid:         WAITLIST_DEPOSIT,
      paymentIntentId:     paymentIntentId || "",
      vehicleName:         vehicleData.name,
      status:              "pending",
      hasInsurance:        hasInsurance || "",
      protectionPlanPref:  protectionPlanPref || "standard",
    };

    const position = await appendWaitlistEntry(vehicleId, entry);

    // ── Generate approve / decline action tokens ──────────────────────────────
    const API_BASE = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://sly-rides.vercel.app";
    const decisionToken = createDecisionToken(vehicleId, entryId);
    const approveUrl = `${API_BASE}/api/waitlist-decision?action=approve&token=${encodeURIComponent(decisionToken)}`;
    const declineUrl = `${API_BASE}/api/waitlist-decision?action=decline&token=${encodeURIComponent(decisionToken)}`;

    const PLAN_LABELS = { basic: "Basic Protection", standard: "Standard Protection", premium: "Premium Protection", none: "Declined" };
    const planLabel = PLAN_LABELS[protectionPlanPref] || (protectionPlanPref ? esc(String(protectionPlanPref)) : "Not specified");
    const insuranceLabel = hasInsurance === "yes" ? "Yes" : hasInsurance === "no" ? "No" : "Not specified";
    const hasInsuranceProof = !!(insuranceBase64 && insuranceFileName && insuranceMimeType);

    // ── Email notifications ───────────────────────────────────────────────────
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: parseInt(process.env.SMTP_PORT || "587") === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      // ── Admin alert ─────────────────────────────────────────────────────────
      try {
        const adminMailOpts = {
          from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
          to:      OWNER_EMAIL,
          subject: `🔔 New Waitlist Sign-up #${position}: ${vehicleData.name} — ${trimmedName} [PENDING REVIEW]`,
          text: [
            `New waitlist sign-up for ${vehicleData.name}`,
            `Queue Position : #${position}`,
            `Status         : PENDING`,
            `Name           : ${trimmedName}`,
            `Email          : ${email}`,
            `Phone          : ${phone || "Not provided"}`,
            `Preferred Pickup: ${preferredPickup || "Not specified"}`,
            `Preferred Return: ${preferredReturn || "Not specified"}`,
            `Has Insurance  : ${insuranceLabel}`,
            `Insurance Proof: ${hasInsuranceProof ? insuranceFileName : "Not uploaded"}`,
            `Protection Plan: ${planLabel}`,
            `Deposit Paid   : $${WAITLIST_DEPOSIT} (non-refundable)`,
            `Payment Intent : ${paymentIntentId || "N/A"}`,
            `Entry ID       : ${entryId}`,
            "",
            `Driver's License: attached`,
            "",
            `APPROVE: ${approveUrl}`,
            `DECLINE: ${declineUrl}`,
          ].join("\n"),
          html: `
            <h2>🔔 New Waitlist Sign-up — ${esc(vehicleData.name)}</h2>
            <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
              <strong>⏳ Status: PENDING REVIEW</strong> — Please review the driver's license (attached) and approve or decline below.
            </p>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Queue Position</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>#${position}</strong></td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleData.name)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(trimmedName)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone || "Not provided")}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Preferred Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(preferredPickup || "Not specified")}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Preferred Return</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(preferredReturn || "Not specified")}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Has Insurance</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(insuranceLabel)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Proof</strong></td><td style="padding:8px;border:1px solid #ddd">${hasInsuranceProof ? `<em>See attached: ${esc(insuranceFileName)}</em>` : "<em>Not uploaded</em>"}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Protection Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(planLabel)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${WAITLIST_DEPOSIT} (non-refundable)</strong></td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Intent</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentIntentId || "N/A")}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Driver's License</strong></td><td style="padding:8px;border:1px solid #ddd">📎 See attachment</td></tr>
            </table>
            <div style="margin-top:24px;text-align:center">
              <a href="${approveUrl}" style="display:inline-block;padding:14px 32px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold;margin-right:16px">
                ✅ Approve
              </a>
              <a href="${declineUrl}" style="display:inline-block;padding:14px 32px;background:#dc3545;color:#fff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:bold">
                ❌ Decline
              </a>
            </div>
            <p style="margin-top:16px;font-size:12px;color:#888">
              Approving will send the customer a confirmation email.<br>
              Declining will update their status to declined${paymentIntentId ? " and automatically refund their $50 deposit" : ""}.
            </p>
          `,
        };

        // Attach the driver's license if provided
        if (idBase64) {
          const safeFileName = (idFileName || "drivers-license.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
          adminMailOpts.attachments = [{
            filename:    safeFileName,
            content:     Buffer.from(idBase64, "base64"),
            contentType: idMimeType || "application/octet-stream",
          }];
        }

        // Also attach insurance proof if provided
        if (hasInsuranceProof) {
          const safeInsName = (insuranceFileName || "insurance-proof.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
          if (!adminMailOpts.attachments) adminMailOpts.attachments = [];
          adminMailOpts.attachments.push({
            filename:    safeInsName,
            content:     Buffer.from(insuranceBase64, "base64"),
            contentType: insuranceMimeType || "application/octet-stream",
          });
        }

        await transporter.sendMail(adminMailOpts);
      } catch (err) {
        console.error("Admin waitlist email failed:", err);
      }

      // ── Customer confirmation ────────────────────────────────────────────────
      if (email) {
        try {
          await transporter.sendMail({
            from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
            to:      email,
            subject: `⏳ Waitlist Application Received — ${vehicleData.name} | SLY Transportation`,
            text: [
              `Hi ${trimmedName},`,
              "",
              `Thank you for joining the waitlist for the ${vehicleData.name}!`,
              `You are #${position} in the queue.`,
              "",
              "Your application is now under review. Once we verify your driver's license, you'll receive a confirmation or decision email within 24–48 hours.",
              "",
              "Waitlist Details:",
              `Vehicle          : ${vehicleData.name}`,
              `Your Position    : #${position}`,
              `Status           : Pending Review`,
              `Preferred Pickup : ${preferredPickup || "Not specified"}`,
              `Preferred Return : ${preferredReturn || "Not specified"}`,
              `Deposit Paid     : $${WAITLIST_DEPOSIT} (non-refundable — applied toward your rental)`,
              "",
              "What happens next:",
              "• We will review your driver's license within 24–48 hours.",
              "• If approved, you'll receive a confirmation email right away.",
              "• When the vehicle becomes available for your preferred dates, we will contact you with a payment link to complete the full booking.",
              "• You will have 12–24 hours to complete payment. If you don't pay in time, the next person in the queue is contacted.",
              "• Your $50 deposit goes toward your total rental cost.",
              "",
              `Questions? Call us at (833) 252-1093 or email ${OWNER_EMAIL}.`,
              "",
              "— Sly Transportation Services LLC Team",
            ].join("\n"),
            html: `
              <h2>⏳ Waitlist Application Received</h2>
              <p>Hi <strong>${esc(trimmedName)}</strong>,</p>
              <p>Thank you for joining the waitlist for the <strong>${esc(vehicleData.name)}</strong>! You are <strong>#${position}</strong> in the queue.</p>
              <p style="background:#fff3cd;padding:10px;border-left:4px solid #ffc107;margin-bottom:16px">
                <strong>⏳ Status: Pending Review</strong> — Your driver's license is under review. You'll hear back within 24–48 hours.
              </p>
              <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
                <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleData.name)}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd"><strong>Your Position</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>#${position}</strong></td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd"><strong>Status</strong></td><td style="padding:8px;border:1px solid #ddd">⏳ Pending Review</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd"><strong>Preferred Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(preferredPickup || "Not specified")}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd"><strong>Preferred Return</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(preferredReturn || "Not specified")}</td></tr>
                <tr><td style="padding:8px;border:1px solid #ddd"><strong>Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${WAITLIST_DEPOSIT} <em style="font-size:12px;color:#888">(non-refundable — applied toward your rental)</em></td></tr>
              </table>
              <h3 style="color:#333">What happens next:</h3>
              <ul>
                <li>We'll review your driver's license within <strong>24–48 hours</strong>.</li>
                <li>If approved, you'll receive a confirmation email right away.</li>
                <li>When the vehicle becomes available for your preferred dates, we'll contact you with a payment link to complete the full booking.</li>
                <li>You have <strong>12–24 hours</strong> to complete payment — otherwise the next person in line is contacted.</li>
                <li>Your <strong>$50 deposit goes toward your total rental cost</strong>.</li>
              </ul>
              <p>Questions? Call us at <strong>(833) 252-1093</strong> or email <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
              <p><strong>Sly Transportation Services LLC Team 🚗</strong></p>
            `,
          });
        } catch (err) {
          console.error("Customer waitlist email failed:", err);
        }
      }
    }

    // ─── Waitlist join SMS ────────────────────────────────────────────────────
    if (phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
      try {
        await sendSms(
          normalizePhone(phone),
          render(WAITLIST_JOINED, {
            customer_name: trimmedName,
            vehicle:       vehicleData.name,
          })
        );
      } catch (smsErr) {
        console.error("Waitlist join SMS failed:", smsErr);
      }
    }

    // ─── TextMagic contact upsert ─────────────────────────────────────────────
    if (phone) {
      try {
        const addTags = ["waitlist"];
        const vTag = vehicleTag(vehicleId);
        if (vTag) addTags.push(vTag);
        await upsertContact(normalizePhone(phone), trimmedName, { addTags });
      } catch (contactErr) {
        console.error("TextMagic contact upsert (waitlist) failed:", contactErr);
      }
    }

    res.status(200).json({ success: true, position });
  } catch (err) {
    console.error("save-waitlist-entry error:", err);
    res.status(500).json({ error: "Failed to save waitlist entry" });
  }
}
