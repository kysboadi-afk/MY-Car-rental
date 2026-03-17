// api/send-otp.js
// Vercel serverless function — sends a 6-digit OTP to the supplied email address
// so the contact form can verify the user controls that address before submitting.
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OTP_SECRET   — long random string used to sign OTP tokens
//
// POST /api/send-otp
//   Body:    { email }
//   Returns: { token }  ← opaque signed token; client passes it back on submit
import nodemailer from "nodemailer";
import { generateOtp, createOtpToken } from "./_otp.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Basic email format check (full RFC validation is done by the SMTP server)
function isValidEmailFormat(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    return res
      .status(500)
      .json({ error: "Server configuration error: SMTP credentials are not set." });
  }

  const { email } = req.body || {};

  if (!email || !isValidEmailFormat(email)) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const otp = generateOtp();
  const token = createOtpToken(email, otp);

  try {
    await transporter.sendMail({
      from: `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Your Verification Code – Sly Transportation Services LLC",
      text: [
        "Hi,",
        "",
        "Your verification code for the Sly Transportation Services LLC contact form is:",
        "",
        `  ${otp}`,
        "",
        "This code expires in 10 minutes. If you did not request this, please ignore this email.",
        "",
        "– Sly Transportation Services LLC",
      ].join("\n"),
      html: `
        <div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#ffb400">Verify Your Email</h2>
          <p>Hi,</p>
          <p>Your verification code for the <strong>Sly Transportation Services LLC</strong> contact form is:</p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#111;background:#f5f5f5;padding:16px 24px;border-radius:8px;display:inline-block;margin:8px 0">${otp}</div>
          <p style="color:#555">This code expires in <strong>10 minutes</strong>. If you did not request this, please ignore this email.</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
          <p style="font-size:12px;color:#888">– Sly Transportation Services LLC · Los Angeles, CA</p>
        </div>
      `,
    });

    return res.status(200).json({ token });
  } catch (err) {
    console.error("OTP email failed:", err);
    return res.status(500).json({ error: "Failed to send verification email." });
  }
}
