// api/_extension-email.js
// Shared helpers for rental-extension confirmation emails and PDF generation.
// Imported by both stripe-webhook.js (webhook path) and
// send-extension-confirmation.js (client-triggered path).

import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { CARS } from "./_pricing.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

/**
 * Escape HTML special characters to prevent XSS in email templates.
 * @param {string} str
 * @returns {string}
 */
export function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generate a PDF Rental Extension Agreement for the given extension.
 * Returns a Promise<Buffer> of the PDF bytes.
 */
export function generateExtensionAgreementPdf({
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

    const BRAND_BLACK     = "#111111";
    const SECTION_GRAY    = "#555555";
    const TABLE_HEADER_BG = "#f0f0f0";
    const LINE_COLOR      = "#cccccc";
    const GREEN           = "#2e7d32";
    const PAGE_WIDTH      = doc.page.width - 100;

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

    // ── Header ──────────────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_BLACK)
      .text("SLY TRANSPORTATION SERVICES — RENTAL EXTENSION AGREEMENT", { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor(SECTION_GRAY)
      .text(`Issued: ${issuedAt} (Pacific Time)`, { align: "center" });
    doc.moveDown(0.5);

    // ── Notice ──────────────────────────────────────────────────────────────────
    doc.rect(50, doc.y, PAGE_WIDTH, 36).fill("#fffde7").strokeColor("#f9a825").lineWidth(0.5).stroke();
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#e65100")
      .text("This is an official extension to an existing rental agreement. All original rental terms and conditions remain in full force. The renter\u2019s prior electronic signature on the original agreement covers this extension.", 55, doc.y + 6, { width: PAGE_WIDTH - 10 });
    doc.moveDown(0.5);

    // ── Parties ─────────────────────────────────────────────────────────────────
    sectionHeader("Parties");
    bodyText("Owner:   SLY Transportation Services \u2014 (213) 916-6606 \u2014 info@slytrans.com");
    bodyText(`Renter:  ${renterName || "Not provided"}`);

    // ── Renter Information ───────────────────────────────────────────────────────
    sectionHeader("Renter Information");
    tableRow("Full Name", renterName  || "Not provided");
    tableRow("Email",     renterEmail || "Not provided");
    tableRow("Phone",     renterPhone || "Not provided");

    // ── Vehicle Information ──────────────────────────────────────────────────────
    sectionHeader("Vehicle Information");
    tableRow("Vehicle", vehicleName);

    // ── Original Rental Period ───────────────────────────────────────────────────
    sectionHeader("Original Rental Period");
    tableRow("Pickup Date",          pickupDate         || "Not provided");
    tableRow("Pickup Time",          pickupTime         || "Not specified");
    tableRow("Original Return Date", originalReturnDate || "Not provided");

    // ── Extension Details ────────────────────────────────────────────────────────
    sectionHeader("Extension Details");
    tableRow("Extension",         extensionLabel  || "");
    tableRow("New Return Date",   newReturnDate   || "");
    tableRow("New Return Time",   newReturnTime   || "Not specified");
    tableRow("Extension Amount",  `$${extensionAmount || "0.00"}`);
    tableRow("Stripe Payment ID", paymentIntentId || "");
    if (extensionCount) tableRow("Extension #", String(extensionCount));
    doc.moveDown(0.3);
    bodyText("\u26a0  Please return the vehicle by the new return date and time listed above. Late returns will be charged at the standard late fee rate per the original rental agreement.");

    // ── Terms Carry-Over ─────────────────────────────────────────────────────────
    sectionHeader("Applicable Terms");
    bodyText("All terms and conditions from the original signed rental agreement continue to apply during the extension period, including but not limited to:");
    [
      "Mileage and geographic restrictions (Los Angeles County / 50-mile radius)",
      "Fuel policy (return with the same fuel level as at pickup)",
      "No smoking, no pets, no off-road use, no subleasing",
      "Late fee: $50/day (economy) after grace period",
      "Payment authorization for all charges under the original agreement",
      "Damage liability and any applicable Protection Plan coverage",
    ].forEach(item => {
      doc.font("Helvetica").fontSize(8.5).fillColor(BRAND_BLACK)
        .text(`  \u2022  ${item}`, { lineGap: 1 });
    });
    doc.moveDown(0.3);
    bodyText("The renter\u2019s prior electronic signature on the original rental agreement constitutes acceptance of these extension terms and authorizes SLY Transportation Services to charge the payment method on file for the extension amount shown above, as well as any additional fees incurred during the extension period.");

    // ── Chargeback Acknowledgment ────────────────────────────────────────────────
    sectionHeader("Payment Authorization");
    bodyText(`The extension payment of $${extensionAmount || "0.00"} was charged via Stripe (Payment ID: ${paymentIntentId || "N/A"}). By completing this payment, the renter confirms authorization of this charge and all associated costs for the extension period. Renter agrees not to dispute or reverse this charge.`);

    // ── Governing Law ────────────────────────────────────────────────────────────
    sectionHeader("Governing Law");
    bodyText("This extension is governed by the laws of the State of California. Disputes shall be resolved in the courts of Los Angeles County.");

    // ── Footer ───────────────────────────────────────────────────────────────────
    doc.moveDown(0.6);
    doc.rect(50, doc.y, PAGE_WIDTH, 48).fill("#f9f9f9").strokeColor(BRAND_BLACK).lineWidth(1).stroke();
    const footerY = doc.y + 8;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GREEN)
      .text("\u2713 Extension Payment Confirmed \u2014 Original Signature on File", 60, footerY);
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
export async function sendExtensionConfirmationEmails({
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
    console.warn("_extension-email: SMTP not configured — skipping extension email");
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

  // ── Generate updated rental agreement PDF ──────────────────────────────────
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
    console.log(`_extension-email: extension agreement PDF generated for PI ${paymentIntent.id}`);
  } catch (pdfErr) {
    console.error("_extension-email: extension PDF generation failed (non-fatal):", pdfErr.message);
  }

  const pdfAttachment = pdfBuffer
    ? [{ filename: `Rental-Agreement-Extension-${updatedReturnDate || "updated"}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
    : [];

  // ── Owner notification ─────────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from:        `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to:          OWNER_EMAIL,
      ...(renterEmail ? { replyTo: renterEmail } : {}),
      subject:     `\u23f1\ufe0f Rental Extension Confirmed \u2014 ${esc(vehicleName)} \u2014 ${esc(renterName || "Renter")}`,
      attachments: pdfAttachment,
      html: `
        <h2>\u23f1\ufe0f Rental Extension Confirmed</h2>
        ${pdfBuffer ? "<p>\ud83d\udcc4 <strong>Updated Rental Agreement is attached.</strong></p>" : ""}
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
        "\u23f1\ufe0f Rental Extension Confirmed",
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
    console.log(`_extension-email: extension owner email sent for PI ${paymentIntent.id}`);
  } catch (ownerEmailErr) {
    console.error("_extension-email: extension owner email failed:", ownerEmailErr.message);
  }

  // ── Renter confirmation ────────────────────────────────────────────────────
  if (renterEmail) {
    try {
      await transporter.sendMail({
        from:        `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
        to:          renterEmail,
        subject:     "\u2705 Rental Extension Confirmed \u2014 Sly Transportation Services LLC",
        attachments: pdfAttachment,
        html: `
          <h2>\u2705 Rental Extension Confirmed</h2>
          <p>Hi ${esc(renterName ? renterName.split(" ")[0] : "there")}, your rental extension payment has been received!</p>
          ${pdfBuffer ? "<p>\ud83d\udcc4 <strong>Your updated Rental Agreement is attached \u2014 please save it for your records.</strong></p>" : ""}
          <table style="border-collapse:collapse;width:100%;margin-top:12px">
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleName)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Extension</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(extensionLabel)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>New Return Date</strong></td><td style="padding:8px;border:1px solid #ddd"><strong style="color:#4caf50">${esc(newReturnDisplay)}</strong></td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(amountDollars)}</strong></td></tr>
          </table>
          <p style="margin-top:16px">Your rental period has been updated. Please return the vehicle by <strong>${esc(newReturnDisplay)}</strong>.</p>
          <p>If you have any questions, please contact us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a> or call <a href="tel:+12139166606">(213) 916-6606</a>.</p>
          <p><strong>Sly Transportation Services LLC \ud83d\ude97</strong></p>
        `,
        text: [
          "\u2705 Rental Extension Confirmed \u2014 Sly Transportation Services LLC",
          "",
          `Hi ${renterName ? renterName.split(" ")[0] : "there"}, your rental extension payment has been received!`,
          pdfBuffer ? "Your updated Rental Agreement is attached \u2014 please save it for your records." : "",
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
      console.log(`_extension-email: extension renter email sent to ${renterEmail} for PI ${paymentIntent.id}`);
    } catch (renterEmailErr) {
      console.error("_extension-email: extension renter email failed:", renterEmailErr.message);
    }
  }
}
