// api/stripe-webhook.js
// Vercel serverless function — Stripe webhook handler.
//
// Handles the payment_intent.succeeded event fired when a PaymentIntent
// (created by create-payment-intent.js or pay-balance.js) is confirmed.
// This is the server-side authoritative fallback for availability updates —
// it runs even if the user closes the browser before success.html completes.
//
// Required environment variables (set in Vercel dashboard):
//   STRIPE_SECRET_KEY      — starts with sk_live_ or sk_test_
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe dashboard
//     (Stripe CLI for local testing: stripe listen --forward-to localhost:3000/api/stripe-webhook)
//
// Register this endpoint in the Stripe dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://sly-rides.vercel.app/api/stripe-webhook
//   Events: payment_intent.succeeded

import Stripe from "stripe";
import crypto from "crypto";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { updateBooking, loadBookings, saveBookings, normalizePhone, appendBooking } from "./_bookings.js";
import { sendSms } from "./_textmagic.js";
import { render, EXTEND_CONFIRMED_SLINGSHOT, EXTEND_CONFIRMED_ECONOMY, DEFAULT_LOCATION } from "./_sms-templates.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { hasOverlap } from "./_availability.js";
import { autoCreateRevenueRecord, autoUpsertCustomer, autoUpsertBooking, autoCreateBlockedDate, autoActivateIfPickupArrived } from "./_booking-automation.js";
import { CARS } from "./_pricing.js";

// Disable Vercel's built-in body parser so we can pass the raw request body
// to stripe.webhooks.constructEvent() for signature verification.
export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
const FLEET_STATUS_PATH  = "fleet-status.json";

/**
 * Read booked-dates.json from GitHub and block the given date range.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function blockBookedDates(vehicleId, from, to) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping date blocking");
    return;
  }
  if (!vehicleId || !from || !to) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadBookedDates() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      return { data: {}, sha: null }; // non-fatal: don't throw, keep existing dates
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch {
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveBookedDates(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:  loadBookedDates,
    apply: (data) => {
      if (!data[vehicleId]) data[vehicleId] = [];
      // Skip if this exact range is already recorded (idempotency guard)
      if (!hasOverlap(data[vehicleId], from, to)) {
        data[vehicleId].push({ from, to });
      }
    },
    save:    saveBookedDates,
    message: `Block dates for ${vehicleId}: ${from} to ${to} (webhook)`,
  });
}

/**
 * Mark a vehicle as unavailable in fleet-status.json on GitHub.
 * Mirrors the same logic used by send-reservation-email.js.
 */
async function markVehicleUnavailable(vehicleId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("stripe-webhook: GITHUB_TOKEN not set — skipping fleet-status update");
    return;
  }
  if (!vehicleId) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadFleetStatus() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      return { data: {}, sha: null }; // non-fatal
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    } catch (parseErr) {
      console.error("stripe-webhook: malformed JSON in fleet-status.json, resetting:", parseErr);
      data = {};
    }
    return { data, sha: file.sha };
  }

  async function saveFleetStatus(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:  loadFleetStatus,
    apply: (data) => {
      if (!data[vehicleId]) data[vehicleId] = {};
      data[vehicleId].available = false;
    },
    save:    saveFleetStatus,
    message: `Mark ${vehicleId} unavailable after confirmed booking (webhook)`,
  });
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
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
 * Save a booking record to bookings.json and Supabase from PaymentIntent metadata.
 *
 * This is the guaranteed server-side path for every new booking — it fires on
 * every payment_intent.succeeded event, meaning bookings land in the admin
 * portal automatically without requiring the browser to complete success.html.
 * appendBooking() is idempotent: it deduplicates by paymentIntentId so a
 * double-save with the browser-side record is always safe.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function saveWebhookBookingRecord(paymentIntent) {
  const meta = paymentIntent.metadata || {};
  const {
    booking_id,
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
    protection_plan_tier,
  } = meta;

  if (!vehicle_id || !pickup_date || !return_date) {
    console.log("stripe-webhook: skipping booking record — missing vehicle/dates in metadata");
    return;
  }

  const amountPaid  = paymentIntent.amount ? Math.round(paymentIntent.amount) / 100 : 0;
  const totalPrice  = full_rental_amount ? Math.round(parseFloat(full_rental_amount) * 100) / 100 : amountPaid;
  const status      = payment_type === "reservation_deposit" ? "reserved_unpaid" : "booked_paid";

  const bookingRecord = {
    bookingId:           booking_id || ("wh-" + crypto.randomBytes(8).toString("hex")),
    name:                renter_name || "",
    phone:               renter_phone ? normalizePhone(renter_phone) : "",
    email:               email || "",
    vehicleId:           vehicle_id,
    vehicleName:         vehicle_name || vehicle_id,
    pickupDate:          pickup_date,
    pickupTime:          pickup_time  || "",
    returnDate:          return_date,
    returnTime:          return_time  || "",
    location:            DEFAULT_LOCATION,
    status,
    amountPaid,
    totalPrice,
    paymentIntentId:     paymentIntent.id,
    paymentMethod:       "stripe",
    stripeCustomerId:    paymentIntent.customer   || null,
    stripePaymentMethodId: paymentIntent.payment_method || null,
    ...(protection_plan_tier ? { protectionPlanTier: protection_plan_tier } : {}),
    smsSentAt:           {},
    createdAt:           new Date().toISOString(),
    source:              "stripe_webhook",
  };

  try {
    await appendBooking(bookingRecord);
    console.log(`stripe-webhook: booking record saved for PI ${paymentIntent.id} (${vehicle_id})`);
  } catch (err) {
    console.error("stripe-webhook: saveWebhookBookingRecord error:", err.message);
  }

  // Non-fatal Supabase sync — this is what the admin portal reads via list action
  try {
    await autoCreateRevenueRecord(bookingRecord);
    await autoUpsertCustomer(bookingRecord, false);
    await autoUpsertBooking(bookingRecord);
    if (bookingRecord.pickupDate && bookingRecord.returnDate) {
      await autoCreateBlockedDate(bookingRecord.vehicleId, bookingRecord.pickupDate, bookingRecord.returnDate, "booking");
    }
  } catch (err) {
    console.error("stripe-webhook: Supabase sync error:", err.message);
  }

  // If the booking is fully paid and the pickup time has already arrived
  // (e.g. same-day rental), immediately transition to active_rental without
  // waiting for the next 15-minute cron cycle.
  if (bookingRecord.status === "booked_paid") {
    try {
      await autoActivateIfPickupArrived(bookingRecord);
    } catch (err) {
      console.error("stripe-webhook: autoActivateIfPickupArrived error (non-fatal):", err.message);
    }
  }
}

