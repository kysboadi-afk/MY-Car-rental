import { CARS, computeAmount, computeRentalDays } from "./_pricing.js";

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value, fallback = "N/A") {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return `$${n.toFixed(2)}`;
}

export function isWebsitePaymentMethod(paymentIntentId) {
  return typeof paymentIntentId === "string" && paymentIntentId.startsWith("pi_");
}

function buildFallbackBreakdownLines({
  vehicleId,
  pickupDate,
  returnDate,
  amountPaid,
  totalPrice,
  fullRentalCost,
}) {
  if (!vehicleId || !pickupDate || !returnDate) return [];
  const days = computeRentalDays(pickupDate, returnDate);
  const knownTotal = computeAmount(vehicleId, pickupDate, returnDate);
  const car = CARS[vehicleId] || {};
  const lines = [];
  lines.push(`Rental Duration: ${days} day${days === 1 ? "" : "s"}`);
  if (car.weekly && days >= 7) {
    lines.push(`Weekly Rate: ${money(car.weekly)}/week`);
  } else if (car.pricePerDay) {
    lines.push(`Daily Rate: ${money(car.pricePerDay)}/day`);
  }
  if (Number.isFinite(knownTotal) && knownTotal > 0) {
    lines.push(`Estimated Rental Total: ${money(knownTotal)}`);
  }
  const charged = Number(amountPaid);
  if (Number.isFinite(charged) && charged > 0) {
    lines.push(`Amount Paid: ${money(charged)}`);
  } else if (Number.isFinite(Number(totalPrice))) {
    lines.push(`Amount Paid: ${money(totalPrice)}`);
  }
  if (Number.isFinite(Number(fullRentalCost)) && Number(fullRentalCost) > 0) {
    lines.push(`Full Rental Cost: ${money(fullRentalCost)}`);
  }
  return lines;
}

export function buildDocumentNotes({
  idUploaded,
  signatureUploaded,
  insuranceUploaded,
  insuranceExpected = false,
}) {
  const allMissing = !idUploaded && !signatureUploaded && !insuranceUploaded;
  if (allMissing) return ["Documents not uploaded yet"];
  const missing = [];
  if (!idUploaded) missing.push("Renter ID not uploaded");
  if (!signatureUploaded) missing.push("Signed rental agreement not available");
  if (insuranceExpected && !insuranceUploaded) missing.push("Insurance selected but proof not uploaded");
  return missing;
}

