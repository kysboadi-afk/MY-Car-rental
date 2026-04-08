// api/bouncie-auth.js
// Bouncie connection status endpoint.
//
// Checks whether a Bouncie API key is configured via the BOUNCIE_API_KEY
// environment variable.
//
// GET /api/bouncie-auth?secret=<ADMIN_SECRET>
//   Returns whether Bouncie is connected.
//
// Required env vars:
//   ADMIN_SECRET            — protects this endpoint

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadBouncieToken } from "./_bouncie.js";
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
    const sb = getSupabaseAdmin();
    const token = sb ? await loadBouncieToken(sb) : null;
    const configured = !!token;
    return res.status(200).json({
      configured,
      message: configured
        ? "Bouncie is connected. Mileage sync is active."
        : "Bouncie is not connected. Please set the BOUNCIE_API_KEY environment variable in your Vercel dashboard to enable GPS mileage sync.",
    });
  } catch (err) {
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

