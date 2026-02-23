// api/send-reservation-email.js
// Vercel serverless function — sends reservation emails via SMTP
//
// Required environment variables (set in Vercel dashboard):
//   SMTP_HOST    — SMTP server hostname  (e.g. smtp.gmail.com)
//   SMTP_PORT    — SMTP port             (587 for TLS, 465 for SSL)
//   SMTP_USER    — sending email address
//   SMTP_PASS    — email password or app password
//   OWNER_EMAIL  — business email that receives all reservation alerts
//                  (defaults to slyservices@supports-info.com)
import nodemailer from "nodemailer";

// Allow larger bodies so the renter's ID photo/PDF can be attached
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
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

  // Guard: fail fast with a clear log if SMTP credentials are missing
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("Missing SMTP environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS). Add them in your Vercel project → Settings → Environment Variables.");
    return res.status(500).json({ error: "Server configuration error: SMTP credentials are not set." });
  }

  const { car, pickup, pickupTime, returnDate, returnTime, email, phone, total, pricePerDay, pricePerWeek, deposit, days, idBase64, idFileName, idMimeType } = req.body;

  try {
    // Build attachment list for the owner email
    const attachments = [];
    if (idBase64 && idFileName) {
      attachments.push({
        filename: idFileName,
        content: idBase64,
        encoding: "base64",
        contentType: idMimeType || "application/octet-stream",
      });
    }

    // --- Notify owner ---
    await transporter.sendMail({
      from: `"SLY Rides Bookings" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: `💰 Payment Confirmed – New Booking: ${esc(car)}`,
      attachments,
      html: `
        <h2>💰 Payment Confirmed – New Booking</h2>
        <p>A customer has completed payment. Their rental details are below.</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(car)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupTime) || "Not specified"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnTime) || "Not specified"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email) || "Not provided"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone) || "Not provided"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Number of Days</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(days || "N/A"))}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Daily Rate</strong></td><td style="padding:8px;border:1px solid #ddd">${pricePerDay != null ? "$" + esc(String(pricePerDay)) + " / day" : "N/A"}</td></tr>
          ${pricePerWeek ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Weekly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerWeek))} / week</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Deposit</strong></td><td style="padding:8px;border:1px solid #ddd">${deposit != null && deposit > 0 ? "$" + esc(String(deposit)) : "None"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(total) || "TBD"}</strong></td></tr>
        </table>
        ${attachments.length > 0 ? `<p>📎 <strong>Renter's ID is attached</strong> to this email (${esc(idFileName)}).</p>` : `<p>⚠️ No ID was uploaded by the renter.</p>`}
        <p>Payment has been received. Please contact the customer to confirm rental details.</p>
      `,
    });

    // --- Confirmation to customer ---
    if (email) {
      await transporter.sendMail({
        from: `"SLY Rides" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "✅ Your SLY Rides Payment Confirmed",
        html: `
          <h2>✅ Payment Confirmed – SLY Rides</h2>
          <p>Hi there! Your payment has been received and your car rental is confirmed. Here are your booking details:</p>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(car)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupTime) || "Not specified"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnTime) || "Not specified"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(total) || "TBD"}</strong></td></tr>
          </table>
          <p>We will be in touch shortly to confirm your rental pick-up details. If you have any questions, reply to this email or reach us at <a href="mailto:slyservices@supports-info.com">slyservices@supports-info.com</a>.</p>
          <p><strong>SLY Rides Team 🚗</strong></p>
        `,
      });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email sending failed" });
  }
}
