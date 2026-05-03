// api/get-expenses.js
// Vercel serverless function — returns expense records, optionally filtered by
// vehicle.  Reads from Supabase when configured; falls back to GitHub
// (expenses.json) so the endpoint works regardless of environment.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/get-expenses
// Body: {
//   "secret":     "<ADMIN_SECRET>",
//   "vehicle_id": "camry"   (optional — omit to get all expenses)
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { loadExpenses } from "./_expenses.js";
import { enrichExpenseCategory, LEGACY_CATEGORY_MAP } from "./_expense-categories.js";
import { adminErrorMessage } from "./_error-helpers.js";

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

  const { secret, vehicle_id } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = getSupabaseAdmin();
    let expenses;

    if (sb) {
      // ── Supabase path (preferred) ──────────────────────────────────────
      let q = sb.from("expenses")
        .select("*, expense_categories!category_id(name, group_name)")
        .order("date", { ascending: false });
      if (vehicle_id) q = q.eq("vehicle_id", vehicle_id);
      const { data, error } = await q;
      if (error) {
        // Table may not exist yet — fall through to GitHub fallback
        console.error("get-expenses supabase error:", error.message);
        expenses = null;
      } else {
        expenses = (data || []).map((e) => {
          const { category_name, category_group } = enrichExpenseCategory(e);
          // Remove the nested relation object; expose flat fields instead
          const { expense_categories: _rel, ...flat } = e;
          return { ...flat, category_name, category_group };
        });
      }
    }

    if (!expenses) {
      // ── GitHub fallback ────────────────────────────────────────────────
      const { data } = await loadExpenses();
      let raw = vehicle_id ? data.filter((e) => e.vehicle_id === vehicle_id) : data;
      // Newest first (descending by date)
      raw.sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);
      // Enrich legacy records with category_name / category_group
      expenses = raw.map((e) => {
        const { category_name, category_group } = enrichExpenseCategory(e);
        return { ...e, category_name, category_group };
      });
    }

    return res.status(200).json({ expenses });
  } catch (err) {
    console.error("get-expenses error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
