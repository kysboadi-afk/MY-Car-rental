// api/approve-late-fee.js
// One-click late-fee approval/decline endpoint for the owner.
//
// Sent as a link in the automated late-return owner email/SMS when a customer
// is overdue past the grace period.  The admin clicks Approve → the card is
// charged immediately via the same executeChargeFee() logic used by the Admin
// UI and the AI assistant.  Clicking Decline records the decision and does
// nothing to the card.
//
// GET /api/approve-late-fee
//   ?action=approve|decline
//   &bookingId=<id>
//   &amount=<dollars>
//   &token=<hmac-signed-token>
//
// Returns a mobile-friendly HTML result page (no login required — token guards it).
//
// Required environment variables:
//   OTP_SECRET             — HMAC secret shared with _late-fee-token.js
//   STRIPE_SECRET_KEY      — for the off-session charge
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — for booking lookup + charges table
//   SMTP_HOST/PORT/USER/PASS — for result confirmation email (optional but recommended)
//   OWNER_EMAIL            — owner's email address

import { verifyLateFeeToken } from "./_late-fee-token.js";
import { executeChargeFee }   from "./charge-fee.js";
import { getSupabaseAdmin }   from "./_supabase.js";
import nodemailer             from "nodemailer";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

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
    body { font-family: sans-serif; max-width: 560px; margin: 60px auto; padding: 24px; text-align: center; background: #0d0d0d; color: #eee; }
    h1   { color: ${esc(color)}; margin-bottom: 12px; }
    p    { color: #aaa; line-height: 1.6; }
    .amt { color: #ffb400; font-weight: bold; font-size: 1.2em; }
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

// ── Send a result confirmation email to the owner ─────────────────────────────

async function sendResultEmail(subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
      to:      OWNER_EMAIL,
      subject,
      html,
    });
  } catch (err) {
    console.warn("approve-late-fee: result email failed (non-fatal):", err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const { action, bookingId: rawBookingId, amount: rawAmount, token } = req.query || {};

  // ── Basic validation ──────────────────────────────────────────────────────
  if (!["approve", "decline"].includes(action) || !rawBookingId || !token) {
    return res.status(400).send(htmlPage(
      "Error", "#c62828", "❌ Invalid link",
      `<p>This approval link is malformed. Please check the latest alert email or contact support.</p>`
    ));
  }

  // ── Token verification ────────────────────────────────────────────────────
  const decoded = verifyLateFeeToken(token);
  if (
    !decoded ||
    decoded.action    !== action ||
    decoded.bookingId !== rawBookingId
  ) {
    return res.status(401).send(htmlPage(
      "Link Expired", "#c62828", "⏰ Link expired or invalid",
      `<p>This approval link has expired (links are valid for 24 hours) or is invalid.</p>
       <p>You can still charge the customer manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
    ));
  }

  const bookingId = decoded.bookingId;
  const amount    = decoded.amount;

  // ── Decline ───────────────────────────────────────────────────────────────
  if (action === "decline") {
    await sendResultEmail(
      `[Sly Rides] Late Fee Declined — Booking ${bookingId}`,
      `<h2>Late Fee Declined</h2>
       <p>You chose not to charge the late fee of <strong>$${esc(String(amount))}</strong> for booking <strong>${esc(bookingId)}</strong>.</p>
       <p>No charge was applied to the customer's card.</p>
       <p>You can still charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
    );

    return res.status(200).send(htmlPage(
      "Declined", "#888", "✅ Late Fee Declined",
      `<p>No charge was applied to the customer's card.</p>
       <p>Booking: <strong>${esc(bookingId)}</strong></p>
       <p>You can still charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
    ));
  }

  // ── Approve: idempotency check then execute the charge ────────────────────
  // Guard against double-tap: if a succeeded late_fee charge already exists
  // for this booking, return a "already charged" page instead of charging again.
  try {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data: existing } = await sb
        .from("charges")
        .select("id, status")
        .eq("booking_id", bookingId)
        .eq("charge_type", "late_fee")
        .in("status", ["succeeded", "pending"])
        .maybeSingle();

      if (existing) {
        return res.status(200).send(htmlPage(
          "Already Charged", "#1a73e8", "ℹ️ Already Charged",
          `<p>A late fee of <strong>$${esc(String(amount))}</strong> was already charged for booking <strong>${esc(bookingId)}</strong>.</p>
           <p>No duplicate charge was applied.</p>`
        ));
      }
    }
  } catch (err) {
    // Non-fatal: if the idempotency check fails, proceed with the charge
    // (better to risk a duplicate than block the owner from charging at all)
    console.warn("approve-late-fee: idempotency check failed (non-fatal):", err.message);
  }

  try {
    const result = await executeChargeFee({
      bookingId,
      chargeType: "late_fee",
      amount,
      notes:      "Late return — approved via admin approval link",
      chargedBy:  "admin",
    });

    await sendResultEmail(
      `[Sly Rides] ✅ Late Fee Charged — Booking ${bookingId}`,
      `<h2>Late Fee Charged Successfully</h2>
       <p>A late fee of <strong>$${esc(String(amount))}</strong> was charged to the customer's card for booking <strong>${esc(bookingId)}</strong>.</p>
       <p>${esc(result.message || "")}</p>
       <p>Confirmation emails have been sent to both you and the customer.</p>`
    );

    return res.status(200).send(htmlPage(
      "Charge Approved", "#4caf50", "✅ Late Fee Charged",
      `<p class="amt">$${esc(String(amount))} charged successfully.</p>
       <p>Booking: <strong>${esc(bookingId)}</strong></p>
       <p>Confirmation emails have been sent to you and the customer.</p>`
    ));
  } catch (err) {
    console.error("approve-late-fee: charge failed:", err.message);

    await sendResultEmail(
      `[Sly Rides] ❌ Late Fee Charge Failed — Booking ${bookingId}`,
      `<h2>Late Fee Charge Failed</h2>
       <p>Attempted to charge <strong>$${esc(String(amount))}</strong> for booking <strong>${esc(bookingId)}</strong> — but Stripe returned an error:</p>
       <blockquote>${esc(err.message)}</blockquote>
       <p>Please charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
    );

    return res.status(200).send(htmlPage(
      "Charge Failed", "#c62828", "❌ Charge Failed",
      `<p>Stripe could not process the late fee for booking <strong>${esc(bookingId)}</strong>.</p>
       <p><em>${esc(err.message)}</em></p>
       <p>Please charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
    ));
  }
}