export function buildUnifiedConfirmationEmail({
  audience,
  bookingId,
  vehicleName,
  vehicleId,
  vehicleMake,
  vehicleModel,
  vehicleYear,
  vehicleVin,
  vehicleColor,
  renterName,
  renterEmail,
  renterPhone,
  pickupDate,
  pickupTime,
  returnDate,
  returnTime,
  amountPaid,
  totalPrice,
  fullRentalCost,
  balanceAtPickup,
  status = "booked_paid",
  paymentMethodLabel = "Booking Confirmation",
  insuranceStatus = "Not selected / No protection plan",
  pricingBreakdownLines = [],
  missingItemNotes = [],
  firstName,
}) {
  const pickupDisplay = [pickupDate, pickupTime].filter(Boolean).join(" at ") || "N/A";
  const returnDisplay = [returnDate, returnTime].filter(Boolean).join(" at ") || "N/A";
  const displayVehicle = vehicleName || vehicleId || "N/A";
  const displayName = renterName || "Not provided";
  const totalDisplay = Number.isFinite(Number(amountPaid))
    ? money(amountPaid)
    : (Number.isFinite(Number(totalPrice)) ? money(totalPrice) : "N/A");
  const resolvedBreakdown = Array.isArray(pricingBreakdownLines) && pricingBreakdownLines.length > 0
    ? pricingBreakdownLines
    : buildFallbackBreakdownLines({
      vehicleId,
      pickupDate,
      returnDate,
      amountPaid,
      totalPrice,
      fullRentalCost,
    });
  const notes = [...(missingItemNotes || [])];
  if (resolvedBreakdown.length === 0) {
    notes.push("Pricing breakdown unavailable — insufficient booking data.");
  }
  const audienceLabel = audience === "owner" ? "Booking Confirmed" : "Your Booking is Confirmed";
  const subject = `✅ ${audienceLabel} — ${displayVehicle}`;
  const intro = audience === "owner"
    ? "A booking confirmation was generated with the standardized template."
    : `Hi ${esc(firstName || displayName.split(" ")[0] || "there")}, your booking is confirmed.`;

  const tableRows = `
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(bookingId || "N/A")}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Status</strong></td><td style="padding:8px;border:1px solid #ddd">✅ ${esc(status || "booked_paid")}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Payment Method</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(paymentMethodLabel)}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Vehicle</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(displayVehicle)}</td></tr>
    ${vehicleMake ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Make</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleMake)}</td></tr>` : ""}
    ${vehicleModel ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Model</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleModel)}</td></tr>` : ""}
    ${vehicleYear ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Year</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(String(vehicleYear))}</td></tr>` : ""}
    ${vehicleVin ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>VIN / Plate</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleVin)}</td></tr>` : ""}
    ${vehicleColor ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Color</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(vehicleColor)}</td></tr>` : ""}
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Renter</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(displayName)}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterEmail || "Not provided")}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Phone</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(renterPhone || "Not provided")}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(pickupDisplay)}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Return</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(returnDisplay)}</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Total Charged</strong></td><td style="padding:8px;border:1px solid #ddd"><strong>${esc(totalDisplay)}</strong></td></tr>
    ${Number.isFinite(Number(fullRentalCost)) && Number(fullRentalCost) > 0 ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Full Rental Cost</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(money(fullRentalCost))}</td></tr>` : ""}
    ${Number.isFinite(Number(balanceAtPickup)) && Number(balanceAtPickup) > 0 ? `<tr><td style="padding:8px;border:1px solid #ddd"><strong>Balance Due at Pickup</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(money(balanceAtPickup))}</td></tr>` : ""}
    <tr><td style="padding:8px;border:1px solid #ddd"><strong>Insurance Status</strong></td><td style="padding:8px;border:1px solid #ddd">${esc(insuranceStatus)}</td></tr>
  `;

  const breakdownHtml = resolvedBreakdown.length
    ? `<h3 style="margin-top:16px">📊 Pricing Breakdown</h3><table style="border-collapse:collapse;width:100%">${resolvedBreakdown
      .map((line) => `<tr><td style="padding:8px;border:1px solid #ddd">${esc(line)}</td></tr>`).join("")}</table>`
    : "";
  const notesHtml = notes.length
    ? `<h3 style="margin-top:16px">📝 Notes</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : "";

  const html = `
    <h2>✅ Booking Confirmation — Sly Transportation Services LLC</h2>
    <p>${intro}</p>
    <table style="border-collapse:collapse;width:100%">${tableRows}</table>
    ${breakdownHtml}
    ${notesHtml}
    <p style="margin-top:16px">If any booking details are incorrect (especially pickup/return dates or times), reply to this email or call (213) 916-6606 so we can correct it right away.</p>
    <p style="margin-top:16px">Thank you for choosing Sly Transportation Services LLC.</p>
  `;

  const text = [
    "Booking Confirmation — Sly Transportation Services LLC",
    "",
    audience === "owner"
      ? "A booking confirmation was generated with the standardized template."
      : `Hi ${firstName || displayName.split(" ")[0] || "there"}, your booking is confirmed.`,
    "",
    `Booking ID       : ${bookingId || "N/A"}`,
    `Status           : ${status || "booked_paid"}`,
    `Payment Method   : ${paymentMethodLabel}`,
    `Vehicle          : ${displayVehicle}`,
    vehicleMake ? `Make             : ${vehicleMake}` : "",
    vehicleModel ? `Model            : ${vehicleModel}` : "",
    vehicleYear ? `Year             : ${vehicleYear}` : "",
    vehicleVin ? `VIN / Plate      : ${vehicleVin}` : "",
    vehicleColor ? `Color            : ${vehicleColor}` : "",
    `Renter           : ${displayName}`,
    `Email            : ${renterEmail || "Not provided"}`,
    `Phone            : ${renterPhone || "Not provided"}`,
    `Pickup           : ${pickupDisplay}`,
    `Return           : ${returnDisplay}`,
    `Total Charged    : ${totalDisplay}`,
    Number.isFinite(Number(fullRentalCost)) && Number(fullRentalCost) > 0 ? `Full Rental Cost : ${money(fullRentalCost)}` : "",
    Number.isFinite(Number(balanceAtPickup)) && Number(balanceAtPickup) > 0 ? `Balance at Pickup: ${money(balanceAtPickup)}` : "",
    `Insurance Status : ${insuranceStatus}`,
    "",
    resolvedBreakdown.length ? "Pricing Breakdown:" : "",
    ...(resolvedBreakdown.length ? resolvedBreakdown.map((line) => `- ${line}`) : []),
    "",
    notes.length ? "Notes:" : "",
    ...(notes.length ? notes.map((n) => `- ${n}`) : []),
    "",
    "If any booking details are incorrect (especially pickup/return dates or times), reply to this email or call (213) 916-6606 so we can correct it right away.",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}
