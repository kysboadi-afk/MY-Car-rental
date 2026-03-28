// api/fleet-status.js
// Vercel serverless function — returns the current availability status of each
// fleet vehicle.
//
// Data source priority:
//   1. Supabase `vehicles` table  (rental_status: 'available' | 'reserved' |
//                                  'rented' | 'maintenance')
//   2. GitHub fleet-status.json   (legacy { vehicleId: { available: bool } } format)
//   3. Hard-coded defaults        (all available)
//
// Response: { slingshot: { available, rental_status }, camry: { … }, … }

import { getSupabaseAdmin } from "./_supabase.js";

const GITHUB_REPO = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const FLEET_STATUS_PATH = "fleet-status.json";
const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const ALL_VEHICLES = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];

const DEFAULT_STATUS = {
  slingshot:  { available: true,  rental_status: "available" },
  slingshot2: { available: true,  rental_status: "available" },
  slingshot3: { available: true,  rental_status: "available" },
  camry:      { available: true,  rental_status: "available" },
  camry2013:  { available: true,  rental_status: "available" },
};

/** Convert Supabase rental_status → boolean available for backwards compat */
function rentalStatusToAvailable(status) {
  return status === "available";
}

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

  // ── 1. Supabase (preferred) ─────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data: rows, error } = await sb
        .from("vehicles")
        .select("vehicle_id, rental_status")
        .in("vehicle_id", ALL_VEHICLES);

      if (!error && rows && rows.length > 0) {
        const result = { ...DEFAULT_STATUS };
        for (const row of rows) {
          if (row.vehicle_id) {
            result[row.vehicle_id] = {
              available:     rentalStatusToAvailable(row.rental_status),
              rental_status: row.rental_status || "available",
            };
          }
        }
        return res.status(200).json(result);
      }
      if (error) console.warn("fleet-status: Supabase error, falling back to GitHub:", error.message);
    } catch (sbErr) {
      console.warn("fleet-status: Supabase threw, falling back to GitHub:", sbErr.message);
    }
  }

  // ── 2. GitHub fleet-status.json fallback ────────────────────────────────
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FLEET_STATUS_PATH}`;
  const ghHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const ghRes = await fetch(apiUrl, { headers: ghHeaders });
    if (ghRes.ok) {
      const fileData = await ghRes.json();
      try {
        const content = JSON.parse(
          Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
        );
        // Merge GitHub data into default structure, adding rental_status field
        const result = { ...DEFAULT_STATUS };
        for (const [vid, val] of Object.entries(content)) {
          if (ALL_VEHICLES.includes(vid)) {
            const avail = typeof val.available === "boolean" ? val.available : true;
            result[vid] = {
              available:     avail,
              rental_status: val.rental_status || (avail ? "available" : "maintenance"),
            };
          }
        }
        return res.status(200).json(result);
      } catch (parseErr) {
        console.error("fleet-status: malformed JSON in file:", parseErr);
      }
    }
  } catch (ghErr) {
    console.error("fleet-status: GitHub fetch error:", ghErr.message);
  }

  // ── 3. Hard-coded defaults ──────────────────────────────────────────────
  return res.status(200).json(DEFAULT_STATUS);
}
