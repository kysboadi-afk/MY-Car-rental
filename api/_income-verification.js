// api/_income-verification.js
// Shared constants and helpers for renter income-verification document uploads.

export const INCOME_VERIFICATION_BUCKET = "application-documents";
export const INCOME_VERIFICATION_DOC_TYPE = "income_verification";

// Max individual file size accepted (post-compression) — generous for mobile uploads.
export const INCOME_VERIFICATION_MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

// How many files a single application may upload.
export const INCOME_VERIFICATION_MAX_FILES = 10;

// MIME types accepted for income verification uploads.
// image/* covers HEIC/HEIF on Safari; explicit types listed for clarity.
export const INCOME_VERIFICATION_ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

// Normalise HEIC/HEIF aliases that some OS/browser combos report.
const MIME_ALIASES = {
  "image/jpg": "image/jpeg",
  "image/x-heic": "image/heic",
  "image/x-heif": "image/heif",
};

export function normalizeIncomeVerificationMime(raw) {
  const lower = (raw || "").trim().toLowerCase();
  return MIME_ALIASES[lower] || lower;
}

export function isAllowedIncomeVerificationMime(raw) {
  const normalized = normalizeIncomeVerificationMime(raw);
  // Allow any image/* type so HEIC and future formats work
  return INCOME_VERIFICATION_ALLOWED_MIME_TYPES.has(normalized) || normalized.startsWith("image/");
}

/**
 * Build the Supabase Storage path for a single income-verification file.
 * Pattern: application-documents/{applicationId}/income-verification/{timestamp}-{random}.{ext}
 */
export function incomeVerificationFilePath(applicationId, ext) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safeExt = (ext || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase();
  return `${applicationId}/income-verification/${ts}-${rand}.${safeExt}`;
}

/**
 * Derive a file extension from a MIME type or fall back to the original filename.
 */
export function extensionFromMime(mime, fileName) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "application/pdf": "pdf",
  };
  const normalized = normalizeIncomeVerificationMime(mime);
  if (map[normalized]) return map[normalized];
  // Fall back to original file extension
  if (fileName) {
    const m = String(fileName).match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
  }
  return "bin";
}

/** Sanitise a display-safe file name (strip path traversal, limit length). */
export function sanitizeIncomeFileName(raw, fallback = "upload") {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const safe = trimmed.replace(/[^a-zA-Z0-9._\- ]/g, "_").slice(0, 120);
  return safe || fallback;
}
