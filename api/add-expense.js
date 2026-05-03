// api/add-expense.js
// Vercel serverless function — appends a new expense record to the Supabase
// `expenses` table.  Falls back to GitHub (expenses.json) when Supabase is
// not configured so the endpoint never hard-fails due to missing env vars.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/add-expense
// Body: {
//   "secret":      "<ADMIN_SECRET>",
//   "vehicle_id":  "camry",
//   "date":        "YYYY-MM-DD",
//   "category_id": "<uuid>",          // preferred: FK to expense_categories
//   "category":    "fuel" | ...,      // legacy fallback (still accepted)
//   "amount":      number,
//   "notes":       string  (optional)
// }

import crypto from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadExpenses, saveExpenses } from "./_expenses.js";
import { loadCategories, LEGACY_CATEGORY_MAP } from "./_expense-categories.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { getActiveVehicleIds } from "./_pricing.js";

const ALLOWED_ORIGINS    = ["https://www.slytrans.com", "https://slytrans.com"];
// Legacy flat categories still accepted for backward-compat
const LEGACY_CATEGORIES  = Object.keys(LEGACY_CATEGORY_MAP);

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

  const { secret, vehicle_id, date, category_id, category, amount, notes } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!vehicle_id || !(await getActiveVehicleIds(getSupabaseAdmin())).includes(vehicle_id)) {
    return res.status(400).json({ error: "Invalid or missing vehicle_id" });
  }

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!date || !ISO_DATE.test(date)) {
    return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  }

  // Category validation — accept category_id (new) or legacy category text
  const sb = getSupabaseAdmin();
  let resolvedCategoryId   = null;
  let resolvedCategoryText = null;

  if (category_id && typeof category_id === "string") {
    // New path: validate the UUID exists in expense_categories
    if (sb) {
      const { data: catRow, error: catErr } = await sb
        .from("expense_categories")
        .select("id, name, group_name")
        .eq("id", category_id)
        .maybeSingle();
      if (catErr || !catRow) {
        return res.status(400).json({ error: "Invalid category_id" });
      }
      resolvedCategoryId   = catRow.id;
      resolvedCategoryText = catRow.name;
    } else {
      // Supabase unavailable — accept the ID as-is and use it for text too
      resolvedCategoryId   = category_id;
      resolvedCategoryText = category || "other";
    }
  } else if (category && typeof category === "string") {
    // Legacy path: accept old flat category names
    if (!LEGACY_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "category must be one of: " + LEGACY_CATEGORIES.join(", ") });
    }
    resolvedCategoryText = category;
    // Try to resolve the category_id from the DB
    if (sb) {
      const allCats = await loadCategories(sb);
      const { name: targetName, group_name: targetGroup } = LEGACY_CATEGORY_MAP[category];
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

  const expense = {
    expense_id:  crypto.randomBytes(8).toString("hex"),
    vehicle_id,
    date,
    category:    resolvedCategoryText || "",
    category_id: resolvedCategoryId   || undefined,
    amount:      Math.round(parsedAmount * 100) / 100,
    notes:       typeof notes === "string" ? notes.trim().slice(0, 500) : "",
    created_at:  new Date().toISOString(),
  };
  // Remove undefined fields so they don't confuse Supabase / JSON serialisation
  if (!expense.category_id) delete expense.category_id;

  try {
    let useGitHub = !sb;
    if (sb) {
      // ── Supabase path (preferred) ──────────────────────────────────────
      const { error: sbErr } = await sb.from("expenses").insert(expense);
      if (sbErr) {
        // Fall back to GitHub for any Supabase error (missing table, constraint
        // violation, network hiccup, etc.) so the admin never gets a hard 500.
        console.warn("add-expense: Supabase insert failed, falling back to GitHub:", sbErr.message);
        useGitHub = true;
      }
    }
    if (useGitHub) {
      // ── GitHub fallback ────────────────────────────────────────────────
      if (!process.env.GITHUB_TOKEN) {
        return res.status(503).json({ error: "Neither Supabase nor GITHUB_TOKEN is configured." });
      }
      await updateJsonFileWithRetry({
        load:    loadExpenses,
        apply:   (data) => {
          if (!data.some((e) => e.expense_id === expense.expense_id)) {
            data.push(expense);
          }
        },
        save:    saveExpenses,
        message: `Add expense for ${vehicle_id}: ${resolvedCategoryText || category_id} $${expense.amount} on ${date}`,
      });
    }

    return res.status(200).json({ success: true, expense });
  } catch (err) {
    console.error("add-expense error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
