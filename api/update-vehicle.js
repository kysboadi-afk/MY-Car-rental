// api/update-vehicle.js
// Vercel serverless function — updates vehicle metadata in vehicles.json.
// Admin-protected: requires ADMIN_SECRET.
//
// POST /api/update-vehicle
// Body: {
//   "secret":         "<ADMIN_SECRET>",
//   "vehicle_id":     "slingshot" | "slingshot2" | "camry" | "camry2013",
//   "purchase_date":  "YYYY-MM-DD"  (optional),
//   "purchase_price": number        (optional),
//   "status":         "active" | "maintenance" | "inactive"  (optional),
//   "vehicle_name":   string        (optional),
// }

import { loadVehicles, saveVehicles } from "./_vehicles.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_STATUSES = ["active", "maintenance", "inactive"];
const ALLOWED_IDS      = ["slingshot", "slingshot2", "camry", "camry2013"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "Server configuration error: GITHUB_TOKEN is not set." });
  }

  const { secret, vehicle_id, purchase_date, purchase_price, status, vehicle_name } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!vehicle_id || !ALLOWED_IDS.includes(vehicle_id)) {
    return res.status(400).json({ error: "Invalid or missing vehicle_id" });
  }

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (purchase_date !== undefined && purchase_date !== "" && !ISO_DATE.test(purchase_date)) {
    return res.status(400).json({ error: "purchase_date must be YYYY-MM-DD or empty string" });
  }
  if (purchase_price !== undefined && (typeof purchase_price !== "number" || purchase_price < 0)) {
    return res.status(400).json({ error: "purchase_price must be a non-negative number" });
  }
  if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be active, maintenance, or inactive" });
  }

  const MAX_RETRIES = 3;
  let lastError = new Error("Unexpected error saving vehicle data");

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { data, sha } = await loadVehicles();

      if (!data[vehicle_id]) {
        return res.status(404).json({ error: "Vehicle not found" });
      }

      // Apply only the fields provided in the request
      if (purchase_date  !== undefined) data[vehicle_id].purchase_date  = purchase_date;
      if (purchase_price !== undefined) data[vehicle_id].purchase_price = purchase_price;
      if (status         !== undefined) data[vehicle_id].status         = status;
      if (vehicle_name   !== undefined && typeof vehicle_name === "string" && vehicle_name.trim()) {
        data[vehicle_id].vehicle_name = vehicle_name.trim();
      }

      await saveVehicles(data, sha, `Update vehicle info for ${vehicle_id}`);

      return res.status(200).json({ success: true, vehicle: data[vehicle_id] });
    } catch (err) {
      lastError = err;
      console.error(`update-vehicle error (attempt ${attempt + 1}):`, err);

      // Only retry on a 409 SHA conflict — any other error is terminal
      const is409 = /\b409\b/.test(err.message);
      if (!is409 || attempt === MAX_RETRIES - 1) break;

      // Brief back-off before retrying with a fresh SHA
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }

  return res.status(500).json({ error: adminErrorMessage(lastError) });
}
