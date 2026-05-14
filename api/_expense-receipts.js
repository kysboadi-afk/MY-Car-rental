export const EXPENSE_RECEIPTS_BUCKET = "expense-receipts";
export const EXPENSE_RECEIPT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const EXPENSE_RECEIPT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];
export const EXPENSE_RECEIPT_SIGNED_URL_TTL_SECONDS = 60 * 60;

const MIME_EXTENSION_MAP = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function isAllowedExpenseReceiptMimeType(mimeType) {
  return EXPENSE_RECEIPT_ALLOWED_MIME_TYPES.includes(String(mimeType || "").toLowerCase());
}

export function getExpenseReceiptFilePath(expenseId) {
  return `${String(expenseId || "").trim()}/receipt-file`;
}

export function sanitizeExpenseReceiptFilename(fileName, mimeType) {
  const ext = MIME_EXTENSION_MAP[String(mimeType || "").toLowerCase()] || "bin";
  const cleaned = String(fileName || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  if (cleaned) return cleaned;
  return `receipt.${ext}`;
}

export function parseExpenseReceiptBuffer(fileData) {
  const base64Data = String(fileData || "").replace(/^data:[^;]+;base64,/, "");
  return Buffer.from(base64Data, "base64");
}

function bufferStartsWith(buffer, signature) {
  if (!Buffer.isBuffer(buffer) || buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

export function matchesExpenseReceiptMimeSignature(buffer, mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;

  if (mime === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === "image/png") {
    return bufferStartsWith(buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/webp") {
    return (
      buffer.length >= 12
      && buffer.toString("ascii", 0, 4) === "RIFF"
      && buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }
  if (mime === "application/pdf") {
    return bufferStartsWith(buffer, Buffer.from("%PDF-", "ascii"));
  }

  return false;
}

export function isExpenseReceiptImage(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("image/");
}

export function isExpenseReceiptPdf(mimeType) {
  return String(mimeType || "").toLowerCase() === "application/pdf";
}

export function emptyExpenseReceiptMetadata() {
  return {
    receipt_url: null,
    receipt_filename: null,
    receipt_uploaded_at: null,
    receipt_size: null,
    receipt_mime_type: null,
  };
}
