// api/admin-resend-booking.js
// Vercel serverless function — admin-only endpoint to recover and resend the
// owner notification email for bookings where the original email was not sent.
//
// Use this when the Stripe webhook fired but the owner email failed (SMTP down,
// attachment error, rate limit, etc.) or when the pending_booking_docs record
// exists but email_sent stayed false.
//
// POST /api/admin-resend-booking
// Body (JSON):
// {
//   "secret":             "<ADMIN_SECRET>",
//   "payment_intent_id":  "pi_3TPYmRPo7fICjrtZ2ZcU63ZK",   // required
//   "booking_id":         "bk-c0c7138a5d2a",                 // optional override
//   "force":              true                                // skip email_sent guard
// }
//
// Returns:
// {
//   ok: true,
//   booking_id,
//   payment_intent_id,
//   renter_name, renter_email,
//   vehicle, pickup_date, return_date,
//   amount_paid,
//   docs_found: boolean,
//   attachments: string[],   // list of attachment filenames sent
//   email_sent_to: string,   // owner email address
// }

import Stripe from "stripe";
import nodemailer from "nodemailer";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { CARS, computeRentalDays } from "./_pricing.js";
import { loadPricingSettings, computeBreakdownLinesFromSettings } from "./_settings.js";
import { generateRentalAgreementPdf } from "./_rental-agreement-pdf.js";
import { buildUnifiedConfirmationEmail, buildDocumentNotes } from "./_booking-confirmation-template.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

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
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret, payment_intent_id, booking_id: bodyBookingId, force = false } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!payment_intent_id || typeof payment_intent_id !== "string" || !payment_intent_id.trim()) {
    return res.status(400).json({ error: "payment_intent_id is required." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(500).json({ error: "SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS." });
  }

  const piId = payment_intent_id.trim();

  // ── 1. Retrieve PaymentIntent from Stripe ─────────────────────────────────
  let paymentIntent;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    paymentIntent = await stripe.paymentIntents.retrieve(piId);
  } catch (err) {
    return res.status(400).json({ error: `Stripe PaymentIntent lookup failed: ${err.message}` });
  }

  const meta = paymentIntent.metadata || {};
  const booking_id = bodyBookingId || meta.booking_id || piId;
  const {
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    pickup_time,
    return_time,
    email,
    payment_type,
    full_rental_amount,
    balance_at_pickup,
    protection_plan_tier,
  } = meta;

  const amountNumber = paymentIntent.amount ? (paymentIntent.amount / 100) : NaN;
  const isDepositMode = payment_type === "reservation_deposit";

  console.log(`admin-resend-booking: processing PI ${piId} booking_id=${booking_id} renter=${renter_name || "(unknown)"}`);

  // ── 2. Fetch stored docs from Supabase ────────────────────────────────────
  let storedDocs = null;
  const sb = getSupabaseAdmin();
  if (sb && booking_id) {
    try {
      const { data: docsRow } = await sb
        .from("pending_booking_docs")
        .select("*")
        .eq("booking_id", booking_id)
        .maybeSingle();

      if (docsRow) {
        if (docsRow.email_sent && !force) {
          console.log(`admin-resend-booking: owner email already sent for booking_id ${booking_id} (use force=true to override)`);
          return res.status(200).json({
            ok: false,
            skipped: true,
            reason: "owner email was already sent for this booking",
            booking_id,
            payment_intent_id: piId,
            hint: "Pass force=true to override the email_sent guard and resend anyway.",
          });
        }
        storedDocs = docsRow;
        console.log(`admin-resend-booking: found pending_booking_docs for booking_id ${booking_id} email_sent=${docsRow.email_sent}`);
      } else {
        console.warn(`admin-resend-booking: no pending_booking_docs found for booking_id ${booking_id} — will send email without attachments`);
      }
    } catch (docsErr) {
      console.warn("admin-resend-booking: could not retrieve pending_booking_docs (non-fatal):", docsErr.message);
    }
  }

  // ── 3. Build attachments ──────────────────────────────────────────────────
  const attachments = [];

  // Rental agreement PDF (requires stored signature)
  if (storedDocs && storedDocs.signature) {
    try {
      const vehicleInfo = (vehicle_id && CARS[vehicle_id]) ? CARS[vehicle_id] : {};
      const rentalDays = (pickup_date && return_date) ? computeRentalDays(pickup_date, return_date) : 0;
      const hasProtectionPlan = !!protection_plan_tier;

      const pdfBody = {
        vehicleId:    vehicle_id   || "",
        car:          vehicle_name || vehicleInfo.name || vehicle_id || "",
        vehicleMake:  vehicleInfo.make  || null,
        vehicleModel: vehicleInfo.model || null,
        vehicleYear:  vehicleInfo.year  || null,
        vehicleVin:   vehicleInfo.vin   || null,
        vehicleColor: vehicleInfo.color || null,
        name:         renter_name  || "",
        email:        email        || "",
        phone:        renter_phone || "",
        pickup:       pickup_date  || "",
        pickupTime:   pickup_time  || "",
        returnDate:   return_date  || "",
        returnTime:   return_time  || "",
        total:        full_rental_amount || (Number.isFinite(amountNumber) ? amountNumber.toFixed(2) : "0"),
        deposit:      vehicleInfo.deposit || 0,
        days:         rentalDays,
        protectionPlan:          hasProtectionPlan,
        protectionPlanTier:      protection_plan_tier || null,
        signature:               storedDocs.signature,
        fullRentalCost:          full_rental_amount || null,
        balanceAtPickup:         balance_at_pickup  || null,
        insuranceCoverageChoice: storedDocs.insurance_coverage_choice ||
          (hasProtectionPlan ? "no" : "yes"),
      };

      const pdfBuffer = await generateRentalAgreementPdf(pdfBody);
      const safeName  = (renter_name || "renter").replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      const safeDate  = (pickup_date || "booking").replace(/[^0-9-]/g, "");
      attachments.push({
        filename:    `rental-agreement-${safeName}-${safeDate}.pdf`,
        content:     pdfBuffer,
        contentType: "application/pdf",
      });
      console.log(`admin-resend-booking: rental agreement PDF generated for PI ${piId}`);
    } catch (pdfErr) {
      console.error("admin-resend-booking: PDF generation failed (non-fatal):", pdfErr.message);
    }
  }

  // Renter ID photo
  if (storedDocs && storedDocs.id_base64 && storedDocs.id_filename) {
    try {
      attachments.push({
        filename:    storedDocs.id_filename,
        content:     Buffer.from(storedDocs.id_base64, "base64"),
        contentType: storedDocs.id_mimetype || "application/octet-stream",
      });
    } catch (idErr) {
      console.error("admin-resend-booking: ID attachment failed (non-fatal):", idErr.message);
    }
  }

  // Insurance document
  if (storedDocs && storedDocs.insurance_base64 && storedDocs.insurance_filename) {
    try {
      attachments.push({
        filename:    storedDocs.insurance_filename,
        content:     Buffer.from(storedDocs.insurance_base64, "base64"),
        contentType: storedDocs.insurance_mimetype || "application/octet-stream",
      });
    } catch (insErr) {
      console.error("admin-resend-booking: insurance attachment failed (non-fatal):", insErr.message);
    }
  }

  console.log(`admin-resend-booking: attachments built for booking_id ${booking_id}: count=${attachments.length} files=[${attachments.map(a => a.filename).join(", ") || "none"}]`);

  // ── 4. Build pricing breakdown ────────────────────────────────────────────
  let breakdownLines = null;
  try {
    const isHourly = !!(vehicle_id && CARS[vehicle_id] && CARS[vehicle_id].hourlyTiers);
    if (!isHourly && vehicle_id && pickup_date && return_date) {
      const hasProtectionPlan = !!protection_plan_tier;
      const pricingSettings = await loadPricingSettings();
      breakdownLines = computeBreakdownLinesFromSettings(
        vehicle_id,
        pickup_date,
        return_date,
        pricingSettings,
        hasProtectionPlan,
        protection_plan_tier || null
      );
    }
  } catch (err) {
    console.warn("admin-resend-booking: pricing breakdown generation failed (non-fatal):", err.message);
  }

  // ── 5. Resolve insurance status label ─────────────────────────────────────
  const hasProtectionPlan = !!(
    protection_plan_tier ||
    meta.protection_plan === "true" ||
    String(meta.insurance_status || "").toLowerCase() === "no_insurance_dpp"
  );
  let insuranceStatus;
  if (storedDocs?.insurance_coverage_choice === "no") {
    insuranceStatus = "No personal insurance provided (Damage Protection Plan or renter liability applies)";
  } else if (storedDocs?.insurance_coverage_choice === "yes") {
    insuranceStatus = storedDocs.insurance_filename
      ? "Own insurance provided (document attached)"
      : "Own insurance selected (proof not uploaded)";
  } else if (hasProtectionPlan) {
    insuranceStatus = `Protection plan selected (${protection_plan_tier || "tier not specified"})`;
  } else {
    insuranceStatus = "Not selected / No protection plan";
  }

  const missingItemNotes = buildDocumentNotes({
    idUploaded:        !!storedDocs?.id_base64,
    signatureUploaded: !!storedDocs?.signature,
    insuranceUploaded: !!storedDocs?.insurance_base64,
    insuranceExpected: storedDocs?.insurance_coverage_choice === "yes",
  });

  // ── 6. Build and send owner email ─────────────────────────────────────────
  const ownerEmail = buildUnifiedConfirmationEmail({
    audience:           "owner",
    bookingId:          booking_id,
    vehicleName:        vehicle_name,
    vehicleId:          vehicle_id,
    renterName:         renter_name,
    renterEmail:        email,
    renterPhone:        renter_phone,
    pickupDate:         pickup_date,
    pickupTime:         pickup_time,
    returnDate:         return_date,
    returnTime:         return_time,
    amountPaid:         amountNumber,
    totalPrice:         Number(full_rental_amount || amountNumber),
    fullRentalCost:     full_rental_amount || null,
    balanceAtPickup:    balance_at_pickup  || null,
    paymentMethodLabel: isDepositMode
      ? "Website (Stripe) — Reservation deposit"
      : "Website (Stripe)",
    insuranceStatus,
    pricingBreakdownLines: breakdownLines || [],
    missingItemNotes: [
      ...missingItemNotes,
      ...(attachments.length
        ? [`Attachments: ${attachments.map(a => a.filename).join(", ")}`]
        : ["⚠️ No documents attached — pending_booking_docs not found or empty"]),
      `[Recovery email — originally unsent for PI ${piId}]`,
    ],
  });

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  let ownerEmailSent = false;
  try {
    await transporter.sendMail({
      from:        `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:          OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject:     `🔁 [RECOVERED] ${ownerEmail.subject}`,
      attachments: attachments,
      text:        ownerEmail.text,
      html:        ownerEmail.html,
    });
    ownerEmailSent = true;
    console.log(`admin-resend-booking: owner recovery email sent for PI ${piId} to ${OWNER_EMAIL} (docs=${attachments.length > 0})`);
  } catch (emailErr) {
    console.error("admin-resend-booking: owner email failed:", emailErr.message);
    return res.status(500).json({ error: `Failed to send email: ${emailErr.message}` });
  }

  // ── 7. Mark email_sent in Supabase ────────────────────────────────────────
  if (ownerEmailSent && sb && booking_id && storedDocs) {
    try {
      await sb
        .from("pending_booking_docs")
        .update({ email_sent: true })
        .eq("booking_id", booking_id);
      console.log(`admin-resend-booking: marked email_sent=true for booking_id ${booking_id}`);
    } catch (markErr) {
      console.warn("admin-resend-booking: could not mark docs email_sent (non-fatal):", markErr.message);
    }
  }

  return res.status(200).json({
    ok: true,
    booking_id,
    payment_intent_id: piId,
    renter_name: renter_name || null,
    renter_email: email || null,
    vehicle: vehicle_name || vehicle_id || null,
    pickup_date: pickup_date || null,
    return_date: return_date || null,
    amount_paid: Number.isFinite(amountNumber) ? amountNumber : null,
    docs_found: !!storedDocs,
    attachments: attachments.map(a => a.filename),
    email_sent_to: OWNER_EMAIL,
  });
}
