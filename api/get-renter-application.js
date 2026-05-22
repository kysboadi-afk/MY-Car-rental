import { fetchRenterApplicationById, toClientApplication } from "./_renter-applications.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const applicationId = req.query?.applicationId || req.query?.id;
  if (!applicationId || typeof applicationId !== "string") {
    return res.status(400).json({ error: "applicationId is required." });
  }

  try {
    const result = await fetchRenterApplicationById(applicationId);
    if (!result.ok) {
      if (result.details) console.error("get-renter-application failed:", result.details);
      return res.status(result.status || 500).json({ error: result.error || "Failed to load application." });
    }

    return res.status(200).json({
      success: true,
      ...toClientApplication(result.data),
    });
  } catch (err) {
    console.error("get-renter-application unexpected error:", err);
    return res.status(500).json({ error: "Failed to load application." });
  }
}
