// api/blocked-dates.js
// Admin API for listing and deleting blocked_dates rows by ID.

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
}

function readSecret(req) {
  return (
    req.headers["x-admin-secret"] ||
    req.query?.secret ||
    req.body?.secret ||
    ""
  );
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("blocked_dates")
      .select("id, vehicle_id, start_date, end_date, reason")
      .order("start_date", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ blockedDates: data || [] });
  }

  if (req.method !== "DELETE") {
    return res.status(405).send("Method Not Allowed");
  }

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }
  if (readSecret(req) !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const idRaw = req.query?.id;
  const id = Number.parseInt(String(idRaw || ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "id must be a positive integer." });
  }

  const { error } = await sb
    .from("blocked_dates")
    .delete()
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true, removed: 1 });
}
