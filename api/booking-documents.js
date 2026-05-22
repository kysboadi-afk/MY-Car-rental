// api/booking-documents.js
// Manage per-booking documents (rental agreement, insurance, id_copy, other) stored in
// Supabase Storage with references tracked in the booking_documents table.
//
// POST /api/booking-documents
// Actions:
//   list    — { secret, action:"list",   bookingId }        bookingId = bookings.id (UUID)
//   add     — { secret, action:"add",    bookingId, docType, fileData, mimeType, fileName? }
//   delete  — { secret, action:"delete", id }
//
// Returns per-action:
//   list   → { success: true, docs: [...] }
//   add    → { success: true, doc: {...} }
//   delete → { success: true }

import { randomBytes } from "crypto";
import {
  buildUploadDiagnostics,
  decodeBase64Document,
  isAllowedDocumentMimeType,
  summarizeSupabaseError,
  uploadWithBucketRecovery,
} from "./_document-upload.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const BUCKET           = "booking-documents";
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_FRONT_ID = "pending-front";
const PENDING_BACK_ID  = "pending-back";
const MAX_SIZE_BYTES   = 15 * 1024 * 1024; // 15 MB
const VALID_TYPES      = ["agreement", "insurance", "other", "id_copy"];
export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, action } = body;

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase not configured." });
  }

  try {
    switch (action) {
      case "list":   return await actionList(sb, body, res);
      case "add":    return await actionAdd(sb, body, res, req);
      case "delete": return await actionDelete(sb, body, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("booking-documents error:", summarizeSupabaseError(err));
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

// ── LIST ──────────────────────────────────────────────────────────────────────

async function actionList(sb, body, res) {
  const { bookingId } = body;
  if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

  const { data, error } = await sb
    .from("booking_documents")
    .select("id, booking_id, type, file_url, file_name, mime_type, uploaded_at")
    .eq("booking_id", bookingId)
    .order("uploaded_at", { ascending: true });

  if (error) throw error;

  const docs = data || [];
  const idDocCount = docs.filter((d) => d.type === "id_copy").length;

  // If fewer than 2 id_copy docs are in booking_documents, also check
  // pending_booking_docs for IDs the renter uploaded during checkout.
  // pending_booking_docs uses the booking_ref (bk-xxx) as its key, so we
  // first resolve that from the bookings table when a UUID was supplied.
  if (idDocCount < 2) {
    try {
      let bookingRef = bookingId;
      // If bookingId looks like a UUID, look up the booking_ref.
      if (UUID_RE.test(bookingId)) {
        const { data: bookingRow } = await sb
          .from("bookings")
          .select("booking_ref")
          .eq("id", bookingId)
          .maybeSingle();
        if (bookingRow?.booking_ref) bookingRef = bookingRow.booking_ref;
      }

      const { data: pendingRow } = await sb
        .from("pending_booking_docs")
        .select(
          "id_base64, id_filename, id_mimetype, id_back_base64, id_back_filename, id_back_mimetype, created_at"
        )
        .eq("booking_id", bookingRef)
        .maybeSingle();

      if (pendingRow) {
        if (pendingRow.id_base64 && pendingRow.id_filename) {
          docs.push({
            id: PENDING_FRONT_ID,
            booking_id: bookingId,
            type: "id_copy",
            file_url: "",
            file_name: pendingRow.id_filename,
            mime_type: pendingRow.id_mimetype || "image/jpeg",
            uploaded_at: pendingRow.created_at,
            source: "renter_upload",
          });
        }
        if (pendingRow.id_back_base64 && pendingRow.id_back_filename) {
          docs.push({
            id: PENDING_BACK_ID,
            booking_id: bookingId,
            type: "id_copy",
            file_url: "",
            file_name: pendingRow.id_back_filename,
            mime_type: pendingRow.id_back_mimetype || "image/jpeg",
            uploaded_at: pendingRow.created_at,
            source: "renter_upload",
          });
        }
      }
    } catch (pendingErr) {
      // Non-fatal: log and return whatever we already have.
      console.warn(
        "booking-documents list: could not check pending_booking_docs:",
        pendingErr.message
      );
    }
  }

  return res.status(200).json({ success: true, docs });
}

// ── ADD ───────────────────────────────────────────────────────────────────────

async function actionAdd(sb, body, res, req) {
  const { bookingId, docType = "other", fileData, mimeType, fileName } = body;

  if (!bookingId || typeof bookingId !== "string") {
    return res.status(400).json({ error: "bookingId is required" });
  }
  if (!VALID_TYPES.includes(docType)) {
    return res.status(400).json({ error: `docType must be one of: ${VALID_TYPES.join(", ")}` });
  }
  if (!fileData || typeof fileData !== "string") {
    return res.status(400).json({ error: "fileData (base64) is required" });
  }

  const diagnostics = buildUploadDiagnostics(req, [
    { field: docType, fileName, mimeType, base64: fileData },
  ]);

  let decodedDoc;
  try {
    decodedDoc = decodeBase64Document({
      base64Data: fileData,
      mimeType,
      fileName,
      maxBytes: MAX_SIZE_BYTES,
    });
  } catch (err) {
    console.error("booking-documents: rejected upload", {
      bookingId,
      docType,
      error: err.message,
      diagnostics,
    });
    return res.status(400).json({ error: err.message || "Invalid document upload." });
  }

  if (!isAllowedDocumentMimeType(decodedDoc.mimeType)) {
    console.error("booking-documents: rejected MIME type", {
      bookingId,
      docType,
      mimeType: decodedDoc.mimeType,
      diagnostics,
    });
    return res.status(400).json({ error: "Only image files and PDFs are accepted." });
  }

  const safeName = fileName
    ? String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
    : `${docType}.${decodedDoc.extension}`;
  const filePath = `${bookingId}/${docType}-${Date.now()}-${randomBytes(4).toString("hex")}.${decodedDoc.extension}`;

  const { error: uploadErr } = await uploadWithBucketRecovery(
    sb,
    BUCKET,
    filePath,
    decodedDoc.buffer,
    { contentType: decodedDoc.mimeType, upsert: false },
    { public: true, fileSizeLimit: String(MAX_SIZE_BYTES) }
  );

  if (uploadErr) {
    console.error("booking-documents: upload error:", {
      bookingId,
      docType,
      error: summarizeSupabaseError(uploadErr),
      diagnostics,
    });
    return res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });
  }

  const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(filePath);
  const fileUrl = urlData?.publicUrl || "";

  const { data: doc, error: insertErr } = await sb
    .from("booking_documents")
    .insert({
      booking_id: bookingId,
      type:       docType,
      file_url:   fileUrl,
      file_name:  safeName,
      mime_type:  decodedDoc.mimeType,
    })
    .select()
    .single();

  if (insertErr) throw insertErr;

  return res.status(200).json({ success: true, doc });
}

// ── DELETE ────────────────────────────────────────────────────────────────────

async function actionDelete(sb, body, res) {
  const { id } = body;
  if (!id) return res.status(400).json({ error: "id is required" });

  const { error } = await sb.from("booking_documents").delete().eq("id", id);
  if (error) throw error;

  return res.status(200).json({ success: true });
}
