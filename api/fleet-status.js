// api/fleet-status.js
// Vercel serverless function — serves fleet-status.json with no caching.
// Returns the availability status of each vehicle in the fleet.
//
// Optional environment variable:
//   GITHUB_TOKEN  — increases the GitHub API rate limit from 60 to 5 000
//                   requests/hour.  Not required but recommended.
//   GITHUB_REPO   — repo in "owner/name" format (defaults to kysboadi-afk/SLY-RIDES)

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_STATUS_PATH = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const DEFAULT_STATUS = {
  slingshot: { available: true },
  camry2013: { available: true },
};

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // Never cache — we need fresh data so status changes appear immediately.
  res.setHeader("Cache-Control", "no-store");

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const ghRes = await fetch(apiUrl, { headers });
    if (!ghRes.ok) {
      console.warn(`GitHub Contents API returned ${ghRes.status} for ${FLEET_STATUS_PATH}`);
      return res.status(200).json(DEFAULT_STATUS);
    }
    const fileData = await ghRes.json();
    let content;
    try {
      content = JSON.parse(
        Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
      );
    } catch (parseErr) {
      console.error("fleet-status: malformed JSON in file:", parseErr);
      return res.status(200).json(DEFAULT_STATUS);
    }
    return res.status(200).json(content);
  } catch (err) {
    console.error("fleet-status endpoint error:", err);
    return res.status(200).json(DEFAULT_STATUS);
  }
}
