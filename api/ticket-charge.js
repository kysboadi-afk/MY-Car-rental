// api/ticket-charge.js
// SLYTRANS Fleet Control v2 — Violation Ticket Charge endpoint.
// Charges a renter's saved Stripe card for a violation ticket when the
// transfer-of-liability attempt has been rejected or the admin overrides.
//
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/ticket-charge
// Actions:
//   charge — { secret, action:"charge", ticketId }
//             Attempts an off-session Stripe charge for ticket.amount + admin_fee.
//             Updates ticket charge_status, status, activity_log.
//             Creates a revenue_records row (type=violation_fee).
//             Sends SMS + email notifications.
//
//   retry  — { secret, action:"retry", ticketId }
//             Same as charge but bypasses the "already charged" guard.
//             Used by the admin UI to manually retry a failed charge.
//             Maximum MAX_RETRIES attempts tracked in charge_retry_count.
//
// Safety rules:
//   • Will not charge when status is NOT in ['approved','rejected','charged'] unless forced.
//   • Will not charge a ticket that is already charge_status=succeeded.
//   • Will not charge if renter_responsible=false (admin must explicitly set true first).
//   • Logs all actions to tickets.activity_log.
//   • Inserts revenue_records row on success (type=violation_fee).

import Stripe from "stripe";
import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { sendSms } from "./_textmagic.js";
import { render, VIOLATION_CHARGED, VIOLATION_CHARGE_FAILED } from "./_sms-templates.js";
import { normalizePhone } from "./_bookings.js";
import { loadNumericSetting } from "./_settings.js";
import { autoCreateRevenueRecord } from "./_booking-automation.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Default admin fee when system_settings row is missing
const DEFAULT_ADMIN_FEE = 25;

