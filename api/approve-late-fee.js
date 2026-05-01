// api/approve-late-fee.js
// One-click late-fee approval/decline/adjustment endpoint for the owner.
//
// Sent as a link in the automated late-return owner email/SMS when a customer
// is overdue past the grace period.
//
// Actions (GET):
//   approve — show a confirmation preview page (never charges without a second click)
//   decline — record dismissal + update late_fee_status, no charge
//   adjust  — show an HTML form to enter a new amount, then re-sign and execute
//
// Actions (POST):
//   confirm — owner clicked "Confirm & Charge" on the preview page; verifies the
//             original approve token is still valid, then charges
//   adjust  — owner submitted the adjusted-amount form; verifies adjust token, charges
//
// Safety protections:
//   • Tokens carry an HMAC-signed exp — links expire after 24 h
//   • Idempotency: blocks re-charge when late_fee_status = 'paid' (Supabase) or
//     when a succeeded/pending charge already exists (charges table)
//   • Confirmation preview: admin must click twice before any charge executes
//   • High-amount warning: charges >= MAX_CHARGE_WARN_USD show a highlighted warning
//   • On Stripe failure: customer receives a fallback payment link via SMS
//
// GET /api/approve-late-fee
//   ?action=approve|decline|adjust
//   &bookingId=<id>
//   &amount=<dollars>
//   &token=<hmac-signed-token>
//
// POST /api/approve-late-fee
//   body (x-www-form-urlencoded):
//     action=confirm     — { bookingId, amount, originalToken }
//     action=adjust      — { bookingId, originalAmount, newAmount, originalToken }
//
// Returns a mobile-friendly HTML result page (no login required — token guards it).
//
// Required environment variables:
//   OTP_SECRET             — HMAC secret shared with _late-fee-token.js
//   STRIPE_SECRET_KEY      — for the off-session charge
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — for booking lookup + charges table
//   SMTP_HOST/PORT/USER/PASS — for result confirmation email (optional but recommended)
//   OWNER_EMAIL            — owner's email address

import { verifyLateFeeToken, buildLateFeeUrls } from "./_late-fee-token.js";
import { executeChargeFee }                      from "./charge-fee.js";
import { getSupabaseAdmin }                      from "./_supabase.js";
import { validateLink, PAGE_URLS }               from "./_link-validator.js";
import { sendSms }                               from "./_textmagic.js";
import { normalizePhone }                        from "./_bookings.js";
import nodemailer                                from "nodemailer";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

