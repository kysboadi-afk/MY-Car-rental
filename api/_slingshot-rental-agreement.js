// api/_slingshot-rental-agreement.js
// Generates a slingshot-specific rental agreement PDF using PDFKit.
//
// Only for Polaris Slingshot bookings (booking_type === "slingshot").
// A snapshot is stored in the rental-agreements Supabase Storage bucket and
// the path is persisted in pending_booking_docs.agreement_pdf_url so the same
// document is always available — it is NEVER regenerated from scratch later.
//
// Exported function:
//   generateSlingshotRentalAgreementPdf(data, ipAddress) → Promise<Buffer>

import PDFDocument from "pdfkit";
import crypto from "crypto";

/**
 * All static policy values for the slingshot agreement.
 * Change these constants if business rules change — no hunting through prose.
 */
const POLICY = {
  companyName:         "LA Slingshot Rentals",
  companyPhone:        "(844) 511-4059",
  companyEmail:        "info@slytrans.com",
  timezone:            "America/Los_Angeles",
  depositReturnDays:   "5–7 business",
  minAge:              21,
  trackingProvider:    "Bouncie",
  damageCap:           "1,000",
  gracePeriodMinutes:  30,
  lateFeeHourly:       100,
  lateThresholdHours:  3,
  fuelLevelStart:      "Full",
  fuelPolicy:          "Full (same level as pickup)",
  refuelFee:           "5/gallon",
  smokingFee:          250,
  cleaningFee:         100,
  ticketProcessingFee: 25,
  cancelWindowHours:   24,
  cancelFee:           "Non-refundable",
  noShowPolicy:        "No refund — full charge applies",
  bookingSource:       "website",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeStr(v) {
  if (v == null) return "";
  return String(v);
}

function formatDate(v) {
  if (!v) return "N/A";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    year:  "numeric",
    month: "long",
    day:   "numeric",
  });
}

function laTimestamp(dt) {
  return dt.toLocaleString("en-US", {
    timeZone:  "America/Los_Angeles",
    dateStyle: "long",
    timeStyle: "short",
  }) + " PT";
}

/**
 * Produce a deterministic hex digest that acts as a "signature hash" for the
 * agreement.  It is derived from booking_id + generated_at so it is stable
 * for the lifetime of the booking but unique per booking.
 */
function buildSignatureHash(bookingId, generatedAt) {
  return crypto
    .createHash("sha256")
    .update(`${bookingId}|${generatedAt}`)
    .digest("hex")
    .slice(0, 32);
}

// ── PDF builder ───────────────────────────────────────────────────────────────

/**
 * Generate a PDF rental agreement buffer from slingshot booking data.
 * Returns a Promise<Buffer> containing the PDF bytes.
 *
 * @param {object} data
 *   @param {string}  data.bookingId
 *   @param {string}  data.paymentIntentId
 *   @param {string}  data.stripeCustomerId
 *   @param {string}  data.renterName
 *   @param {string}  [data.driverLicenseNumber]
 *   @param {string}  data.renterPhone
 *   @param {string}  data.renterEmail
 *   @param {string}  [data.vehicleVin]
 *   @param {string}  data.vehicleName
 *   @param {string}  [data.licensePlate]
 *   @param {string}  data.vehicleId
 *   @param {string}  data.startDatetime     — "YYYY-MM-DD HH:MM" or similar
 *   @param {string}  data.endDatetime
 *   @param {string}  [data.packageLabel]    — "2 Hours", "24 Hours", etc.
 *   @param {number}  data.baseRate           — package price (no deposit)
 *   @param {number}  data.totalPrice         — total charged (incl. deposit)
 *   @param {number}  data.securityDeposit
 *   @param {string}  [data.paymentStatus]
 *   @param {boolean} [data.licenseVerified]
 *   @param {boolean} [data.identityVerified]
 * @param {string}   [ipAddress]  — renter's IP address (optional)
 * @returns {Promise<Buffer>}
 */
