// api/v2-protection-plans.js
// SLYTRANS Fleet Control v2 — Protection plan configuration endpoint.
// Admins can manage coverage tiers that are attached to bookings/revenue.
//
// POST /api/v2-protection-plans
// Actions:
//   list    — { secret, action:"list" }
//   get     — { secret, action:"get", id }
//   create  — { secret, action:"create", name, description?, daily_rate, liability_cap? }
//   update  — { secret, action:"update", id, updates:{...} }
//   delete  — { secret, action:"delete", id }
//
// Storage: Supabase `protection_plans` table (primary).
//          Falls back to GitHub `protection-plans.json` when Supabase is not configured.

import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO      = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const PLANS_FILE_PATH  = "protection-plans.json";

// Default protection plans — used only to auto-seed an empty Supabase table.
const DEFAULT_PLANS = [
  { id: "plan-none",     name: "None",     description: "No protection plan selected",         daily_rate: 0,  liability_cap: 0,    is_active: true, sort_order: 0 },
  { id: "plan-basic",    name: "Basic",    description: "Basic damage protection, $1,000 cap", daily_rate: 15, liability_cap: 1000, is_active: true, sort_order: 1 },
  { id: "plan-standard", name: "Standard", description: "Standard coverage, $500 cap",         daily_rate: 25, liability_cap: 500,  is_active: true, sort_order: 2 },
  { id: "plan-premium",  name: "Premium",  description: "Full coverage, $0 liability",         daily_rate: 40, liability_cap: 0,    is_active: true, sort_order: 3 },
];

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function listFromSupabase() {
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from("protection_plans")
      .select("*").order("sort_order").order("name");
    if (error) {
      console.error("v2-protection-plans list error:", error.message);
      return null;
    }
    // Auto-seed an empty table with defaults.
    if (!data || data.length === 0) {
      const seedRecords = DEFAULT_PLANS.map(({ id, ...p }) => p);
      const { error: seedErr } = await sb.from("protection_plans").insert(seedRecords);
      if (seedErr) {
        console.error("v2-protection-plans seed error (non-fatal):", seedErr.message);
        return null;
      }
      const { data: seeded, error: refetchErr } = await sb.from("protection_plans")
        .select("*").order("sort_order").order("name");
      return refetchErr ? null : (seeded || null);
    }
    return data;
  } catch (e) {
    console.error("v2-protection-plans Supabase list exception:", e.message);
    return null;
  }
}

// ── GitHub fallback helpers ───────────────────────────────────────────────────

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Load plans array from protection-plans.json in GitHub. */
async function loadPlansFromGitHub() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${PLANS_FILE_PATH}`;
  const resp   = await fetch(apiUrl, { headers: ghHeaders() });
  if (!resp.ok) return { data: [...DEFAULT_PLANS], sha: null };
  const file = await resp.json();
  let data = DEFAULT_PLANS;
  try {
    const parsed = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (Array.isArray(parsed)) data = parsed;
  } catch {
    data = [...DEFAULT_PLANS];
  }
  return { data, sha: file.sha };
}

/** Write plans array back to protection-plans.json in GitHub. */
async function savePlansToGitHub(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("v2-protection-plans: GITHUB_TOKEN not set — plans will not be saved");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${PLANS_FILE_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT protection-plans.json failed: ${resp.status} ${text}`);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });

  const body = req.body || {};
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const sb = getSupabaseAdmin();

  try {
    // ── LIST ──────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      const sbPlans = await listFromSupabase();
      if (sbPlans !== null) return res.status(200).json({ plans: sbPlans });
      // GitHub fallback
      const { data } = await loadPlansFromGitHub();
      return res.status(200).json({ plans: data });
    }

    // ── GET ───────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { data, error } = await sb.from("protection_plans").select("*").eq("id", body.id).single();
        if (error) throw error;
        return res.status(200).json({ plan: data });
      }
      // GitHub fallback
      const { data: plans } = await loadPlansFromGitHub();
      const plan = plans.find((p) => p.id === body.id);
      if (!plan) return res.status(404).json({ error: "Plan not found" });
      return res.status(200).json({ plan });
    }

    // ── CREATE ────────────────────────────────────────────────────────────────
    if (action === "create") {
      const { name, daily_rate } = body;
      if (!name || daily_rate == null)
        return res.status(400).json({ error: "name and daily_rate are required" });
      const record = {
        name:          String(name).trim(),
        description:   body.description   || null,
        daily_rate:    Number(daily_rate),
        liability_cap: body.liability_cap != null ? Number(body.liability_cap) : 1000,
        is_active:     body.is_active !== false,
        sort_order:    body.sort_order != null ? Number(body.sort_order) : 99,
      };
      if (sb) {
        const { data, error } = await sb.from("protection_plans").insert(record).select().single();
        if (error) throw error;
        return res.status(201).json({ plan: data });
      }
      // GitHub fallback — assign a UUID as id
      const newPlan = { id: randomUUID(), ...record };
      let created;
      await updateJsonFileWithRetry({
        load:    loadPlansFromGitHub,
        apply:   (data) => { data.push(newPlan); created = newPlan; },
        save:    savePlansToGitHub,
        message: `v2: Add protection plan "${record.name}"`,
      });
      return res.status(201).json({ plan: created });
    }

    // ── UPDATE ────────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const allowed = ["name", "description", "daily_rate", "liability_cap", "is_active", "sort_order"];
      if (sb) {
        const updates = { updated_at: new Date().toISOString() };
        for (const f of allowed) {
          if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
        }
        const { data, error } = await sb.from("protection_plans").update(updates).eq("id", body.id).select().single();
        if (error) throw error;
        return res.status(200).json({ plan: data });
      }
      // GitHub fallback
      let updated;
      await updateJsonFileWithRetry({
        load:    loadPlansFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((p) => p.id === body.id);
          if (idx === -1) throw new Error("Plan not found");
          for (const f of allowed) {
            if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) data[idx][f] = (body.updates)[f];
          }
          data[idx].updated_at = new Date().toISOString();
          updated = data[idx];
        },
        save:    savePlansToGitHub,
        message: `v2: Update protection plan "${body.id}"`,
      });
      return res.status(200).json({ plan: updated });
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { error } = await sb.from("protection_plans").delete().eq("id", body.id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
      // GitHub fallback
      await updateJsonFileWithRetry({
        load:    loadPlansFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((p) => p.id === body.id);
          if (idx !== -1) data.splice(idx, 1);
        },
        save:    savePlansToGitHub,
        message: `v2: Delete protection plan "${body.id}"`,
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-protection-plans error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
