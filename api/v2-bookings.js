// api/v2-bookings.js
// SLYTRANS FLEET CONTROL v2 — Bookings CRUD endpoint.
// Supports listing bookings and updating booking status (approve/decline).
//
// POST /api/v2-bookings
// Actions:
//   list    — { secret, action:"list", vehicleId?, status? }
//   update  — { secret, action:"update", vehicleId, bookingId, updates:{status,...} }
//   create  — { secret, action:"create", ...bookingFields } (manual booking)
//
// Booking automation (triggered automatically, non-fatal):
//   On create (booked_paid) or status → "booked_paid" / "active_rental":
//   1. Revenue record created in Supabase revenue_records table.
//   2. Customer upserted in Supabase customers table.
//   3. Booking synced to Supabase bookings table.
//   4. Blocked dates inserted in Supabase blocked_dates table.
//   On status → "completed_rental":
//   5. Customer stats incremented.
//   On status → "cancelled_rental":
//   1-4 skipped; no revenue or stats updated.

import crypto from "crypto";
import { loadBookings, saveBookings, appendBooking } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { hasOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import {
  autoCreateRevenueRecord,
  autoUpsertCustomer,
  autoUpsertBooking,
  autoCreateBlockedDate,
} from "./_booking-automation.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
const VEHICLE_NAMES    = {
  slingshot:  "Slingshot R",
  slingshot2: "Slingshot R (Unit 2)",
  slingshot3: "Slingshot R (Unit 3)",
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

async function loadBookedDates() {
  const apiUrl  = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const getResp = await fetch(apiUrl, { headers: ghHeaders() });
  if (!getResp.ok) {
    if (getResp.status === 404) return { data: {}, sha: null };
    return { data: {}, sha: null }; // non-fatal
  }
  const fileData = await getResp.json();
  let data = {};
  try {
    data = JSON.parse(Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (typeof data !== "object" || Array.isArray(data)) data = {};
  } catch {
    data = {};
  }
  return { data, sha: fileData.sha };
}

async function saveBookedDates(data, sha, message) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${BOOKED_DATES_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");
  const body = { message, content };
  if (sha) body.sha = sha;
  const resp = await fetch(apiUrl, {
    method:  "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub PUT booked-dates.json failed: ${resp.status} ${text}`);
  }
}

async function blockBookedDates(vehicleId, from, to) {
  await updateJsonFileWithRetry({
    load:    loadBookedDates,
    apply:   (data) => {
      if (!data[vehicleId]) data[vehicleId] = [];
      if (!hasOverlap(data[vehicleId], from, to)) {
        data[vehicleId].push({ from, to });
      }
    },
    save:    saveBookedDates,
    message: `Block dates for ${vehicleId}: ${from} to ${to} (v2 manual booking)`,
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

      // Validate booking exists before the retry loop
      const { data: checkData } = await loadBookings();
      if (!Array.isArray(checkData[vehicleId])) {
        return res.status(404).json({ error: "Vehicle not found" });
      }
      if (!checkData[vehicleId].some((b) => b.bookingId === bookingId || b.paymentIntentId === bookingId)) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Build safe update set (timestamp is fixed before retry to stay consistent)
      const safeUpdates = {};
      const allowedUpdateFields = ["status", "notes", "amountPaid", "paymentMethod", "cancelReason"];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          safeUpdates[f] = updates[f];
        }
      }
      safeUpdates.updatedAt = new Date().toISOString();

      let updatedBooking;
      await updateJsonFileWithRetry({
        load:    loadBookings,
        apply:   (data) => {
          if (!Array.isArray(data[vehicleId])) return;
          const idx = data[vehicleId].findIndex(
            (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
          );
          if (idx === -1) return;
          data[vehicleId][idx] = { ...data[vehicleId][idx], ...safeUpdates };
          updatedBooking = data[vehicleId][idx];
        },
        save:    saveBookings,
        message: `v2: Update booking ${bookingId} for ${vehicleId}: ${JSON.stringify(Object.keys(safeUpdates))}`,
      });

      // ── Booking automation ────────────────────────────────────────────────
      // When a booking becomes paid, automatically create a revenue record,
      // upsert the customer, sync to the Supabase bookings table, and create
      // a blocked_dates entry.  All operations are non-fatal.
      // Stats (total_bookings, total_spent) are only incremented on
      // "completed_rental" to prevent double-counting across status transitions.
      const newStatus = safeUpdates.status;
      if (updatedBooking && (newStatus === "booked_paid" || newStatus === "active_rental")) {
        await autoCreateRevenueRecord(updatedBooking);
        await autoUpsertCustomer(updatedBooking, false); // create record, no stat increment yet
        await autoUpsertBooking(updatedBooking);
        await autoCreateBlockedDate(
          updatedBooking.vehicleId,
          updatedBooking.pickupDate,
          updatedBooking.returnDate,
          "booking"
        );
      } else if (updatedBooking && newStatus === "completed_rental") {
        await autoUpsertCustomer(updatedBooking, true); // increment stats once on completion
        await autoUpsertBooking(updatedBooking);
      } else if (updatedBooking) {
        // Sync any other status change (cancelled, reserved_unpaid, etc.)
        await autoUpsertBooking(updatedBooking);
      }
      // "cancelled_rental" intentionally skips revenue creation and stat updates

      return res.status(200).json({ success: true, booking: updatedBooking });
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

      // Build the booking record once; bookingId is stable across retries for idempotency
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

      // Save with retry; apply is idempotent — skips if bookingId already present
      await updateJsonFileWithRetry({
        load:    loadBookings,
        apply:   (data) => {
          if (!Array.isArray(data[vehicleId])) data[vehicleId] = [];
          if (!data[vehicleId].some((b) => b.bookingId === booking.bookingId)) {
            data[vehicleId].push(booking);
          }
        },
        save:    saveBookings,
        message: `v2: Manual booking ${booking.bookingId} for ${vehicleId} (${name.trim()})`,
      });

      await blockBookedDates(vehicleId, pickupDate, returnDate).catch((err) => {
        console.warn("v2-bookings: blockBookedDates failed (non-fatal):", err.message);
      });

      // ── Booking automation for new paid bookings ─────────────────────────
      // For manual bookings created directly as "booked_paid", create the revenue
      // record immediately and sync to the Supabase bookings / blocked_dates tables.
      // Stats are not yet incremented — they increment when the booking reaches
      // "completed_rental".
      if (booking.status === "booked_paid") {
        await autoCreateRevenueRecord(booking);
        await autoUpsertCustomer(booking, false);
      }
      // Always sync new bookings to Supabase (includes pending/reserved bookings)
      await autoUpsertBooking(booking);
      await autoCreateBlockedDate(vehicleId, pickupDate, returnDate, "booking");

      return res.status(200).json({ success: true, booking });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-bookings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
