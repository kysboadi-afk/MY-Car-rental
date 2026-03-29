// api/v2-bookings.js
// SLYTRANS FLEET CONTROL v2 — Bookings CRUD endpoint.
// Supports listing bookings and updating booking status (approve/decline).
//
// POST /api/v2-bookings
// Actions:
//   list      — { secret, action:"list", vehicleId?, status? }
//   list_raw  — { secret, action:"list_raw" }  (unfiltered Supabase read — Phase 6)
//   update    — { secret, action:"update", vehicleId, bookingId, updates:{status,...} }
//   create    — { secret, action:"create", ...bookingFields } (manual booking)
//
// Booking automation (triggered automatically, non-fatal):
//   On create (booked_paid) or status → "booked_paid" / "active_rental":
//   1. Revenue record created in Supabase revenue_records table.
//   2. Customer upserted in Supabase customers table.
//   3. Booking synced to Supabase bookings table.
//   4. Blocked dates inserted in Supabase blocked_dates table.
//   On status → "completed_rental":
//   5. Customer stats incremented.
//   6. completedAt timestamp stamped automatically.
//   7. Blocked date range removed from booked-dates.json (restores availability).
//   On status → "cancelled_rental":
//   1-4 skipped; no revenue or stats updated.
//   8. Blocked date range removed from booked-dates.json.