// Maximum automatic retries before giving up (manual retry still allowed via admin UI)
const MAX_RETRIES = 3;

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, action = "charge", ticketId } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!ticketId) {
    return res.status(400).json({ error: "ticketId is required" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }

  try {
    switch (action) {
      case "charge": return await actionCharge(sb, ticketId, false, res);
      case "retry":  return await actionCharge(sb, ticketId, true,  res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("ticket-charge error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

// ── CHARGE / RETRY ────────────────────────────────────────────────────────────

async function actionCharge(sb, ticketId, isRetry, res) {
  // ── 1. Fetch ticket ────────────────────────────────────────────────────────
  const { data: ticket, error: ticketErr } = await sb
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketErr) throw ticketErr;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  // ── 2. Safety checks ───────────────────────────────────────────────────────
  if (ticket.charge_status === "succeeded") {
    return res.status(409).json({ error: "This ticket has already been charged successfully." });
  }

  const chargeableStatuses = ["approved", "rejected", "charged"];
  if (!isRetry && !chargeableStatuses.includes(ticket.status)) {
    return res.status(400).json({
      error: `Ticket must be in 'approved' or 'rejected' status before charging. Current status: ${ticket.status}. Use action:"retry" to override.`,
    });
  }

  if (!isRetry && ticket.renter_responsible === false) {
    return res.status(400).json({
      error: "renter_responsible is false for this ticket. Set renter_responsible=true before charging.",
    });
  }

  if (!isRetry && ticket.charge_retry_count >= MAX_RETRIES) {
    return res.status(400).json({
      error: `Maximum automatic retries (${MAX_RETRIES}) reached. Use action:"retry" to force a manual attempt.`,
    });
  }
  if (!ticket.booking_ref) {
    return res.status(400).json({ error: "Ticket is not matched to a booking — cannot charge." });
  }

  const { data: booking, error: bkErr } = await sb
    .from("bookings")
    .select(
      "id, booking_ref, stripe_customer_id, stripe_payment_method_id, " +
      "extension_stripe_customer_id, extension_stripe_payment_method_id, " +
      "vehicle_id, customers(id, name, email, phone)"
    )
    .eq("booking_ref", ticket.booking_ref)
    .maybeSingle();

  if (bkErr) throw bkErr;
  if (!booking) {
    return res.status(404).json({ error: `Booking "${ticket.booking_ref}" not found.` });
  }

  // Prefer original booking card; fall back to extension card
  const stripeCustomerId =
    booking.stripe_customer_id      || booking.extension_stripe_customer_id      || null;
  const stripePaymentMethodId =
    booking.stripe_payment_method_id || booking.extension_stripe_payment_method_id || null;

  if (!stripeCustomerId || !stripePaymentMethodId) {
    return res.status(400).json({
      error:
        "No saved payment method found for this booking. " +
        "Card saving was added April 2026 — older bookings cannot be charged off-session.",
    });
  }

  // ── 4. Resolve admin fee from system_settings ─────────────────────────────
  const adminFee = await loadNumericSetting("violation_admin_fee", DEFAULT_ADMIN_FEE);
  const effectiveAdminFee = Number(ticket.admin_fee ?? adminFee);
  const totalAmount = Math.round((Number(ticket.amount) + effectiveAdminFee) * 100) / 100;
  const amountCents = Math.round(totalAmount * 100);

  const renterName  = booking.customers?.name  || "Customer";
  const renterEmail = booking.customers?.email || null;
  const renterPhone = booking.customers?.phone || null;
  const customerId  = booking.customers?.id    || null;

  // ── 5. Create off-session Stripe PaymentIntent ────────────────────────────
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const description =
    `Sly Transportation Services LLC – Violation Ticket #${ticket.ticket_number}` +
    ` (includes $${effectiveAdminFee.toFixed(2)} admin fee)`;

  let stripePI    = null;
  let stripeStatus = "failed";
  let stripeError  = null;

  try {
    stripePI = await stripe.paymentIntents.create({
      amount:         amountCents,
      currency:       "usd",
      customer:       stripeCustomerId,
      payment_method: stripePaymentMethodId,
      confirm:        true,
      off_session:    true,
      description,
      metadata: {
        payment_type:  "violation_fee",
        booking_ref:   ticket.booking_ref,
        ticket_id:     ticket.id,
        ticket_number: ticket.ticket_number,
        vehicle_id:    ticket.vehicle_id || "",
        renter_name:   renterName,
        ticket_amount: String(ticket.amount),
        admin_fee:     String(effectiveAdminFee),
        total_amount:  String(totalAmount),
        // Legacy compat fields
        booking_id:    ticket.booking_ref,
        charge_type:   "violation_fee",
      },
    });
    stripeStatus = stripePI.status === "succeeded" ? "succeeded" : "pending";
  } catch (err) {
    stripeStatus = "failed";
    stripeError  = err.message;
  }

  const now = new Date().toISOString();

  // ── 6. Update ticket ──────────────────────────────────────────────────────
  const newTicketStatus = stripeStatus === "succeeded" ? "charged" : ticket.status;
  const activityLog = Array.isArray(ticket.activity_log) ? [...ticket.activity_log] : [];

  if (stripeStatus === "succeeded") {
    activityLog.push({
      date:   now,
      action: `Charged $${totalAmount.toFixed(2)} (ticket $${Number(ticket.amount).toFixed(2)} + admin fee $${effectiveAdminFee.toFixed(2)})`,
      note:   stripePI?.id || "",
    });
  } else {
    activityLog.push({
      date:   now,
      action: `Charge failed (attempt ${(ticket.charge_retry_count || 0) + 1})`,
      note:   stripeError || "Unknown Stripe error",
    });
  }

  const ticketPatch = {
    charge_status:            stripeStatus,
    status:                   newTicketStatus,
    activity_log:             activityLog,
    charge_retry_count:       (ticket.charge_retry_count || 0) + 1,
    charge_last_attempted_at: now,
  };

  const { data: updatedTicket, error: updateErr } = await sb
    .from("tickets")
    .update(ticketPatch)
    .eq("id", ticketId)
    .select()
    .single();

  if (updateErr) {
    console.error("ticket-charge: ticket update error (non-fatal):", updateErr.message);
  }

  // ── 7. Create revenue record on success ───────────────────────────────────
  if (stripeStatus === "succeeded" && stripePI?.id) {
    try {
      await autoCreateRevenueRecord({
        bookingId:       ticket.booking_ref,
        booking_ref:     ticket.booking_ref,
        paymentIntentId: stripePI.id,
        vehicleId:       ticket.vehicle_id || booking.vehicle_id || "",
        customerId,
        name:            renterName,
        email:           renterEmail || "",
        phone:           renterPhone || "",
        amountPaid:      totalAmount,
        paymentMethod:   "stripe",
        type:            "violation_fee",
        notes:           `Violation ticket #${ticket.ticket_number} — $${ticket.amount} + $${effectiveAdminFee} admin fee`,
      }, { strict: false, requireStripeFee: false });
    } catch (revErr) {
      console.error("ticket-charge: revenue record creation failed (non-fatal):", revErr.message);
    }
  }

  // ── 8. Send SMS notification ──────────────────────────────────────────────
  if (renterPhone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
    try {
      let smsText;
      if (stripeStatus === "succeeded") {
        smsText = render(VIOLATION_CHARGED, {
          amount:        totalAmount.toFixed(2),
          ticket_number: ticket.ticket_number,
        });
      } else {
        smsText = render(VIOLATION_CHARGE_FAILED, {
          ticket_number: ticket.ticket_number,
        });
      }
      await sendSms(normalizePhone(renterPhone), smsText);
    } catch (smsErr) {
      console.error("ticket-charge: SMS failed (non-fatal):", smsErr.message);
    }
  }

  // ── 9. Send email notifications ───────────────────────────────────────────
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const formattedTotal = `$${totalAmount.toFixed(2)}`;
    const violationDate  = ticket.violation_date
      ? new Date(ticket.violation_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "N/A";

    const detailTable = `
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Ticket #</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ticket.ticket_number)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Violation Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(violationDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterName)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(ticket.booking_ref || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Ticket Amount</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(Number(ticket.amount).toFixed(2)))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Admin Fee</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(effectiveAdminFee.toFixed(2)))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Charged</strong></td><td style="padding:8px;border:1px solid #ddd;color:#e53935"><strong>${esc(formattedTotal)}</strong></td></tr>
      </table>`;

    const emailPromises = [];

    if (stripeStatus === "succeeded") {
      // Renter notification
      if (renterEmail) {
        emailPromises.push(
          transporter.sendMail({
            from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
            to:      renterEmail,
            subject: `Violation Charge – $${totalAmount.toFixed(2)} | Sly Transportation Services LLC`,
            html: `
              <h2>\ud83d\udea8 Violation Charge Notice</h2>
              <p>Hi ${esc(renterName.split(" ")[0])},</p>
              <p>A charge of <strong>${esc(formattedTotal)}</strong> has been applied to your card for a violation ticket recorded during your rental.</p>
              ${detailTable}
              <p>Questions? Contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+18332521093">(833) 252-1093</a>.</p>
              <p><strong>Sly Transportation Services LLC \ud83d\ude97</strong></p>
            `,
            text: [
              `Violation Charge Notice — Sly Transportation Services LLC`,
              ``,
              `Hi ${renterName.split(" ")[0]},`,
              ``,
              `A charge of ${formattedTotal} has been applied for violation #${ticket.ticket_number}.`,
              ``,
              `Ticket Amount : $${Number(ticket.amount).toFixed(2)}`,
              `Admin Fee     : $${effectiveAdminFee.toFixed(2)}`,
              `Total         : ${formattedTotal}`,
              `Booking       : ${ticket.booking_ref || "N/A"}`,
              ``,
              `Questions? Call (833) 252-1093 or email ${OWNER_EMAIL}.`,
              ``,
              `Sly Transportation Services LLC`,
            ].join("\n"),
          }).catch((e) => console.error("ticket-charge: renter email failed:", e.message))
        );
      }

      // Owner notification
      if (OWNER_EMAIL) {
        emailPromises.push(
          transporter.sendMail({
            from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
            to:      OWNER_EMAIL,
            subject: `[Admin] Violation Charge Succeeded – ${renterName} – ${formattedTotal}`,
            html: `
              <h2>\u2705 Violation Charge Succeeded</h2>
              <p>A violation ticket charge completed successfully.</p>
              ${detailTable}
              <p><strong>Sly Transportation Services LLC \ud83d\ude97</strong></p>
            `,
          }).catch((e) => console.error("ticket-charge: owner email failed:", e.message))
        );
      }
    } else {
      // Owner-only failure alert
      if (OWNER_EMAIL) {
        emailPromises.push(
          transporter.sendMail({
            from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
            to:      OWNER_EMAIL,
            subject: `[Admin] Violation Charge FAILED – ${renterName} – Ticket #${ticket.ticket_number}`,
            html: `
              <h2>\u274c Violation Charge Failed</h2>
              <p>A violation ticket charge attempt failed.</p>
              ${detailTable}
              <p><strong>Error:</strong> ${esc(stripeError || "Unknown error")}</p>
              <p>Retry count: ${ticketPatch.charge_retry_count}</p>
              <p><strong>Sly Transportation Services LLC \ud83d\ude97</strong></p>
            `,
          }).catch((e) => console.error("ticket-charge: owner failure email failed:", e.message))
        );
      }
    }

    await Promise.allSettled(emailPromises);
  }

  // ── 10. Return result ─────────────────────────────────────────────────────
  if (stripeStatus === "succeeded") {
    return res.status(200).json({
      success: true,
      chargeStatus: "succeeded",
      amount:        totalAmount,
      paymentIntentId: stripePI?.id || null,
      ticket:        updatedTicket || { ...ticket, ...ticketPatch },
      message: `Charged $${totalAmount.toFixed(2)} to ${renterName} for ticket #${ticket.ticket_number}.`,
    });
  } else {
    // HTTP 402 Payment Required — the charge attempt was valid but Stripe declined.
    return res.status(402).json({
      success: false,
      chargeStatus: "failed",
      error:   stripeError || "Unknown Stripe error",
      retryCount: ticketPatch.charge_retry_count,
      ticket:  updatedTicket || { ...ticket, ...ticketPatch },
      message: `Charge failed (attempt ${ticketPatch.charge_retry_count}): ${stripeError}`,
    });
  }
}
