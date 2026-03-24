// api/v2-bookings.js
// SLYTRANS FLEET CONTROL v2 — Bookings CRUD endpoint.
// Supports listing bookings and updating booking status (approve/decline).
//
// POST /api/v2-bookings
// Actions:
//   list    — { secret, action:"list", vehicleId?, status? }
//   update  — { secret, action:"update", vehicleId, bookingId, updates:{status,...} }
//   create  — { secret, action:"create", ...bookingFields } (manual booking)

import crypto from "crypto";
import { loadBookings, saveBookings, appendBooking } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { hasOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = ["slingshot", "slingshot2", "camry", "camry2013"];
const VEHICLE_NAMES    = {
  slingshot:  "Slingshot R",
  slingshot2: "Slingshot R (2)",
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};

const GITHUB_REPO       = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const BOOKED_DATES_PATH = "booked-dates.json";

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function blockBookedDates(vehicleId, from, to) {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const getResp = await fetch(apiUrl, { headers: ghHeaders() });
  if (!getResp.ok) return; // non-fatal — calendar may be stale but booking is saved

  const fileData = await getResp.json();
  const current  = JSON.parse(
    Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
  );
  if (!current[vehicleId]) current[vehicleId] = [];
  if (hasOverlap(current[vehicleId], from, to)) return;

  current[vehicleId].push({ from, to });
  const updatedContent = Buffer.from(JSON.stringify(current, null, 2) + "\n").toString("base64");

  await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify({
      message: `Block dates for ${vehicleId}: ${from} to ${to} (v2 manual booking)`,
      content: updatedContent,
      sha:     fileData.sha,
    }),
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

  const body   = req.body || {};
  const { secret, action } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (action === "list" || !action) {
      const { data } = await loadBookings();
      const { vehicleId, status } = body;

      let result = [];
      if (vehicleId && ALLOWED_VEHICLES.includes(vehicleId)) {
        result = data[vehicleId] || [];
      } else {
        for (const vid of ALLOWED_VEHICLES) {
          result = result.concat((data[vid] || []).map((b) => ({ ...b, vehicleId: b.vehicleId || vid })));
        }
      }

      if (status) {
        result = result.filter((b) => b.status === status);
      }

      // Newest first
      result.sort((a, b) => (b.createdAt || b.pickupDate || "") > (a.createdAt || a.pickupDate || "") ? 1 : -1);

      return res.status(200).json({ bookings: result });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      const { vehicleId, bookingId, updates } = body;

      if (!vehicleId || !bookingId || !updates || typeof updates !== "object") {
        return res.status(400).json({ error: "vehicleId, bookingId, and updates are required" });
      }

      if (!process.env.GITHUB_TOKEN) {
        return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
      }

      const { data, sha } = await loadBookings();
      if (!Array.isArray(data[vehicleId])) {
        return res.status(404).json({ error: "Vehicle not found" });
      }

      const idx = data[vehicleId].findIndex(
        (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
      );
      if (idx === -1) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Only allow safe fields to be updated
      const safeUpdates = {};
      const allowedUpdateFields = ["status", "notes", "amountPaid", "paymentMethod"];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          safeUpdates[f] = updates[f];
        }
      }
      safeUpdates.updatedAt = new Date().toISOString();

      data[vehicleId][idx] = { ...data[vehicleId][idx], ...safeUpdates };
      await saveBookings(
        data, sha,
        `v2: Update booking ${bookingId} for ${vehicleId}: ${JSON.stringify(Object.keys(safeUpdates))}`
      );

      return res.status(200).json({ success: true, booking: data[vehicleId][idx] });
    }

    // ── CREATE (manual booking) ─────────────────────────────────────────────
    if (action === "create") {
      if (!process.env.GITHUB_TOKEN) {
        return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
      }

      const {
        vehicleId, name, phone, email,
        pickupDate, pickupTime, returnDate, returnTime,
        amountPaid, paymentMethod, notes,
      } = body;

      if (!vehicleId || !ALLOWED_VEHICLES.includes(vehicleId)) {
        return res.status(400).json({ error: "Invalid or missing vehicleId" });
      }
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
      }
      const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
      if (!pickupDate || !ISO_DATE.test(pickupDate)) {
        return res.status(400).json({ error: "pickupDate must be YYYY-MM-DD" });
      }
      if (!returnDate || !ISO_DATE.test(returnDate)) {
        return res.status(400).json({ error: "returnDate must be YYYY-MM-DD" });
      }
      if (returnDate < pickupDate) {
        return res.status(400).json({ error: "returnDate must not be before pickupDate" });
      }

      // Check for overlapping bookings
      const { data: existingBookings } = await loadBookings();
      const vehicleBookings = existingBookings[vehicleId] || [];
      const activeOverlap = vehicleBookings.filter(
        (b) => b.status === "booked_paid" || b.status === "active_rental" || b.status === "reserved_unpaid"
      );
      for (const existing of activeOverlap) {
        const eFrom = existing.pickupDate;
        const eTo   = existing.returnDate;
        if (eFrom && eTo && !(returnDate < eFrom || pickupDate > eTo)) {
          return res.status(409).json({
            error: `Date conflict: vehicle already booked from ${eFrom} to ${eTo} for ${existing.name}`,
          });
        }
      }

      const parsedAmount = typeof amountPaid === "number" ? amountPaid : parseFloat(amountPaid) || 0;

      const booking = {
        bookingId:      crypto.randomBytes(8).toString("hex"),
        name:           name.trim().slice(0, 100),
        phone:          typeof phone === "string" ? phone.trim().slice(0, 20) : "",
        email:          typeof email === "string" ? email.trim().slice(0, 100) : "",
        vehicleId,
        vehicleName:    VEHICLE_NAMES[vehicleId] || vehicleId,
        pickupDate,
        pickupTime:     typeof pickupTime === "string" ? pickupTime.trim() : "",
        returnDate,
        returnTime:     typeof returnTime === "string" ? returnTime.trim() : "",
        amountPaid:     Math.round(parsedAmount * 100) / 100,
        paymentMethod:  typeof paymentMethod === "string" ? paymentMethod : "cash",
        status:         parsedAmount > 0 ? "booked_paid" : "reserved_unpaid",
        notes:          typeof notes === "string" ? notes.trim().slice(0, 500) : "",
        smsSentAt:      {},
        createdAt:      new Date().toISOString(),
        source:         "admin_v2",
      };

      await appendBooking(booking);
      await blockBookedDates(vehicleId, pickupDate, returnDate).catch((err) => {
        console.warn("v2-bookings: blockBookedDates failed (non-fatal):", err.message);
      });

      return res.status(200).json({ success: true, booking });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-bookings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
