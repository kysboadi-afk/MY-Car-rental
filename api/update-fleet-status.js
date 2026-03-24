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
//     "vehicleId": "camry" | "slingshot" | "camry2013",
//     "available": true | false
//   }

import { adminErrorMessage } from "./_error-helpers.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_STATUS_PATH = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const DEFAULT_STATUS = {
  slingshot: { available: true },
  camry:     { available: true },
  camry2013: { available: true },
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
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    const getResp = await fetch(apiUrl, { headers });
    let current = { ...DEFAULT_STATUS };
    let sha = null;

    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      try {
        current = JSON.parse(
          Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
        );
      } catch (parseErr) {
        console.error("update-fleet-status: malformed JSON in file, resetting to defaults:", parseErr);
        current = { ...DEFAULT_STATUS };
      }
    }

    if (!current[vehicleId]) current[vehicleId] = {};
    current[vehicleId].available = available;

    const updatedContent = Buffer.from(
      JSON.stringify(current, null, 2) + "\n"
    ).toString("base64");

    const putBody = {
      message: `Update ${vehicleId} availability to ${available ? "available" : "unavailable"}`,
      content: updatedContent,
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      console.error(`GitHub PUT failed: ${putResp.status} ${errText}`);
      return res.status(502).json({ error: "Failed to update fleet-status.json on GitHub" });
    }

    return res.status(200).json({ success: true, vehicleId, available });
  } catch (err) {
    console.error("update-fleet-status error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
