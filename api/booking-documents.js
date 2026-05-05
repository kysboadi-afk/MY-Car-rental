// api/booking-documents.js
// Manage per-booking documents (rental agreement, insurance, other) stored in
// Supabase Storage with references tracked in the booking_documents table.
//
// POST /api/booking-documents
// Actions:
//   list    — { secret, action:"list",   bookingId }
//   add     — { secret, action:"add",    bookingId, docType, fileData, mimeType, fileName? }
//   delete  — { secret, action:"delete", id }
//
// Returns per-action:
//   list   → { success: true, docs: [...] }
//   add    → { success: true, doc: {...} }
//   delete → { success: true }

import { randomBytes } from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const BUCKET           = "booking-documents";
const MAX_SIZE_BYTES   = 15 * 1024 * 1024; // 15 MB
const VALID_TYPES      = ["agreement", "insurance", "other"];
const ALLOWED_MIMETYPES = [
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
      case "add":    return await actionAdd(sb, body, res);
      case "delete": return await actionDelete(sb, body, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("booking-documents error:", err);
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
  return res.status(200).json({ success: true, docs: data || [] });
}

// ── ADD ───────────────────────────────────────────────────────────────────────

async function actionAdd(sb, body, res) {
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

  const mime = (mimeType || "application/pdf").toLowerCase();
  if (!ALLOWED_MIMETYPES.includes(mime)) {
    return res.status(400).json({ error: `mimeType must be one of: ${ALLOWED_MIMETYPES.join(", ")}` });
  }

  const base64Data = fileData.replace(/^data:[^;]+;base64,/, "");
  let buffer;
  try {
    buffer = Buffer.from(base64Data, "base64");
  } catch {
    return res.status(400).json({ error: "Invalid base64 data" });
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    return res.status(400).json({ error: `File too large. Maximum size is ${MAX_SIZE_BYTES / 1024 / 1024} MB.` });
  }

  const extMap = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
  const ext = extMap[mime] || "bin";
  const safeName = fileName
    ? String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
    : `${docType}.${ext}`;
  const filePath = `${bookingId}/${docType}-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;

  const { error: uploadErr } = await sb.storage
    .from(BUCKET)
    .upload(filePath, buffer, { contentType: mime, upsert: false });

  if (uploadErr) {
    console.error("booking-documents: upload error:", uploadErr);
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
      mime_type:  mime,
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
