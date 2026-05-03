// api/get-expense-categories.js
// Vercel serverless function — manages the expense_categories table.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/get-expense-categories
// Body: {
//   "secret": "<ADMIN_SECRET>",
//   "action": "list" | "create" | "update" | "toggle",
//
//   // For "list":  no extra params; returns all categories ordered by group/name
//   // For "create": { "name": string, "group_name": string }
//   // For "update": { "id": string, "name": string }
//   // For "toggle": { "id": string, "is_active": boolean }
// }
//
// Response: { categories: Array }
//           or { success: true, category: object }  for create/update/toggle

import crypto from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadCategories } from "./_expense-categories.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const MAX_NAME_LEN    = 80;
const MAX_GROUP_LEN   = 60;

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

  const { secret, action = "list", id, name, group_name, is_active } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = getSupabaseAdmin();

    // ── list ──────────────────────────────────────────────────────────────────
    if (action === "list") {
      const categories = await loadCategories(sb);
      return res.status(200).json({ categories });
    }

    // ── create ────────────────────────────────────────────────────────────────
    if (action === "create") {
      const trimName  = typeof name       === "string" ? name.trim().slice(0, MAX_NAME_LEN)  : "";
      const trimGroup = typeof group_name === "string" ? group_name.trim().slice(0, MAX_GROUP_LEN) : "";

      if (!trimName)  return res.status(400).json({ error: "name is required" });
      if (!trimGroup) return res.status(400).json({ error: "group_name is required" });

      if (!sb) {
        return res.status(503).json({ error: "Supabase is required to create categories." });
      }

      const newCat = {
        id:         crypto.randomUUID(),
        name:       trimName,
        group_name: trimGroup,
        is_default: false,
        is_active:  true,
      };

      const { data, error } = await sb
        .from("expense_categories")
        .insert(newCat)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return res.status(409).json({ error: `A category named "${trimName}" already exists in group "${trimGroup}".` });
        }
        throw new Error(error.message);
      }

      const categories = await loadCategories(sb);
      return res.status(200).json({ success: true, category: data, categories });
    }

    // ── update ────────────────────────────────────────────────────────────────
    if (action === "update") {
      const trimName = typeof name === "string" ? name.trim().slice(0, MAX_NAME_LEN) : "";

      if (!id || typeof id !== "string")  return res.status(400).json({ error: "id is required" });
      if (!trimName)                       return res.status(400).json({ error: "name is required" });

      if (!sb) {
        return res.status(503).json({ error: "Supabase is required to update categories." });
      }

      const { data: existing } = await sb
        .from("expense_categories")
        .select("id, is_default")
        .eq("id", id)
        .maybeSingle();

      if (!existing) return res.status(404).json({ error: "Category not found." });

      const { data, error } = await sb
        .from("expense_categories")
        .update({ name: trimName })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return res.status(409).json({ error: `A category named "${trimName}" already exists in this group.` });
        }
        throw new Error(error.message);
      }

      const categories = await loadCategories(sb);
      return res.status(200).json({ success: true, category: data, categories });
    }

    // ── toggle (enable / disable) ─────────────────────────────────────────────
    if (action === "toggle") {
      if (!id || typeof id !== "string")    return res.status(400).json({ error: "id is required" });
      if (typeof is_active !== "boolean")   return res.status(400).json({ error: "is_active (boolean) is required" });

      if (!sb) {
        return res.status(503).json({ error: "Supabase is required to toggle categories." });
      }

      const { data: existing } = await sb
        .from("expense_categories")
        .select("id")
        .eq("id", id)
        .maybeSingle();

      if (!existing) return res.status(404).json({ error: "Category not found." });

      const { data, error } = await sb
        .from("expense_categories")
        .update({ is_active })
        .eq("id", id)
        .select()
        .single();

      if (error) throw new Error(error.message);

      const categories = await loadCategories(sb);
      return res.status(200).json({ success: true, category: data, categories });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("get-expense-categories error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