import crypto from "crypto";
import { loadBookings, saveBookings } from "./_bookings.js";
import { hasOverlap, hasDateTimeOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import {
  autoCreateRevenueRecord,
  autoUpsertCustomer,
  autoUpsertBooking,
  autoCreateBlockedDate,
} from "./_booking-automation.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";
import { normalizePhone } from "./_bookings.js";
import { render, DEFAULT_LOCATION, BOOKING_CONFIRMED } from "./_sms-templates.js";

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

async function unblockBookedDates(vehicleId, from, to) {
  if (!vehicleId || !from || !to) return;
  await updateJsonFileWithRetry({
    load:    loadBookedDates,
    apply:   (data) => {
      if (!Array.isArray(data[vehicleId])) return;
      data[vehicleId] = data[vehicleId].filter((r) => !(r.from === from && r.to === to));
    },
    save:    saveBookedDates,
    message: `Unblock dates for ${vehicleId}: ${from} to ${to}`,
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
    // Primary source: Supabase bookings table (includes all Stripe webhook
    // bookings saved by saveWebhookBookingRecord).  Falls back to bookings.json
    // so the admin always sees data even when Supabase is unreachable.
    if (action === "list" || !action) {
      const { vehicleId, status } = body;

      const sb = getSupabaseAdmin();
      if (sb) {
        // Build the query with filters BEFORE .order() so the chain terminates
        // correctly (the Supabase JS SDK — and our test stubs — resolve on .order()).
        let q = sb
          .from("bookings")
          .select(`
            id,
            booking_ref,
            vehicle_id,
            pickup_date,
            return_date,
            pickup_time,
            return_time,
            status,
            total_price,
            deposit_paid,
            remaining_balance,
            payment_status,
            payment_method,
            payment_intent_id,
            notes,
            created_at,
            updated_at,
            customers ( id, name, phone, email )
          `);

        if (vehicleId && ALLOWED_VEHICLES.includes(vehicleId)) {
          q = q.eq("vehicle_id", vehicleId);
        } else {
          q = q.in("vehicle_id", ALLOWED_VEHICLES);
        }
        if (status) {
          q = q.eq("status", status);
        }

        const { data: rows, error } = await q.order("created_at", { ascending: false });

        if (!error) {
          const bookings = (rows || []).map((r) => ({
            bookingId:       r.booking_ref || r.id,
            vehicleId:       r.vehicle_id,
            vehicleName:     VEHICLE_NAMES[r.vehicle_id] || r.vehicle_id,
            name:            r.customers?.name  || "",
            phone:           r.customers?.phone || "",
            email:           r.customers?.email || "",
            pickupDate:      r.pickup_date  || "",
            pickupTime:      r.pickup_time  || "",
            returnDate:      r.return_date  || "",
            returnTime:      r.return_time  || "",
            location:        "",
            status:          r.status,
            amountPaid:      Number(r.deposit_paid      || 0),
            totalPrice:      Number(r.total_price       || 0),
            remaining:       Number(r.remaining_balance || 0),
            paymentStatus:   r.payment_status  || "",
            paymentMethod:   r.payment_method  || "",
            paymentIntentId: r.payment_intent_id || "",
            notes:           r.notes || "",
            smsSentAt:       {},
            createdAt:       r.created_at,
            updatedAt:       r.updated_at || null,
            _source:         "supabase",
          }));
          return res.status(200).json({ bookings });
        }

        console.error("v2-bookings list: Supabase error, falling back to bookings.json:", error.message);
      }

      // Fallback: bookings.json
      const { data } = await loadBookings();
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

    // ── LIST_RAW (Phase 6) — unfiltered direct Supabase read ─────────────────
    // Returns every row from the Supabase bookings table with no status/vehicle
    // filters and no aggregation.  Used by the admin panel to verify data
    // consistency independently of the bookings.json flat-file store.
    // Falls back to the same flat-file data as "list" when Supabase is not
    // configured, so the admin never sees an empty table due to misconfiguration.
    if (action === "list_raw") {
      const sb = getSupabaseAdmin();
      if (sb) {
        const { data: rows, error } = await sb
          .from("bookings")
          .select(`
            id,
            booking_ref,
            vehicle_id,
            pickup_date,
            return_date,
            pickup_time,
            return_time,
            status,
            total_price,
            deposit_paid,
            remaining_balance,
            payment_status,
            payment_method,
            notes,
            created_at,
            updated_at,
            activated_at,
            completed_at,
            customers ( id, name, phone, email )
          `)
          .order("created_at", { ascending: false });

        if (error) {
          console.error("v2-bookings list_raw Supabase error:", error.message);
          // Fall through to JSON fallback
        } else {
          const bookings = (rows || []).map((r) => ({
            bookingId:       r.booking_ref || r.id,
            vehicleId:       r.vehicle_id,
            name:            r.customers?.name  || "",
            phone:           r.customers?.phone || "",
            email:           r.customers?.email || "",
            pickupDate:      r.pickup_date  || "",
            pickupTime:      r.pickup_time  || "",
            returnDate:      r.return_date  || "",
            returnTime:      r.return_time  || "",
            status:          r.status,
            amountPaid:      Number(r.deposit_paid   || 0),
            totalPrice:      Number(r.total_price    || 0),
            remaining:       Number(r.remaining_balance || 0),
            paymentStatus:   r.payment_status,
            paymentMethod:   r.payment_method || "",
            notes:           r.notes || "",
            createdAt:       r.created_at,
            activatedAt:     r.activated_at  || null,
            completedAt:     r.completed_at  || null,
            _source:         "supabase",
          }));
          return res.status(200).json({ bookings, source: "supabase", total: bookings.length });
        }
      }

      // Fallback: return the same flat-file bookings as "list"
      const { data: fbData } = await loadBookings();
      let fbResult = [];
      for (const vid of ALLOWED_VEHICLES) {
        fbResult = fbResult.concat((fbData[vid] || []).map((b) => ({ ...b, vehicleId: b.vehicleId || vid, _source: "bookings_json" })));
      }
      fbResult.sort((a, b) => (b.createdAt || b.pickupDate || "") > (a.createdAt || a.pickupDate || "") ? 1 : -1);
      return res.status(200).json({ bookings: fbResult, source: "bookings_json", total: fbResult.length });
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
      const allowedUpdateFields = ["status", "notes", "amountPaid", "totalPrice", "paymentMethod", "cancelReason", "returnDate", "returnTime"];
      for (const f of allowedUpdateFields) {
        if (Object.prototype.hasOwnProperty.call(updates, f)) {
          safeUpdates[f] = updates[f];
        }
      }
      safeUpdates.updatedAt = new Date().toISOString();
      // Auto-stamp activatedAt when an admin marks the vehicle as picked up
      if (safeUpdates.status === "active_rental" && !safeUpdates.activatedAt) {
        safeUpdates.activatedAt = safeUpdates.updatedAt;
      }
      // Auto-stamp completedAt when an admin marks the rental as finished
      if (safeUpdates.status === "completed_rental" && !safeUpdates.completedAt) {
        safeUpdates.completedAt = safeUpdates.updatedAt;
      }

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
        // Send booking confirmation SMS when status transitions to booked_paid
        if (newStatus === "booked_paid" && updatedBooking.phone &&
            process.env.TEXTMAGIC_USERNAME && process.env.TEXTMAGIC_API_KEY) {
          try {
            await sendSms(
              normalizePhone(updatedBooking.phone),
              render(BOOKING_CONFIRMED, {
                vehicle:       updatedBooking.vehicleName || updatedBooking.vehicleId || "",
                customer_name: (updatedBooking.name || "Customer").split(" ")[0],
                pickup_date:   updatedBooking.pickupDate  || "",
                pickup_time:   updatedBooking.pickupTime  || "",
                location:      DEFAULT_LOCATION,
              })
            );
          } catch (smsErr) {
            console.error("v2-bookings: booking confirmation SMS failed (non-fatal):", smsErr.message);
          }
        }
      } else if (updatedBooking && newStatus === "completed_rental") {
        await autoUpsertCustomer(updatedBooking, true); // increment stats once on completion
        await autoUpsertBooking(updatedBooking);
      } else if (updatedBooking) {
        // Sync any other status change (cancelled, reserved_unpaid, etc.)
        // Also re-sync when returnDate/returnTime were edited so Supabase and
        // booked-dates.json stay consistent with the updated dates.
        await autoUpsertBooking(updatedBooking);
        if (safeUpdates.returnDate && updatedBooking.pickupDate && updatedBooking.returnDate) {
          // Re-block with the corrected date range so /api/booked-dates returns
          // the updated range and "Next Available" badges show correctly.
          await autoCreateBlockedDate(
            updatedBooking.vehicleId,
            updatedBooking.pickupDate,
            updatedBooking.returnDate,
            "booking"
          );
          await blockBookedDates(updatedBooking.vehicleId, updatedBooking.pickupDate, updatedBooking.returnDate).catch((err) => {
            console.warn("v2-bookings: blockBookedDates on returnDate update failed (non-fatal):", err.message);
          });
        }
      }
      // "cancelled_rental" intentionally skips revenue creation and stat updates

      // Restore availability in booked-dates.json when a rental ends
      if (updatedBooking && (newStatus === "completed_rental" || newStatus === "cancelled_rental")) {
        try {
          await unblockBookedDates(
            updatedBooking.vehicleId,
            updatedBooking.pickupDate,
            updatedBooking.returnDate
          );
        } catch (err) {
          console.error("v2-bookings: unblockBookedDates failed (non-fatal):", err.message);
        }
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
        amountPaid, totalPrice, paymentMethod, notes,
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

      // Check for overlapping bookings — uses datetime-aware comparison so that
      // back-to-back bookings on the same day (different time slots) are allowed.
      const { data: existingBookings } = await loadBookings();
      const vehicleBookings = existingBookings[vehicleId] || [];
      const activeOverlap = vehicleBookings.filter(
        (b) => b.status === "booked_paid" || b.status === "active_rental" || b.status === "reserved_unpaid"
      );
      for (const existing of activeOverlap) {
        const eFrom = existing.pickupDate;
        const eTo   = existing.returnDate;
        if (eFrom && eTo) {
          const conflictRanges = [{ from: eFrom, to: eTo, fromTime: existing.pickupTime, toTime: existing.returnTime }];
          if (hasDateTimeOverlap(conflictRanges, pickupDate, returnDate, pickupTime, returnTime)) {
            return res.status(409).json({
              error: `Date/time conflict: vehicle already booked from ${eFrom} ${existing.pickupTime || ""} to ${eTo} ${existing.returnTime || ""} for ${existing.name}`.trim(),
            });
          }
        }
      }

      const parsedAmount = typeof amountPaid === "number" ? amountPaid : parseFloat(amountPaid) || 0;
      const parsedTotal  = typeof totalPrice === "number" ? totalPrice  : parseFloat(totalPrice)  || 0;

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
        totalPrice:     Math.round((parsedTotal || parsedAmount) * 100) / 100,
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
