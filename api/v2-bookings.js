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
//   When a booking status transitions to "booked_paid" or "active_rental":
//   1. A revenue record is created in Supabase (revenue_records table).
//   2. The customer is upserted in Supabase (customers table) if phone is present.
//   When a booking status transitions to "completed_rental":
//   2. The customer stats (total_bookings, total_spent, last_booking_date) are updated.

import crypto from "crypto";
import { loadBookings, saveBookings, appendBooking } from "./_bookings.js";
import { loadVehicles } from "./_vehicles.js";
import { hasOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { getSupabaseAdmin } from "./_supabase.js";

// ── Booking automation helpers ─────────────────────────────────────────────

/**
 * Auto-creates a revenue record in Supabase for a booking that just became paid.
 * Non-fatal: any Supabase error is logged but does not fail the booking update.
 *
 * @param {object} booking  - the updated booking record from bookings.json
 */
async function autoCreateRevenueRecord(booking) {
  const sb = getSupabaseAdmin();
  if (!sb) return; // Supabase not configured — skip silently

  try {
    // Avoid creating duplicate records (idempotent: check by booking_id)
    const { data: existing } = await sb
      .from("revenue_records")
      .select("id")
      .eq("booking_id", booking.bookingId)
      .maybeSingle();
    if (existing) return; // already exists

    const days = booking.pickupDate && booking.returnDate
      ? Math.max(1, Math.round((new Date(booking.returnDate) - new Date(booking.pickupDate)) / 86400000))
      : null;

    const record = {
      booking_id:     booking.bookingId,
      vehicle_id:     booking.vehicleId,
      customer_name:  booking.name  || null,
      customer_phone: booking.phone || null,
      customer_email: booking.email || null,
      pickup_date:    booking.pickupDate  || null,
      return_date:    booking.returnDate  || null,
      gross_amount:   Number(booking.amountPaid || 0),
      deposit_amount: 0,
      refund_amount:  0,
      payment_method: booking.paymentMethod || "cash",
      payment_status: "paid",
      notes:          booking.notes || null,
      is_no_show:     false,
      is_cancelled:   false,
      override_by_admin: true,
    };

    const { error } = await sb.from("revenue_records").insert(record);
    if (error) {
      console.error("v2-bookings auto-revenue insert error (non-fatal):", error.message);
    } else {
      console.log(`v2-bookings: auto-created revenue record for booking ${booking.bookingId}`);
    }
  } catch (err) {
    console.error("v2-bookings autoCreateRevenueRecord error (non-fatal):", err.message);
  }
}

/**
 * Auto-upserts a customer record in Supabase from a booking.
 * Non-fatal: any error is logged but does not fail the booking update.
 *
 * @param {object} booking    - the updated booking record from bookings.json
 * @param {boolean} countStats - when true, increment booking count and total_spent
 *                               (only pass true for final-state transitions like
 *                               "completed_rental" to avoid double-counting)
 */
async function autoUpsertCustomer(booking, countStats = false) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  if (!booking.phone) return; // phone required for upsert key

  try {
    const record = {
      name:       booking.name  || "Unknown",
      phone:      String(booking.phone).trim(),
      email:      booking.email || null,
      updated_at: new Date().toISOString(),
    };

    // Fetch existing customer to determine whether to create or update
    const { data: existing } = await sb
      .from("customers")
      .select("total_bookings, total_spent, first_booking_date")
      .eq("phone", record.phone)
      .maybeSingle();

    if (existing) {
      const updates = { name: record.name, email: record.email, updated_at: record.updated_at };
      // Only increment counters when explicitly requested (e.g. on completed_rental)
      if (countStats) {
        updates.total_bookings = (existing.total_bookings || 0) + 1;
        updates.total_spent    = Math.round(((existing.total_spent || 0) + Number(booking.amountPaid || 0)) * 100) / 100;
        updates.last_booking_date = booking.pickupDate || null;
      }
      await sb.from("customers").update(updates).eq("phone", record.phone);
    } else {
      const insert = {
        ...record,
        total_bookings:     countStats ? 1 : 0,
        total_spent:        countStats ? Math.round(Number(booking.amountPaid || 0) * 100) / 100 : 0,
        first_booking_date: booking.pickupDate || null,
        last_booking_date:  booking.pickupDate || null,
      };
      await sb.from("customers").insert(insert);
    }
    console.log(`v2-bookings: auto-upserted customer ${record.phone} (${record.name})`);
  } catch (err) {
    console.error("v2-bookings autoUpsertCustomer error (non-fatal):", err.message);
  }
}

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
      const allowedUpdateFields = ["status", "notes", "amountPaid", "paymentMethod"];
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
      // When a booking becomes paid, automatically create a revenue record and
      // upsert the customer in Supabase.  Both operations are non-fatal.
      // Stats (total_bookings, total_spent) are only incremented on
      // "completed_rental" to prevent double-counting across status transitions.
      const newStatus = safeUpdates.status;
      if (updatedBooking && (newStatus === "booked_paid" || newStatus === "active_rental")) {
        await autoCreateRevenueRecord(updatedBooking);
        await autoUpsertCustomer(updatedBooking, false); // create record, no stat increment yet
      } else if (updatedBooking && newStatus === "completed_rental") {
        await autoUpsertCustomer(updatedBooking, true); // increment stats once on completion
      }

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
      // record immediately. Stats are not yet incremented — they increment when
      // the booking reaches "completed_rental".
      if (booking.status === "booked_paid") {
        await autoCreateRevenueRecord(booking);
        await autoUpsertCustomer(booking, false);
      }

      return res.status(200).json({ success: true, booking });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-bookings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
