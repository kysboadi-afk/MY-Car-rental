import crypto from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { getVehicleById } from "./_vehicles.js";
import { generateSlingshotRentalAgreementPdf } from "./_slingshot-rental-agreement.js";
import { createManageToken } from "./_manage-booking-token.js";
import { applySlingshotBookingStatusTransition } from "./_slingshot-booking-status-transitions.js";
import { isSchemaError } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const SLINGSHOT_DEPOSIT = 500;
const BOOKING_SELECT_VARIANTS = [
  "booking_ref, vehicle_id, category, status, customer_name, customer_email, customer_phone, renter_phone, pickup_date, pickup_time, return_date, return_time, total_price, remaining_balance, payment_status, identity_session_id, manage_token",
  "booking_ref, vehicle_id, status, customer_name, customer_email, customer_phone, renter_phone, pickup_date, pickup_time, return_date, return_time, total_price, remaining_balance, payment_status, identity_session_id, manage_token",
  "booking_ref, vehicle_id, category, status, customer_name, customer_email, customer_phone, renter_phone, pickup_date, pickup_time, return_date, return_time, total_price, remaining_balance, payment_status, manage_token",
  "booking_ref, vehicle_id, status, customer_name, customer_email, customer_phone, renter_phone, pickup_date, pickup_time, return_date, return_time, total_price, remaining_balance, payment_status, manage_token",
];

function inferPackage(baseRate) {
  const map = {
    150: "2 Hours",
    200: "3 Hours",
    250: "6 Hours",
    350: "24 Hours",
  };
  return map[Math.round(Number(baseRate || 0))] || "";
}

