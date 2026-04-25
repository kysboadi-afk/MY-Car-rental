// api/charge-fee.js
// Admin-authenticated endpoint that charges a customer's saved card
// (stored during Checkout via setup_future_usage: "off_session") for
// damages, late fees, key replacement, smoking penalties, etc.
//
// POST /api/charge-fee
// Body: {
//   secret:      string,   // ADMIN_SECRET
//   booking_id:  string,   // booking_ref from the bookings table
//   charge_type: string,   // "key_replacement" | "smoking" | "late_fee" | "custom"
//   amount:      number,   // USD amount (overrides predefined fee if provided)
//   notes:       string,   // optional description
//   charged_by:  string,   // "admin" | "ai" (defaults to "admin")
// }
//
// Returns: { success, charge, message }

import Stripe from "stripe";
import nodemailer from "nodemailer";
import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";
import { render, LATE_FEE_APPLIED, POST_RENTAL_CHARGE } from "./_sms-templates.js";
import { normalizePhone } from "./_bookings.js";
import { autoCreateRevenueRecord } from "./_booking-automation.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// ── Predefined fee amounts (USD) ─────────────────────────────────────────────
export const PREDEFINED_FEES = {
  key_replacement: 150,
  smoking:          50,
  // late_fee and custom require an explicit amount from the caller
};

export const CHARGE_TYPE_LABELS = {
  key_replacement: "Key Replacement",
  smoking:         "Smoking Penalty",
  late_fee:        "Late Return Fee",
  custom:          "Additional Charge",
};

// Maps internal charge_type values to Stripe metadata payment_type values.
// These are the canonical payment_type identifiers used in:
//   - Stripe PaymentIntent metadata
//   - stripe-webhook.js routing
//   - revenue_records.type
export const CHARGE_TYPE_TO_PAYMENT_TYPE = {
  late_fee:        "late_fee",
  key_replacement: "lost_key_fee",
  smoking:         "damage_fee",
  custom:          "other_fee",
};

const VALID_CHARGE_TYPES = Object.keys(CHARGE_TYPE_LABELS);

// HTML-escape helper for email templates.
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Core charge logic — shared by the HTTP endpoint and the AI tool in
 * _admin-actions.js.  Returns { success, charge, message } on success or
 * throws on failure.
 *
 * @param {object} params
 * @param {string} params.bookingId   - booking_ref
 * @param {string} params.chargeType  - one of VALID_CHARGE_TYPES
 * @param {number} [params.amount]              - USD; uses predefined fee when omitted
 * @param {string} [params.notes]               - optional note
 * @param {string} [params.chargedBy]           - "admin" | "ai" | "admin_link"
 * @param {number} [params.adjustedFromAmount]  - original assessed amount when admin adjusted
 */
