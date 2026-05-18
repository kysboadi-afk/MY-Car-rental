// api/upload-income-verification.js
// Renter-facing endpoint: upload a single income-verification document and link
// it to an existing application.
//
// POST /api/upload-income-verification
// Body (JSON): {
//   applicationId: string   — existing renter application UUID
//   fileData:      string   — base64-encoded file (data-URI or raw base64)
//   mimeType:      string   — e.g. "image/jpeg", "application/pdf"
//   fileName:      string   — original file name (used for extension fallback)
// }
//
// Returns: { success: true, documentId, url, fileName, mimeType, fileSize }
//
// No admin secret required — any caller with a valid applicationId may upload.
// Rate-limiting / abuse prevention is handled by:
//  - Validating that the applicationId exists and is in an uploadable state
//  - Capping total documents per application at INCOME_VERIFICATION_MAX_FILES
//  - Enforcing per-file size limit (INCOME_VERIFICATION_MAX_FILE_BYTES)

import { randomBytes } from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import {
  decodeBase64Document,
  summarizeSupabaseError,
  uploadWithBucketRecovery,
} from "./_document-upload.js";
import {
  INCOME_VERIFICATION_BUCKET,
  INCOME_VERIFICATION_DOC_TYPE,
  INCOME_VERIFICATION_MAX_FILE_BYTES,
  INCOME_VERIFICATION_MAX_FILES,
  isAllowedIncomeVerificationMime,
  normalizeIncomeVerificationMime,
  incomeVerificationFilePath,
  sanitizeIncomeFileName,
  extensionFromMime,
} from "./_income-verification.js";

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Statuses that still allow document uploads
const UPLOADABLE_STATUSES = new Set([
  "submitted",
  "under_review",
  "needs_info",
  "approved",
]);

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Storage service is not configured." });

  const { applicationId, fileData, mimeType, fileName } = req.body || {};

  if (!applicationId || typeof applicationId !== "string" || !applicationId.trim()) {
    return res.status(400).json({ error: "applicationId is required." });
  }
  if (!fileData || typeof fileData !== "string") {
    return res.status(400).json({ error: "fileData (base64) is required." });
  }

  const normalizedMime = normalizeIncomeVerificationMime(mimeType || "");
  if (!isAllowedIncomeVerificationMime(normalizedMime)) {
    return res.status(400).json({
      error: "Unsupported file type. Accepted formats: JPG, PNG, WEBP, PDF, HEIC.",
    });
  }

  // Decode and size-check
  let decoded;
  try {
    decoded = decodeBase64Document({
      base64Data: fileData,
      mimeType: normalizedMime,
      fileName,
      maxBytes: INCOME_VERIFICATION_MAX_FILE_BYTES,
    });
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("too large")) {
      return res.status(400).json({ error: `File too large. Maximum size is 15 MB.` });
    }
    return res.status(400).json({ error: "Invalid file data." });
  }

  // Verify application exists and is in an uploadable state
  const { data: appRow, error: appErr } = await sb
    .from("renter_applications")
    .select("id, application_status")
    .eq("id", applicationId.trim())
    .maybeSingle();

  if (appErr) {
    console.error("upload-income-verification: application lookup failed", {
      applicationId: applicationId.trim(),
      error: summarizeSupabaseError(appErr),
    });
    return res.status(503).json({ error: "Failed to verify application." });
  }
  if (!appRow) {
    return res.status(404).json({ error: "Application not found." });
  }
  if (!UPLOADABLE_STATES_OK(appRow.application_status)) {
    return res.status(409).json({
      error: `Documents cannot be uploaded for an application with status "${appRow.application_status}".`,
    });
  }

  // Enforce per-application file count cap
  const { count: existingCount, error: countErr } = await sb
    .from("application_documents")
    .select("id", { count: "exact", head: true })
    .eq("application_id", applicationId.trim())
    .eq("doc_type", INCOME_VERIFICATION_DOC_TYPE);

  if (!countErr && existingCount != null && existingCount >= INCOME_VERIFICATION_MAX_FILES) {
    return res.status(400).json({
      error: `Maximum of ${INCOME_VERIFICATION_MAX_FILES} income verification documents already uploaded.`,
    });
  }
  // If countErr (e.g. table doesn't exist yet) we continue — don't fail the upload.

  // Build storage path and upload
  const ext = extensionFromMime(normalizedMime, fileName);
  const filePath = incomeVerificationFilePath(applicationId.trim(), ext);
  const safeFileName = sanitizeIncomeFileName(fileName || `upload.${ext}`);

  const { error: uploadErr } = await uploadWithBucketRecovery(
    sb,
    INCOME_VERIFICATION_BUCKET,
    filePath,
    decoded.buffer,
    { contentType: normalizedMime, upsert: false },
    { public: false, fileSizeLimit: String(INCOME_VERIFICATION_MAX_FILE_BYTES) }
  );

  if (uploadErr) {
    console.error("upload-income-verification: storage upload failed", {
      applicationId: applicationId.trim(),
      error: summarizeSupabaseError(uploadErr),
    });
    return res.status(500).json({ error: "Upload failed. Please try again." });
  }

  // Get a signed URL (30-day expiry) for immediate admin preview
  const { data: urlData } = await sb.storage
    .from(INCOME_VERIFICATION_BUCKET)
    .createSignedUrl(filePath, 60 * 60 * 24 * 30);
  const signedUrl = urlData?.signedUrl || null;

  // Persist document record — fail gracefully if table doesn't exist yet
  let documentId = null;
  try {
    const { data: docRow, error: docErr } = await sb
      .from("application_documents")
      .insert({
        application_id: applicationId.trim(),
        doc_type: INCOME_VERIFICATION_DOC_TYPE,
        file_name: safeFileName,
        mime_type: normalizedMime,
        file_path: filePath,
        file_size_bytes: decoded.bytes,
        verification_status: "pending",
      })
      .select("id")
      .single();

    if (docErr) {
      console.error("upload-income-verification: db record insert failed", {
        applicationId: applicationId.trim(),
        error: summarizeSupabaseError(docErr),
      });
    } else {
      documentId = docRow?.id || null;
    }
  } catch (dbErr) {
    console.error("upload-income-verification: db insert threw", adminErrorMessage(dbErr));
  }

  console.info("upload-income-verification: upload succeeded", {
    applicationId: applicationId.trim(),
    documentId,
    mimeType: normalizedMime,
    bytes: decoded.bytes,
  });

  return res.status(200).json({
    success: true,
    documentId,
    signedUrl,
    fileName: safeFileName,
    mimeType: normalizedMime,
    fileSize: decoded.bytes,
  });
}

function UPLOADABLE_STATES_OK(status) {
  return UPLOADABLE_STATUSES.has(status);
}
