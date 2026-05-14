import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";
import {
  EXPENSE_RECEIPTS_BUCKET,
  EXPENSE_RECEIPT_ALLOWED_MIME_TYPES,
  EXPENSE_RECEIPT_MAX_SIZE_BYTES,
  getExpenseReceiptFilePath,
  parseExpenseReceiptBuffer,
  sanitizeExpenseReceiptFilename,
  isAllowedExpenseReceiptMimeType,
  matchesExpenseReceiptMimeSignature,
} from "./_expense-receipts.js";

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const EXPENSE_SELECT = "expense_id, vehicle_id, date, category, category_id, amount, notes, created_at, receipt_url, receipt_filename, receipt_uploaded_at, receipt_size, receipt_mime_type";

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret, expenseId, fileData, mimeType, fileName } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!expenseId || typeof expenseId !== "string") {
    return res.status(400).json({ error: "expenseId is required" });
  }
  if (!fileData || typeof fileData !== "string") {
    return res.status(400).json({ error: "fileData (base64) is required" });
  }

  const mime = String(mimeType || "").toLowerCase();
  if (!isAllowedExpenseReceiptMimeType(mime)) {
    return res.status(400).json({ error: `mimeType must be one of: ${EXPENSE_RECEIPT_ALLOWED_MIME_TYPES.join(", ")}` });
  }

  let buffer;
  try {
    buffer = parseExpenseReceiptBuffer(fileData);
  } catch {
    return res.status(400).json({ error: "Invalid base64 data" });
  }

  if (!buffer.length) {
    return res.status(400).json({ error: "Receipt file is empty" });
  }
  if (buffer.length > EXPENSE_RECEIPT_MAX_SIZE_BYTES) {
    return res.status(400).json({ error: `File too large. Maximum size is ${EXPENSE_RECEIPT_MAX_SIZE_BYTES / 1024 / 1024} MB.` });
  }
  if (!matchesExpenseReceiptMimeSignature(buffer, mime)) {
    return res.status(400).json({ error: "Receipt file contents do not match MIME type" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase not configured." });
  }

  try {
    const { data: existingExpense, error: fetchErr } = await sb
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("expense_id", expenseId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existingExpense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const filePath = getExpenseReceiptFilePath(expenseId);
    const previousPath = existingExpense.receipt_url;
    if (previousPath && previousPath !== filePath) {
      const { error: removePreviousErr } = await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([previousPath]);
      if (removePreviousErr) {
        console.warn("upload-expense-receipt: old receipt cleanup failed:", removePreviousErr.message);
      }
    }

    const { error: uploadErr } = await sb.storage
      .from(EXPENSE_RECEIPTS_BUCKET)
      .upload(filePath, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (uploadErr) {
      return res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });
    }

    const { data: updatedExpense, error: updateErr } = await sb
      .from("expenses")
      .update({
        receipt_url:         filePath,
        receipt_filename:    sanitizeExpenseReceiptFilename(fileName, mime),
        receipt_uploaded_at: new Date().toISOString(),
        receipt_size:        buffer.length,
        receipt_mime_type:   mime,
      })
      .eq("expense_id", expenseId)
      .select(EXPENSE_SELECT)
      .maybeSingle();

    if (updateErr) {
      if (!previousPath || previousPath !== filePath) {
        const { error: rollbackErr } = await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([filePath]);
        if (rollbackErr) {
          console.warn("upload-expense-receipt: rollback cleanup failed:", rollbackErr.message);
        }
      }
      throw updateErr;
    }

    return res.status(200).json({ success: true, expense: updatedExpense });
  } catch (err) {
    console.error("upload-expense-receipt error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