// Charges at or above this amount show a prominent "high amount" warning on the
// confirmation page.  The second-click confirm step still applies for all amounts.
const MAX_CHARGE_WARN_USD = 500;

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
    .warn { background: #7f1d1d; color: #fca5a5; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-weight: bold; }
    a    { color: #1a73e8; }
    form { text-align: left; margin: 24px 0; }
    label { display: block; margin-bottom: 6px; color: #ccc; font-size: 14px; }
    input[type=number] { width: 100%; padding: 10px; border: 1px solid #444; border-radius: 6px;
                         background: #1a1a1a; color: #eee; font-size: 16px; box-sizing: border-box; }
    button       { display: block; width: 100%; margin-top: 16px; padding: 14px;
                   background: #1a73e8; color: #fff; border: none; border-radius: 8px;
                   font-size: 16px; font-weight: bold; cursor: pointer; }
    button:hover { background: #1558b0; }
    button.green { background: #4caf50; }
    button.green:hover { background: #388e3c; }
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

/**
 * Update bookings.late_fee_status and audit fields in Supabase.
 * Non-fatal — logs errors but never throws.
 */
async function updateLateFeeStatus(bookingId, status, approvedBy) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb || !bookingId) return;
    await sb
      .from("bookings")
      .update({
        late_fee_status:      status,
        late_fee_approved_at: new Date().toISOString(),
        late_fee_approved_by: approvedBy,
        updated_at:           new Date().toISOString(),
      })
      .eq("booking_ref", bookingId);
  } catch (err) {
    console.warn("approve-late-fee: late_fee_status update failed (non-fatal):", err.message);
  }
}

/**
 * Check whether this booking's late fee is already fully settled.
 * Returns true when late_fee_status = 'paid' in Supabase.
 * Falls back to false on any error (non-fatal — charge table guard catches it too).
 */
async function isLateFeeAlreadyPaid(bookingId) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb || !bookingId) return false;
    const { data } = await sb
      .from("bookings")
      .select("late_fee_status")
      .eq("booking_ref", bookingId)
      .maybeSingle();
    return data?.late_fee_status === "paid";
  } catch (err) {
    console.warn("approve-late-fee: paid status check failed (non-fatal):", err.message);
    return false;
  }
}

/**
 * Build and validate a payment link for the customer as a charge-failed fallback.
 * Returns a safe URL (original or cars.html fallback).
 */
async function buildFallbackPaymentLink(bookingId) {
  const baseLink = `${PAGE_URLS.balance}?ref=${encodeURIComponent(bookingId)}&type=late_fee`;
  const { url } = await validateLink(baseLink, {
    baseUrlForValidation: PAGE_URLS.balance,
    fallback:             PAGE_URLS.cars,
  });
  return url;
}

/**
 * Send a fallback payment link to the customer when off-session charge fails.
 * Non-fatal.
 */
async function sendCustomerFallbackSms(bookingId, amount, phone) {
  if (!phone || !process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) return;
  try {
    const paymentLink = await buildFallbackPaymentLink(bookingId);
    const msg =
      `A late fee of $${amount} is owed on your rental.\n\n` +
      `Please complete payment here:\n${paymentLink}\n\n` +
      `Questions? Call (833) 252-1093.\n\nReply STOP to opt out.`;
    await sendSms(normalizePhone(phone), msg);
  } catch (smsErr) {
    console.warn("approve-late-fee: fallback SMS to customer failed (non-fatal):", smsErr.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  // ── POST: confirm (from preview page) or adjust form submission ───────────
  if (req.method === "POST") {
    const body = req.body || {};
    if (String(body.action || "").trim() === "confirm") {
      return handleConfirmPost(req, res);
    }
    return handleAdjustPost(req, res);
  }

  // ── GET: approve / decline / adjust ──────────────────────────────────────
  const { action, bookingId: rawBookingId, amount: rawAmount, token } = req.query || {};

  if (!["approve", "decline", "adjust"].includes(action) || !rawBookingId || !token) {
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
    await updateLateFeeStatus(bookingId, "dismissed", "admin_link");
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

  // ── Adjust: show form to enter new amount ─────────────────────────────────
  if (action === "adjust") {
    return res.status(200).send(htmlPage(
      "Adjust Late Fee", "#1a73e8", "✏️ Adjust Late Fee Amount",
      `<p>Assessed amount: <span class="amt">$${esc(String(amount))}</span></p>
       <p>Enter the adjusted amount to charge, then click Confirm.</p>
       <form method="POST" action="/api/approve-late-fee">
         <input type="hidden" name="action"         value="adjust" />
         <input type="hidden" name="bookingId"      value="${esc(bookingId)}" />
         <input type="hidden" name="originalAmount" value="${esc(String(amount))}" />
         <input type="hidden" name="originalToken"  value="${esc(token)}" />
         <label for="newAmount">New amount (USD):</label>
         <input type="number" id="newAmount" name="newAmount"
                min="1" max="5000" step="0.01"
                value="${esc(String(amount))}" required />
         <!-- Server-side validation of this range is enforced in handleAdjustPost() -->
         <button type="submit">✅ Confirm &amp; Charge</button>
       </form>
       <p style="font-size:13px;color:#777">Amount must be between $1 and $5,000.</p>`
    ));
  }

  // ── Approve: show confirmation preview page (no immediate charge) ─────────
  const isHighAmount = amount >= MAX_CHARGE_WARN_USD;
  const warnHtml = isHighAmount
    ? `<p class="warn">⚠️ HIGH AMOUNT — $${esc(String(amount))} — please confirm this is correct before charging.</p>`
    : "";

  return res.status(200).send(htmlPage(
    "Confirm Late Fee Charge", "#ffb400", "💳 Confirm Late Fee Charge",
    `${warnHtml}
     <p>You are about to charge <span class="amt">$${esc(String(amount))}</span> to the saved card for booking <strong>${esc(bookingId)}</strong>.</p>
     <p style="color:#888;font-size:13px">The customer's saved Stripe payment method will be charged off-session.</p>
     <form method="POST" action="/api/approve-late-fee">
       <input type="hidden" name="action"        value="confirm" />
       <input type="hidden" name="bookingId"     value="${esc(bookingId)}" />
       <input type="hidden" name="amount"        value="${esc(String(amount))}" />
       <input type="hidden" name="originalToken" value="${esc(token)}" />
       <button type="submit" class="green">✅ Confirm &amp; Charge $${esc(String(amount))}</button>
     </form>
     <p style="margin-top:16px"><a href="https://www.slytrans.com/admin-v2/">← Back to Admin Panel</a></p>`
  ));
}

// ── Confirm POST handler (from approve preview page) ─────────────────────────

async function handleConfirmPost(req, res) {
  const body          = req.body || {};
  const bookingId     = String(body.bookingId     || "").trim();
  const amount        = parseFloat(body.amount)       || 0;
  const originalToken = String(body.originalToken || "").trim();

  if (!bookingId || amount <= 0) {
    return res.status(400).send(htmlPage(
      "Error", "#c62828", "❌ Invalid confirmation",
      `<p>The confirmation data is missing or invalid. Please click the Approve link in the original email again.</p>`
    ));
  }

  // Re-verify the original approve token — it must still be valid (not expired)
  const decoded = verifyLateFeeToken(originalToken);
  if (!decoded || decoded.action !== "approve" || decoded.bookingId !== bookingId) {
    return res.status(401).send(htmlPage(
      "Link Expired", "#c62828", "⏰ Link expired or invalid",
      `<p>This confirmation's token has expired. Please click the Approve link in the original email again.</p>`
    ));
  }

  return handleApprove(res, bookingId, decoded.amount, decoded.amount, "admin_link");
}

// ── Adjust POST handler ───────────────────────────────────────────────────────

async function handleAdjustPost(req, res) {
  const body           = req.body || {};
  const bookingId      = String(body.bookingId      || "").trim();
  const originalAmount = parseFloat(body.originalAmount) || 0;
  const newAmount      = parseFloat(body.newAmount)      || 0;
  const originalToken  = String(body.originalToken  || "").trim();

  if (!bookingId || newAmount <= 0 || newAmount > 5000) {
    return res.status(400).send(htmlPage(
      "Error", "#c62828", "❌ Invalid adjustment",
      `<p>Amount must be between $1 and $5,000. Please go back and try again.</p>`
    ));
  }

  // Verify the original adjust token to authenticate this form submission
  const decoded = verifyLateFeeToken(originalToken);
  if (!decoded || decoded.action !== "adjust" || decoded.bookingId !== bookingId) {
    return res.status(401).send(htmlPage(
      "Link Expired", "#c62828", "⏰ Link expired or invalid",
      `<p>This form's token has expired. Please click the Adjust link in the original email again.</p>`
    ));
  }

  return handleApprove(res, bookingId, newAmount, originalAmount, "admin_link");
}

// ── Shared approve + charge logic ─────────────────────────────────────────────

async function handleApprove(res, bookingId, amount, originalAmount, approvedBy) {
  // ── Idempotency guard 1: booking-level paid status ────────────────────────
  // If the booking is already marked 'paid', no further charge is possible.
  if (await isLateFeeAlreadyPaid(bookingId)) {
    return res.status(200).send(htmlPage(
      "Already Paid", "#1a73e8", "ℹ️ Late Fee Already Paid",
      `<p>The late fee for booking <strong>${esc(bookingId)}</strong> has already been settled.</p>
       <p>No duplicate charge was applied.</p>`
    ));
  }

  // ── Idempotency guard 2: charges table succeeded/pending row ─────────────
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
    // (better to risk a duplicate than block the owner from charging at all —
    // the booking-level paid check above already covers the primary guard).
    console.warn("approve-late-fee: idempotency check failed (non-fatal):", err.message);
  }

  const adjustmentNote = (originalAmount && originalAmount !== amount)
    ? `Late return — approved via admin link (adjusted from $${originalAmount} to $${amount})`
    : "Late return — approved via admin approval link";

  try {
    // Pass approved_by/approved_at as extra metadata for the charges row
    const result = await executeChargeFee({
      bookingId,
      chargeType:           "late_fee",
      amount,
      notes:                adjustmentNote,
      chargedBy:            approvedBy,
      adjustedFromAmount:   (originalAmount && originalAmount !== amount) ? originalAmount : undefined,
    });

    // Mark booking as fully paid (not just approved) so no further charge can be issued
    await updateLateFeeStatus(bookingId, "paid", approvedBy);

    await sendResultEmail(
      `[Sly Rides] ✅ Late Fee Charged — Booking ${bookingId}`,
      `<h2>Late Fee Charged Successfully</h2>
       <p>A late fee of <strong>$${esc(String(amount))}</strong> was charged to the customer's card for booking <strong>${esc(bookingId)}</strong>.</p>
       ${originalAmount && originalAmount !== amount ? `<p><em>(Original assessed amount: $${esc(String(originalAmount))})</em></p>` : ""}
       <p>${esc(result.message || "")}</p>
       <p>Confirmation emails have been sent to both you and the customer.</p>`
    );

    return res.status(200).send(htmlPage(
      "Charge Approved", "#4caf50", "✅ Late Fee Charged",
      `<p class="amt">$${esc(String(amount))} charged successfully.</p>
       <p>Booking: <strong>${esc(bookingId)}</strong></p>
       ${originalAmount && originalAmount !== amount ? `<p style="font-size:13px;color:#aaa">(Adjusted from original $${esc(String(originalAmount))})</p>` : ""}
       <p>Confirmation emails have been sent to you and the customer.</p>`
    ));
  } catch (err) {
    console.error("approve-late-fee: charge failed:", err.message);

    // Mark booking as failed (charge was attempted but Stripe rejected it)
    await updateLateFeeStatus(bookingId, "failed", approvedBy);

    // Look up customer phone to send a fallback payment link via SMS
    try {
      const sb = getSupabaseAdmin();
      if (sb) {
        const { data: bk } = await sb
          .from("bookings")
          .select("customers(phone)")
          .eq("booking_ref", bookingId)
          .maybeSingle();
        const phone = bk?.customers?.phone;
        if (phone) {
          await sendCustomerFallbackSms(bookingId, amount, phone);
        }
      }
    } catch (lookupErr) {
      console.warn("approve-late-fee: fallback SMS lookup failed (non-fatal):", lookupErr.message);
    }

    await sendResultEmail(
      `[Sly Rides] ❌ Late Fee Charge Failed — Booking ${bookingId}`,
      `<h2>Late Fee Charge Failed</h2>
       <p>Attempted to charge <strong>$${esc(String(amount))}</strong> for booking <strong>${esc(bookingId)}</strong> — but Stripe returned an error:</p>
       <blockquote>${esc(err.message)}</blockquote>
       <p>A payment link has been sent to the customer as a fallback.</p>
       <p>Please also charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a> if needed.</p>`
    );

    return res.status(200).send(htmlPage(
      "Charge Failed", "#c62828", "❌ Charge Failed",
      `<p>Stripe could not process the late fee for booking <strong>${esc(bookingId)}</strong>.</p>
       <p><em>${esc(err.message)}</em></p>
       <p>A payment link has been sent to the customer as a fallback.</p>
       <p>Please charge manually from the <a href="https://www.slytrans.com/admin-v2/">Admin Panel</a>.</p>`
    ));
  }
}
