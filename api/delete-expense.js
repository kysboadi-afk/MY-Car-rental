// api/delete-expense.js
// Vercel serverless function — removes an expense record from expenses.json by ID.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/delete-expense
// Body: {
//   "secret":     "<ADMIN_SECRET>",
//   "expense_id": "<expense_id to delete>"
// }

import { loadExpenses, saveExpenses } from "./_expenses.js";

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
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "Server configuration error: GITHUB_TOKEN is not set." });
  }

  const { secret, expense_id } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!expense_id || typeof expense_id !== "string") {
    return res.status(400).json({ error: "expense_id is required" });
  }

  try {
    const { data, sha } = await loadExpenses();
    const before = data.length;
    const updated = data.filter((e) => e.expense_id !== expense_id);

    if (updated.length === before) {
      return res.status(404).json({ error: "Expense not found" });
    }

    await saveExpenses(updated, sha, `Delete expense ${expense_id}`);
    return res.status(200).json({ success: true, deleted: before - updated.length });
  } catch (err) {
    console.error("delete-expense error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
