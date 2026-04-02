// api/update-fleet-status.js
// Vercel serverless function — updates vehicle availability in the fleet.
// Admin-protected; requires the ADMIN_SECRET environment variable.
//
// Data source priority (same as fleet-status.js):
//   1. Supabase `vehicles` table  (rental_status: 'available' | 'maintenance')
//   2. GitHub fleet-status.json   (legacy fallback — requires GITHUB_TOKEN)
//
// Request body (JSON):
//   {
//     "secret":    "<ADMIN_SECRET value>",
//     "vehicleId": "camry" | "slingshot" | …,
//     "available": true | false
//   }

import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const FLEET_STATUS_PATH  = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];

const DEFAULT_STATUS = {
  slingshot:  { available: true },
  slingshot2: { available: true },
  slingshot3: { available: true },
  camry:      { available: true },
  camry2013:  { available: true },
};

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const h = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function loadFleetStatus() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const resp   = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders() });
  if (!resp.ok) {
    if (resp.status === 404) return { data: { ...DEFAULT_STATUS }, sha: null };
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET fleet-status.json failed: ${resp.status} ${text}`);
  }
  const file = await resp.json();
  let data;
  try {
    data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
  } catch {
    data = { ...DEFAULT_STATUS };
  }
  return { data, sha: file.sha };
}

async function saveFleetStatus(data, sha, message) {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body    = { message, content, branch: GITHUB_DATA_BRANCH };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
  }
}

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

  const { secret, vehicleId, available } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!vehicleId || !ALLOWED_VEHICLES.includes(vehicleId)) {
    return res.status(400).json({ error: "Invalid or missing vehicleId" });
  }

  if (typeof available !== "boolean") {
    return res.status(400).json({ error: "available must be a boolean" });
  }

  // Map boolean available → Supabase rental_status.
  // available=false uses 'maintenance' so the vehicle shows as blocked on the public site.
  const newRentalStatus = available ? "available" : "maintenance";

  try {
    const sb = getSupabaseAdmin();

    // ── 1. Supabase (preferred) ──────────────────────────────────────────
    if (sb) {
      const { error } = await sb
        .from("vehicles")
        .update({ rental_status: newRentalStatus, updated_at: new Date().toISOString() })
        .eq("vehicle_id", vehicleId);

      if (!error) {
        return res.status(200).json({ success: true, vehicleId, available, rental_status: newRentalStatus });
      }
      console.warn("update-fleet-status: Supabase update failed, falling back to GitHub:", error.message);
    }

    // ── 2. GitHub fleet-status.json fallback ────────────────────────────
    if (!process.env.GITHUB_TOKEN) {
      // No Supabase and no GitHub token — nothing to save, still return success
      // so the UI doesn't show an error for a toggle that has no persistent backend.
      console.warn("update-fleet-status: neither Supabase nor GITHUB_TOKEN configured — toggle not persisted");
      return res.status(200).json({ success: true, vehicleId, available, persisted: false });
    }

    await updateJsonFileWithRetry({
      load:    loadFleetStatus,
      apply:   (data) => {
        if (!data[vehicleId]) data[vehicleId] = {};
        data[vehicleId].available     = available;
        data[vehicleId].rental_status = newRentalStatus;
      },
      save:    saveFleetStatus,
      message: `Update ${vehicleId} availability to ${available ? "available" : "unavailable"}`,
    });

    return res.status(200).json({ success: true, vehicleId, available, rental_status: newRentalStatus });
  } catch (err) {
    console.error("update-fleet-status error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