async function fetchBookingWithCompatibility(sb, bookingRef) {
  let schemaError = null;
  for (const selectClause of BOOKING_SELECT_VARIANTS) {
    const result = await sb
      .from("bookings")
      .select(selectClause)
      .eq("booking_ref", bookingRef)
      .maybeSingle();
    if (!result.error) return result;
    if (!isSchemaError(result.error)) return result;
    schemaError = result.error;
  }
  return { data: null, error: schemaError };
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

  const { bookingId, signature } = req.body || {};
  const trimmedBookingId = typeof bookingId === "string" ? bookingId.trim() : "";
  const trimmedSignature = typeof signature === "string" ? signature.trim().replace(/\s+/g, " ") : "";

  if (!trimmedBookingId) return res.status(400).json({ error: "bookingId is required." });
  if (!trimmedSignature) return res.status(400).json({ error: "A typed signature is required." });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Database unavailable. Please try again." });

  const { data: booking, error: bookingErr } = await fetchBookingWithCompatibility(sb, trimmedBookingId);

  if (bookingErr) return res.status(500).json({ error: `Booking lookup failed: ${bookingErr.message}` });
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  const vehicleData = booking.vehicle_id ? await getVehicleById(booking.vehicle_id).catch(() => null) : null;
  const category = String(booking.category || "").trim().toLowerCase();
  if (category && category !== "slingshot") {
    return res.status(409).json({ error: "This agreement endpoint only supports slingshot bookings." });
  }
  if (!category && String(vehicleData?.type || "").toLowerCase() !== "slingshot") {
    return res.status(409).json({ error: "This agreement endpoint only supports slingshot bookings." });
  }

  const rawCurrentStatus = String(booking.status || "").trim();
  const currentStatus = rawCurrentStatus === "pending" ? "pending_checkout" : rawCurrentStatus;
  const allowedStatuses = new Set(["pending", "identity_verified", "pending_checkout", "agreement_pending", "agreement_signed", "pending_manual_payment", "ready_for_pickup"]);
  if (!allowedStatuses.has(currentStatus)) {
    return res.status(409).json({ error: `Booking is not ready for agreement signing (current status: ${currentStatus || "unknown"}).` });
  }

  const { data: existingDocs } = await sb
    .from("pending_booking_docs")
    .select("agreement_pdf_url")
    .eq("booking_id", trimmedBookingId)
    .maybeSingle();

  if ((currentStatus === "pending_manual_payment" || currentStatus === "ready_for_pickup") && existingDocs?.agreement_pdf_url) {
    const { data: signedExisting } = await sb.storage
      .from("rental-agreements")
      .createSignedUrl(existingDocs.agreement_pdf_url, 3600);
    return res.status(200).json({
      success: true,
      bookingId: trimmedBookingId,
      agreementPdfUrl: signedExisting?.signedUrl || null,
      manageLink: booking.manage_token ? `https://www.slytrans.com/manage-booking.html?t=${encodeURIComponent(booking.manage_token)}` : null,
    });
  }
  if (currentStatus === "pending_manual_payment" || currentStatus === "ready_for_pickup") {
    return res.status(409).json({ error: "This booking is already signed and awaiting pickup workflows. Please contact support if the agreement file needs to be restored." });
  }

  if (booking.customer_name && booking.customer_name.trim().toLowerCase() !== trimmedSignature.toLowerCase()) {
    console.warn("[SLINGSHOT_AGREEMENT] signature mismatch", {
      bookingId: trimmedBookingId,
      renterName: booking.customer_name,
      signature: trimmedSignature,
    });
  }

  const totalPrice = Number(booking.total_price || 0);
  const baseRate = Math.max(0, totalPrice - SLINGSHOT_DEPOSIT);
  const packageLabel = inferPackage(baseRate);
  const signedAtIso = new Date().toISOString();
  const ipAddress = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null;
  const userAgent = String(req.headers["user-agent"] || "").trim() || null;
  const signatureHash = crypto
    .createHash("sha256")
    .update(`${trimmedBookingId}|${trimmedSignature}|${signedAtIso}`)
    .digest("hex");

  const pdfBuffer = await generateSlingshotRentalAgreementPdf({
    bookingId: trimmedBookingId,
    renterName: booking.customer_name || trimmedSignature,
    renterSignature: trimmedSignature,
    renterPhone: booking.customer_phone || booking.renter_phone || "",
    renterEmail: booking.customer_email || "",
    vehicleVin: vehicleData?.vin || "",
    vehicleName: vehicleData?.name || "Polaris Slingshot",
    licensePlate: vehicleData?.licensePlate || vehicleData?.license_plate || "",
    vehicleId: booking.vehicle_id || "",
    startDatetime: `${booking.pickup_date || ""}${booking.pickup_time ? ` at ${booking.pickup_time}` : ""}`.trim(),
    endDatetime: `${booking.return_date || ""}${booking.return_time ? ` at ${booking.return_time}` : ""}`.trim(),
    packageLabel,
    baseRate,
    totalPrice,
    securityDeposit: SLINGSHOT_DEPOSIT,
    paymentStatus: "Due at pickup — collected in person",
    identityVerified: true,
    identitySessionId: booking.identity_session_id || "",
    signatureMethod: "typed_name",
    signedAt: signedAtIso,
  }, ipAddress);

  const safeDate = signedAtIso.replace(/[:.]/g, "-");
  const storagePath = `slingshot/${trimmedBookingId}/agreement-${safeDate}.pdf`;
  const { error: uploadErr } = await sb.storage
    .from("rental-agreements")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });
  if (uploadErr) {
    return res.status(500).json({ error: `Agreement storage failed: ${uploadErr.message}` });
  }

  const manageToken = booking.manage_token || createManageToken(trimmedBookingId);
  const manageLink = `https://www.slytrans.com/manage-booking.html?t=${encodeURIComponent(manageToken)}`;
  await sb
    .from("bookings")
    .update({ manage_token: manageToken, updated_at: new Date().toISOString() })
    .eq("booking_ref", trimmedBookingId);

  let currentBookingState = { ...booking, status: currentStatus };
  if (rawCurrentStatus === "pending") {
    await sb
      .from("bookings")
      .update({ status: "pending_checkout", updated_at: new Date().toISOString() })
      .eq("booking_ref", trimmedBookingId);
  }
  if (currentStatus === "identity_verified" || currentStatus === "pending_checkout") {
    currentBookingState = await applySlingshotBookingStatusTransition(sb, currentBookingState, "agreement_pending", {
      changedBy: "slingshot-agreement",
    });
  }
  currentBookingState = await applySlingshotBookingStatusTransition(sb, currentBookingState, "agreement_signed", {
    changedBy: "slingshot-agreement",
    auditFields: { agreement_signature_method: "typed_name" },
  });
  currentBookingState = await applySlingshotBookingStatusTransition(sb, currentBookingState, "pending_manual_payment", {
    changedBy: "slingshot-agreement",
    extraFields: {
      payment_status: "manual_pending",
    },
    auditFields: { payment_status: "manual_pending" },
  });

  await sb
    .from("pending_booking_docs")
    .upsert({
      booking_id: trimmedBookingId,
      booking_type: "slingshot",
      agreement_pdf_url: storagePath,
      signed_at: signedAtIso,
      signature_hash: signatureHash,
      ip_address: ipAddress,
      identity_session_id: booking.identity_session_id || null,
      signature_method: "typed_name",
      user_agent: userAgent,
      signature: trimmedSignature,
      email_sent: false,
    }, { onConflict: "booking_id" });

  const { data: signedData } = await sb.storage
    .from("rental-agreements")
    .createSignedUrl(storagePath, 3600);

  return res.status(200).json({
    success: true,
    bookingId: trimmedBookingId,
    manageLink,
    agreementPdfUrl: signedData?.signedUrl || null,
    notifications: {
      renterEmailSent: false,
      ownerEmailSent: false,
      deferredToAdminAfterManualPayment: true,
    },
  });
}
