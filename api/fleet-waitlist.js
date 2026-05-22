import crypto from "crypto";
import nodemailer from "nodemailer";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const WAITLIST_CAPTURE_PATH = "fleet-waitlist.json";
const ALLOWED_ORIGINS = [
  "https://www.slytrans.com",
  "https://slytrans.com",
  "https://slycarrentals.com",
  "https://www.slycarrentals.com",
  "https://admin.slycarrentals.com",
  "https://slyslingshotrentals.com",
  "https://www.slyslingshotrentals.com",
];

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clean(value, maxLen = 160) {
  return String(value || "").trim().slice(0, maxLen);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function appendFleetWaitlistEntry(entry) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return false;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${WAITLIST_CAPTURE_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const EMPTY_FILE = { entries: [] };

  async function loadFile() {
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      if (response.status === 404) return { data: { ...EMPTY_FILE }, sha: null };
      throw new Error(`GitHub GET waitlist capture failed: ${response.status}`);
    }

    const file = await response.json();
    let data = { ...EMPTY_FILE };
    try {
      data = JSON.parse(Buffer.from(String(file.content || "").replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch (_) {}
    if (!data || typeof data !== "object") data = { ...EMPTY_FILE };
    if (!Array.isArray(data.entries)) data.entries = [];
    return { data, sha: file.sha || null };
  }

  async function saveFile(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const response = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub PUT waitlist capture failed: ${response.status} ${body}`);
    }
  }

  await updateJsonFileWithRetry({
    load: loadFile,
    apply: (data) => {
      if (!Array.isArray(data.entries)) data.entries = [];
      const exists = data.entries.some((row) => row?.submissionId === entry.submissionId);
      if (exists) return;
      data.entries.unshift(entry);
      if (data.entries.length > 5000) data.entries.length = 5000;
    },
    save: saveFile,
    message: `Add empty-state waitlist submission: ${entry.name}`,
  });

  return true;
}

async function sendOwnerNotification(entry) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: parseInt(process.env.SMTP_PORT || "587", 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: `"Sly Car Rentals LLC" <${process.env.SMTP_USER}>`,
    to: OWNER_EMAIL,
    replyTo: entry.email,
    subject: `🚘 Fleet Waitlist Request — ${entry.name} [${entry.submissionId}]`,
    text: [
      "New empty-state waitlist request submitted on cars.html.",
      "",
      `Submission ID     : ${entry.submissionId}`,
      `Created At        : ${entry.createdAt}`,
      `Name              : ${entry.name}`,
      `Phone             : ${entry.phone}`,
      `Email             : ${entry.email}`,
      `Preferred Vehicle : ${entry.preferredVehicle || "Any available vehicle"}`,
      `Weekly Budget     : ${entry.weeklyBudget || "Not provided"}`,
      `Source Page       : ${entry.sourcePage || "cars-empty-state"}`,
    ].join("\n"),
    html: `
      <h2>🚘 New Fleet Waitlist Request</h2>
      <p>Submitted from the no-availability empty state on <strong>cars.html</strong>.</p>
      <table style="border-collapse:collapse;width:100%;max-width:680px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Submission ID</strong></td><td style="padding:8px;border:1px solid #ddd;font-family:monospace">${esc(entry.submissionId)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Created At</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.createdAt)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.name)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.phone)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd"><a href="mailto:${esc(entry.email)}">${esc(entry.email)}</a></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Preferred Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.preferredVehicle || "Any available vehicle")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Weekly Budget</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(entry.weeklyBudget || "Not provided")}</td></tr>
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
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    name,
    phone,
    email,
    preferredVehicle,
    weeklyBudget,
    honeypot,
    sourcePage,
  } = req.body || {};

  if (honeypot) return res.status(400).json({ error: "Submission rejected." });

  const normalizedName = clean(name, 120);
  const normalizedPhone = clean(phone, 60);
  const normalizedEmail = clean(email, 180).toLowerCase();
  if (!normalizedName || !normalizedPhone || !normalizedEmail || !isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: "Name, phone, and valid email are required." });
  }

  const entry = {
    submissionId: `FLEET-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    createdAt: new Date().toISOString(),
    name: normalizedName,
    phone: normalizedPhone,
    email: normalizedEmail,
    preferredVehicle: clean(preferredVehicle, 120),
    weeklyBudget: clean(weeklyBudget, 80),
    sourcePage: clean(sourcePage || "cars-empty-state", 80),
  };

  let captured = false;
  try {
    const stored = await appendFleetWaitlistEntry(entry);
    captured = captured || stored;
  } catch (err) {
    console.error("fleet-waitlist: storage failed:", err);
  }

  try {
    const emailed = await sendOwnerNotification(entry);
    captured = captured || emailed;
  } catch (err) {
    console.error("fleet-waitlist: owner email failed:", err);
  }

  if (!captured) {
    return res.status(500).json({ error: "Unable to capture waitlist request right now. Please call (844) 511-4059." });
  }

  return res.status(200).json({ success: true, submissionId: entry.submissionId });
}
