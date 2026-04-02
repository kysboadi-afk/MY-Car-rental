// api/block-dates.js
// Vercel serverless function — adds a blocked date range to booked-dates.json
// so that a vehicle's dates show as unavailable on the booking calendar.
// Use this to manually record a booking when the automatic blocking (triggered
// by send-reservation-email.js) failed, e.g. because GITHUB_TOKEN was not set.
//
// Required environment variables:
//   GITHUB_TOKEN  — personal access token with contents:write on the repo
//   ADMIN_SECRET  — a secret string the caller must supply to authorise the request
//
// Request body (JSON):
//   {
//     "secret":    "<ADMIN_SECRET value>",
//     "vehicleId": "camry" | "slingshot" | "slingshot2" | "slingshot3" | "camry2013",
//     "from":      "YYYY-MM-DD",
//     "to":        "YYYY-MM-DD"
//   }
//
// The endpoint is idempotent: if the range is already present (or overlaps an
// existing range) it returns 200 without adding a duplicate entry.

import { hasOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const GITHUB_REPO        = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const GITHUB_DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || "main";
const BOOKED_DATES_PATH  = "booked-dates.json";
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

  // Guard: ADMIN_SECRET must be configured
  if (!process.env.ADMIN_SECRET) {
    console.error("ADMIN_SECRET environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  // Guard: GITHUB_TOKEN must be configured to write the file
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: GITHUB_TOKEN is not set." });
  }

  const { secret, vehicleId, from, to } = req.body || {};

  // Authenticate the caller
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validate inputs
  if (!vehicleId || typeof vehicleId !== "string") {
    return res.status(400).json({ error: "vehicleId is required" });
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !ISO_DATE.test(from)) {
    return res.status(400).json({ error: "from must be a date in YYYY-MM-DD format" });
  }
  if (!to || !ISO_DATE.test(to)) {
    return res.status(400).json({ error: "to must be a date in YYYY-MM-DD format" });
  }
  if (from > to) {
    return res.status(400).json({ error: "from must not be after to" });
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const ghHeaders = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function loadBookedDates() {
    const resp = await fetch(`${apiUrl}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}`, { headers: ghHeaders });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub GET booked-dates.json failed: ${resp.status} ${text}`);
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
      if (typeof data !== "object" || Array.isArray(data)) data = {};
    } catch { data = {}; }
    return { data, sha: file.sha };
  }

  async function saveBookedDates(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content, branch: GITHUB_DATA_BRANCH };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
    }
  }

  try {
    let added = 0;
    await updateJsonFileWithRetry({
      load:    loadBookedDates,
      apply:   (data) => {
        if (!data[vehicleId]) data[vehicleId] = [];
        if (!hasOverlap(data[vehicleId], from, to)) {
          data[vehicleId].push({ from, to });
          added = 1;
        } else {
          added = 0;
        }
      },
      save:    saveBookedDates,
      message: `Block dates for ${vehicleId}: ${from} to ${to}`,
    });

    return res.status(200).json({ success: true, added });
  } catch (err) {
    console.error("block-dates endpoint error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
