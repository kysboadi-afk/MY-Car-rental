// api/sms-logs.js
// Vercel serverless function — returns the 100 most recent SMS delivery log
// entries from the sms_delivery_logs table.  Admin-protected.
//
// GET /api/sms-logs?secret=<ADMIN_SECRET>
// Response: { "logs": [ { id, booking_ref, vehicle_id, renter_phone,
//                          message_type, message_body, status, error,
//                          provider_id, created_at }, … ] }

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";

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

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const secret = req.query?.secret;
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase not configured." });
  }

  try {
    const { data, error } = await sb
      .from("sms_delivery_logs")
      .select("id, booking_ref, vehicle_id, renter_phone, message_type, message_body, status, error, provider_id, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("[sms-logs] Supabase query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch SMS logs: " + error.message });
    }

    return res.status(200).json({ logs: data || [] });
  } catch (err) {
    console.error("[sms-logs] Unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