export async function executeChargeFee({ bookingId, chargeType, amount, notes, chargedBy = "admin", adjustedFromAmount }) {
  if (!bookingId) throw new Error("booking_id is required");
  if (!chargeType || !VALID_CHARGE_TYPES.includes(chargeType)) {
    throw new Error(`charge_type must be one of: ${VALID_CHARGE_TYPES.join(", ")}`);
  }

  // Resolve amount: use predefined if not explicitly given
  const resolvedAmount =
    amount !== undefined && amount !== null
      ? Number(amount)
      : PREDEFINED_FEES[chargeType] ?? null;

  if (resolvedAmount === null) {
    throw new Error(`amount is required for charge_type "${chargeType}"`);
  }
  if (isNaN(resolvedAmount) || resolvedAmount <= 0) {
    throw new Error("amount must be a positive number");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured");

  // ── Look up the booking ───────────────────────────────────────────────────
  const { data: booking, error: bkErr } = await sb
    .from("bookings")
    .select(
      "id, booking_ref, stripe_customer_id, stripe_payment_method_id, vehicle_id, " +
      "pickup_date, return_date, customers(name, email, phone)"
    )
    .eq("booking_ref", bookingId)
    .maybeSingle();

  if (bkErr) throw new Error(`Booking lookup failed: ${bkErr.message}`);
  if (!booking) throw new Error(`Booking "${bookingId}" not found`);

  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
    throw new Error(
      "This booking does not have a saved payment method. " +
      "Card saving was added on April 7 2026 — older bookings cannot be charged off-session."
    );
  }

  const renterName  = booking.customers?.name  || "Customer";
  const renterEmail = booking.customers?.email || null;
  const renterPhone = booking.customers?.phone || null;
  const label       = CHARGE_TYPE_LABELS[chargeType] || chargeType;
  const paymentType = CHARGE_TYPE_TO_PAYMENT_TYPE[chargeType] || "other_fee";
  const description = `Sly Transportation Services LLC – ${label}` + (notes ? ` (${notes})` : "");

  // ── Create off-session Stripe PaymentIntent ──────────────────────────────
  const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY);
  const amountCents = Math.round(resolvedAmount * 100);
  let stripePI, stripeStatus, stripeError;
  try {
    stripePI = await stripe.paymentIntents.create({
      amount:         amountCents,
      currency:       "usd",
      customer:       booking.stripe_customer_id,
      payment_method: booking.stripe_payment_method_id,
      confirm:        true,
      off_session:    true,
      description,
      metadata: {
        // Canonical post-rental charge fields (used by stripe-webhook.js routing)
        payment_type: paymentType,
        booking_ref:  bookingId,
        vehicle_id:   booking.vehicle_id || "",
        renter_name:  renterName,
        reason:       notes || label,
        // Legacy fields kept for backward compatibility
        booking_id:   bookingId,
        charge_type:  chargeType,
        notes:        notes || "",
        charged_by:   chargedBy,
      },
    });
    stripeStatus = stripePI.status === "succeeded" ? "succeeded" : "pending";
  } catch (err) {
    stripeStatus = "failed";
    stripeError  = err.message;
  }

  // ── Persist charge record in Supabase ────────────────────────────────────
  const chargeRecord = {
    booking_id:               bookingId,
    charge_type:              chargeType,
    amount:                   resolvedAmount,
    notes:                    notes || null,
    stripe_payment_intent_id: stripePI?.id  || null,
    status:                   stripeStatus,
    charged_by:               chargedBy,
    error_message:            stripeError || null,
    // Approval audit fields (from late-fee approval flow)
    approved_by:              chargedBy || null,
    approved_at:              new Date().toISOString(),
    adjusted_from_amount:     (adjustedFromAmount != null && adjustedFromAmount !== resolvedAmount)
                                ? adjustedFromAmount
                                : null,
  };

  const { data: insertedCharge, error: insertErr } = await sb
    .from("charges")
    .insert(chargeRecord)
    .select()
    .single();

  if (insertErr) {
    console.error("charge-fee: charges insert error (non-fatal):", insertErr.message);
  }

  const charge = insertedCharge || chargeRecord;

  if (stripeStatus === "failed") {
    throw new Error(`Stripe charge failed: ${stripeError}`);
  }

  // ── Send confirmation emails ─────────────────────────────────────────────
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const formattedAmount = `$${resolvedAmount.toFixed(2)}`;
    const chargeIdDisplay = charge.id ? String(charge.id).slice(0, 18) + "…" : "N/A";
    const sharedTable = `
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(bookingId)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterName)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Charge Type</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(label)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount</strong></td><td style="padding:8px;border:1px solid #ddd;color:#e53935"><strong>${esc(formattedAmount)}</strong></td></tr>
        ${notes ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Note</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(notes)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Charge Reference</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(chargeIdDisplay)}</td></tr>
      </table>`;

    const promises = [];

    // Email to renter
    if (renterEmail) {
      promises.push(
        transporter.sendMail({
          from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
          to:      renterEmail,
          subject: `Additional Charge – ${label} | Sly Transportation Services LLC`,
          html: `
            <h2>📋 Additional Charge Notice</h2>
            <p>Hi ${esc(renterName.split(" ")[0])},</p>
            <p>An additional charge of <strong>${esc(formattedAmount)}</strong> has been applied to your rental for <strong>${esc(label)}</strong>.</p>
            ${sharedTable}
            <p>If you have any questions, please contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
            <p><strong>Sly Transportation Services LLC 🚗</strong></p>
          `,
          text: [
            `Additional Charge Notice — Sly Transportation Services LLC`,
            ``,
            `Hi ${renterName.split(" ")[0]},`,
            ``,
            `An additional charge of ${formattedAmount} has been applied to your rental for ${label}.`,
            ``,
            `Booking ID   : ${bookingId}`,
            `Customer     : ${renterName}`,
            `Charge Type  : ${label}`,
            `Amount       : ${formattedAmount}`,
            notes ? `Note         : ${notes}` : "",
            ``,
            `If you have any questions contact us at ${OWNER_EMAIL} or call (213) 916-6606.`,
            ``,
            `Sly Transportation Services LLC`,
          ].filter((l) => l !== undefined).join("\n"),
        }).catch((err) => console.error("charge-fee: renter email failed:", err.message))
      );
    }

    // Email to owner
    if (OWNER_EMAIL) {
      promises.push(
        transporter.sendMail({
          from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
          to:      OWNER_EMAIL,
          subject: `[Admin] Extra Charge Applied – ${label} – ${renterName}`,
          html: `
            <h2>💳 Extra Charge Applied</h2>
            <p>A charge was applied to a customer's card from the <strong>${esc(chargedBy)}</strong> interface.</p>
            ${sharedTable}
            <p><strong>Sly Transportation Services LLC 🚗</strong></p>
          `,
          text: [
            `Extra Charge Applied — Sly Transportation Services LLC`,
            ``,
            `A charge was applied to a customer's card from the ${chargedBy} interface.`,
            ``,
            `Booking ID   : ${bookingId}`,
            `Customer     : ${renterName}`,
            `Charge Type  : ${label}`,
            `Amount       : ${formattedAmount}`,
            notes ? `Note         : ${notes}` : "",
            ``,
            `Sly Transportation Services LLC`,
          ].filter((l) => l !== undefined).join("\n"),
        }).catch((err) => console.error("charge-fee: owner email failed:", err.message))
      );
    }

    await Promise.allSettled(promises);
  }

  // ── Customer SMS notification ─────────────────────────────────────────────
  if (renterPhone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
    try {
      let smsText;
      if (chargeType === "late_fee") {
        smsText = render(LATE_FEE_APPLIED, { late_fee: resolvedAmount.toFixed(2) });
      } else {
        const reasonLine = notes ? `Reason: ${notes}\n` : "";
        smsText = render(POST_RENTAL_CHARGE, {
          charge_label: label,
          amount:       resolvedAmount.toFixed(2),
          reason:       reasonLine,
        });
      }
      await sendSms(normalizePhone(renterPhone), smsText);
    } catch (smsErr) {
      console.error("charge-fee: customer SMS failed (non-fatal):", smsErr.message);
    }
  }

  // ── Create revenue record (idempotent backup; webhook also does this) ──────
  if (stripePI?.id) {
    try {
      const customerId = await (async () => {
        const sbRev = getSupabaseAdmin();
        if (!sbRev) return null;
        const { data } = await sbRev
          .from("customers")
          .select("id")
          .or(
            renterEmail
              ? `email.eq.${renterEmail.trim().toLowerCase()}`
              : `phone.eq.${(renterPhone || "").trim()}`
          )
          .maybeSingle();
        return data?.id || null;
      })();
      await autoCreateRevenueRecord({
        bookingId:       bookingId,
        paymentIntentId: stripePI.id,
        vehicleId:       booking.vehicle_id || "",
        customerId,
        name:            renterName,
        email:           renterEmail || "",
        phone:           renterPhone || "",
        amountPaid:      resolvedAmount,
        paymentMethod:   "stripe",
        type:            paymentType,
        notes:           notes || label,
      }, { strict: false, requireStripeFee: false });
    } catch (revErr) {
      console.error("charge-fee: revenue record creation failed (non-fatal):", revErr.message);
    }
  }

  return {
    success: true,
    charge,
    message: `${label} of ${`$${resolvedAmount.toFixed(2)}`} charged to ${renterName} (booking ${bookingId}).`,
  };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { secret, action, booking_id, charge_type, amount, notes, charged_by } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── List charges ──────────────────────────────────────────────────────────
  if (action === "list") {
    const sb = getSupabaseAdmin();
    if (!sb) return res.status(500).json({ error: "Supabase is not configured" });

    let query = sb
      .from("charges")
      .select("id, booking_id, charge_type, amount, notes, stripe_payment_intent_id, status, charged_by, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (booking_id) query = query.eq("booking_id", booking_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows  = data || [];
    const total = rows.filter((r) => r.status === "succeeded")
                      .reduce((s, r) => s + Number(r.amount || 0), 0);
    return res.status(200).json({ charges: rows, total_charged: Math.round(total * 100) / 100 });
  }

  // ── Apply charge ──────────────────────────────────────────────────────────
  try {
    const result = await executeChargeFee({
      bookingId:   booking_id,
      chargeType:  charge_type,
      amount:      amount !== undefined ? Number(amount) : undefined,
      notes:       notes || "",
      chargedBy:   charged_by || "admin",
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("charge-fee handler error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}
