// api/update-expense.js
// Vercel serverless function — updates an existing expense record by expense_id.
// Uses Supabase when configured, with GitHub fallback when unavailable.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/update-expense
// Body: {
//   "secret":      "<ADMIN_SECRET>",
//   "expense_id":  "<expense id>",
//   "vehicle_id":  "camry",
//   "date":        "YYYY-MM-DD",
//   "category_id": "<uuid>",     // optional
//   "category":    "maintenance" // optional legacy/category key fallback
//   "amount":      number,
//   "notes":       string
// }

import { getSupabaseAdmin } from "./_supabase.js";
import { loadExpenses, saveExpenses } from "./_expenses.js";
import { loadCategories, LEGACY_CATEGORY_MAP } from "./_expense-categories.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { getActiveVehicleIds } from "./_pricing.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const LEGACY_CATEGORIES = Object.keys(LEGACY_CATEGORY_MAP);

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

  const { secret, expense_id, vehicle_id, date, category_id, category, amount, notes } = req.body || {};

  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!expense_id || typeof expense_id !== "string") {
    return res.status(400).json({ error: "expense_id is required" });
  }
  if (!vehicle_id || !(await getActiveVehicleIds(getSupabaseAdmin())).includes(vehicle_id)) {
    return res.status(400).json({ error: "Invalid or missing vehicle_id" });
  }

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!date || !ISO_DATE.test(date)) {
    return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  }

  const sb = getSupabaseAdmin();
  let resolvedCategoryId = null;
  let resolvedCategoryText = null;

  if (category_id && typeof category_id === "string") {
    if (sb) {
      const { data: catRow, error: catErr } = await sb
        .from("expense_categories")
        .select("id, name")
        .eq("id", category_id)
        .maybeSingle();
      if (catErr || !catRow) return res.status(400).json({ error: "Invalid category_id" });
      resolvedCategoryId = catRow.id;
      resolvedCategoryText = catRow.name;
    } else {
      resolvedCategoryId = category_id;
      resolvedCategoryText = category || "misc";
    }
  } else if (category && typeof category === "string") {
    const normalizedCategory = category.trim().toLowerCase();
    if (!LEGACY_CATEGORIES.includes(normalizedCategory)) {
      return res.status(400).json({ error: "category must be one of: " + LEGACY_CATEGORIES.join(", ") });
    }
    resolvedCategoryText = normalizedCategory;
    if (sb) {
      const allCats = await loadCategories(sb);
      const { name: targetName, group_name: targetGroup } = LEGACY_CATEGORY_MAP[normalizedCategory];
      const match = allCats.find((c) => c.name === targetName && c.group_name === targetGroup);
      if (match) resolvedCategoryId = match.id;
    }
  } else {
    return res.status(400).json({ error: "category_id or category is required" });
  }

  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }

  const updates = {
    vehicle_id,
    date,
    category: resolvedCategoryText || "",
    category_id: resolvedCategoryId || null,
    amount: Math.round(parsedAmount * 100) / 100,
    notes: typeof notes === "string" ? notes.trim().slice(0, 500) : "",
  };

  try {
    let useGitHub = !sb;

    if (sb) {
      const { data: existing, error: existingErr } = await sb
        .from("expenses")
        .select("expense_id")
        .eq("expense_id", expense_id)
        .maybeSingle();
      if (existingErr) {
        console.warn("update-expense: Supabase lookup failed, falling back to GitHub:", existingErr.message);
        useGitHub = true;
      } else if (!existing) {
        return res.status(404).json({ error: "Expense not found" });
      } else {
        const { data: updated, error: updateErr } = await sb
          .from("expenses")
          .update(updates)
          .eq("expense_id", expense_id)
          .select("*")
          .single();
        if (updateErr) {
          console.warn("update-expense: Supabase update failed, falling back to GitHub:", updateErr.message);
          useGitHub = true;
        } else {
          return res.status(200).json({ success: true, expense: updated });
        }
      }
    }

    if (useGitHub) {
      if (!process.env.GITHUB_TOKEN) {
        return res.status(503).json({ error: "Neither Supabase nor GITHUB_TOKEN is configured." });
      }

      let updatedExpense = null;
      let found = false;
      await updateJsonFileWithRetry({
        load: loadExpenses,
        apply: (data) => {
          const idx = data.findIndex((e) => e.expense_id === expense_id);
          if (idx === -1) return;
          found = true;
          const existing = data[idx] || {};
          updatedExpense = {
            ...existing,
            ...updates,
            expense_id: existing.expense_id,
            category_id: updates.category_id || undefined,
          };
          if (updatedExpense.category_id === undefined || updatedExpense.category_id === null) {
            delete updatedExpense.category_id;
          }
          data[idx] = updatedExpense;
        },
        save: saveExpenses,
        message: `Update expense ${expense_id}`,
      });

      if (!found) return res.status(404).json({ error: "Expense not found" });
      return res.status(200).json({ success: true, expense: updatedExpense });
    }

    return res.status(500).json({ error: "Unable to update expense" });
  } catch (err) {
    console.error("update-expense error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
