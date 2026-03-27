// api/update-fleet-status.js
// Vercel serverless function — updates vehicle availability in fleet-status.json.
// Admin-protected; requires the ADMIN_SECRET environment variable.
//
// Required environment variables:
//   GITHUB_TOKEN  — personal access token with contents:write on the repo
//   ADMIN_SECRET  — a secret string the caller must supply to authorise the request
//
// Request body (JSON):
//   {
//     "secret":    "<ADMIN_SECRET value>",
//     "vehicleId": "camry" | "slingshot" | "slingshot2" | "slingshot3" | "camry2013",
//     "available": true | false
//   }

import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_STATUS_PATH = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const DEFAULT_STATUS = {
  slingshot:  { available: true },
  slingshot2: { available: true },
  slingshot3: { available: true },
  camry:      { available: true },
  camry2013:  { available: true },
};

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
    console.error("ADMIN_SECRET environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: GITHUB_TOKEN is not set." });
  }

  const { secret, vehicleId, available } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!vehicleId || typeof vehicleId !== "string") {
    return res.status(400).json({ error: "vehicleId is required" });
  }

  if (typeof available !== "boolean") {
    return res.status(400).json({ error: "available must be a boolean" });
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const ghHeaders = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadFleetStatus() {
    const resp = await fetch(apiUrl, { headers: ghHeaders });
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
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT fleet-status.json failed: ${resp.status} ${text}`);
    }
  }

  try {
    await updateJsonFileWithRetry({
      load:    loadFleetStatus,
      apply:   (data) => {
        if (!data[vehicleId]) data[vehicleId] = {};
        data[vehicleId].available = available;
      },
      save:    saveFleetStatus,
      message: `Update ${vehicleId} availability to ${available ? "available" : "unavailable"}`,
    });

    return res.status(200).json({ success: true, vehicleId, available });
  } catch (err) {
    console.error("update-fleet-status error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
