// api/_rental-agreement-pdf.js
// Shared helper — generates a PDF rental agreement buffer.
// Imported by both send-reservation-email.js (browser-triggered flow) and
// stripe-webhook.js (server-side webhook flow) so the same document format
// is produced regardless of which path delivers it to the owner.

import PDFDocument from "pdfkit";
import {
  CARS,
  PROTECTION_PLAN_DAILY,
  PROTECTION_PLAN_WEEKLY,
  PROTECTION_PLAN_BIWEEKLY,
  PROTECTION_PLAN_MONTHLY,
  PROTECTION_PLAN_BASIC,
  PROTECTION_PLAN_STANDARD,
  PROTECTION_PLAN_PREMIUM,
} from "./_pricing.js";

/**
 * Return the liability cap dollar amount for a given economy DPP tier.
 * Basic → $2,500  |  Standard → $1,000  |  Premium → $500
 * @param {string|undefined} tier
 * @returns {string}
 */
export function dppTierLiabilityCap(tier) {
  if (tier === "basic")   return "$2,500";
  if (tier === "premium") return "$500";
  return "$1,000";
}

/**
 * Generate a PDF rental agreement buffer from the booking data.
 * Returns a Promise<Buffer> containing the PDF bytes.
 *
 * @param {object} body         - booking data (same shape as send-reservation-email body)
 * @param {string} [ipAddress]  - customer IP address captured server-side
 * @param {string} [cardLast4]  - last 4 digits of the card used for payment (if available)
 * @returns {Promise<Buffer>}
 */
