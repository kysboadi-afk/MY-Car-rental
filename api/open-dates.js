// api/open-dates.js
// Vercel serverless function — removes a blocked date range from booked-dates.json
// so that previously unavailable dates become bookable again (e.g. after a cancellation).
//
// Required environment variables:
//   GITHUB_TOKEN  — personal access token with contents:write on the repo
//   ADMIN_SECRET  — a secret string the caller must supply to authorise the request
//
// Request body (JSON):
//   {
//     "secret":    "<ADMIN_SECRET value>",
//     "vehicleId": "camry2013" | "slingshot",
//     "from":      "YYYY-MM-DD",
//     "to":        "YYYY-MM-DD"
//   }
//
// The endpoint removes every stored range whose [from, to] exactly matches the
// requested range.  It does NOT perform partial overlap removal.

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
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
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    // Fetch current file
    const getResp = await fetch(apiUrl, { headers });
    if (!getResp.ok) {
      const errText = await getResp.text();
      console.error(`GitHub GET failed: ${getResp.status} ${errText}`);
      return res.status(502).json({ error: "Failed to read booked-dates.json from GitHub" });
    }
    const fileData = await getResp.json();
    const current = JSON.parse(
      Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
    );

    // Remove the exact matching range(s) for the given vehicle
    const before = (current[vehicleId] || []).length;
    current[vehicleId] = (current[vehicleId] || []).filter(
      (r) => !(r.from === from && r.to === to)
    );
    const removed = before - current[vehicleId].length;

    // Write back even if nothing was removed, to stay idempotent
    const updatedContent = Buffer.from(
      JSON.stringify(current, null, 2) + "\n"
    ).toString("base64");

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Open dates for ${vehicleId}: ${from} to ${to}`,
        content: updatedContent,
        sha: fileData.sha,
      }),
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      console.error(`GitHub PUT failed: ${putResp.status} ${errText}`);
      return res.status(502).json({ error: "Failed to update booked-dates.json on GitHub" });
    }

    return res.status(200).json({ success: true, removed });
  } catch (err) {
    console.error("open-dates endpoint error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
