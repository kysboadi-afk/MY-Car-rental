// api/upload-customer-doc.js
// Upload a customer document (e.g. driver's license front) to Supabase Storage
// and store the public URL in the customers table.
//
// POST /api/upload-customer-doc
// Body (JSON): {
//   secret:     string  — admin password
//   customerId: string  — customer UUID
//   docType:    string  — "license_front" (only supported type for now)
//   imageData:  string  — base64-encoded image (data URI or raw base64)
//   mimeType:   string  — e.g. "image/jpeg", "image/png", "application/pdf"
//   fileName:   string  — original file name (optional, used for extension fallback)
// }
//
// Returns: { success: true, url: string }

import { randomBytes } from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const BUCKET           = "customer-documents";
const MAX_SIZE_BYTES   = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIMETYPES = [
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
];

const DOC_TYPE_COLUMN = {
  license_front: { url: "license_front_url", at: "license_uploaded_at" },
};

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

  const { secret, customerId, docType = "license_front", imageData, mimeType, fileName } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!customerId || typeof customerId !== "string") {
    return res.status(400).json({ error: "customerId is required" });
  }
  if (!DOC_TYPE_COLUMN[docType]) {
    return res.status(400).json({ error: `docType must be one of: ${Object.keys(DOC_TYPE_COLUMN).join(", ")}` });
  }
  if (!imageData || typeof imageData !== "string") {
    return res.status(400).json({ error: "imageData (base64) is required" });
  }

  const mime = (mimeType || "image/jpeg").toLowerCase();
  if (!ALLOWED_MIMETYPES.includes(mime)) {
    return res.status(400).json({ error: `mimeType must be one of: ${ALLOWED_MIMETYPES.join(", ")}` });
  }

  const base64Data = imageData.replace(/^data:[^;]+;base64,/, "");
  let buffer;
  try {
    buffer = Buffer.from(base64Data, "base64");
  } catch {
    return res.status(400).json({ error: "Invalid base64 data" });
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    return res.status(400).json({ error: `File too large. Maximum size is ${MAX_SIZE_BYTES / 1024 / 1024} MB.` });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase not configured." });
  }

  try {
    // Build file path: customer-documents/<customerId>/<docType>-<random>.<ext>
    const extMap = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
    const ext = extMap[mime] || "bin";
    const filePath = `${customerId}/${docType}-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;

    const { error: uploadErr } = await sb.storage
      .from(BUCKET)
      .upload(filePath, buffer, { contentType: mime, upsert: true });

    if (uploadErr) {
      console.error("upload-customer-doc: upload error:", uploadErr);
      return res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });
    }

    const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(filePath);
    const url = urlData?.publicUrl || "";

    // Update the customer record
    const cols = DOC_TYPE_COLUMN[docType];
    const { error: updateErr } = await sb
      .from("customers")
      .update({ [cols.url]: url, [cols.at]: new Date().toISOString() })
      .eq("id", customerId);

    if (updateErr) {
      console.error("upload-customer-doc: customer update error:", updateErr);
      // Still return the URL — the file was uploaded successfully
      return res.status(200).json({ success: true, url, customerUpdated: false });
    }

    return res.status(200).json({ success: true, url, customerUpdated: true });
  } catch (err) {
    console.error("upload-customer-doc error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
