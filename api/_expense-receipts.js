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
