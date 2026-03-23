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
//   STRIPE_SECRET_KEY — used to look up card last4 from a PaymentIntent (optional)
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import Stripe from "stripe";
import { hasOverlap } from "./_availability.js";
import { CARS, PROTECTION_PLAN_DAILY, PROTECTION_PLAN_WEEKLY, PROTECTION_PLAN_BIWEEKLY, PROTECTION_PLAN_MONTHLY, computeBreakdownLines, SLINGSHOT_BOOKING_DEPOSIT, SLINGSHOT_DEPOSIT_WITH_INSURANCE, SLINGSHOT_DEPOSIT_WITHOUT_INSURANCE } from "./_pricing.js";

// Allow larger bodies so the renter's ID photo/PDF and insurance can be attached
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const FLEET_STATUS_PATH = "fleet-status.json";

/**
 * Update booked-dates.json in the GitHub repo to block the reserved dates.
 * Requires GITHUB_TOKEN env var with contents:write permission on the repo.
 * Failures are logged but do not abort the email response.
 */
async function blockBookedDates(vehicleId, from, to) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("GITHUB_TOKEN not set — booked-dates.json will not be updated automatically");
    return;
  }
  if (!vehicleId || !from || !to) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getResp = await fetch(apiUrl, { headers });
  if (!getResp.ok) {
    const errText = await getResp.text();
    throw new Error(`GitHub GET failed: ${getResp.status} ${errText}`);
  }
  const fileData = await getResp.json();

  const current = JSON.parse(
    Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
  );
  if (!current[vehicleId]) current[vehicleId] = [];
  if (hasOverlap(current[vehicleId], from, to)) return;
  current[vehicleId].push({ from, to });

  const updatedContent = Buffer.from(
    JSON.stringify(current, null, 2) + "\n"
  ).toString("base64");

  const putResp = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Block dates for ${vehicleId}: ${from} to ${to}`,
      content: updatedContent,
      sha: fileData.sha,
    }),
  });
  if (!putResp.ok) {
    const errText = await putResp.text();
    throw new Error(`GitHub PUT failed: ${putResp.status} ${errText}`);
  }
}

/**
 * Mark a vehicle as unavailable in fleet-status.json on GitHub.
 * Called automatically after a confirmed booking so the car card on the
 * website switches to the red "Unavailable / Booked" state immediately.
 * Requires GITHUB_TOKEN env var with contents:write permission on the repo.
 * Failures are logged but do not abort the email response.
 */
async function markVehicleUnavailable(vehicleId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("GITHUB_TOKEN not set — fleet-status.json will not be updated automatically");
    return;
  }
  if (!vehicleId) return;

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getResp = await fetch(apiUrl, { headers });
  let current = {};
  let sha = null;
  if (getResp.ok) {
    const fileData = await getResp.json();
    sha = fileData.sha;
    try {
      current = JSON.parse(
        Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
      );
    } catch (parseErr) {
      console.error("markVehicleUnavailable: malformed JSON in fleet-status.json, resetting:", parseErr);
      current = {};
    }
  }

  if (!current[vehicleId]) current[vehicleId] = {};
  // Nothing to do if already marked unavailable
  if (current[vehicleId].available === false) {
    console.log(`markVehicleUnavailable: ${vehicleId} is already unavailable — skipping write`);
    return;
  }
  current[vehicleId].available = false;

  const updatedContent = Buffer.from(
    JSON.stringify(current, null, 2) + "\n"
  ).toString("base64");

  const putBody = {
    message: `Mark ${vehicleId} unavailable after confirmed booking`,
    content: updatedContent,
  };
  if (sha) putBody.sha = sha;

  const putResp = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!putResp.ok) {
    const errText = await putResp.text();
    throw new Error(`GitHub PUT failed (fleet-status): ${putResp.status} ${errText}`);
  }
}

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

/**
 * Build a self-contained HTML document representing the signed rental agreement.
 * This is generated server-side from the verified booking data so it can be
 * attached to the owner confirmation email as a permanent record.
 *
 * @param {object} body - the validated request body from the email handler
 * @returns {string} complete HTML document as a string
 */
function generateRentalAgreementHtml(body) {
  const {
    vehicleId, car, vehicleMake, vehicleModel, vehicleYear, vehicleVin, vehicleColor,
    name, email, phone,
    pickup, pickupTime, returnDate, returnTime,
    total, deposit, days, protectionPlan, signature,
    slingshotDuration,
    fullRentalCost, balanceAtPickup,
    insuranceCoverageChoice, slingshotDepositAmount,
  } = body;

  const signedAt = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "long", timeStyle: "short" });

  // Build the DPP rates label from server-side constants to avoid hardcoding
  const dppRatesText = `$${PROTECTION_PLAN_DAILY}/day &bull; $${PROTECTION_PLAN_WEEKLY}/week &bull; $${PROTECTION_PLAN_BIWEEKLY}/2 wks &bull; $${PROTECTION_PLAN_MONTHLY}/month`;
  const dppRatesTextLong = `$${PROTECTION_PLAN_DAILY}/day &bull; $${PROTECTION_PLAN_WEEKLY}/week &bull; $${PROTECTION_PLAN_BIWEEKLY}/2 weeks &bull; $${PROTECTION_PLAN_MONTHLY}/month`;

  // Deposit / pricing section — matches the logic in car.js openAgreement()
  const carInfo = (vehicleId && CARS[vehicleId]) ? CARS[vehicleId] : null;
  const isHourly = !!(carInfo && carInfo.hourlyTiers);
  let depositSection = "";
  if (isHourly) {
    // Full payment system: security deposit included in total, charged at booking
    const dppLine = protectionPlan
      ? `<p><strong>Damage Protection Plan (${dppRatesText}):</strong> automatically included &mdash; reduces your damage liability to $1,000</p>`
      : "";
    depositSection = `
      <h4>SECURITY DEPOSIT (Refundable)</h4>
      <p>A <strong>$150 refundable security deposit</strong> is included in your total payment. It will be released after the vehicle is returned and inspected with no issues (typically within 5&ndash;7 business days). The deposit may be fully or partially retained to cover damages, loss of use, cleaning, tolls, or fuel.</p>
      <p><strong>Insurance/Protection Choice:</strong> ${insuranceCoverageChoice === "no" ? "Option B — No personal insurance (Damage Protection Plan included)" : "Option A — Renter provided own insurance (proof required at pickup)"}</p>
      ${dppLine}
    `;
  } else {
    depositSection = `
      <p>No security deposit is required for this vehicle.</p>
      <p><strong>Damage Protection Plan (${dppRatesText}):</strong> optional add-on &mdash; reduces your damage liability to $1,000</p>
    `;
  }

  // Insurance / protection plan summary
  const insuranceSummary = isHourly
    ? (insuranceCoverageChoice === "no"
        ? "Option B: No personal insurance — Damage Protection Plan included"
        : "Option A: Renter has own insurance (proof required at pickup)")
    : (protectionPlan
        ? "Damage Protection Plan selected"
        : "Renter provided personal rental car insurance");

  // Slingshot speed policy section
  const speedSection = isHourly ? `
    <h4>SLINGSHOT SPEED POLICY</h4>
    <p><strong>Speed Limit:</strong> The posted speed limit is 65 mph. Renters may not exceed <strong>75 mph</strong> under any circumstances. Exceeding 75 mph at any time constitutes a violation of this agreement.</p>
    <p><strong>Strike Policy:</strong> After two (2) speed or agreement violations ("strikes"), the renter's security deposit becomes <strong>non-refundable</strong>.</p>
  ` : "";

  // Rental duration line
  const durationLine = isHourly && slingshotDuration
    ? (Number(slingshotDuration) >= 48
        ? `${esc(String(Number(slingshotDuration) / 24))}-day rental`
        : `${esc(String(slingshotDuration))}-hour rental`)
    : (days ? `${esc(String(days))} day${Number(days) !== 1 ? "s" : ""}` : "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Signed Rental Agreement — SLY Transportation Services LLC</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 14px; color: #111; margin: 40px; line-height: 1.6; }
    h2 { text-align: center; border-bottom: 2px solid #111; padding-bottom: 8px; }
    h4 { margin-top: 20px; margin-bottom: 4px; border-bottom: 1px solid #ccc; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    td, th { padding: 7px 10px; border: 1px solid #999; }
    th { background: #f0f0f0; text-align: left; width: 40%; }
    .sig-block { background: #f9f9f9; border: 2px solid #111; padding: 16px 20px; margin-top: 30px; }
    .sig-name { font-size: 22px; font-style: italic; font-family: Georgia, serif; border-bottom: 1px solid #555; padding-bottom: 4px; margin: 10px 0 4px; }
    .watermark { color: green; font-size: 13px; font-weight: bold; }
    ul { margin: 4px 0 4px 20px; }
    p { margin: 6px 0; }
  </style>
</head>
<body>
  <h2>SLY TRANSPORTATION SERVICES — CAR RENTAL AGREEMENT</h2>
  <p style="text-align:center;font-size:13px;color:#555">Generated: ${esc(signedAt)} (Pacific Time)</p>

  <h4>PARTIES</h4>
  <p><strong>Owner:</strong> SLY Transportation Services &mdash; (213) 916-6606 &mdash; info@slytrans.com</p>
  <p><strong>Renter:</strong> ${esc(name || "Not provided")}</p>

  <h4>RENTER INFORMATION</h4>
  <table>
    <tr><th>Full Name</th><td>${esc(name || "Not provided")}</td></tr>
    <tr><th>Email</th><td>${esc(email || "Not provided")}</td></tr>
    <tr><th>Phone</th><td>${esc(phone || "Not provided")}</td></tr>
  </table>

  <h4>VEHICLE INFORMATION</h4>
  <table>
    <tr><th>Vehicle</th><td>${esc(car || "")}</td></tr>
    ${vehicleMake  ? `<tr><th>Make</th><td>${esc(vehicleMake)}</td></tr>`  : ""}
    ${vehicleModel ? `<tr><th>Model</th><td>${esc(vehicleModel)}</td></tr>` : ""}
    ${vehicleYear  ? `<tr><th>Year</th><td>${esc(String(vehicleYear))}</td></tr>` : ""}
    ${vehicleVin   ? `<tr><th>VIN / Plate</th><td>${esc(vehicleVin)}</td></tr>` : ""}
    ${vehicleColor ? `<tr><th>Color</th><td>${esc(vehicleColor)}</td></tr>` : ""}
  </table>
  <p>Fuel Level at Pickup: Full &nbsp;&nbsp; Half &nbsp;&nbsp; Quarter &nbsp;&nbsp;&nbsp; Condition Photos Attached: Yes</p>

  <h4>RENTAL PERIOD</h4>
  <table>
    <tr><th>Pickup Date</th><td>${esc(pickup || "")}</td></tr>
    <tr><th>Pickup Time</th><td>${esc(pickupTime || "Not specified")}</td></tr>
    <tr><th>Return Date</th><td>${esc(returnDate || "")}</td></tr>
    <tr><th>Return Time</th><td>${esc(returnTime || "Not specified")}</td></tr>
    ${durationLine ? `<tr><th>Duration</th><td>${durationLine}</td></tr>` : ""}
    <tr><th>${isHourly ? "Total Charged" : "Total Charged"}</th><td><strong>$${esc(total || "TBD")}</strong></td></tr>
    ${!isHourly && balanceAtPickup ? `<tr><th>Balance Due at Pickup</th><td><strong>$${esc(balanceAtPickup)}</strong></td></tr>` : ""}
    <tr><th>Insurance / Protection</th><td>${esc(insuranceSummary)}</td></tr>
  </table>
  <p><strong>Late Fee:</strong> $50/day after a 2-hour grace period.</p>

  <h4>MILEAGE, GEOGRAPHIC USE &amp; FUEL</h4>
  <p><strong>Mileage &amp; Geographic Limit:</strong> Unlimited miles are included within a designated local area only. All vehicle use must remain within <strong>Los Angeles County</strong> or within a <strong>50-mile radius of Los Angeles</strong>, unless otherwise approved in writing by the host. Travel outside this area — including trips to San Diego, San Francisco, Las Vegas, or any out-of-state destination — is not allowed without prior written authorization. Unauthorized use outside the approved area will result in a <strong>$500 penalty fee</strong> and may lead to early termination of the rental without refund. The vehicle is equipped with a GPS tracking system for security and compliance; by renting, you consent to location monitoring during the rental period.</p>
  <p><strong>Fuel Policy:</strong> Return the vehicle with the same fuel level as at pickup, or pay a $5/gallon replacement fee.</p>

  ${depositSection}

  <h4>INSURANCE &amp; LIABILITY</h4>
  <p>Renter must provide <strong>one of the following</strong> prior to vehicle release:</p>
  <ul>
    <li>Valid personal auto insurance covering rental vehicles (proof required), <strong>OR</strong></li>
    <li>Purchase of SLY Transportation Services Damage Protection Plan</li>
  </ul>
  <p><strong>Damage Protection Plan (Optional):</strong> ${dppRatesTextLong}</p>
  <p>This plan reduces the renter's financial responsibility for covered vehicle damage to a maximum of <strong>$1,000 per incident</strong>.</p>
  <p><strong>Without Protection Plan:</strong> Renter is fully responsible for all damages and associated costs, including but not limited to:</p>
  <ul>
    <li>Full cost of vehicle repair or replacement</li>
    <li>Loss of use (rental downtime)</li>
    <li>Diminished value</li>
    <li>Administrative, towing, and storage fees</li>
  </ul>
  <p><strong>With Protection Plan:</strong> Renter's responsibility is limited to the stated deductible, provided all terms of this agreement are followed.</p>
  <p><strong>Exclusions (Protection Plan Void If):</strong></p>
  <ul>
    <li>Driver is under the influence of drugs or alcohol</li>
    <li>Unauthorized driver operates the vehicle</li>
    <li>Reckless, illegal, or negligent use</li>
    <li>Off-road or prohibited use</li>
    <li>Failure to report damage within 24 hours</li>
    <li>Violation of rental agreement terms</li>
  </ul>
  <p><strong>Third-Party Liability:</strong> Renter is solely responsible for any third-party claims, including bodily injury, property damage, or death. SLY Transportation Services is not liable for renter negligence. Renter agrees to indemnify and hold harmless SLY Transportation Services from any claims, losses, or expenses arising from vehicle use.</p>

  <h4>USE RESTRICTIONS</h4>
  <p>Renter agrees to all of the following restrictions:</p>
  <p>No smoking &nbsp; No pets &nbsp; No off-road use &nbsp; No subleasing</p>
  <p>Approved drivers only &nbsp; No racing or towing &nbsp; No commercial hauling</p>

  ${speedSection}

  <h4>CONDITION INSPECTION</h4>
  <p>Vehicle is inspected and accepted as-is at time of pickup. Condition photos are taken at pickup. Renter must report any pre-existing damage within 24 hours of pickup.</p>

  <h4>TERMINATION</h4>
  <p>SLY Transportation Services may terminate this agreement immediately for breach of terms, unpaid fees, unlawful use, or safety violations. Renter is liable for all costs to recover the vehicle.</p>

  <h4>PAYMENT TERMS</h4>
  <p>${isHourly ? "Full payment (including a $150 refundable security deposit) was charged at the time of booking. The security deposit will be released within 5–7 business days after the vehicle is returned and inspected with no issues." : "All fees are due at pickup."} Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.</p>
  <p>&#9888; <strong>No-Refund Policy:</strong> All payments are final once a booking is confirmed. Cancellations or no-shows after booking are not eligible for a refund. Refunds may be issued only if SLY Transportation cancels or cannot fulfill the rental.</p>

  <h4>PAYMENT AUTHORIZATION &amp; CHARGEBACK POLICY</h4>
  <p>By signing this agreement, renter expressly authorizes SLY Transportation Services to charge the payment method on file for all amounts owed under this agreement, including but not limited to:</p>
  <ul>
    <li>Rental charges and extensions</li>
    <li>Security deposit and any applicable deductions</li>
    <li>Vehicle damage, repair, or replacement costs</li>
    <li>Loss of use and diminished value</li>
    <li>Fuel, cleaning, smoking, or excess wear fees</li>
    <li>Towing, storage, tickets, tolls, and administrative fees</li>
  </ul>
  <p>Renter agrees that these charges may be processed after the rental period if additional costs are identified upon inspection or later discovery.</p>
  <p>Renter acknowledges that all charges are valid, agreed upon, and authorized under this contract. Renter agrees not to dispute, reverse, or initiate a chargeback for any legitimate charge incurred in accordance with this agreement.</p>
  <p><strong>In the event of a payment dispute or chargeback, renter agrees that:</strong></p>
  <ul>
    <li>This signed agreement serves as binding proof of authorization</li>
    <li>SLY Transportation Services may submit this agreement, along with rental records, photos, inspection reports, and communication logs, as evidence to the payment processor</li>
    <li>Renter remains financially responsible for all charges, including any fees resulting from the dispute</li>
  </ul>
  <p>If a chargeback is initiated without valid cause, SLY Transportation Services reserves the right to pursue collection, legal action, and recovery of all associated costs, including reasonable attorney's fees where permitted by law.</p>

  <h4>GOVERNING LAW</h4>
  <p>This agreement is governed by the laws of the State of California. Disputes shall be resolved in the courts of Los Angeles County. By signing, the renter acknowledges they have read, understood, and agreed to all terms above.</p>

  <div class="sig-block">
    <p><strong>ELECTRONIC SIGNATURE</strong></p>
    <p>By typing their name below, the renter agrees to all terms of this Rental Agreement. This electronic signature is legally binding. By signing, the renter confirms they are <strong>21 years of age or older</strong> and have full legal capacity to enter into this agreement.</p>
    <p class="sig-name">${esc(signature || "")}</p>
    <p class="watermark">&#10003; Digitally Signed</p>
    <p style="font-size:13px;color:#555">Signed: ${esc(signedAt)} (Pacific Time)</p>
    <p style="font-size:13px;color:#555">Renter: ${esc(name || "Not provided")} &nbsp;|&nbsp; Email: ${esc(email || "Not provided")} &nbsp;|&nbsp; Phone: ${esc(phone || "Not provided")}</p>
  </div>
</body>
</html>`;
}

