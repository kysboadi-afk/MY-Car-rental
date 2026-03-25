// api/add-manual-booking.js
// Vercel serverless function — creates a manual booking record for a cash or
// offline reservation and blocks the corresponding dates on the calendar.
// Admin-protected: requires ADMIN_SECRET.
//
// Use this when a customer pays in cash or books over the phone so that the
// booking appears in the profit dashboard and the calendar shows the dates
// as unavailable.
//
// POST /api/add-manual-booking
// Body: {
//   "secret":     "<ADMIN_SECRET>",
//   "vehicleId":  "camry" | "camry2013" | "slingshot" | "slingshot2",
//   "name":       "Customer Full Name",
//   "phone":      "2135551234",        (optional)
//   "email":      "customer@email.com",(optional)
//   "pickupDate": "YYYY-MM-DD",
//   "pickupTime": "10:00 AM",          (optional)
//   "returnDate": "YYYY-MM-DD",
//   "returnTime": "5:00 PM",           (optional)
//   "amountPaid": 350,                 (optional, dollars)
//   "notes":      "Cash payment",      (optional)
// }

import crypto from "crypto";
import { loadBookings, saveBookings } from "./_bookings.js";
import { hasOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { autoCreateRevenueRecord, autoUpsertCustomer } from "./_booking-automation.js";

const GITHUB_REPO       = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";
const ALLOWED_ORIGINS   = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES  = ["slingshot", "slingshot2", "camry", "camry2013"];
const VEHICLE_NAMES     = {
  slingshot:  "Slingshot R",
  slingshot2: "Slingshot R (2)",
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};

/**
 * Block the date range in booked-dates.json so the calendar shows the
 * vehicle as unavailable for those dates.  Retries on 409 conflict.
 */
async function blockBookedDates(vehicleId, from, to) {
  const token   = process.env.GITHUB_TOKEN;
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const ghHeaders = {
    Authorization:           `Bearer ${token}`,
    Accept:                  "application/vnd.github+json",
    "X-GitHub-Api-Version":  "2022-11-28",
  };

  async function loadBookedDates() {
    const resp = await fetch(apiUrl, { headers: ghHeaders });
    if (!resp.ok) {
      if (resp.status === 404) return { data: {}, sha: null };
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub GET booked-dates.json failed: ${resp.status} ${text}`);
    }
    const file = await resp.json();
    let data = {};
    try {
      data = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
      if (typeof data !== "object" || Array.isArray(data)) data = {};
    } catch { data = {}; }
    return { data, sha: file.sha };
  }

  async function saveBookedDates(data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
    const body = { message, content };
    if (sha) body.sha = sha;
    const resp = await fetch(apiUrl, {
      method:  "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
    }
  }

  await updateJsonFileWithRetry({
    load:    loadBookedDates,
    apply:   (data) => {
      if (!data[vehicleId]) data[vehicleId] = [];
      if (!hasOverlap(data[vehicleId], from, to)) {
        data[vehicleId].push({ from, to });
      }
    },
    save:    saveBookedDates,
    message: `Block dates for ${vehicleId}: ${from} to ${to} (manual booking)`,
  });
}

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

  const {
    secret, vehicleId, name, phone, email,
    pickupDate, pickupTime, returnDate, returnTime,
    amountPaid, notes,
  } = req.body || {};

  // Authentication
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validation
  if (!vehicleId || !ALLOWED_VEHICLES.includes(vehicleId)) {
    return res.status(400).json({ error: "Invalid or missing vehicleId" });
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Customer name is required" });
  }
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!pickupDate || !ISO_DATE.test(pickupDate)) {
    return res.status(400).json({ error: "pickupDate must be in YYYY-MM-DD format" });
  }
  if (!returnDate || !ISO_DATE.test(returnDate)) {
    return res.status(400).json({ error: "returnDate must be in YYYY-MM-DD format" });
  }
  if (pickupDate > returnDate) {
    return res.status(400).json({ error: "pickupDate must not be after returnDate" });
  }

  const booking = {
    bookingId:       crypto.randomBytes(8).toString("hex"),
    name:            name.trim(),
    phone:           typeof phone === "string" ? phone.trim() : "",
    email:           typeof email === "string" ? email.trim() : "",
    vehicleId,
    vehicleName:     VEHICLE_NAMES[vehicleId],
    pickupDate,
    pickupTime:      typeof pickupTime === "string" ? pickupTime.trim() : "",
    returnDate,
    returnTime:      typeof returnTime === "string" ? returnTime.trim() : "",
    location:        "",
    status:          "booked_paid",
    paymentIntentId: "manual_" + crypto.randomBytes(6).toString("hex"),
    amountPaid:      typeof amountPaid === "number" && amountPaid > 0
                       ? Math.round(amountPaid * 100) / 100
                       : 0,
    notes:           typeof notes === "string" ? notes.trim().slice(0, 500) : "",
    createdAt:       new Date().toISOString(),
  };

  try {
    // 1. Block the dates in booked-dates.json first so the calendar reflects the
    //    reservation before the booking record is persisted.
    await blockBookedDates(vehicleId, pickupDate, returnDate);

    // 2. Save the booking record to bookings.json with retry + idempotency guard.
    await updateJsonFileWithRetry({
      load:    loadBookings,
      apply:   (data) => {
        if (!Array.isArray(data[vehicleId])) data[vehicleId] = [];
        // Idempotent: don't add if bookingId already present (safe on retry)
        if (!data[vehicleId].some((b) => b.bookingId === booking.bookingId)) {
          data[vehicleId].push(booking);
        }
      },
      save:    saveBookings,
      message: `Add manual booking for ${vehicleId}: ${booking.name} (${booking.bookingId})`,
    });

    // Auto-sync to Supabase so admin Revenue Tracker and Customer Management
    // are populated immediately without any manual "Sync" step.
    await autoCreateRevenueRecord(booking);
    await autoUpsertCustomer(booking, false);

    return res.status(200).json({ success: true, booking });
  } catch (err) {
    console.error("add-manual-booking error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
