import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { EXPENSE_RECEIPTS_BUCKET, emptyExpenseReceiptMetadata } from "./_expense-receipts.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const EXPENSE_SELECT = "expense_id, vehicle_id, date, category, category_id, amount, notes, created_at, receipt_url, receipt_filename, receipt_uploaded_at, receipt_size, receipt_mime_type";

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const { secret, expenseId } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!expenseId || typeof expenseId !== "string") {
    return res.status(400).json({ error: "expenseId is required" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase not configured." });
  }

  try {
    const { data: expense, error: fetchErr } = await sb
      .from("expenses")
      .select(EXPENSE_SELECT)
      .eq("expense_id", expenseId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }
    if (!expense.receipt_url) {
      return res.status(404).json({ error: "No receipt attached to this expense" });
    }

    const { error: removeErr } = await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([expense.receipt_url]);
    if (removeErr) {
      return res.status(500).json({ error: `Failed to delete receipt from storage: ${removeErr.message}` });
    }

    const { data: updatedExpense, error: updateErr } = await sb
      .from("expenses")
      .update(emptyExpenseReceiptMetadata())
      .eq("expense_id", expenseId)
      .select(EXPENSE_SELECT)
      .maybeSingle();

    if (updateErr) throw updateErr;

    return res.status(200).json({ success: true, expense: updatedExpense });
  } catch (err) {
    console.error("delete-expense-receipt error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