/**
 * Generate a PDF Rental Extension Agreement for the given extension.
 * Returns a Promise<Buffer> of the PDF bytes.
 */
function generateExtensionAgreementPdf({
  vehicleId,
  renterName,
  renterEmail,
  renterPhone,
  pickupDate,
  pickupTime,
  originalReturnDate,
  newReturnDate,
  newReturnTime,
  extensionLabel,
  extensionAmount,
  paymentIntentId,
  extensionCount,
}) {
  return new Promise((resolve, reject) => {
    const issuedAt = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "long",
      timeStyle: "short",
    });

    const carInfo = (vehicleId && CARS[vehicleId]) ? CARS[vehicleId] : null;
    const vehicleName = (carInfo && carInfo.name) || vehicleId || "Vehicle";

    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const BRAND_BLACK   = "#111111";
    const SECTION_GRAY  = "#555555";
    const TABLE_HEADER_BG = "#f0f0f0";
    const LINE_COLOR    = "#cccccc";
    const GREEN         = "#2e7d32";
    const PAGE_WIDTH    = doc.page.width - 100;

    function sectionHeader(text) {
      doc.moveDown(0.4)
        .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
        .strokeColor(LINE_COLOR).lineWidth(0.5).stroke()
        .moveDown(0.2)
        .font("Helvetica-Bold").fontSize(10).fillColor(BRAND_BLACK)
        .text(text.toUpperCase())
        .moveDown(0.15);
      doc.font("Helvetica").fontSize(9).fillColor(BRAND_BLACK);
    }

    function tableRow(label, value) {
      const rowY   = doc.y;
      const labelW = PAGE_WIDTH * 0.4;
      const valueW = PAGE_WIDTH * 0.6;
      const rowH   = 18;
      doc.rect(50, rowY, labelW, rowH).fill(TABLE_HEADER_BG);
      doc.rect(50 + labelW, rowY, valueW, rowH).fill("#ffffff");
      doc.rect(50, rowY, PAGE_WIDTH, rowH).strokeColor(LINE_COLOR).lineWidth(0.5).stroke();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND_BLACK)
        .text(label, 55, rowY + 4, { width: labelW - 10 });
      doc.font("Helvetica").fontSize(8.5).fillColor(BRAND_BLACK)
        .text(String(value || ""), 55 + labelW, rowY + 4, { width: valueW - 10 });
      doc.y = rowY + rowH;
    }

    function bodyText(text) {
      doc.font("Helvetica").fontSize(8.5).fillColor(BRAND_BLACK).text(text, { lineGap: 2 });
    }

    // ── Header ────────────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_BLACK)
      .text("SLY TRANSPORTATION SERVICES — RENTAL EXTENSION AGREEMENT", { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor(SECTION_GRAY)
      .text(`Issued: ${issuedAt} (Pacific Time)`, { align: "center" });
    doc.moveDown(0.5);

    // ── Notice ────────────────────────────────────────────────────────────────
    doc.rect(50, doc.y, PAGE_WIDTH, 36).fill("#fffde7").strokeColor("#f9a825").lineWidth(0.5).stroke();
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#e65100")
      .text("This is an official extension to an existing rental agreement. All original rental terms and conditions remain in full force. The renter's prior electronic signature on the original agreement covers this extension.", 55, doc.y + 6, { width: PAGE_WIDTH - 10 });
    doc.moveDown(0.5);

    // ── Parties ───────────────────────────────────────────────────────────────
    sectionHeader("Parties");
    bodyText("Owner:   SLY Transportation Services — (213) 916-6606 — info@slytrans.com");
    bodyText(`Renter:  ${renterName || "Not provided"}`);

    // ── Renter Information ────────────────────────────────────────────────────
    sectionHeader("Renter Information");
    tableRow("Full Name", renterName || "Not provided");
    tableRow("Email",     renterEmail || "Not provided");
    tableRow("Phone",     renterPhone || "Not provided");

    // ── Vehicle Information ───────────────────────────────────────────────────
    sectionHeader("Vehicle Information");
    tableRow("Vehicle", vehicleName);

    // ── Original Rental Period ────────────────────────────────────────────────
    sectionHeader("Original Rental Period");
    tableRow("Pickup Date",          pickupDate        || "Not provided");
    tableRow("Pickup Time",          pickupTime        || "Not specified");
    tableRow("Original Return Date", originalReturnDate || "Not provided");

    // ── Extension Details ─────────────────────────────────────────────────────
    sectionHeader("Extension Details");
    tableRow("Extension",         extensionLabel  || "");
    tableRow("New Return Date",   newReturnDate   || "");
    tableRow("New Return Time",   newReturnTime   || "Not specified");
    tableRow("Extension Amount",  `$${extensionAmount || "0.00"}`);
    tableRow("Stripe Payment ID", paymentIntentId || "");
    if (extensionCount) tableRow("Extension #", String(extensionCount));
    doc.moveDown(0.3);
    bodyText("⚠  Please return the vehicle by the new return date and time listed above. Late returns will be charged at the standard late fee rate per the original rental agreement.");

    // ── Terms Carry-Over ──────────────────────────────────────────────────────
    sectionHeader("Applicable Terms");
    bodyText("All terms and conditions from the original signed rental agreement continue to apply during the extension period, including but not limited to:");
    [
      "Mileage and geographic restrictions (Los Angeles County / 50-mile radius)",
      "Fuel policy (return with the same fuel level as at pickup)",
      "No smoking, no pets, no off-road use, no subleasing",
      "Late fee: $50/day (economy) or $100/hour (Slingshot) after grace period",
      "Payment authorization for all charges under the original agreement",
      "Damage liability and any applicable Protection Plan coverage",
    ].forEach(item => {
      doc.font("Helvetica").fontSize(8.5).fillColor(BRAND_BLACK)
        .text(`  •  ${item}`, { lineGap: 1 });
    });
    doc.moveDown(0.3);
    bodyText("The renter's prior electronic signature on the original rental agreement constitutes acceptance of these extension terms and authorizes SLY Transportation Services to charge the payment method on file for the extension amount shown above, as well as any additional fees incurred during the extension period.");

    // ── Chargeback Acknowledgment ─────────────────────────────────────────────
    sectionHeader("Payment Authorization");
    bodyText(`The extension payment of $${extensionAmount || "0.00"} was charged via Stripe (Payment ID: ${paymentIntentId || "N/A"}). By completing this payment, the renter confirms authorization of this charge and all associated costs for the extension period. Renter agrees not to dispute or reverse this charge.`);

    // ── Governing Law ─────────────────────────────────────────────────────────
    sectionHeader("Governing Law");
    bodyText("This extension is governed by the laws of the State of California. Disputes shall be resolved in the courts of Los Angeles County.");

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveDown(0.6);
    doc.rect(50, doc.y, PAGE_WIDTH, 48).fill("#f9f9f9").strokeColor(BRAND_BLACK).lineWidth(1).stroke();
    const footerY = doc.y + 8;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GREEN)
      .text("✓ Extension Payment Confirmed — Original Signature on File", 60, footerY);
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(8).fillColor(SECTION_GRAY)
      .text(`Issued: ${issuedAt} (Pacific Time)  |  Renter: ${renterName || "Not provided"}  |  Email: ${renterEmail || "Not provided"}`, 60, doc.y, { width: PAGE_WIDTH - 20 });

    doc.end();
  });
}

