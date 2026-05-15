// api/store-booking-docs.js
// Vercel serverless function — stores pre-payment booking documents in Supabase
// so the Stripe webhook can retrieve and attach them to the owner notification email.
//
// Called from car.js immediately before stripe.confirmPayment() is invoked.
// If this call fails (network error, Supabase down, etc.) the payment still
// proceeds normally — this is a best-effort reliability enhancement, not a
// gate.  The existing sessionStorage/IndexedDB fallback in success.html
// continues to work as before.
//
// POST /api/store-booking-docs
// Body: {
//   bookingId, signature,
//   idBase64, idFileName, idMimeType,
//   idBackBase64, idBackFileName, idBackMimeType,
//   insuranceBase64, insuranceFileName, insuranceMimeType,
//   insuranceCoverageChoice
// }
// Returns: { ok: true, stored: boolean }

import {
  buildUploadDiagnostics,
  estimateBase64Bytes,
  hasBase64Payload,
  normalizeBase64Payload,
  normalizeDocumentMimeType,
  retrySupabaseOperation,
  summarizeSupabaseError,
} from "./_document-upload.js";
import { getSupabaseAdmin } from "./_supabase.js";

// Allow large bodies (ID front + back + insurance doc can be several MB base64-encoded).
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "30mb",
    },
  },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const MAX_DOC_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_DOC_FILE_BYTES = 18 * 1024 * 1024; // 18 MB total across docs

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const {
    bookingId,
    signature,
    idBase64, idFileName, idMimeType,
    idBackBase64, idBackFileName, idBackMimeType,
    insuranceBase64, insuranceFileName, insuranceMimeType,
    insuranceCoverageChoice,
  } = req.body || {};

  if (!bookingId || typeof bookingId !== "string" || !bookingId.trim()) {
    return res.status(400).json({ error: "bookingId is required." });
  }

  const trimmedIdFileName = typeof idFileName === "string" ? idFileName.trim() : "";
  const trimmedIdBackFileName = typeof idBackFileName === "string" ? idBackFileName.trim() : "";
  if (!trimmedIdFileName || !hasBase64Payload(idBase64)) {
    return res.status(400).json({ error: "The front of your driver's license or ID is required." });
  }
  if (!trimmedIdBackFileName || !hasBase64Payload(idBackBase64)) {
    return res.status(400).json({ error: "The back of your driver's license or ID is required." });
  }
  if (insuranceCoverageChoice === "yes") {
    const trimmedInsuranceFileName = typeof insuranceFileName === "string" ? insuranceFileName.trim() : "";
    if (!trimmedInsuranceFileName || !hasBase64Payload(insuranceBase64)) {
      return res.status(400).json({ error: "Insurance file and payload are required when personal insurance is selected." });
    }
  }

  const docs = [
    { key: "idFront", base64: idBase64, fileName: trimmedIdFileName, mimeType: idMimeType },
    { key: "idBack", base64: idBackBase64, fileName: trimmedIdBackFileName, mimeType: idBackMimeType },
    { key: "insurance", base64: insuranceBase64, fileName: insuranceFileName, mimeType: insuranceMimeType },
  ];
  let totalBytes = 0;
  for (const doc of docs) {
    const bytes = estimateBase64Bytes(doc.base64);
    if (bytes > MAX_DOC_FILE_BYTES) {
      return res.status(413).json({
        error: `${doc.key} exceeds the ${Math.round(MAX_DOC_FILE_BYTES / (1024 * 1024))}MB per-file limit.`,
        code: "DOC_FILE_TOO_LARGE",
        field: doc.key,
      });
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_DOC_FILE_BYTES) {
    return res.status(413).json({
      error: `Combined document size exceeds the ${Math.round(MAX_TOTAL_DOC_FILE_BYTES / (1024 * 1024))}MB limit.`,
      code: "DOC_TOTAL_TOO_LARGE",
    });
  }

  const normalizedDocs = {
    idBase64: normalizeBase64Payload(idBase64) || null,
    idFileName: trimmedIdFileName || null,
    idMimeType: normalizeDocumentMimeType(idMimeType, trimmedIdFileName, "application/octet-stream"),
    idBackBase64: normalizeBase64Payload(idBackBase64) || null,
    idBackFileName: trimmedIdBackFileName || null,
    idBackMimeType: normalizeDocumentMimeType(idBackMimeType, trimmedIdBackFileName, "application/octet-stream"),
    insuranceBase64: normalizeBase64Payload(insuranceBase64) || null,
    insuranceFileName: typeof insuranceFileName === "string" ? insuranceFileName.trim() || null : null,
    insuranceMimeType: normalizeDocumentMimeType(insuranceMimeType, insuranceFileName, "application/octet-stream"),
  };

  const diagnostics = buildUploadDiagnostics(req, [
    { field: "idFront", fileName: normalizedDocs.idFileName, mimeType: normalizedDocs.idMimeType, base64: normalizedDocs.idBase64 },
    { field: "idBack", fileName: normalizedDocs.idBackFileName, mimeType: normalizedDocs.idBackMimeType, base64: normalizedDocs.idBackBase64 },
    { field: "insurance", fileName: normalizedDocs.insuranceFileName, mimeType: normalizedDocs.insuranceMimeType, base64: normalizedDocs.insuranceBase64 },
  ]);

  const sb = getSupabaseAdmin();
  if (!sb) {
    console.error("store-booking-docs: Supabase not configured — docs not stored", diagnostics);
    return res.status(503).json({ ok: false, stored: false, error: "Document storage service is not configured. Please contact support." });
  }

  try {
    const { error } = await retrySupabaseOperation(() => sb.from("pending_booking_docs").upsert(
      {
        booking_id:               bookingId.trim(),
        signature:                signature || null,
        id_base64:                normalizedDocs.idBase64,
        id_filename:              normalizedDocs.idFileName,
        id_mimetype:              normalizedDocs.idMimeType,
        id_back_base64:           normalizedDocs.idBackBase64,
        id_back_filename:         normalizedDocs.idBackFileName,
        id_back_mimetype:         normalizedDocs.idBackMimeType,
        insurance_base64:         normalizedDocs.insuranceBase64,
        insurance_filename:       normalizedDocs.insuranceFileName,
        insurance_mimetype:       normalizedDocs.insuranceMimeType,
        insurance_coverage_choice: insuranceCoverageChoice || null,
        email_sent:               false,
      },
      { onConflict: "booking_id" }
    ), { attempts: 3, baseDelayMs: 300, label: "store-booking-docs" });

    if (error) {
      console.error("store-booking-docs: Supabase upsert error:", {
        bookingId: bookingId.trim(),
        error: summarizeSupabaseError(error),
        diagnostics,
      });
      return res.status(503).json({ ok: false, stored: false, error: "Could not store booking documents. Please try again." });
    }

    console.log("store-booking-docs: stored docs", {
      bookingId: bookingId.trim(),
      totalBytes,
      diagnostics,
    });
    return res.status(200).json({ ok: true, stored: true });
  } catch (err) {
    console.error("store-booking-docs: unexpected error:", {
      bookingId: bookingId.trim(),
      error: summarizeSupabaseError(err),
      diagnostics,
    });
    return res.status(500).json({ ok: false, stored: false, error: "Unexpected document storage error. Please try again." });
  }
}
