// api/bouncie-auth.js
// Bouncie token status endpoint.
//
// The OAuth flow is no longer used — Bouncie access is configured via the
// BOUNCIE_ACCESS_TOKEN environment variable set in Vercel.
//
// GET /api/bouncie-auth?secret=<ADMIN_SECRET>
//   Returns whether BOUNCIE_ACCESS_TOKEN is configured.
//
// Required env vars:
//   ADMIN_SECRET            — protects this endpoint
//   BOUNCIE_ACCESS_TOKEN    — Bouncie access token (set in Vercel)

import { isAdminAuthorized } from "./_admin-auth.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const secret = req.query?.secret;
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const configured = !!process.env.BOUNCIE_ACCESS_TOKEN;
    return res.status(200).json({
      configured,
      message: configured
        ? "BOUNCIE_ACCESS_TOKEN is set. Mileage sync is active."
        : "BOUNCIE_ACCESS_TOKEN is not set. Add it to Vercel environment variables.",
    });
  } catch (err) {
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