/**
 * Send confirmation emails (with updated rental agreement PDF attached) to
 * the owner and renter after a rental extension payment is confirmed.
 *
 * @param {object} opts
 * @param {object} opts.paymentIntent        - Stripe PaymentIntent object
 * @param {object} opts.booking              - booking record from bookings.json
 * @param {string} opts.updatedReturnDate    - new return date (YYYY-MM-DD)
 * @param {string} opts.updatedReturnTime    - new return time (e.g. "3:00 PM")
 * @param {string} opts.extensionLabel       - human-readable label (e.g. "+2 days")
 * @param {string} opts.vehicleId            - vehicle ID
 * @param {string} opts.renterEmail          - renter's email address
 * @param {string} opts.renterName           - renter's name
 * @param {string} opts.originalReturnDate   - return date before this extension
 * @param {number} opts.extensionCount       - running count of extensions (1-based)
 */
async function sendExtensionConfirmationEmails({
  paymentIntent,
  booking,
  updatedReturnDate,
  updatedReturnTime,
  extensionLabel,
  vehicleId,
  renterEmail,
  renterName,
  originalReturnDate,
  extensionCount,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("stripe-webhook: SMTP not configured — skipping extension email");
    return;
  }

  const amountDollars = paymentIntent.amount ? (paymentIntent.amount / 100).toFixed(2) : "N/A";
  const vehicleName   = (paymentIntent.metadata || {}).vehicle_name || vehicleId;

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const newReturnDisplay = updatedReturnDate +
    (updatedReturnTime ? ` at ${updatedReturnTime}` : "");

  // ── Generate updated rental agreement PDF ──────────────────────────────
  let pdfBuffer = null;
  try {
    pdfBuffer = await generateExtensionAgreementPdf({
      vehicleId,
      renterName,
      renterEmail,
      renterPhone:        (booking && booking.phone) || "",
      pickupDate:         (booking && booking.pickupDate) || "",
      pickupTime:         (booking && booking.pickupTime) || "",
      originalReturnDate: originalReturnDate || "",
      newReturnDate:      updatedReturnDate,
      newReturnTime:      updatedReturnTime,
      extensionLabel,
      extensionAmount:    amountDollars,
      paymentIntentId:    paymentIntent.id,
      extensionCount,
    });
    console.log(`stripe-webhook: extension agreement PDF generated for PI ${paymentIntent.id}`);
  } catch (pdfErr) {
    console.error("stripe-webhook: extension PDF generation failed (non-fatal):", pdfErr.message);
  }

  const pdfAttachment = pdfBuffer
    ? [{ filename: `Rental-Agreement-Extension-${updatedReturnDate || "updated"}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
    : [];

  // ── Owner notification ─────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from:        `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:          OWNER_EMAIL,
      ...(renterEmail ? { replyTo: renterEmail } : {}),
      subject:     `⏱️ Rental Extension Confirmed — ${esc(vehicleName)} — ${esc(renterName || "Renter")}`,
      attachments: pdfAttachment,
      html: `
        <h2>⏱️ Rental Extension Confirmed</h2>
        ${pdfBuffer ? "<p>📄 <strong>Updated Rental Agreement is attached.</strong></p>" : ""}
        <table style="border-collapse:collapse;width:100%;margin-top:16px">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterName || "N/A")}</td></tr>
          ${renterEmail ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterEmail)}</td></tr>` : ""}
          ${booking && booking.phone ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(booking.phone)}</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Extension</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(extensionLabel)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>New Return Date</strong></td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#4caf50">${esc(newReturnDisplay)}</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(amountDollars)}</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Stripe Payment ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentIntent.id)}</td></tr>
        </table>
        <p style="margin-top:16px">The booking has been updated with the new return date/time.</p>
      `,
      text: [
        "⏱️ Rental Extension Confirmed",
        pdfBuffer ? "Updated Rental Agreement PDF is attached." : "",
        "",
        `Renter         : ${renterName || "N/A"}`,
        renterEmail ? `Email          : ${renterEmail}` : "",
        booking && booking.phone ? `Phone          : ${booking.phone}` : "",
        `Vehicle        : ${vehicleName}`,
        `Extension      : ${extensionLabel}`,
        `New Return Date: ${newReturnDisplay}`,
        `Amount Charged : $${amountDollars}`,
        `Stripe PI      : ${paymentIntent.id}`,
      ].filter(Boolean).join("\n"),
    });
    console.log(`stripe-webhook: extension owner email sent for PI ${paymentIntent.id}`);
  } catch (ownerEmailErr) {
    console.error("stripe-webhook: extension owner email failed:", ownerEmailErr.message);
  }

  // ── Renter confirmation ────────────────────────────────────────────────
  if (renterEmail) {
    try {
      await transporter.sendMail({
        from:        `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:          renterEmail,
        subject:     "✅ Rental Extension Confirmed — Sly Transportation Services LLC",
        attachments: pdfAttachment,
        html: `
          <h2>✅ Rental Extension Confirmed</h2>
          <p>Hi ${esc(renterName ? renterName.split(" ")[0] : "there")}, your rental extension payment has been received!</p>
          ${pdfBuffer ? "<p>📄 <strong>Your updated Rental Agreement is attached — please save it for your records.</strong></p>" : ""}
          <table style="border-collapse:collapse;width:100%;margin-top:12px">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Extension</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(extensionLabel)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>New Return Date</strong></td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#4caf50">${esc(newReturnDisplay)}</strong></td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(amountDollars)}</strong></td></tr>
          </table>
          <p style="margin-top:16px">Your rental period has been updated. Please return the vehicle by <strong>${esc(newReturnDisplay)}</strong>.</p>
          <p>If you have any questions, please contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
          <p><strong>Sly Transportation Services LLC 🚗</strong></p>
        `,
        text: [
          "✅ Rental Extension Confirmed — Sly Transportation Services LLC",
          "",
          `Hi ${renterName ? renterName.split(" ")[0] : "there"}, your rental extension payment has been received!`,
          pdfBuffer ? "Your updated Rental Agreement is attached — please save it for your records." : "",
          "",
          `Vehicle        : ${vehicleName}`,
          `Extension      : ${extensionLabel}`,
          `New Return Date: ${newReturnDisplay}`,
          `Amount Charged : $${amountDollars}`,
          "",
          `Your rental period has been updated. Please return the vehicle by ${newReturnDisplay}.`,
          `Questions? Contact us at ${OWNER_EMAIL} or call (213) 916-6606.`,
          "",
          "Sly Transportation Services LLC",
        ].filter(Boolean).join("\n"),
      });
      console.log(`stripe-webhook: extension renter email sent to ${renterEmail} for PI ${paymentIntent.id}`);
    } catch (renterEmailErr) {
      console.error("stripe-webhook: extension renter email failed:", renterEmailErr.message);
    }
  }
}