export function generateSlingshotRentalAgreementPdf(data, ipAddress) {
  return new Promise((resolve, reject) => {
    const {
      bookingId         = "",
      paymentIntentId   = "",
      stripeCustomerId  = "",
      renterName        = "",
      driverLicenseNumber = "Provided (ID on file)",
      renterPhone       = "",
      renterEmail       = "",
      vehicleVin        = "",
      vehicleName       = "Polaris Slingshot",
      licensePlate      = "",
      vehicleId         = "",
      startDatetime     = "",
      endDatetime       = "",
      packageLabel      = "",
      baseRate          = 0,
      totalPrice        = 0,
      securityDeposit   = 500,
      paymentStatus     = "paid",
      licenseVerified   = false,
      identityVerified  = false,
    } = data;

    const now          = new Date();
    const generatedAt  = laTimestamp(now);
    const signedAt     = generatedAt;
    const signatureHash = buildSignatureHash(bookingId, now.toISOString());
    const rentalType   = packageLabel ? `Hourly — ${packageLabel}` : "Hourly";

    const doc    = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks = [];
    doc.on("data",  (c) => chunks.push(c));
    doc.on("end",   ()  => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Colors & page metrics ─────────────────────────────────────────────────
    const BLACK      = "#111111";
    const GRAY       = "#555555";
    const LIGHT_GRAY = "#f0f0f0";
    const LINE       = "#cccccc";
    const GREEN      = "#2e7d32";
    const GOLD       = "#b8860b";
    const PAGE_W     = doc.page.width - 100; // 50 px margin each side

    // ── Helper renderers ──────────────────────────────────────────────────────
    function hr() {
      doc.moveDown(0.3)
        .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
        .strokeColor(LINE).lineWidth(0.5).stroke()
        .moveDown(0.3);
    }

    function sectionHeader(n, title) {
      hr();
      doc.font("Helvetica-Bold").fontSize(10).fillColor(BLACK)
        .text(`${n}. ${title.toUpperCase()}`)
        .moveDown(0.15);
      doc.font("Helvetica").fontSize(9).fillColor(BLACK);
    }

    function kv(label, value) {
      const rowY = doc.y;
      const lW   = PAGE_W * 0.38;
      const vW   = PAGE_W * 0.62;
      const rowH = 17;

      doc.rect(50,      rowY, lW, rowH).fill(LIGHT_GRAY);
      doc.rect(50 + lW, rowY, vW, rowH).fill("#ffffff");
      doc.rect(50,      rowY, PAGE_W, rowH).strokeColor(LINE).lineWidth(0.5).stroke();

      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BLACK)
        .text(label, 55, rowY + 4, { width: lW - 10 });
      doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
        .text(safeStr(value) || "—", 55 + lW, rowY + 4, { width: vW - 10 });

      doc.y = rowY + rowH;
    }

    function body(text) {
      doc.font("Helvetica").fontSize(8.5).fillColor(BLACK).text(text, { lineGap: 2 });
    }

    function bullets(items) {
      items.forEach((item) => {
        doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
          .text(`  •  ${item}`, { lineGap: 1 });
      });
    }

    function numbered(items) {
      items.forEach((item, i) => {
        doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
          .text(`  ${i + 1}.  ${item}`, { lineGap: 1 });
      });
    }

    // ── Document header ───────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(14).fillColor(BLACK)
      .text("LA SLINGSHOT RENTALS — VEHICLE RENTAL AGREEMENT", { align: "center" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(9).fillColor(GRAY)
      .text(`Generated: ${generatedAt}`, { align: "center" });
    doc.moveDown(0.5);

    // Parties banner
    doc.rect(50, doc.y, PAGE_W, 24).fill(LIGHT_GRAY);
    const bannerY = doc.y + 7;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK)
      .text(`Company: ${POLICY.companyName}   |   ${POLICY.companyPhone}   |   ${POLICY.companyEmail}`, 55, bannerY);
    doc.y = bannerY + 17;
    kv("Renter Name",         renterName        || "—");
    kv("Driver's License #",  driverLicenseNumber || "Provided (ID on file)");
    kv("Phone",               renterPhone       || "—");
    kv("Email",               renterEmail       || "—");

    // ── Section 1 — Vehicle ───────────────────────────────────────────────────
    sectionHeader(1, "Vehicle Information");
    kv("Vehicle",        "Polaris Slingshot");
    kv("Vehicle Name",   vehicleName   || "—");
    kv("Vehicle ID/VIN", vehicleVin    || "—");
    kv("License Plate",  licensePlate  || "—");

    // ── Section 2 — Rental Period ─────────────────────────────────────────────
    sectionHeader(2, "Rental Period");
    kv("Start Date/Time", startDatetime || "—");
    kv("End Date/Time",   endDatetime   || "—");
    kv("Timezone",        "America/Los_Angeles");

    // ── Section 3 — Pricing ───────────────────────────────────────────────────
    sectionHeader(3, "Pricing Details");
    kv("Rental Type",        rentalType);
    kv("Base Rate",          `$${Number(baseRate).toFixed(2)}`);
    kv("Security Deposit",   `$${Number(securityDeposit).toFixed(2)}`);
    kv("Total Charged",      `$${Number(totalPrice).toFixed(2)}`);
    kv("Payment Status",     safeStr(paymentStatus).toUpperCase());
    kv("Stripe Payment ID",  paymentIntentId || "—");

    // ── Section 4 — Security Deposit Terms ────────────────────────────────────
    sectionHeader(4, "Security Deposit Terms");
    body("The security deposit will be held on file and may be used to cover:");
    bullets([
      "Vehicle damage",
      "Late return fees",
      "Cleaning fees",
      "Traffic violations or tolls",
    ]);
    doc.moveDown(0.2);
    body(`Remaining balance will be refunded within ${POLICY.depositReturnDays} days after inspection.`);

    // ── Section 5 — Driver Eligibility ────────────────────────────────────────
    sectionHeader(5, "Driver Eligibility");
    body("Renter confirms:");
    bullets([
      `Age: ${POLICY.minAge}+ years (must be ${POLICY.minAge} or older)`,
      `Valid driver's license uploaded: ${licenseVerified ? "Yes ✓" : "Pending — required at pickup"}`,
      `Identity verification status: ${identityVerified ? "Verified ✓" : "Pending"}`,
    ]);
    doc.moveDown(0.2);
    body("Only approved drivers may operate the vehicle.");

    // ── Section 6 — Use Restrictions ──────────────────────────────────────────
    sectionHeader(6, "Vehicle Use Restrictions");
    body("The renter agrees NOT to:");
    bullets([
      "Drive under the influence of drugs or alcohol",
      "Allow unauthorized drivers",
      "Use vehicle for racing, drifting, or reckless driving",
      "Leave the state of California without prior written approval",
      "Use for commercial or rideshare purposes",
      "Smoke or allow pets in the vehicle",
    ]);

    // ── Section 7 — GPS ────────────────────────────────────────────────────────
    sectionHeader(7, "GPS & Vehicle Monitoring");
    body(`Renter acknowledges vehicle is equipped with GPS tracking via ${POLICY.trackingProvider} for:`);
    bullets([
      "Theft prevention",
      "Location monitoring",
      "Driving behavior",
    ]);
    doc.moveDown(0.2);
    body("Tampering with the tracking device is prohibited and may result in immediate termination of the rental.");

    // ── Section 8 — Damage & Liability ────────────────────────────────────────
    sectionHeader(8, "Damage & Liability");
    body("Renter accepts full responsibility for:");
    bullets([
      "Any damage during the rental period",
      "Mechanical damage caused by misuse",
      "Tire, wheel, or interior damage",
    ]);
    doc.moveDown(0.2);
    body(`Estimated Damage Liability Cap: $${POLICY.damageCap}`);
    doc.moveDown(0.2);
    body("If damage occurs:");
    bullets([
      "Renter will be charged immediately using the payment method on file",
      "Additional charges may be invoiced if damages exceed the deposit",
    ]);

    // ── Section 9 — Accident Procedure ────────────────────────────────────────
    sectionHeader(9, "Accident Procedure");
    body("In case of accident, renter must:");
    numbered([
      `Notify company immediately at ${POLICY.companyPhone}`,
      "File a police report",
      `Send photos to ${POLICY.companyEmail}`,
    ]);
    doc.moveDown(0.2);
    body("Failure to report may result in full liability.");

    // ── Section 10 — Late Return ───────────────────────────────────────────────
    sectionHeader(10, "Late Return Policy");
    kv("Grace Period",   `${POLICY.gracePeriodMinutes} minutes`);
    kv("Late Fee",       `$${POLICY.lateFeeHourly}/hour after grace period`);
    kv("Higher Fee",     `Full additional charge after ${POLICY.lateThresholdHours} hours`);
    doc.moveDown(0.2);
    body("Unauthorized extensions may trigger:");
    bullets(["Auto-charge via payment method on file", "GPS vehicle recovery"]);

    // ── Section 11 — Fuel ─────────────────────────────────────────────────────
    sectionHeader(11, "Fuel Policy");
    kv("Fuel Level at Pickup",   POLICY.fuelLevelStart);
    kv("Required Return Level",  POLICY.fuelPolicy);
    kv("Refueling Fee",          `$${POLICY.refuelFee}`);

    // ── Section 12 — Cleaning ─────────────────────────────────────────────────
    sectionHeader(12, "Cleaning Policy");
    body("Standard cleaning is included with every rental.");
    doc.moveDown(0.1);
    body("Additional fees apply for:");
    bullets([
      `Smoking ($${POLICY.smokingFee})`,
      `Excessive dirt or contamination ($${POLICY.cleaningFee})`,
      "Interior damage",
    ]);

    // ── Section 13 — Traffic Violations ──────────────────────────────────────
    sectionHeader(13, "Traffic Violations");
    body("Renter is responsible for all tickets, tolls, and parking violations incurred during the rental.");
    doc.moveDown(0.1);
    kv("Admin Processing Fee", `$${POLICY.ticketProcessingFee} per violation`);

    // ── Section 14 — Cancellation ─────────────────────────────────────────────
    sectionHeader(14, "Cancellation Policy");
    kv("Free Cancellation Window", `${POLICY.cancelWindowHours} hours before pickup`);
    kv("Late Cancellation Fee",    POLICY.cancelFee);
    kv("No-Show Policy",           POLICY.noShowPolicy);

    // ── Section 15 — Digital Agreement & Signature ────────────────────────────
    sectionHeader(15, "Digital Agreement & Signature");
    doc.moveDown(0.1);

    const sigBoxY = doc.y;
    doc.rect(50, sigBoxY, PAGE_W, 120).fill("#f9f9f9").strokeColor(BLACK).lineWidth(1).stroke();
    doc.y = sigBoxY + 10;

    doc.font("Helvetica-Bold").fontSize(10).fillColor(BLACK)
      .text("ELECTRONIC AGREEMENT — LEGALLY BINDING", 60, doc.y);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
      .text(
        "By completing payment and booking, renter electronically agrees to all terms of this Rental Agreement, " +
        "including the Terms and Conditions. This constitutes an electronic signature under applicable law.",
        60, doc.y, { width: PAGE_W - 20 }
      );
    doc.moveDown(0.4);

    doc.font("Helvetica-Bold").fontSize(9).fillColor(GREEN)
      .text("✓ Agreement Accepted via Payment Confirmation", 60, doc.y);
    doc.moveDown(0.25);

    doc.font("Helvetica").fontSize(8).fillColor(GRAY)
      .text(`Accepted: ${signedAt}`, 60, doc.y);
    doc.moveDown(0.1);
    doc.text(`Renter: ${renterName || "—"}  |  Email: ${renterEmail || "—"}  |  Phone: ${renterPhone || "—"}`, 60, doc.y, { width: PAGE_W - 20 });
    doc.moveDown(0.1);
    if (ipAddress) {
      doc.text(`IP Address: ${ipAddress}`, 60, doc.y);
      doc.moveDown(0.1);
    }
    doc.font("Helvetica").fontSize(7.5).fillColor(GRAY)
      .text(`Signature Hash: ${signatureHash}`, 60, doc.y);

    // ── Section 16 — System Notes (internal) ─────────────────────────────────
    sectionHeader(16, "System Notes (Internal)");
    kv("Booking ID",    bookingId        || "—");
    kv("Customer ID",   stripeCustomerId || "—");
    kv("Vehicle ID",    vehicleId        || "—");
    kv("Booking Type",  "SLINGSHOT");
    kv("Source",        POLICY.bookingSource);

    doc.end();
  });
}
