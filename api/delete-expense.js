// api/delete-expense.js
// Vercel serverless function — removes an expense record by ID.
// Deletes from Supabase when configured; falls back to GitHub (expenses.json).
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/delete-expense
// Body: {
//   "secret":     "<ADMIN_SECRET>",
//   "expense_id": "<expense_id to delete>"
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { loadExpenses, saveExpenses } from "./_expenses.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

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

  const { secret, expense_id } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!expense_id || typeof expense_id !== "string") {
    return res.status(400).json({ error: "expense_id is required" });
  }

  try {
    const sb = getSupabaseAdmin();
    let useGitHub = !sb;

    if (sb) {
      // ── Supabase path (preferred) ──────────────────────────────────────
      const { data: existing, error: fetchErr } = await sb
        .from("expenses").select("expense_id").eq("expense_id", expense_id).maybeSingle();

      if (fetchErr && isSchemaError(fetchErr)) {
        console.warn("delete-expense: expenses table missing in Supabase, falling back to GitHub");
        useGitHub = true;
      } else if (fetchErr) {
        throw new Error(fetchErr.message);
      } else if (!existing) {
        return res.status(404).json({ error: "Expense not found" });
      } else {
        const { error: delErr } = await sb.from("expenses").delete().eq("expense_id", expense_id);
        if (delErr && isSchemaError(delErr)) {
          console.warn("delete-expense: expenses table missing in Supabase, falling back to GitHub");
          useGitHub = true;
        } else if (delErr) {
          throw new Error(delErr.message);
        }
      }
    }

    if (useGitHub) {
      // ── GitHub fallback ────────────────────────────────────────────────
      if (!process.env.GITHUB_TOKEN) {
        return res.status(503).json({ error: "Neither Supabase nor GITHUB_TOKEN is configured." });
      }
      const { data: checkData } = await loadExpenses();
      if (!checkData.some((e) => e.expense_id === expense_id)) {
        return res.status(404).json({ error: "Expense not found" });
      }
      await updateJsonFileWithRetry({
        load:    loadExpenses,
        apply:   (data) => {
          const after = data.filter((e) => e.expense_id !== expense_id);
          data.splice(0, data.length, ...after);
        },
        save:    saveExpenses,
        message: `Delete expense ${expense_id}`,
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("delete-expense error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