/**
 * Generate a PDF rental agreement buffer from the booking data.
 * Returns a Promise<Buffer> containing the PDF bytes.
 *
 * @param {object} body      - validated request body (same shape as generateRentalAgreementHtml)
 * @param {string} [ipAddress]  - customer IP address captured server-side
 * @param {string} [cardLast4]  - last 4 digits of the card used for payment (if available)
 * @returns {Promise<Buffer>}
 */
function generateRentalAgreementPdf(body, ipAddress, cardLast4) {
  return new Promise((resolve, reject) => {
    const {
      vehicleId, car, vehicleMake, vehicleModel, vehicleYear, vehicleVin, vehicleColor,
      name, email, phone,
      pickup, pickupTime, returnDate, returnTime,
      total, deposit, days, protectionPlan, signature,
      slingshotDuration,
      fullRentalCost, balanceAtPickup,
      insuranceCoverageChoice, slingshotDepositAmount,
    } = body;

    const signedAt = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "long",
      timeStyle: "short",
    });

    const carInfo = (vehicleId && CARS[vehicleId]) ? CARS[vehicleId] : null;
    const isHourly = !!(carInfo && carInfo.hourlyTiers);
    const dppRatesText = `$${PROTECTION_PLAN_DAILY}/day  •  $${PROTECTION_PLAN_WEEKLY}/week  •  $${PROTECTION_PLAN_BIWEEKLY}/2 wks  •  $${PROTECTION_PLAN_MONTHLY}/month`;
    // Slingshot: insurance choice is explicit; Camry: derive from protectionPlan flag
    const insuranceSummary = isHourly
      ? (insuranceCoverageChoice === "no"
          ? "Option B: No personal insurance — Damage Protection Plan included"
          : "Option A: Renter has own insurance (proof required at pickup)")
      : (protectionPlan
          ? "Damage Protection Plan selected"
          : "Renter provided personal rental car insurance");
    const durationLine = isHourly && slingshotDuration
      ? (Number(slingshotDuration) >= 48
          ? `${Number(slingshotDuration) / 24}-day rental`
          : `${Number(slingshotDuration)}-hour rental`)
      : (days ? `${days} day${Number(days) !== 1 ? "s" : ""}` : "");

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

    function tableRow(label, value, isLast = false) {
      const rowY = doc.y;
      const labelW = PAGE_WIDTH * 0.4;
      const valueW = PAGE_WIDTH * 0.6;
      const rowH = 18;

      // Label cell background
      doc.rect(50, rowY, labelW, rowH).fill(TABLE_HEADER_BG);
      doc.rect(50 + labelW, rowY, valueW, rowH).fill("#ffffff");
      // Borders
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

    function boldText(text) {
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BRAND_BLACK).text(text);
      doc.font("Helvetica").fontSize(8.5);
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
    bodyText(`Owner:   SLY Transportation Services — (213) 916-6606 — info@slytrans.com`);
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
    bodyText("Late Fee: $50/day after a 2-hour grace period.");

    // ── Mileage & Fuel ─────────────────────────────────────────────────────────
    sectionHeader("Mileage, Geographic Use & Fuel");
    bodyText("Mileage & Geographic Limit: Unlimited miles are included within a designated local area only. All vehicle use must remain within Los Angeles County or within a 50-mile radius of Los Angeles, unless otherwise approved in writing by the host. Travel outside this area — including trips to San Diego, San Francisco, Las Vegas, or any out-of-state destination — is not allowed without prior written authorization. Unauthorized use outside the approved area will result in a $500 penalty fee and may lead to early termination of the rental without refund. The vehicle is equipped with a GPS tracking system for security and compliance; by renting, you consent to location monitoring during the rental period.");
    doc.moveDown(0.2);
    bodyText("Fuel Policy: Return the vehicle with the same fuel level as at pickup, or pay a $5/gallon replacement fee.");

    // ── Deposit / Pricing ──────────────────────────────────────────────────────
    sectionHeader("Deposit & Protection Plan");
    if (isHourly && carInfo) {
      // Full payment system: security deposit included in total
      bodyText(`Security Deposit: A $150 refundable security deposit is included in your total payment. Released within 5–7 business days after return and inspection with no issues. May be retained to cover damages, loss of use, cleaning, tolls, or fuel.`);
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
      bodyText(`Damage Protection Plan (${dppRatesText}): optional add-on — reduces your damage liability to $1,000.`);
    }

    // ── Insurance & Liability ──────────────────────────────────────────────────
    sectionHeader("Insurance & Liability");
    bodyText("Renter must provide one of the following prior to vehicle release:");
    bulletList([
      "Valid personal auto insurance covering rental vehicles (proof required), OR",
      "Purchase of SLY Transportation Services Damage Protection Plan",
    ]);
    doc.moveDown(0.2);
    bodyText(`Damage Protection Plan (Optional): ${dppRatesText}`);
    doc.moveDown(0.1);
    bodyText("This plan reduces the renter's financial responsibility for covered vehicle damage to a maximum of $1,000 per incident.");
    doc.moveDown(0.2);
    bodyText("Without Protection Plan: Renter is fully responsible for all damages and associated costs, including:");
    bulletList(["Full cost of vehicle repair or replacement", "Loss of use (rental downtime)", "Diminished value", "Administrative, towing, and storage fees"]);
    doc.moveDown(0.2);
    bodyText("With Protection Plan: Renter's responsibility is limited to the stated deductible, provided all terms of this agreement are followed.");
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

    // ── Slingshot Speed Policy ─────────────────────────────────────────────────
    if (isHourly) {
      sectionHeader("Slingshot Speed Policy");
      bodyText("Speed Limit: The posted speed limit is 65 mph. Renters may not exceed 75 mph under any circumstances.");
      doc.moveDown(0.1);
      bodyText("Strike Policy: After two (2) speed or agreement violations, the renter's security deposit becomes non-refundable.");
    }

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
      bodyText(`Full payment (including a $150 refundable security deposit) was charged at the time of booking. The security deposit will be released within 5–7 business days after return and inspection with no issues. Late payments accrue interest at 1.5% per month. NSF (returned check) fee: $35.`);
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

    // Signature in cursive-style font (using Helvetica-BoldOblique as fallback)
    doc.font("Helvetica-BoldOblique").fontSize(18).fillColor(BRAND_BLACK)
      .text(signature || "", 60, doc.y);
    doc.moveDown(0.2);

    // Underline for signature
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

/**
 * Retrieve the last 4 digits of the card used for a PaymentIntent via Stripe API.
 * Returns null if the key is missing, the lookup fails, or no card data is available.
 *
 * @param {string} paymentIntentId
 * @returns {Promise<string|null>}
 */
async function fetchCardLast4(paymentIntentId) {
  if (!paymentIntentId || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["payment_method"],
    });
    return pi.payment_method?.card?.last4 || null;
  } catch (err) {
    console.warn("fetchCardLast4: failed to retrieve payment method:", err.message);
    return null;
  }
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

  const { vehicleId, car, vehicleMake, vehicleModel, vehicleYear, vehicleVin, vehicleColor, name, pickup, pickupTime, returnDate, returnTime, email, phone, total, pricePerDay, pricePerWeek, pricePerBiWeekly, pricePerMonthly, deposit, days, slingshotDuration, idBase64, idFileName, idMimeType, insuranceBase64, insuranceFileName, insuranceMimeType, protectionPlan, signature, paymentStatus, fullRentalCost, balanceAtPickup, paymentType, paymentIntentId, insuranceCoverageChoice, slingshotDepositAmount } = req.body;

  // Extract the customer's IP address from reverse-proxy headers (Vercel sets x-forwarded-for).
  const customerIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || null;

  // Compute server-side pricing breakdown lines for daily/weekly rentals.
  // Slingshot (hourly tier) or missing dates fall back gracefully to null.
  const breakdownLines = (vehicleId && pickup && returnDate && !slingshotDuration)
    ? computeBreakdownLines(vehicleId, pickup, returnDate, !!protectionPlan)
    : null;
  const breakdownText = breakdownLines ? breakdownLines.join("\n") : null;
  const breakdownHtml = breakdownLines
    ? `<table style="border-collapse:collapse;width:100%;margin-top:4px">
        ${breakdownLines.map(line => {
          const isTotal = line.startsWith("Total:");
          return `<tr><td style="padding:6px 8px;border:1px solid #ddd${isTotal ? ";font-weight:bold" : ""}">${esc(line)}</td></tr>`;
        }).join("")}
      </table>`
    : null;

  // isConfirmed: true for successful payments (default), false for failed/cancelled
  const isConfirmed = !paymentStatus || paymentStatus === "confirmed";

  // isBalancePayment: true when the renter is paying the remaining balance after
  // having already paid the $50 reservation deposit.
  const isBalancePayment = paymentType === "balance_payment";

  // For deposit bookings, build a "Pay Balance Online" URL so the renter can
  // complete their final payment without re-filling the form.
  // The link encodes only booking params — amounts are always recomputed server-side.
  let balancePayUrl = null;
  if (isConfirmed && !isBalancePayment && fullRentalCost && vehicleId && pickup && returnDate && email) {
    const bpParts = [
      ["v",   vehicleId],
      ["p",   pickup],
      ["r",   returnDate],
      ["pp",  protectionPlan ? "1" : "0"],
      ...(name      ? [["n",   name]]      : []),
      ...(email     ? [["e",   email]]     : []),
      ...(phone     ? [["ph",  phone]]     : []),
      ...(pickupTime  ? [["pt", pickupTime]]  : []),
      ...(returnTime  ? [["rt", returnTime]]  : []),
      ...(car       ? [["car", car]]       : []),
      ...(slingshotDuration ? [["d", String(slingshotDuration)]] : []),
    ];
    balancePayUrl = "https://www.slytrans.com/balance.html?" +
      bpParts.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  }

  // For Slingshot bookings, 'total' is the full rental amount charged at booking (including $150 security deposit).
  const isHourlyEmail = !!(vehicleId && CARS[vehicleId] && CARS[vehicleId].hourlyTiers);
  const totalChargedLabel = isBalancePayment
    ? "Balance Paid"
    // fullRentalCost is only set for Camry deposit-mode bookings (partial payment up front).
    // Slingshot bookings set fullRentalCost to null since everything is charged at once.
    : (fullRentalCost ? "Booking Deposit Charged" : "Total Charged");
  const ownerSubject = isBalancePayment
    ? `🎉 Balance Paid – Booking Fully Paid: ${esc(car)}`
    : (isConfirmed
        ? `💰 Payment Confirmed – New Booking: ${esc(car)}`
        : `⚠️ Payment Failed – Booking Attempt: ${esc(car)}`);
  const statusLabel  = isConfirmed ? "✅ CONFIRMED" : "❌ FAILED";
  const statusColor  = isConfirmed ? "green" : "red";
  const introText    = isBalancePayment
    ? "The renter has paid the remaining balance online. The booking is now fully paid."
    : (isConfirmed
        ? "A customer has completed payment. Their rental details are below."
        : "A customer attempted payment but it did not go through. Details below.");
  const footerText   = isBalancePayment
    ? "The remaining balance has been received. The booking is now fully paid — no further action required."
    : (isConfirmed
        ? "Payment has been received. Please contact the customer to confirm rental details."
        : "NOTE: Payment was NOT completed. The customer may retry or need assistance.");

  try {
    // Fetch card last4 from Stripe when a PaymentIntent ID was provided.
    // This is non-blocking — a lookup failure does not abort the email flow.
    const cardLast4 = isConfirmed && paymentIntentId ? await fetchCardLast4(paymentIntentId) : null;

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
    if (insuranceBase64 && insuranceFileName) {
      attachments.push({
        filename: insuranceFileName,
        content: insuranceBase64,
        encoding: "base64",
        contentType: insuranceMimeType || "application/octet-stream",
      });
    }
    // Generate a signed PDF rental agreement for confirmed payments with a signature.
    // The PDF is attached to both the owner and the renter emails.
    let agreementPdfBuffer = null;
    let agreementPdfFilename = null;
    if (isConfirmed && signature) {
      const safeName = (name || "renter").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
      const safeDate = (pickup || new Date().toISOString().split("T")[0]).replace(/[^0-9-]/g, "");
      agreementPdfFilename = `rental-agreement-${safeName}-${safeDate}.pdf`;
      agreementPdfBuffer = await generateRentalAgreementPdf(req.body, customerIp, cardLast4);
      attachments.push({
        filename: agreementPdfFilename,
        content: agreementPdfBuffer,
        contentType: "application/pdf",
      });
    }

    // --- Notify owner ---
    const ownerEmailOpts = {
      from: `"Sly Transportation Services LLC Bookings" <${process.env.SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject: ownerSubject,
      attachments,
      ...(email ? { replyTo: email } : {}),
      text: [
        isConfirmed ? "Payment Confirmed – New Booking" : "Payment Failed – Booking Attempt",
        "",
        `Payment Status : ${isConfirmed ? "CONFIRMED" : "FAILED"}`,
        `Vehicle        : ${car || ""}`,
        vehicleMake  ? `Make           : ${vehicleMake}`  : "",
        vehicleModel ? `Model          : ${vehicleModel}` : "",
        vehicleYear  ? `Year           : ${vehicleYear}`  : "",
        vehicleVin   ? `VIN / Plate    : ${vehicleVin}`   : "",
        vehicleColor ? `Color          : ${vehicleColor}` : "",
        `Renter Name    : ${name || "Not provided"}`,
        `Pickup Date    : ${pickup || ""}`,
        `Pickup Time    : ${pickupTime || "Not specified"}`,
        `Return Date    : ${returnDate || ""}`,
        `Return Time    : ${returnTime || "Not specified"}`,
        `Customer Email : ${email || "Not provided"}`,
        `Phone          : ${phone || "Not provided"}`,
        `Number of Days : ${days || "N/A"}`,
        `Daily Rate     : ${pricePerDay != null ? "$" + pricePerDay + " / day" : "N/A"}`,
        pricePerWeek     ? `Weekly Rate    : $${pricePerWeek} / week`       : "",
        pricePerBiWeekly ? `Bi-Weekly Rate : $${pricePerBiWeekly} / 2 weeks` : "",
        pricePerMonthly  ? `Monthly Rate   : $${pricePerMonthly} / month`    : "",
        `Deposit        : ${deposit != null && deposit > 0 ? "$" + deposit : "None"}`,
        `${totalChargedLabel.padEnd(15)}: $${total || "TBD"}`,
        !isHourlyEmail && fullRentalCost   ? `Full Rental Cost: $${fullRentalCost}` : "",
        !isHourlyEmail && balanceAtPickup ? `Balance at Pickup: $${balanceAtPickup}` : "",
        isHourlyEmail
          ? `Insurance Option: ${insuranceCoverageChoice === "no" ? "Option B — No insurance (DPP included)" : "Option A — Own insurance (proof required at pickup)"}`
          : (protectionPlan != null ? `Insurance      : ${protectionPlan ? "Damage Protection Plan (no personal coverage)" : "Own insurance (proof uploaded)"}` : ""),
        isHourlyEmail ? `Insurance Uploaded: ${insuranceBase64 && insuranceFileName ? "Yes (" + insuranceFileName + ")" : "No"}` : "",
        isHourlyEmail ? `Protection Plan: ${protectionPlan ? "Included (Option B)" : "Not included (Option A)"}` : "",
        signature ? `Digital Signature: ${signature}` : "",
        breakdownText ? "\nPrice Breakdown:\n" + breakdownText : "",
        "",
        idBase64 && idFileName ? `ID attached: ${idFileName}` : "No ID was uploaded by the renter.",
        isHourlyEmail
          ? (insuranceBase64 && insuranceFileName
              ? `Insurance attached: ${insuranceFileName}`
              : (insuranceCoverageChoice === "no"
                  ? "No insurance upload (renter chose Option B / DPP)."
                  : "No insurance document uploaded — verify at pickup (renter chose Option A)."))
          : (insuranceBase64 && insuranceFileName ? `Insurance attached: ${insuranceFileName}` : (protectionPlan ? "No insurance upload (renter chose Damage Protection Plan)." : "No insurance document was uploaded by the renter.")),
        isConfirmed && signature ? `Signed Rental Agreement: attached (${agreementPdfFilename})` : "",
        "",
        footerText,
      ].filter((line) => line !== undefined).join("\n"),
      html: `
        <h2>${ownerSubject}</h2>
        <p>${introText}</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:${statusColor}"><strong>${statusLabel}</strong></td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(car)}</td></tr>
          ${vehicleMake  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Make</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleMake)}</td></tr>`  : ""}
          ${vehicleModel ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Model</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleModel)}</td></tr>` : ""}
          ${vehicleYear  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Year</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(vehicleYear))}</td></tr>`  : ""}
          ${vehicleVin   ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>VIN / Plate</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleVin)}</td></tr>`   : ""}
          ${vehicleColor ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Color</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleColor)}</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter Name</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(name || "Not provided")}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupTime) || "Not specified"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnTime) || "Not specified"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Customer Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(email) || "Not provided"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(phone) || "Not provided"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Number of Days</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(days || "N/A"))}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Daily Rate</strong></td><td style="padding:8px;border:1px solid #ddd">${pricePerDay != null ? "$" + esc(String(pricePerDay)) + " / day" : "N/A"}</td></tr>
          ${pricePerWeek     ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Weekly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerWeek))} / week</td></tr>` : ""}
          ${pricePerBiWeekly ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Bi-Weekly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerBiWeekly))} / 2 weeks</td></tr>` : ""}
          ${pricePerMonthly  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Monthly Rate</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(String(pricePerMonthly))} / month</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Deposit</strong></td><td style="padding:8px;border:1px solid #ddd">${deposit != null && deposit > 0 ? "$" + esc(String(deposit)) : "None"}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalChargedLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(total) || "TBD"}</strong></td></tr>
          ${fullRentalCost && !isHourlyEmail  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(fullRentalCost)}</td></tr>` : ""}
          ${!isHourlyEmail && balanceAtPickup ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balanceAtPickup)}</strong></td></tr>` : ""}
          ${isHourlyEmail
            ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Option</strong></td><td style="padding:8px;border:1px solid #ddd">${insuranceCoverageChoice === "no" ? "⚠️ Option B — No personal insurance (DPP included)" : "✅ Option A — Renter has own insurance (proof required at pickup)"}</td></tr>
               <tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Uploaded</strong></td><td style="padding:8px;border:1px solid #ddd">${insuranceBase64 && insuranceFileName ? "✅ Yes (" + esc(insuranceFileName) + ")" : "❌ No"}</td></tr>
               <tr><td style="padding:8px;border:1px solid #ddd"><strong>Protection Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${protectionPlan ? "✅ Included (Option B)" : "❌ Not included (Option A)"}</td></tr>`
            : `${protectionPlan != null ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Coverage</strong></td><td style="padding:8px;border:1px solid #ddd">${protectionPlan ? "⚠️ Damage Protection Plan (no personal coverage)" : "✅ Own insurance (proof uploaded)"}</td></tr>` : ""}`
          }
          ${signature ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Digital Signature</strong></td><td style="padding:8px;border:1px solid #ddd;font-style:italic">${esc(signature)}</td></tr>` : ""}
        </table>
        ${breakdownHtml ? `<h3 style="margin-top:16px">📊 Price Breakdown</h3>${breakdownHtml}` : ""}
        ${idBase64 && idFileName ? `<p>📎 <strong>Renter's ID is attached</strong> to this email (${esc(idFileName)}).</p>` : `<p>⚠️ No ID was uploaded by the renter.</p>`}
        ${insuranceBase64 && insuranceFileName
          ? `<p>🛡️ <strong>Renter's insurance document is attached</strong> to this email (${esc(insuranceFileName)}).</p>`
          : (isHourlyEmail
              ? (insuranceCoverageChoice === "no"
                  ? `<p>ℹ️ Renter chose Option B (Damage Protection Plan) — no personal insurance upload required.</p>`
                  : `<p>⚠️ Renter chose Option A (own insurance) but did not upload proof — verify at pickup.</p>`)
              : (protectionPlan
                  ? `<p>ℹ️ Renter chose the Damage Protection Plan — no personal insurance was uploaded.</p>`
                  : `<p>⚠️ No insurance document was uploaded by the renter.</p>`))
        }
        ${isConfirmed && signature ? `<p>📄 <strong>Signed Rental Agreement is attached</strong> to this email as a PDF file.</p>` : ""}
        <p>${footerText}</p>
        ${isConfirmed && vehicleId && pickup && returnDate ? `
        <hr style="margin:24px 0;border:none;border-top:1px solid #ddd">
        <p style="font-size:13px;color:#555">
          <strong>📅 Calendar update:</strong> These dates are being automatically marked as unavailable on the booking calendar.
          If the calendar is not updated within a few minutes, use the
          <a href="https://www.slytrans.com/admin.html?vehicle=${encodeURIComponent(vehicleId)}&from=${encodeURIComponent(pickup)}&to=${encodeURIComponent(returnDate)}" style="color:#1a73e8">Admin Calendar Page</a>
          to block them manually.
        </p>` : ""}
      `,
    };

    let ownerEmailErr = null;
    try {
      await transporter.sendMail(ownerEmailOpts);
    } catch (ownerErr) {
      console.error("Owner notification email failed:", ownerErr);
      ownerEmailErr = ownerErr;
    }

    // --- Confirmation to customer (only for successful payments) ---
    let customerEmailErr = null;
    if (isConfirmed && email) {
      const customerSubject = isBalancePayment
        ? "🎉 Balance Paid – Your Rental is Fully Confirmed"
        : "Rental Agreement Confirmation – SLY Transportation";
      const customerIntro = isBalancePayment
        ? "Great news! Your final balance payment has been received. Your rental is now fully paid and confirmed."
        : "Your booking is confirmed. Attached is your signed rental agreement.";
      try {
        await transporter.sendMail({
          from: `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
          to: email,
          subject: customerSubject,
          ...(agreementPdfBuffer && agreementPdfFilename ? {
            attachments: [{
              filename: agreementPdfFilename,
              content: agreementPdfBuffer,
              contentType: "application/pdf",
            }],
          } : {}),
          text: [
            isBalancePayment ? "Balance Paid – Sly Transportation Services LLC" : "Payment Confirmed – Sly Transportation Services LLC",
            "",
            customerIntro,
            "Here are your booking details:",
            "",
            `Payment Status : CONFIRMED`,
            `Vehicle        : ${car || ""}`,
            vehicleMake  ? `Make           : ${vehicleMake}`  : "",
            vehicleModel ? `Model          : ${vehicleModel}` : "",
            vehicleYear  ? `Year           : ${vehicleYear}`  : "",
            vehicleVin   ? `VIN / Plate    : ${vehicleVin}`   : "",
            vehicleColor ? `Color          : ${vehicleColor}` : "",
            `Pickup Date    : ${pickup || ""}`,
            `Pickup Time    : ${pickupTime || "Not specified"}`,
            `Return Date    : ${returnDate || ""}`,
            `Return Time    : ${returnTime || "Not specified"}`,
            isBalancePayment
              ? `Balance Paid   : $${total || "TBD"} (final payment — booking fully paid)`
              : `Total Charged  : $${total || "TBD"}`,
            !isBalancePayment && fullRentalCost  ? `Full Rental Cost: $${fullRentalCost}` : "",
            !isBalancePayment && balanceAtPickup ? `Balance at Pickup: $${balanceAtPickup}` : "",
            !isBalancePayment && balancePayUrl   ? `Pay balance online: ${balancePayUrl}` : "",
            breakdownText ? "\nPrice Breakdown:\n" + breakdownText : "",
            "",
            "We will be in touch shortly to confirm your rental pick-up details.",
            `If you have any questions, reply to this email or reach us at ${OWNER_EMAIL}.`,
            "",
            "Sly Transportation Services LLC Team",
          ].filter(line => line !== undefined).join("\n"),
          html: `
            <h2>${isBalancePayment ? "🎉 Balance Paid – Sly Transportation Services LLC" : "✅ Payment Confirmed – Sly Transportation Services LLC"}</h2>
            <p>${esc(customerIntro)} Here are your booking details:</p>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #ddd;color:green"><strong>✅ CONFIRMED</strong></td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(car)}</td></tr>
              ${vehicleMake  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Make</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleMake)}</td></tr>`  : ""}
              ${vehicleModel ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Model</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleModel)}</td></tr>` : ""}
              ${vehicleYear  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Year</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(vehicleYear))}</td></tr>`  : ""}
              ${vehicleVin   ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>VIN / Plate</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleVin)}</td></tr>`   : ""}
              ${vehicleColor ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Color</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleColor)}</td></tr>` : ""}
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickup)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupTime) || "Not specified"}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Date</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDate)}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return Time</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnTime) || "Not specified"}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalChargedLabel)}</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>$${esc(total) || "TBD"}</strong>${isBalancePayment ? " <em style='font-size:12px;color:#888'>(final payment — fully paid)</em>" : ""}</td></tr>
              ${!isBalancePayment && fullRentalCost  ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">$${esc(fullRentalCost)}</td></tr>` : ""}
              ${!isBalancePayment && balanceAtPickup ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd;color:#ff9800"><strong>$${esc(balanceAtPickup)}</strong></td></tr>` : ""}
              ${!isBalancePayment && balancePayUrl   ? `<tr><td colspan="2" style="padding:12px;border:1px solid #ddd;text-align:center"><a href="${esc(balancePayUrl)}" style="display:inline-block;padding:12px 28px;background:#c8a000;color:#000;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px">💳 Pay Balance Online</a><br><span style="font-size:12px;color:#888;display:block;margin-top:6px">Or pay in person at pickup — your choice</span></td></tr>` : ""}
            </table>
            ${breakdownHtml ? `<h3 style="margin-top:16px">📊 Price Breakdown</h3>${breakdownHtml}` : ""}
            <p>We will be in touch shortly to confirm your rental pick-up details. If you have any questions, reply to this email or reach us at <a href="mailto:${esc(OWNER_EMAIL)}">${esc(OWNER_EMAIL)}</a>.</p>
            <p><strong>Sly Transportation Services LLC Team 🚗</strong></p>
          `,
        });
      } catch (custErr) {
        console.error("Customer confirmation email failed:", custErr);
        customerEmailErr = custErr;
      }
    }

    // Block the reserved dates in booked-dates.json and mark the vehicle
    // unavailable in fleet-status.json BEFORE sending the response and BEFORE
    // checking for email errors.  This ensures availability is always updated
    // for confirmed bookings even when the owner notification email fails.
    // Vercel terminates the serverless function as soon as res.json() is called,
    // so any async work scheduled after that is not guaranteed to run.
    // Failures are non-fatal (emails already sent) and only logged.
    if (isConfirmed && !isBalancePayment && vehicleId && pickup && returnDate) {
      try {
        await blockBookedDates(vehicleId, pickup, returnDate);
      } catch (err) {
        console.error("Failed to update booked-dates.json:", err.message);
      }
      try {
        await markVehicleUnavailable(vehicleId);
      } catch (err) {
        console.error("Failed to update fleet-status.json:", err.message);
      }
    }

    // Owner email is critical — surface a 500 so the operator knows.
    // Customer email failure is non-fatal: it is already logged above and the
    // owner received the booking alert so the booking is not lost.
    if (ownerEmailErr) {
      return res.status(500).json({ error: "Reservation owner notification email failed. Please contact slyservices@supports-info.com to confirm your booking." });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email sending failed" });
  }
}