export function generateRentalAgreementPdf(body, ipAddress, cardLast4) {
  return new Promise((resolve, reject) => {
    const {
      vehicleId, car, vehicleMake, vehicleModel, vehicleYear, vehicleVin, vehicleColor,
      name, email, phone,
      pickup, pickupTime, returnDate, returnTime,
      total, deposit, days, protectionPlan, protectionPlanTier, signature,
      fullRentalCost, balanceAtPickup,
      insuranceCoverageChoice,
    } = body;

    const signedAt = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "long",
      timeStyle: "short",
    });

    const carInfo = (vehicleId && CARS[vehicleId]) ? CARS[vehicleId] : null;
    const isHourly = !!(carInfo && carInfo.hourlyTiers);
    const dppRatesText = `$${PROTECTION_PLAN_DAILY}/day  •  $${PROTECTION_PLAN_WEEKLY}/week  •  $${PROTECTION_PLAN_BIWEEKLY}/2 wks  •  $${PROTECTION_PLAN_MONTHLY}/month`;
    const pdfTierLabel = protectionPlanTier === "basic" ? "Basic ($15/day)"
      : protectionPlanTier === "premium" ? "Premium ($50/day)"
      : "Standard ($30/day)";
    const pdfTierLiabilityCap = dppTierLiabilityCap(protectionPlanTier);
    const insuranceSummary = isHourly
      ? (insuranceCoverageChoice === "no"
          ? "Option B: No personal insurance — Damage Protection Plan included"
          : "Option A: Renter has own insurance (proof required at pickup)")
      : (protectionPlan
          ? `Damage Protection Plan selected — ${pdfTierLabel}`
          : "Renter provided personal rental car insurance");
    const durationLine = days ? `${days} day${Number(days) !== 1 ? "s" : ""}` : "";

    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const BRAND_BLACK = "#111111";
    const SECTION_GRAY = "#555555";
    const TABLE_HEADER_BG = "#f0f0f0";
    const LINE_COLOR = "#cccccc";
    const GREEN = "#2e7d32";
    const PAGE_WIDTH = doc.page.width - 100; // margins on both sides

    function sectionHeader(text) {
      doc.moveDown(0.4)
        .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(LINE_COLOR).lineWidth(0.5).stroke()
        .moveDown(0.2)
        .font("Helvetica-Bold").fontSize(10).fillColor(BRAND_BLACK)
        .text(text.toUpperCase())
        .moveDown(0.15);
      doc.font("Helvetica").fontSize(9).fillColor(BRAND_BLACK);
    }

    function tableRow(label, value) {
      const rowY = doc.y;
      const labelW = PAGE_WIDTH * 0.4;
      const valueW = PAGE_WIDTH * 0.6;
      const rowH = 18;

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

    function bulletList(items) {
      items.forEach(item => {
        doc.font("Helvetica").fontSize(8.5).fillColor(BRAND_BLACK)
          .text(`  •  ${item}`, { lineGap: 1 });
      });
    }

    // ── Header ─────────────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_BLACK)
      .text("SLY TRANSPORTATION SERVICES — CAR RENTAL AGREEMENT", { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor(SECTION_GRAY)
      .text(`Generated: ${signedAt} (Pacific Time)`, { align: "center" });
    doc.moveDown(0.5);

    // ── Parties ────────────────────────────────────────────────────────────────
    sectionHeader("Parties");
    bodyText(`Owner:   SLY Transportation Services — (844) 511-4059 — info@slytrans.com`);
    bodyText(`Renter:  ${name || "Not provided"}`);

    // ── Renter Information ─────────────────────────────────────────────────────
    sectionHeader("Renter Information");
    tableRow("Full Name", name || "Not provided");
    tableRow("Email", email || "Not provided");
    tableRow("Phone", phone || "Not provided");

    // ── Vehicle Information ────────────────────────────────────────────────────
    sectionHeader("Vehicle Information");
    tableRow("Vehicle", car || "");
    if (vehicleMake)  tableRow("Make",       vehicleMake);
    if (vehicleModel) tableRow("Model",      vehicleModel);
    if (vehicleYear)  tableRow("Year",       String(vehicleYear));
    if (vehicleVin)   tableRow("VIN / Plate", vehicleVin);
    if (vehicleColor) tableRow("Color",      vehicleColor);
    doc.moveDown(0.3);
    bodyText("Fuel Level at Pickup:  Full   Half   Quarter       Condition Photos Attached: Yes");

    // ── Rental Period ──────────────────────────────────────────────────────────
    sectionHeader("Rental Period");
    tableRow("Pickup Date", pickup || "");
    tableRow("Pickup Time", pickupTime || "Not specified");
    tableRow("Return Date", returnDate || "");
    tableRow("Return Time", returnTime || "Not specified");
    if (durationLine) tableRow("Duration", durationLine);
    tableRow("Total Charged", `$${total || "TBD"}`);
    if (!isHourly && balanceAtPickup) tableRow("Balance Due at Pickup", `$${balanceAtPickup}`);
    tableRow("Insurance / Protection", insuranceSummary);
    doc.moveDown(0.3);
    bodyText(isHourly ? "Late Fee: $100/hour after a 30-minute grace period." : "Late Fee: $50/day after a 2-hour grace period.");

    // ── Mileage & Fuel ─────────────────────────────────────────────────────────
    sectionHeader("Mileage, Geographic Use & Fuel");
    bodyText("Mileage & Geographic Limit: Unlimited miles are included within a designated local area only. All vehicle use must remain within Los Angeles County or within a 50-mile radius of Los Angeles, unless otherwise approved in writing by the host. Travel outside this area — including trips to San Diego, San Francisco, Las Vegas, or any out-of-state destination — is not allowed without prior written authorization. Unauthorized use outside the approved area will result in a $500 penalty fee and may lead to early termination of the rental without refund. The vehicle is equipped with a GPS tracking system for security and compliance; by renting, you consent to location monitoring during the rental period.");
    doc.moveDown(0.2);
    bodyText("Fuel Policy: Return the vehicle with the same fuel level as at pickup, or pay a $5/gallon replacement fee.");

    // ── Deposit / Pricing ──────────────────────────────────────────────────────
    sectionHeader("Deposit & Protection Plan");
    if (isHourly && carInfo) {
      bodyText(`Security Deposit: A refundable security deposit equal to your rental fee is included in your total payment. Released within 5–7 business days after return and inspection with no issues. May be retained to cover damages, loss of use, cleaning, tolls, or fuel.`);
      doc.moveDown(0.2);
      if (insuranceCoverageChoice === "no") {
        bodyText(`Option B selected: No personal insurance — Damage Protection Plan automatically included.`);
        doc.moveDown(0.1);
        bodyText(`Damage Protection Plan (${dppRatesText}): included — reduces your damage liability to $1,000.`);
      } else {
        bodyText(`Option A selected: Renter provided own insurance. Proof of insurance must be presented at pickup.`);
      }
    } else {
      bodyText("No security deposit is required for this vehicle.");
    }
    if (!isHourly) {
      doc.moveDown(0.2);
      const tierRatesText = `Basic — $${PROTECTION_PLAN_BASIC}/day  •  Standard — $${PROTECTION_PLAN_STANDARD}/day  •  Premium — $${PROTECTION_PLAN_PREMIUM}/day`;
      bodyText(`Damage Protection Plan (${tierRatesText}): optional add-on — reduces your damage liability.`);
    }

    // ── Insurance & Liability ──────────────────────────────────────────────────
    sectionHeader("Insurance & Liability");
    bodyText("Renter must provide one of the following prior to vehicle release:");
    bulletList([
      "Valid personal auto insurance covering rental vehicles (proof required), OR",
      "Purchase of SLY Transportation Services Damage Protection Plan",
    ]);
    doc.moveDown(0.2);
    bodyText(`Damage Protection Plan (Optional): Basic — $${PROTECTION_PLAN_BASIC}/day  •  Standard — $${PROTECTION_PLAN_STANDARD}/day  •  Premium — $${PROTECTION_PLAN_PREMIUM}/day`);
    doc.moveDown(0.1);
    bodyText("This plan reduces the renter's financial responsibility for covered vehicle damage per incident. Liability cap depends on plan selected (Basic: $2,500 / Standard: $1,000 / Premium: $500).");
    doc.moveDown(0.2);
    bodyText("Without Protection Plan: Renter is fully responsible for all damages and associated costs, including:");
    bulletList(["Full cost of vehicle repair or replacement", "Loss of use (rental downtime)", "Diminished value", "Administrative, towing, and storage fees"]);
    doc.moveDown(0.2);
    bodyText("With Protection Plan: Renter's maximum liability for covered vehicle damage is limited to " + (isHourly ? "$1,000" : pdfTierLiabilityCap) + " per incident. Any damage costs exceeding this cap are covered by the plan, provided all terms of this agreement are followed.");
    doc.moveDown(0.2);
    bodyText("Exclusions (Protection Plan Void If):");
    bulletList([
      "Driver is under the influence of drugs or alcohol",
      "Unauthorized driver operates the vehicle",
      "Reckless, illegal, or negligent use",
      "Off-road or prohibited use",
      "Failure to report damage within 24 hours",
      "Violation of rental agreement terms",
    ]);
    doc.moveDown(0.2);
    bodyText("Third-Party Liability: Renter is solely responsible for any third-party claims, including bodily injury, property damage, or death. SLY Transportation Services is not liable for renter negligence. Renter agrees to indemnify and hold harmless SLY Transportation Services from any claims, losses, or expenses arising from vehicle use.");

    // ── Use Restrictions ───────────────────────────────────────────────────────
    sectionHeader("Use Restrictions");
    bodyText("Renter agrees to all of the following restrictions:");
    bodyText("No smoking  ·  No pets  ·  No off-road use  ·  No subleasing");
    bodyText("Approved drivers only  ·  No racing or towing  ·  No commercial hauling");

    // ── Condition Inspection ───────────────────────────────────────────────────
    sectionHeader("Condition Inspection");
    bodyText("Vehicle is inspected and accepted as-is at time of pickup. Condition photos are taken at pickup. Renter must report any pre-existing damage within 24 hours of pickup.");

    // ── Termination ────────────────────────────────────────────────────────────
    sectionHeader("Termination");
    bodyText("SLY Transportation Services may terminate this agreement immediately for breach of terms, unpaid fees, unlawful use, or safety violations. Renter is liable for all costs to recover the vehicle.");

    // ── Payment Terms ──────────────────────────────────────────────────────────
    sectionHeader("Payment Terms");
    if (isHourly) {
      bodyText(`Full payment (including a refundable security deposit equal to your rental fee) was charged at the time of booking. The security deposit will be released within 5–7 business days after return and inspection with no issues. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.`);
    } else {
      bodyText("All fees are due at pickup. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.");
    }
    doc.moveDown(0.1);
    bodyText("⚠ No-Refund Policy: All payments are final once a booking is confirmed. Cancellations or no-shows after booking are not eligible for a refund. Refunds may be issued only if SLY Transportation cancels or cannot fulfill the rental.");

    // ── Payment Authorization & Chargeback Policy ──────────────────────────────
    sectionHeader("Payment Authorization & Chargeback Policy");
    bodyText("By signing this agreement, renter expressly authorizes SLY Transportation Services to charge the payment method on file for all amounts owed, including:");
    bulletList([
      "Rental charges and extensions",
      "Security deposit and any applicable deductions",
      "Vehicle damage, repair, or replacement costs",
      "Loss of use and diminished value",
      "Fuel, cleaning, smoking, or excess wear fees",
      "Towing, storage, tickets, tolls, and administrative fees",
    ]);
    doc.moveDown(0.2);
    bodyText("Renter acknowledges that all charges are valid, agreed upon, and authorized under this contract and agrees not to initiate a chargeback for any legitimate charge.");
    doc.moveDown(0.1);
    bodyText("In the event of a payment dispute or chargeback:");
    bulletList([
      "This signed agreement serves as binding proof of authorization",
      "SLY Transportation Services may submit this agreement and supporting records as evidence",
      "Renter remains financially responsible for all charges including dispute fees",
    ]);

    // ── Governing Law ──────────────────────────────────────────────────────────
    sectionHeader("Governing Law");
    bodyText("This agreement is governed by the laws of the State of California. Disputes shall be resolved in the courts of Los Angeles County.");

    // ── Electronic Signature Block ─────────────────────────────────────────────
    doc.moveDown(0.5);
    const sigBoxY = doc.y;
    doc.rect(50, sigBoxY, PAGE_WIDTH, 130).fill("#f9f9f9").strokeColor(BRAND_BLACK).lineWidth(1).stroke();
    doc.y = sigBoxY + 10;

    doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND_BLACK)
      .text("ELECTRONIC SIGNATURE", 60, doc.y);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8.5).fillColor(BRAND_BLACK)
      .text("By typing their name below, the renter agrees to all terms of this Rental Agreement. This electronic signature is legally binding. By signing, the renter confirms they are 21 years of age or older and have full legal capacity to enter into this agreement.", 60, doc.y, { width: PAGE_WIDTH - 20 });
    doc.moveDown(0.5);

    doc.font("Helvetica-BoldOblique").fontSize(18).fillColor(BRAND_BLACK)
      .text(signature || "", 60, doc.y);
    doc.moveDown(0.2);

    const underlineY = doc.y - 2;
    doc.moveTo(60, underlineY).lineTo(50 + PAGE_WIDTH - 10, underlineY)
      .strokeColor("#555555").lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica-Bold").fontSize(9).fillColor(GREEN)
      .text("✓ Digitally Signed", 60, doc.y);
    doc.moveDown(0.25);

    doc.font("Helvetica").fontSize(8).fillColor(SECTION_GRAY)
      .text(`Signed: ${signedAt} (Pacific Time)`, 60, doc.y);
    doc.moveDown(0.1);
    doc.text(`Renter: ${name || "Not provided"}  |  Email: ${email || "Not provided"}  |  Phone: ${phone || "Not provided"}`, 60, doc.y, { width: PAGE_WIDTH - 20 });

    if (ipAddress) {
      doc.moveDown(0.1);
      doc.text(`IP Address: ${ipAddress}`, 60, doc.y);
    }
    if (cardLast4) {
      doc.moveDown(0.1);
      doc.text(`Card (last 4): ••••  ••••  ••••  ${cardLast4}`, 60, doc.y);
    }

    doc.end();
  });
}