/**
 * Send a server-side fallback notification email to the owner and customer
 * using data extracted from the PaymentIntent metadata.
 *
 * This is the guaranteed backup path that fires even when the customer's
 * browser loses sessionStorage during a 3DS redirect and never calls
 * send-reservation-email.js.
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 */
async function sendWebhookNotificationEmails(paymentIntent) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("stripe-webhook: SMTP not configured — skipping fallback email");
    return;
  }

  const meta = paymentIntent.metadata || {};
  const {
    renter_name,
    renter_phone,
    vehicle_id,
    vehicle_name,
    pickup_date,
    return_date,
    email,
    payment_type,
    full_rental_amount,
    balance_at_pickup,
  } = meta;

  const amountDollars = paymentIntent.amount ? (paymentIntent.amount / 100).toFixed(2) : "N/A";
  const isDepositMode = payment_type === "reservation_deposit";
  const totalLabel    = isDepositMode ? "Booking Deposit Charged" : "Total Charged";
  const totalDisplay  = isDepositMode
    ? `$${amountDollars} (non-refundable deposit — balance due at pickup)`
    : `$${amountDollars}`;

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // ── Owner notification ────────────────────────────────────────────────────
  const ownerSubject = `💰 Payment Confirmed – New Booking: ${esc(vehicle_name || vehicle_id)} (Server Backup)`;
  const ownerHtml = `
    <h2>💰 Payment Confirmed – New Booking (Server-Side Backup Notification)</h2>
    <p><strong>⚠️ This is an automatic server-side backup email.</strong> It fires whenever a payment succeeds on Stripe, regardless of what happened in the customer's browser. If you already received a separate "Payment Confirmed" email with the signed rental agreement, this duplicate can be ignored.</p>
    <table style="border-collapse:collapse;width:100%;margin-top:16px">
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Stripe Payment ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentIntent.id)}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicle_name || vehicle_id || "N/A")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renter_name || "Not provided")}</td></tr>
      ${renter_phone ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renter_phone)}</td></tr>` : ""}
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email || "Not provided")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup_date || "N/A")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(return_date || "N/A")}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalDisplay)}</strong></td></tr>
      ${isDepositMode && full_rental_amount ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(full_rental_amount)}</td></tr>` : ""}
      ${isDepositMode && balance_at_pickup  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balance_at_pickup)}</strong></td></tr>` : ""}
    </table>
    <p style="margin-top:16px">⚠️ <strong>Action required:</strong> The signed rental agreement, renter's ID, and insurance documents are only attached to the full confirmation email sent from the customer's browser. If that email did not arrive, please contact the customer directly at ${esc(email || "the email above")} to collect a signed agreement.</p>
    <p>Dates have been automatically blocked on the booking calendar.</p>
  `;

  try {
    await transporter.sendMail({
      from:    `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:      OWNER_EMAIL,
      ...(email ? { replyTo: email } : {}),
      subject: ownerSubject,
      text:    [
        "Payment Confirmed – New Booking (Server-Side Backup Notification)",
        "",
        "NOTE: This is a server-side backup email. It fires on every confirmed Stripe payment.",
        "If you already received a full confirmation with the signed agreement, this can be ignored.",
        "",
        `Stripe Payment ID  : ${paymentIntent.id}`,
        `Vehicle            : ${vehicle_name || vehicle_id || "N/A"}`,
        `Renter Name        : ${renter_name || "Not provided"}`,
        renter_phone ? `Phone              : ${renter_phone}` : "",
        `Customer Email     : ${email || "Not provided"}`,
        `Pickup Date        : ${pickup_date || "N/A"}`,
        `Return Date        : ${return_date || "N/A"}`,
        `${totalLabel.padEnd(19)}: ${totalDisplay}`,
        isDepositMode && full_rental_amount ? `Full Rental Cost   : $${full_rental_amount}` : "",
        isDepositMode && balance_at_pickup  ? `Balance at Pickup  : $${balance_at_pickup}` : "",
      ].filter(Boolean).join("\n"),
      html: ownerHtml,
    });
    console.log(`stripe-webhook: backup owner email sent for PI ${paymentIntent.id}`);
  } catch (emailErr) {
    console.error("stripe-webhook: backup owner email failed:", emailErr.message);
  }

  // ── Customer confirmation ─────────────────────────────────────────────────
  if (email) {
    const customerSubject = "Your Booking is Confirmed – Sly Transportation Services LLC";
    const customerHtml = `
      <h2>✅ Payment Confirmed – Sly Transportation Services LLC</h2>
      <p>Hi ${esc(renter_name ? renter_name.split(" ")[0] : "there")}, your payment has been received and your booking is confirmed!</p>
      <table style="border-collapse:collapse;width:100%;margin-top:12px">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicle_name || vehicle_id || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup_date || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(return_date || "N/A")}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalDisplay)}</strong></td></tr>
        ${isDepositMode && full_rental_amount ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(full_rental_amount)}</td></tr>` : ""}
        ${isDepositMode && balance_at_pickup  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balance_at_pickup)}</strong></td></tr>` : ""}
      </table>
      <p style="margin-top:16px">We will be in touch shortly to confirm your rental pick-up details.</p>
      <p>If you have any questions, please contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
      <p><strong>Sly Transportation Services LLC 🚗</strong></p>
    `;
    try {
      await transporter.sendMail({
        from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:      email,
        subject: customerSubject,
        text:    [
          "Payment Confirmed – Sly Transportation Services LLC",
          "",
          `Hi ${renter_name ? renter_name.split(" ")[0] : "there"}, your payment has been received and your booking is confirmed!`,
          "",
          `Vehicle            : ${vehicle_name || vehicle_id || "N/A"}`,
          `Pickup Date        : ${pickup_date || "N/A"}`,
          `Return Date        : ${return_date || "N/A"}`,
          `${totalLabel.padEnd(19)}: ${totalDisplay}`,
          isDepositMode && full_rental_amount ? `Full Rental Cost   : $${full_rental_amount}` : "",
          isDepositMode && balance_at_pickup  ? `Balance at Pickup  : $${balance_at_pickup}` : "",
          "",
          "We will be in touch shortly to confirm your rental pick-up details.",
          `If you have any questions contact us at ${OWNER_EMAIL} or call (213) 916-6606.`,
          "",
          "Sly Transportation Services LLC",
        ].filter(Boolean).join("\n"),
        html: customerHtml,
      });
      console.log(`stripe-webhook: backup customer email sent to ${email} for PI ${paymentIntent.id}`);
    } catch (custErr) {
      console.error("stripe-webhook: backup customer email failed:", custErr.message);
    }
  }
}

