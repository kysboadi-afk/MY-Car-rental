// api/booked-dates.js
// Vercel serverless function — serves booked-dates.json with no caching.
//
// GitHub Pages CDN caches static files for several minutes after a commit,
// so fetching booked-dates.json directly from the Pages URL gives stale data.
// This endpoint reads the file from the GitHub Contents API on every request
// so the calendar always reflects the latest blocked ranges immediately after
// a booking is confirmed.
//
// Optional environment variable:
//   GITHUB_TOKEN  — increases the GitHub API rate limit from 60 to 5 000
//                   requests/hour.  Not required but recommended.
//   GITHUB_REPO   — repo in "owner/name" format (defaults to kysboadi-afk/SLY-RIDES)

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // Never cache — we need fresh data on every request so blocked dates appear
  // immediately after a booking is confirmed.
  res.setHeader("Cache-Control", "no-store");

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
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
      // Fall back to an empty schedule rather than breaking the calendar
      console.warn(`GitHub Contents API returned ${ghRes.status} for ${BOOKED_DATES_PATH}`);
      return res.status(200).json({});
    }
    const fileData = await ghRes.json();
    const content = JSON.parse(
      Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
    );
    return res.status(200).json(content);
  } catch (err) {
    console.error("booked-dates endpoint error:", err);
    // Return an empty schedule on error so the calendar still loads
    return res.status(200).json({});
  }
}
