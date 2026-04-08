// api/bouncie-auth.js
// Bouncie connection status endpoint.
//
// Checks whether a Bouncie OAuth token is stored in the bouncie_tokens table.
//
// GET /api/bouncie-auth?secret=<ADMIN_SECRET>
//   Returns whether Bouncie is connected.
//
// Required env vars:
//   ADMIN_SECRET            — protects this endpoint
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

import { isAdminAuthorized } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { getBouncieVehicles } from "./_bouncie.js";
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
    if (!sb) {
      return res.status(200).json({
        configured: false,
        message: "Database not configured.",
      });
    }

    // Verify the token actually works by calling the Bouncie API.
    // Simply checking whether a token row exists in the DB can show "Connected"
    // even when the stored token is expired or invalid.
    try {
      await getBouncieVehicles();
    } catch (bouncieErr) {
      return res.status(200).json({
        configured: false,
        message: adminErrorMessage(bouncieErr),
      });
    }

    return res.status(200).json({
      configured: true,
      message: "Bouncie is connected. Mileage sync is active.",
    });
  } catch (err) {
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}