/**
 * Read the raw request body from a Node.js IncomingMessage stream.
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).send("Server configuration error");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET environment variable is not set");
    return res.status(500).send("Server configuration error");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;

    // Handle rental extension payment confirmations.
    if ((paymentIntent.metadata || {}).payment_type === "rental_extension") {
      const {
        vehicle_id,
        original_booking_id,
        renter_name,
        renter_email,
        extension_label,
        new_return_date,
        new_return_time,
      } = paymentIntent.metadata || {};

      if (vehicle_id && original_booking_id) {
        try {
          const { data, sha } = await loadBookings();
          if (Array.isArray(data[vehicle_id])) {
            const idx = data[vehicle_id].findIndex(
              (b) => b.bookingId === original_booking_id || b.paymentIntentId === original_booking_id
            );
            if (idx !== -1) {
              const booking = data[vehicle_id][idx];
              // Use extensionPendingPayment from booking record if available,
              // otherwise fall back to PI metadata (for web-initiated extensions
              // where the booking update may not have completed yet).
              const ext = booking.extensionPendingPayment || (new_return_date ? {
                newReturnDate: new_return_date,
                newReturnTime: new_return_time || "",
                label:         extension_label || "",
              } : null);

              if (ext) {
                const updatedReturnDate = ext.newReturnDate || booking.returnDate;
                const updatedReturnTime = ext.newReturnTime || booking.returnTime;
                const oldReturnDate     = booking.returnDate;
                const pickupDate        = booking.pickupDate;
                data[vehicle_id][idx].returnDate = updatedReturnDate;
                data[vehicle_id][idx].returnTime = updatedReturnTime;
                data[vehicle_id][idx].extensionPendingPayment = null;
                data[vehicle_id][idx].extensionCount = (booking.extensionCount || 0) + 1;
                await saveBookings(data, sha, `Confirm extension for booking ${original_booking_id}`);

                // Sync updated return date to Supabase bookings table
                try {
                  await autoUpsertBooking(data[vehicle_id][idx]);
                } catch (syncErr) {
                  console.error("stripe-webhook: Supabase extension sync error (non-fatal):", syncErr.message);
                }

                // Update booked-dates.json: replace old range with the extended range.
                // The old range (pickupDate → oldReturnDate) is removed and the new
                // range (pickupDate → updatedReturnDate) is added so that:
                //   • the "Next Available" badge on cars.html shows the correct date
                //   • the availability calendar blocks the full extended period
                if (pickupDate && updatedReturnDate) {
                  try {
                    await blockBookedDates(vehicle_id, pickupDate, updatedReturnDate);
                    console.log(`stripe-webhook: booked-dates.json updated for extension ${vehicle_id}: ${pickupDate} → ${updatedReturnDate}`);
                  } catch (bdErr) {
                    console.error("stripe-webhook: booked-dates.json extension update failed (non-fatal):", bdErr.message);
                  }
                }

                // Update Supabase blocked_dates: replace old end date with new one.
                // autoCreateBlockedDate uses upsert so it will insert or update in place.
                if (pickupDate && updatedReturnDate) {
                  try {
                    await autoCreateBlockedDate(vehicle_id, pickupDate, updatedReturnDate, "booking");
                    console.log(`stripe-webhook: Supabase blocked_dates updated for extension ${vehicle_id}: ${pickupDate} → ${updatedReturnDate}`);
                  } catch (sbBlockErr) {
                    console.error("stripe-webhook: Supabase blocked_dates extension update failed (non-fatal):", sbBlockErr.message);
                  }
                }

                // Send extension confirmed SMS
                if (booking.phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
                  const isSlingshot = vehicle_id && vehicle_id.startsWith("slingshot");
                  const template = isSlingshot ? EXTEND_CONFIRMED_SLINGSHOT : EXTEND_CONFIRMED_ECONOMY;
                  const vars = {
                    return_time: updatedReturnTime,
                    return_date: updatedReturnDate,
                  };
                  try {
                    await sendSms(normalizePhone(booking.phone), render(template, vars));
                  } catch (smsErr) {
                    console.error("stripe-webhook: extension confirmed SMS failed:", smsErr.message);
                  }
                }

                // Send extension confirmation emails (with updated agreement PDF) to owner and renter
                try {
                  await sendExtensionConfirmationEmails({
                    paymentIntent,
                    booking,
                    updatedReturnDate,
                    updatedReturnTime,
                    extensionLabel:     ext.label || extension_label || "",
                    vehicleId:          vehicle_id,
                    renterEmail:        booking.email || renter_email || "",
                    renterName:         booking.name  || renter_name  || "",
                    originalReturnDate: oldReturnDate,
                    extensionCount:     data[vehicle_id][idx].extensionCount,
                  });
                } catch (emailErr) {
                  console.error("stripe-webhook: extension email failed (non-fatal):", emailErr.message);
                }
              }
            }
          }
        } catch (err) {
          console.error("stripe-webhook: extension confirmation error:", err);
        }
      }
      return res.status(200).json({ received: true });
    }

    // Skip balance payments — dates were already blocked when the deposit was paid.
    if ((paymentIntent.metadata || {}).payment_type === "balance_payment") {
      console.log(
        `stripe-webhook: balance_payment for PaymentIntent ${paymentIntent.id} — skipping date blocking`
      );
      // Update booking status to booked_paid when full balance is paid
      const { vehicle_id } = paymentIntent.metadata || {};
      const originalPiId = (paymentIntent.metadata || {}).original_payment_intent_id ||
        (paymentIntent.metadata || {}).deposit_payment_intent_id;
      if (vehicle_id && originalPiId) {
        try {
          await updateBooking(vehicle_id, originalPiId, { status: "booked_paid" });
          // Sync the status change to Supabase bookings table
          const { data: updatedData } = await loadBookings();
          const updatedBooking = (updatedData[vehicle_id] || []).find(
            (b) => b.bookingId === originalPiId || b.paymentIntentId === originalPiId
          );
          if (updatedBooking) {
            await autoUpsertBooking(updatedBooking);
            // Auto-activate if the renter's pickup time has already arrived —
            // e.g. they paid the balance on the day of pickup.
            try {
              await autoActivateIfPickupArrived(updatedBooking);
            } catch (activErr) {
              console.error("stripe-webhook: autoActivateIfPickupArrived (balance) error (non-fatal):", activErr.message);
            }
          }
        } catch (err) {
          console.error("stripe-webhook: updateBooking (balance) error:", err);
        }
      }
      return res.status(200).json({ received: true });
    }

    // ── Slingshot security-deposit-only payment ───────────────────────────────
    // When a renter pays only the security deposit, we:
    //   1. Block the dates (vehicle is now reserved).
    //   2. Save the booking record with payment_status = "deposit_paid".
    //   3. Generate a unique payment_link_token and store it in the booking.
    //   4. Send email + SMS to the customer with the completion link.
    if ((paymentIntent.metadata || {}).payment_type === "slingshot_security_deposit") {
      const meta = paymentIntent.metadata || {};
      const {
        vehicle_id, pickup_date, return_date,
        renter_name, renter_phone, email,
        rental_price, security_deposit, remaining_balance,
        full_rental_amount, rental_duration,
      } = meta;

      console.log(
        `stripe-webhook: slingshot_security_deposit — vehicle=${vehicle_id} pi=${paymentIntent.id}`
      );

      // Block dates so the vehicle shows as reserved
      if (vehicle_id && pickup_date && return_date) {
        try {
          await blockBookedDates(vehicle_id, pickup_date, return_date);
        } catch (err) {
          console.error("stripe-webhook: blockBookedDates (slingshot deposit) error:", err);
        }
      }

      // Generate a unique token for the completion link
      const paymentLinkToken = crypto.randomBytes(24).toString("hex");

      // Persist the booking record with the token and deposit-paid status
      const amountPaid = paymentIntent.amount ? Math.round(paymentIntent.amount) / 100 : 0;
      const bookingRecord = {
        bookingId:                meta.booking_id || ("wh-" + crypto.randomBytes(8).toString("hex")),
        name:                     renter_name || "",
        phone:                    renter_phone ? normalizePhone(renter_phone) : "",
        email:                    email || "",
        vehicleId:                vehicle_id,
        vehicleName:              meta.vehicle_name || vehicle_id,
        pickupDate:               pickup_date,
        pickupTime:               meta.pickup_time || "",
        returnDate:               return_date,
        returnTime:               meta.return_time || "",
        location:                 DEFAULT_LOCATION,
        status:                   "reserved_unpaid",
        paymentStatus:            "deposit_paid",
        slingshot_payment_status: "deposit_paid",
        bookingStatus:            "reserved",
        slingshot_booking_status: "reserved",
        rentalPrice:              Number(rental_price || 0),
        securityDeposit:          Number(security_deposit || 0),
        amountPaid,
        remainingBalance:         Number(remaining_balance || rental_price || 0),
        fullRentalAmount:         Number(full_rental_amount || 0),
        rentalDuration:           rental_duration || "",
        paymentIntentId:          paymentIntent.id,
        paymentLinkToken,
        paymentMethod:            "stripe",
        stripeCustomerId:         paymentIntent.customer          || null,
        stripePaymentMethodId:    paymentIntent.payment_method    || null,
        smsSentAt:                {},
        createdAt:                new Date().toISOString(),
        source:                   "stripe_webhook",
      };

      try {
        await appendBooking(bookingRecord);
        console.log(`stripe-webhook: slingshot deposit booking saved (PI ${paymentIntent.id})`);
      } catch (err) {
        console.error("stripe-webhook: slingshot deposit booking save error:", err.message);
      }

      // Supabase sync
      try {
        await autoUpsertCustomer(bookingRecord, false);
        await autoUpsertBooking(bookingRecord);
        if (pickup_date && return_date) {
          await autoCreateBlockedDate(vehicle_id, pickup_date, return_date, "booking");
        }
      } catch (err) {
        console.error("stripe-webhook: slingshot deposit Supabase sync error:", err.message);
      }

      // Build the completion link
      const completionLink = `https://www.slytrans.com/complete-booking.html?token=${paymentLinkToken}`;

      // Send email to customer with completion link
      if (email && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          await sendSlingshotDepositEmail({
            to:              email,
            renterName:      renter_name || "",
            vehicleName:     meta.vehicle_name || vehicle_id,
            pickupDate:      pickup_date,
            returnDate:      return_date,
            rentalDuration:  rental_duration || "",
            securityDeposit: amountPaid,
            remainingBalance: Number(remaining_balance || rental_price || 0),
            completionLink,
          });
        } catch (emailErr) {
          console.error("stripe-webhook: slingshot deposit customer email error:", emailErr.message);
        }
      }

      // Send owner notification email
      try {
        await sendSlingshotDepositOwnerEmail({
          renterName:      renter_name || "",
          renterPhone:     renter_phone || "",
          renterEmail:     email || "",
          vehicleName:     meta.vehicle_name || vehicle_id,
          pickupDate:      pickup_date,
          returnDate:      return_date,
          rentalDuration:  rental_duration || "",
          securityDeposit: amountPaid,
          remainingBalance: Number(remaining_balance || rental_price || 0),
          completionLink,
          paymentIntentId: paymentIntent.id,
        });
      } catch (ownerEmailErr) {
        console.error("stripe-webhook: slingshot deposit owner email error:", ownerEmailErr.message);
      }

      // Send SMS to customer with completion link
      if (renter_phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
        try {
          const smsText = `Your Slingshot booking is reserved! Complete your payment here: ${completionLink}`;
          await sendSms(normalizePhone(renter_phone), smsText);
          console.log(`stripe-webhook: slingshot deposit SMS sent to ${renter_phone}`);
        } catch (smsErr) {
          console.error("stripe-webhook: slingshot deposit SMS error:", smsErr.message);
        }
      }

      return res.status(200).json({ received: true });
    }

    // ── Slingshot balance completion payment ─────────────────────────────────
    // When a renter pays the remaining rental balance via the complete-booking page.
    if ((paymentIntent.metadata || {}).payment_type === "slingshot_balance_payment") {
      const meta = paymentIntent.metadata || {};
      const { vehicle_id, payment_link_token, renter_name, email, renter_phone } = meta;

      console.log(
        `stripe-webhook: slingshot_balance_payment — vehicle=${vehicle_id} pi=${paymentIntent.id}`
      );

      // Update the booking record: fully_paid, remaining_balance = 0
      if (vehicle_id && payment_link_token) {
        try {
          const { data: bkData } = await loadBookings();
          const list = Array.isArray(bkData[vehicle_id]) ? bkData[vehicle_id] : [];
          const booking = list.find((b) => b.paymentLinkToken === payment_link_token);
          if (booking) {
            const bookingId = booking.bookingId || booking.paymentIntentId;
            await updateBooking(vehicle_id, bookingId, {
              status:                   "booked_paid",
              paymentStatus:            "fully_paid",
              slingshot_payment_status: "fully_paid",
              bookingStatus:            "reserved",
              slingshot_booking_status: "reserved",
              remainingBalance:         0,
              completionPaymentIntentId: paymentIntent.id,
              completedAt:              new Date().toISOString(),
            });
            console.log(`stripe-webhook: slingshot balance booking updated to fully_paid (${bookingId})`);

            // Send confirmation email to customer
            if ((email || booking.email) && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
              try {
                await sendSlingshotFullyPaidEmail({
                  to:          email || booking.email,
                  renterName:  renter_name || booking.name || "",
                  vehicleName: meta.vehicle_name || booking.vehicleName || vehicle_id,
                  pickupDate:  meta.pickup_date  || booking.pickupDate,
                  returnDate:  meta.return_date  || booking.returnDate,
                  amountPaid:  paymentIntent.amount ? (paymentIntent.amount / 100) : 0,
                });
              } catch (emailErr) {
                console.error("stripe-webhook: slingshot balance paid email error:", emailErr.message);
              }
            }

            // Send confirmation SMS
            const phone = renter_phone || booking.phone;
            if (phone && process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
              try {
                const vehicleName = meta.vehicle_name || booking.vehicleName || "Slingshot";
                await sendSms(normalizePhone(phone), `✅ Payment complete! Your ${vehicleName} rental is fully booked. See you at pickup. – Sly Rides`);
              } catch (smsErr) {
                console.error("stripe-webhook: slingshot balance SMS error:", smsErr.message);
              }
            }
          }
        } catch (err) {
          console.error("stripe-webhook: slingshot balance booking update error:", err);
        }
      }

      return res.status(200).json({ received: true });
    }

    const { vehicle_id, pickup_date, return_date } = paymentIntent.metadata || {};

    console.log(
      `stripe-webhook: payment_intent.succeeded — vehicle=${vehicle_id} ` +
      `pickup=${pickup_date} return=${return_date} pi=${paymentIntent.id}`
    );

    // Block the booked dates and mark the vehicle unavailable.
    if (vehicle_id && pickup_date && return_date) {
      try {
        await blockBookedDates(vehicle_id, pickup_date, return_date);
      } catch (err) {
        console.error("stripe-webhook: blockBookedDates error:", err);
      }
      try {
        await markVehicleUnavailable(vehicle_id);
      } catch (err) {
        console.error("stripe-webhook: markVehicleUnavailable error:", err);
      }
    }

    // Send server-side backup notification emails to the owner and customer.
    // These fire on every confirmed payment as a guaranteed fallback for the
    // browser-side send-reservation-email call (which can fail if the customer's
    // sessionStorage is lost during a 3DS redirect or if the browser is closed
    // before success.html completes).
    try {
      await sendWebhookNotificationEmails(paymentIntent);
    } catch (emailErr) {
      console.error("stripe-webhook: sendWebhookNotificationEmails error:", emailErr.message);
    }

    // Save a booking record from PI metadata — fallback for when success.html
    // never completes (lost sessionStorage, browser closed, 3DS redirect).
    // appendBooking() is idempotent (deduplicates on paymentIntentId), so a
    // double-save with the browser-side record is always safe.
    try {
      await saveWebhookBookingRecord(paymentIntent);
    } catch (bookingErr) {
      console.error("stripe-webhook: saveWebhookBookingRecord error:", bookingErr.message);
    }
  }

  return res.status(200).json({ received: true });
}

// ── Slingshot deposit-paid notification email to customer ──────────────────

async function sendSlingshotDepositEmail({
  to, renterName, vehicleName, pickupDate, returnDate, rentalDuration,
  securityDeposit, remainingBalance, completionLink,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const firstName = renterName ? renterName.split(" ")[0] : "there";
  await transporter.sendMail({
    from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
    to,
    subject: "Complete Your Slingshot Booking – Sly Transportation Services LLC",
    html: `
      <h2>🏎️ Your Slingshot is Reserved!</h2>
      <p>Hi ${esc(firstName)},</p>
      <p>Your vehicle has been reserved with a security deposit. To complete your booking, please use the link below:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
        ${rentalDuration ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Duration</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(rentalDuration)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Security Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(securityDeposit.toFixed ? securityDeposit.toFixed(2) : securityDeposit))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Remaining Balance</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(String(remainingBalance.toFixed ? remainingBalance.toFixed(2) : remainingBalance))}</strong></td></tr>
      </table>
      <p><a href="${esc(completionLink)}" style="display:inline-block;background:#ffb400;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:700">Complete Payment →</a></p>
      <p style="color:#aaa;font-size:0.9em">You can complete this now or when you arrive for pickup. Full payment must be completed before the vehicle is handed over.</p>
      <p>If you have any questions, contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
      <p><strong>Sly Transportation Services LLC 🏎️</strong></p>
    `,
    text: [
      "Your Slingshot is Reserved!",
      "",
      `Hi ${firstName},`,
      "Your vehicle has been reserved with a security deposit.",
      "To complete your booking, please use the link below:",
      "",
      `Vehicle            : ${vehicleName}`,
      rentalDuration ? `Duration           : ${rentalDuration}` : "",
      `Pickup Date        : ${pickupDate}`,
      `Return Date        : ${returnDate}`,
      `Security Deposit   : $${typeof securityDeposit === "number" ? securityDeposit.toFixed(2) : securityDeposit}`,
      `Remaining Balance  : $${typeof remainingBalance === "number" ? remainingBalance.toFixed(2) : remainingBalance}`,
      "",
      `Complete Payment: ${completionLink}`,
      "",
      "You can complete this now or when you arrive for pickup.",
      "Full payment must be completed before the vehicle is handed over.",
      "",
      `Questions? Contact ${OWNER_EMAIL} or call (213) 916-6606.`,
      "",
      "Sly Transportation Services LLC",
    ].filter((l) => l !== undefined).join("\n"),
  });
}

// ── Slingshot deposit-paid notification email to owner ────────────────────

async function sendSlingshotDepositOwnerEmail({
  renterName, renterPhone, renterEmail, vehicleName, pickupDate, returnDate,
  rentalDuration, securityDeposit, remainingBalance, completionLink, paymentIntentId,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from:    `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
    to:      OWNER_EMAIL,
    ...(renterEmail ? { replyTo: renterEmail } : {}),
    subject: `🔒 Slingshot Deposit Paid – ${esc(renterName || "New Renter")} (Balance Pending)`,
    html: `
      <h2>🔒 Slingshot Security Deposit Received</h2>
      <p>A renter has paid the security deposit. Remaining balance is pending.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterName || "N/A")}</td></tr>
        ${renterEmail ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterEmail)}</td></tr>` : ""}
        ${renterPhone ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterPhone)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
        ${rentalDuration ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Duration</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(rentalDuration)}</td></tr>` : ""}
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Security Deposit Paid</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(typeof securityDeposit === "number" ? securityDeposit.toFixed(2) : securityDeposit))}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Remaining Balance</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(String(typeof remainingBalance === "number" ? remainingBalance.toFixed(2) : remainingBalance))}</strong></td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Stripe Payment ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentIntentId || "N/A")}</td></tr>
      </table>
      <p>The customer's completion link: <a href="${esc(completionLink)}">${esc(completionLink)}</a></p>
      <p style="color:#ff9800"><strong>⚠️ Full payment must be received before handing over the vehicle.</strong></p>
    `,
    text: [
      "Slingshot Security Deposit Received",
      "",
      `Renter             : ${renterName || "N/A"}`,
      renterEmail ? `Email              : ${renterEmail}` : "",
      renterPhone ? `Phone              : ${renterPhone}` : "",
      `Vehicle            : ${vehicleName}`,
      rentalDuration ? `Duration           : ${rentalDuration}` : "",
      `Pickup Date        : ${pickupDate}`,
      `Return Date        : ${returnDate}`,
      `Security Deposit   : $${typeof securityDeposit === "number" ? securityDeposit.toFixed(2) : securityDeposit}`,
      `Remaining Balance  : $${typeof remainingBalance === "number" ? remainingBalance.toFixed(2) : remainingBalance}`,
      `Stripe PI          : ${paymentIntentId || "N/A"}`,
      "",
      `Completion link: ${completionLink}`,
      "",
      "⚠️ Full payment must be received before handing over the vehicle.",
    ].filter((l) => l !== undefined).join("\n"),
  });
}

// ── Slingshot fully-paid confirmation email to customer ───────────────────

async function sendSlingshotFullyPaidEmail({
  to, renterName, vehicleName, pickupDate, returnDate, amountPaid,
}) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const firstName = renterName ? renterName.split(" ")[0] : "there";
  await transporter.sendMail({
    from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
    to,
    subject: "✅ Slingshot Booking Fully Paid – Sly Transportation Services LLC",
    html: `
      <h2>✅ Your Slingshot Booking is Fully Paid!</h2>
      <p>Hi ${esc(firstName)}, your payment has been received and your booking is complete.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount Paid</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>$${esc(String(typeof amountPaid === "number" ? amountPaid.toFixed(2) : amountPaid))}</strong></td></tr>
      </table>
      <p>See you at pickup! If you have any questions, contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
      <p><strong>Sly Transportation Services LLC 🏎️</strong></p>
    `,
    text: [
      "✅ Your Slingshot Booking is Fully Paid!",
      "",
      `Hi ${firstName}, your payment has been received and your booking is complete.`,
      "",
      `Vehicle     : ${vehicleName}`,
      `Pickup Date : ${pickupDate}`,
      `Return Date : ${returnDate}`,
      `Amount Paid : $${typeof amountPaid === "number" ? amountPaid.toFixed(2) : amountPaid}`,
      "",
      `Questions? Contact ${OWNER_EMAIL} or call (213) 916-6606.`,
      "",
      "Sly Transportation Services LLC",
    ].join("\n"),
  });
}
