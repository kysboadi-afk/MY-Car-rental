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
import nodemailer from "nodemailer";
import { loadBookings, saveBookings } from "./_bookings.js";
import { hasOverlap, hasDateTimeOverlap } from "./_availability.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import {
  autoCreateRevenueRecord,
  autoUpsertCustomer,
  autoUpsertBooking,
  autoCreateBlockedDate,
  parseTime12h,
} from "./_booking-automation.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { persistBooking } from "./_booking-pipeline.js";
import { CARS, computeRentalDays } from "./_pricing.js";
import { loadPricingSettings, computeBreakdownLinesFromSettings } from "./_settings.js";
import { generateRentalAgreementPdf } from "./_rental-agreement-pdf.js";
import { buildUnifiedConfirmationEmail, buildDocumentNotes, isWebsitePaymentMethod } from "./_booking-confirmation-template.js";
import { sendSms } from "./_textmagic.js";
import { normalizePhone } from "./_bookings.js";
import { render, DEFAULT_LOCATION, BOOKING_CONFIRMED } from "./_sms-templates.js";
import { triggerMaintenanceUpdate } from "./update-maintenance-status.js";

const ALLOWED_ORIGINS  = ["https://www.slytrans.com", "https://slytrans.com"];
const ALLOWED_VEHICLES = ["slingshot", "slingshot2", "slingshot3", "camry", "camry2013"];
const VEHICLE_NAMES    = {
  slingshot:  "Slingshot R",
  slingshot2: "Slingshot R (Unit 2)",
  slingshot3: "Slingshot R (Unit 3)",
  camry:      "Camry 2012",
  camry2013:  "Camry 2013 SE",
};

// Mapping between app-level status values (used in bookings.json and the admin UI)
// and database-level status values (used in the Supabase bookings table).
const APP_TO_DB_STATUS = {
  reserved_unpaid:  "pending",
  booked_paid:      "approved",
  active_rental:    "active",
  completed_rental: "completed",
  cancelled_rental: "cancelled",
};
const DB_TO_APP_STATUS = Object.fromEntries(
  Object.entries(APP_TO_DB_STATUS).map(([app, db]) => [db, app])
);

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
      data[vehicleId] = data[vehicleId].filter((r) => !(r.from <= to && r.to >= from));
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
            flagged,
            risk_score,
            notes,
            created_at,
            updated_at,
            customers ( id, name, phone, email, risk_flag, flagged, banned, total_profit, total_bookings, no_show_count )
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
          // Fetch revenue_records for stripe fee data (best-effort; non-fatal)
          let revenueByBookingId = {};
          try {
            const bookingRefs = (rows || []).map((r) => r.booking_ref || String(r.id)).filter(Boolean);
            if (bookingRefs.length) {
              const { data: rrRows } = await sb
                .from("revenue_records_effective")
                .select("booking_id, gross_amount, stripe_fee, stripe_net, payment_method, customer_name, customer_phone, customer_email")
                .in("booking_id", bookingRefs);
              for (const rr of (rrRows || [])) {
                if (!revenueByBookingId[rr.booking_id]) {
                  revenueByBookingId[rr.booking_id] = rr;
                }
              }
            }
          } catch (_e) { /* non-fatal */ }

          const bookings = (rows || []).map((r) => {
            const bookingRef = r.booking_ref || String(r.id);
            const rr = revenueByBookingId[bookingRef] || null;
            const totalPrice = Number(r.total_price || 0);
            const gross      = rr ? Number(rr.gross_amount || 0) : totalPrice;
            const stripeFee  = rr && rr.stripe_fee != null ? Number(rr.stripe_fee) : null;
            const amountNet  = stripeFee != null ? gross - stripeFee : null;
            const cust = r.customers || {};
            return {
              bookingId:       bookingRef,
              vehicleId:       r.vehicle_id,
              vehicleName:     VEHICLE_NAMES[r.vehicle_id] || r.vehicle_id,
              name:            cust.name  || rr?.customer_name  || "",
              phone:           cust.phone || rr?.customer_phone || "",
              email:           cust.email || rr?.customer_email || "",
              pickupDate:      r.pickup_date  || "",
              pickupTime:      r.pickup_time  || "",
              returnDate:      r.return_date  || "",
              returnTime:      r.return_time  || "",
              location:        "",
              status:          DB_TO_APP_STATUS[r.status] || r.status,
              amountPaid:      Number(r.deposit_paid      || 0),
              totalPrice,
              remaining:       Number(r.remaining_balance || 0),
              paymentStatus:   r.payment_status  || "",
              paymentMethod:   r.payment_method  || "",
              paymentIntentId: r.payment_intent_id || "",
              flagged:         r.flagged || false,
              riskScore:       r.risk_score || 0,
              // Financial
              amountGross:     gross,
              stripeFee,
              amountNet,
              // Customer insight
              custRiskFlag:    cust.risk_flag    || "low",
              custFlagged:     cust.flagged      || false,
              custBanned:      cust.banned       || false,
              custTotalProfit: cust.total_profit != null ? Number(cust.total_profit) : null,
              custBookings:    cust.total_bookings || 0,
              custNoShows:     cust.no_show_count  || 0,
              notes:           r.notes || "",
              smsSentAt:       {},
              createdAt:       r.created_at,
              updatedAt:       r.updated_at || null,
              _source:         "supabase",
            };
          });
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
            status:          DB_TO_APP_STATUS[r.status] || r.status,
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
      const foundInJson = checkData[vehicleId].some(
        (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
      );

      // If the booking isn't in bookings.json, it may exist only in Supabase
      // (e.g. created via the Stripe webhook before bookings.json was written,
      //  or an extended booking whose Supabase row diverged from the JSON).
      // Try to locate it in Supabase so the status update can still proceed.
      let sbOnlyRow = null;
      if (!foundInJson) {
        const sbVal = getSupabaseAdmin();
        if (sbVal) {
          try {
            // Try by booking_ref first
            let { data: sbCheck } = await sbVal
              .from("bookings")
              .select("id, booking_ref, payment_intent_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, total_price, deposit_paid, notes, payment_method")
              .eq("vehicle_id", vehicleId)
              .eq("booking_ref", bookingId)
              .maybeSingle();
            // Fallback: try by numeric Supabase row id
            if (!sbCheck) {
              const numId = parseInt(bookingId, 10);
              if (!isNaN(numId)) {
                const { data: sbCheckById } = await sbVal
                  .from("bookings")
                  .select("id, booking_ref, payment_intent_id, vehicle_id, pickup_date, return_date, pickup_time, return_time, status, total_price, deposit_paid, notes, payment_method")
                  .eq("vehicle_id", vehicleId)
                  .eq("id", numId)
                  .maybeSingle();
                sbCheck = sbCheckById;
              }
            }
            sbOnlyRow = sbCheck || null;
          } catch (_sbValErr) { /* non-fatal */ }
        }
        if (!sbOnlyRow) {
          return res.status(404).json({ error: "Booking not found" });
        }
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

      // ── Supabase direct update (primary path when configured) ──────────────
      // Update the Supabase bookings table directly so that status transitions
      // ("Mark Active", "Mark Completed", etc.) succeed immediately even if
      // the GitHub bookings.json write is temporarily blocked by a SHA conflict.
      // This is intentionally done BEFORE the bookings.json write so that, if
      // GitHub fails after all retries, we can fall back to the Supabase result.
      // Also fires when returnDate/returnTime are being changed (e.g. admin
      // correcting a return date or processing a manual extension) so Supabase-
      // only bookings stay consistent with the updated dates.
      let sbUpdateSuccess = false;
      const sbInstance = getSupabaseAdmin();
      const hasReturnUpdate = safeUpdates.returnDate !== undefined || safeUpdates.returnTime !== undefined;
      if (sbInstance && (safeUpdates.status || hasReturnUpdate)) {
        const dbStatus = safeUpdates.status ? APP_TO_DB_STATUS[safeUpdates.status] : null;
        if (dbStatus || hasReturnUpdate) {
          try {
            const sbPayload = {
              ...(dbStatus ? { status: dbStatus } : {}),
              updated_at: safeUpdates.updatedAt,
              ...(safeUpdates.activatedAt ? { activated_at: safeUpdates.activatedAt } : {}),
              ...(safeUpdates.completedAt ? { completed_at: safeUpdates.completedAt } : {}),
              ...(safeUpdates.notes !== undefined  ? { notes: safeUpdates.notes } : {}),
              ...(safeUpdates.returnDate !== undefined ? { return_date: safeUpdates.returnDate } : {}),
              ...(safeUpdates.returnTime !== undefined ? { return_time: parseTime12h(safeUpdates.returnTime) } : {}),
            };

            // If we already located the Supabase row during validation (Supabase-only
            // bookings not present in bookings.json), update it directly by id to avoid
            // any booking_ref / payment_intent_id mismatch.
            if (sbOnlyRow) {
              const { error: soErr } = await sbInstance
                .from("bookings")
                .update(sbPayload)
                .eq("id", sbOnlyRow.id);
              if (!soErr) {
                sbUpdateSuccess = true;
              } else {
                console.error("v2-bookings: Supabase-only booking update error (non-fatal):", soErr.message);
              }
            } else {
              const { data: sbRow, error: sbErr } = await sbInstance
                .from("bookings")
                .update(sbPayload)
                .eq("booking_ref", bookingId)
                .select("id")
                .maybeSingle();
              if (!sbErr && sbRow) {
                sbUpdateSuccess = true;
              } else if (!sbErr && !sbRow) {
                // The booking_ref lookup matched 0 rows — try payment_intent_id as a
                // fallback.  This handles Supabase rows that have no booking_ref set
                // (e.g. created before the column was populated, or where the initial
                // autoUpsertBooking failed).  Using UPDATE avoids the INSERT conflict-
                // check trigger that fires on date-overlapping bookings.
                const preCheck = checkData[vehicleId].find(
                  (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
                );
                const piId = preCheck?.paymentIntentId;
                if (piId) {
                  const { data: piRow } = await sbInstance
                    .from("bookings")
                    .select("id")
                    .eq("payment_intent_id", piId)
                    .maybeSingle();
                  if (piRow) {
                    const { error: piErr } = await sbInstance
                      .from("bookings")
                      .update(sbPayload)
                      .eq("id", piRow.id);
                    if (!piErr) {
                      sbUpdateSuccess = true;
                    } else {
                      console.error("v2-bookings: Supabase fallback update error (non-fatal):", piErr.message);
                    }
                  }
                }
              } else if (sbErr) {
                console.error("v2-bookings: Supabase direct update error (non-fatal):", sbErr.message);
              }
            }
          } catch (sbCatchErr) {
            console.error("v2-bookings: Supabase direct update threw (non-fatal):", sbCatchErr.message);
          }
        }
      }

      let updatedBooking;
      // Only attempt the bookings.json write when the booking exists there.
      // Supabase-only bookings (sbOnlyRow set) skip the GitHub write entirely
      // to avoid writing an unchanged file and creating a spurious commit.
      if (!sbOnlyRow) {
        try {
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
        } catch (githubErr) {
          if (sbUpdateSuccess) {
            // Supabase already has the updated status — treat the GitHub write
            // failure as non-fatal and reconstruct updatedBooking from local state.
            console.error(
              "v2-bookings: bookings.json write failed after Supabase update succeeded (non-fatal):",
              githubErr.message
            );
            const preCheckBooking = checkData[vehicleId].find(
              (b) => b.bookingId === bookingId || b.paymentIntentId === bookingId
            );
            if (preCheckBooking) {
              updatedBooking = { ...preCheckBooking, ...safeUpdates };
            }
          } else {
            // No Supabase fallback available — propagate the error to the client.
            throw githubErr;
          }
        }
      }

      // For Supabase-only bookings (not found in bookings.json), the apply()
      // callback above silently skips the write (idx === -1) so updatedBooking
      // stays undefined.  Reconstruct a minimal booking object from the Supabase
      // row so that downstream automation (unblock dates, customer stats, etc.)
      // can still run correctly.
      if (sbOnlyRow) {
        if (!sbUpdateSuccess) {
          // The Supabase update failed and there is no bookings.json to fall back on.
          return res.status(500).json({ error: "Failed to update booking in database" });
        }
        updatedBooking = {
          bookingId,
          vehicleId,
          pickupDate:      sbOnlyRow.pickup_date  || "",
          pickupTime:      sbOnlyRow.pickup_time  || "",
          returnDate:      sbOnlyRow.return_date  || "",
          returnTime:      sbOnlyRow.return_time  || "",
          totalPrice:      Number(sbOnlyRow.total_price  || 0),
          amountPaid:      Number(sbOnlyRow.deposit_paid || 0),
          paymentMethod:   sbOnlyRow.payment_method  || "",
          paymentIntentId: sbOnlyRow.payment_intent_id || "",
          notes:           sbOnlyRow.notes || "",
          ...safeUpdates,
        };
      }

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
          "booking",
          updatedBooking.bookingId || null
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

        // ── Capture start odometer on rental activation (non-fatal) ───────────
        // Reads the current vehicle mileage (synced by the bouncie-sync cron every
        // 5 minutes) and writes a placeholder trips record so the driver's start
        // odometer is preserved even before GPS trip_log data accumulates.
        // Idempotent: skips the insert when a placeholder already exists for this
        // booking_id (e.g. created by migration 0040 for pre-deployment rentals).
        if (newStatus === "active_rental" && updatedBooking.vehicleId) {
          try {
            const sb = getSupabaseAdmin();
            if (sb) {
              // Guard: only insert if no trips row already exists for this booking
              const { data: existingStart } = await sb
                .from("trips")
                .select("id")
                .eq("booking_id", updatedBooking.bookingId)
                .is("end_mileage", null)
                .limit(1)
                .maybeSingle();

              if (!existingStart) {
                const { data: vRow } = await sb
                  .from("vehicles")
                  .select("mileage")
                  .eq("vehicle_id", updatedBooking.vehicleId)
                  .maybeSingle();

                const startOdo = vRow?.mileage != null ? Number(vRow.mileage) : null;

                const { error: startTripErr } = await sb.from("trips").insert({
                  vehicle_id:    updatedBooking.vehicleId,
                  booking_id:    updatedBooking.bookingId,
                  start_mileage: startOdo,
                  end_mileage:   null,
                  distance:      null,
                  driver_name:   updatedBooking.name  || null,
                  driver_phone:  updatedBooking.phone || null,
                });
                if (startTripErr) {
                  console.warn("v2-bookings: start mileage trips insert failed (non-fatal):", startTripErr.message);
                } else {
                  console.log(`v2-bookings: captured start odometer ${startOdo ?? "n/a"} mi for booking ${updatedBooking.bookingId}`);
                }
              } else {
                // Placeholder already exists (from migration 0040) — ensure driver info is populated
                const { error: patchErr } = await sb
                  .from("trips")
                  .update({
                    driver_name:  updatedBooking.name  || null,
                    driver_phone: updatedBooking.phone || null,
                  })
                  .eq("id", existingStart.id)
                  .is("driver_name", null); // only patch if still empty
                if (patchErr) {
                  console.warn("v2-bookings: driver info patch on existing trips row failed (non-fatal):", patchErr.message);
                }
              }
            }
          } catch (startTripCatchErr) {
            console.error("v2-bookings: start mileage capture failed (non-fatal):", startTripCatchErr.message);
          }
        }
      } else if (updatedBooking && newStatus === "completed_rental") {
        await autoUpsertCustomer(updatedBooking, true); // increment stats once on completion
        await autoUpsertBooking(updatedBooking);

        // ── Record trip + update vehicle mileage (non-fatal) ───────────────
        // Sum GPS trip_log distances for this vehicle during the booking window,
        // then insert a booking-linked trip record in the trips table and
        // recompute maintenance status.
        try {
          const sb = getSupabaseAdmin();
          if (sb && updatedBooking.vehicleId && updatedBooking.pickupDate && updatedBooking.returnDate) {
            // Aggregate distance from GPS trip_log entries during the rental window
            const { data: tripLogRows } = await sb
              .from("trip_log")
              .select("trip_distance, end_odometer")
              .eq("vehicle_id", updatedBooking.vehicleId)
              .gte("trip_at", new Date(updatedBooking.pickupDate).toISOString())
              .lte("trip_at", new Date(updatedBooking.returnDate + "T23:59:59Z").toISOString());

            const gpsRows    = tripLogRows || [];
            const distance   = gpsRows.reduce((s, r) => s + (Number(r.trip_distance) || 0), 0);
            const endOdoRows = gpsRows.filter((r) => r.end_odometer != null);
            const endOdo     = endOdoRows.length > 0
              ? Math.max(...endOdoRows.map((r) => Number(r.end_odometer)))
              : null;

            // ── Upsert booking-linked trip record (trips table — migration 0030) ──
            // Check for a placeholder row inserted when the booking was activated.
            // If found, update it with end mileage and driver info.
            // If not found (e.g. booking was activated before this feature), insert fresh.
            const { data: existingTrip } = await sb
              .from("trips")
              .select("id, start_mileage")
              .eq("booking_id", updatedBooking.bookingId)
              .is("end_mileage", null)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            const startOdo = existingTrip?.start_mileage != null ? Number(existingTrip.start_mileage) : null;
            // Prefer GPS-summed distance; fall back to odometer delta when start was captured
            const finalDistance =
              distance > 0
                ? distance
                : (startOdo != null && endOdo != null ? Math.max(0, endOdo - startOdo) : null);

            if (existingTrip) {
              const { error: tripErr } = await sb
                .from("trips")
                .update({
                  end_mileage:  endOdo,
                  distance:     finalDistance,
                  driver_name:  updatedBooking.name  || null,
                  driver_phone: updatedBooking.phone || null,
                })
                .eq("id", existingTrip.id);
              if (tripErr) console.warn("v2-bookings: trips update failed (non-fatal):", tripErr.message);
            } else {
              const { error: tripErr } = await sb.from("trips").insert({
                vehicle_id:    updatedBooking.vehicleId,
                booking_id:    updatedBooking.bookingId,
                start_mileage: null,
                end_mileage:   endOdo,
                distance:      finalDistance,
                driver_name:   updatedBooking.name  || null,
                driver_phone:  updatedBooking.phone || null,
              });
              if (tripErr) console.warn("v2-bookings: trips insert failed (non-fatal):", tripErr.message);
            }

            // Update vehicle current_mileage (mileage column) when GPS data available
            if (endOdo) {
              const { error: mileageErr } = await sb
                .from("vehicles")
                .update({ mileage: endOdo, updated_at: new Date().toISOString() })
                .eq("vehicle_id", updatedBooking.vehicleId)
                .lt("mileage", endOdo); // only update if higher than stored (prevent rollback)
              if (mileageErr) console.warn("v2-bookings: vehicle mileage update failed (non-fatal):", mileageErr.message);
            }

            // Recompute maintenance status for this vehicle
            await triggerMaintenanceUpdate(updatedBooking.vehicleId);
          }
        } catch (tripErr) {
          console.error("v2-bookings: trip recording failed (non-fatal):", tripErr.message);
        }
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
            "booking",
            updatedBooking.bookingId || null
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

    // ── FLAG (toggle flagged state on a booking) ────────────────────────────
    if (action === "flag") {
      const { bookingId, flagged: flagValue, notes: flagNotes } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });
      const sbFlag = getSupabaseAdmin();
      if (!sbFlag) return res.status(500).json({ error: "Database not configured" });

      const flagPayload = {
        flagged:    typeof flagValue === "boolean" ? flagValue : true,
        updated_at: new Date().toISOString(),
        ...(flagNotes !== undefined ? { notes: flagNotes } : {}),
      };
      const { error: flagErr } = await sbFlag
        .from("bookings")
        .update(flagPayload)
        .eq("booking_ref", bookingId);
      if (flagErr) return res.status(500).json({ error: flagErr.message });
      return res.status(200).json({ success: true });
    }

    // ── CREATE (manual booking) ─────────────────────────────────────────────
    if (action === "create") {
      if (!process.env.GITHUB_TOKEN) {
        return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
      }

      const {
        vehicleId, name, phone, email,
        pickupDate, pickupTime, returnDate, returnTime,
        amountPaid, totalPrice, paymentMethod, paymentIntentId, notes,
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
      const bookingId    = crypto.randomBytes(8).toString("hex");

      // Persist booking through the unified pipeline (Supabase + bookings.json).
      // bookingId is stable across retries for idempotency.
      const result = await persistBooking({
        bookingId,
        vehicleId,
        vehicleName:    VEHICLE_NAMES[vehicleId] || vehicleId,
        name:           name.trim().slice(0, 100),
        phone:          typeof phone === "string" ? phone.trim().slice(0, 20) : "",
        email:          typeof email === "string" ? email.trim().slice(0, 100) : "",
        pickupDate,
        pickupTime:     typeof pickupTime === "string" ? pickupTime.trim() : "",
        returnDate,
        returnTime:     typeof returnTime === "string" ? returnTime.trim() : "",
        amountPaid:     Math.round(parsedAmount * 100) / 100,
        totalPrice:     Math.round((parsedTotal || parsedAmount) * 100) / 100,
        paymentMethod:  typeof paymentMethod    === "string" ? paymentMethod.trim()    : "cash",
        paymentIntentId: typeof paymentIntentId  === "string" ? paymentIntentId.trim()  : "",
        status:         parsedAmount > 0 ? "booked_paid" : "reserved_unpaid",
        notes:          typeof notes === "string" ? notes.trim().slice(0, 500) : "",
        source:         "admin_v2",
      });

      await blockBookedDates(vehicleId, pickupDate, returnDate).catch((err) => {
        console.warn("v2-bookings: blockBookedDates failed (non-fatal):", err.message);
      });

      return res.status(200).json({ success: true, booking: result.booking });
    }

    if (action === "resend_confirmation") {
      const { bookingId } = body;
      if (!bookingId) return res.status(400).json({ error: "bookingId is required" });

      // Find the booking in bookings.json
      const { data: bData } = await loadBookings();
      let booking = null;
      for (const list of Object.values(bData)) {
        if (!Array.isArray(list)) continue;
        const found = list.find((b) => b.bookingId === bookingId);
        if (found) { booking = found; break; }
      }
      if (!booking) return res.status(404).json({ error: `No booking found with ID "${bookingId}"` });

      if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(500).json({ error: "SMTP not configured — add SMTP_HOST, SMTP_USER, SMTP_PASS in Vercel." });
      }

      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_PORT === "465",
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const ownerEmail = process.env.OWNER_EMAIL || process.env.SMTP_USER;
      const { name, email, phone, vehicleName, vehicleId: bVid,
              pickupDate, pickupTime, returnDate, returnTime,
              amountPaid, totalPrice, status, paymentIntentId } = booking;
      const firstName = (name || "there").split(" ")[0];

      // Retrieve stored docs for attachments (if available).
      let storedDocs = null;
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          const { data: docsRow } = await sb
            .from("pending_booking_docs")
            .select("*")
            .eq("booking_id", bookingId)
            .maybeSingle();
          storedDocs = docsRow || null;
        }
      } catch (docsErr) {
        console.warn("v2-bookings resend_confirmation: pending_booking_docs read failed (non-fatal):", docsErr.message);
      }

      const attachments = [];
      if (storedDocs && storedDocs.signature) {
        try {
          const vehicleInfo = (bVid && CARS[bVid]) ? CARS[bVid] : {};
          const hasProtectionPlan = !!(storedDocs.protection_plan_tier || booking.protectionPlanTier || booking.protectionPlan);
          const protectionPlanTier = storedDocs.protection_plan_tier || booking.protectionPlanTier || null;
          const pdfBody = {
            vehicleId:   bVid || "",
            car:         vehicleName || vehicleInfo.name || bVid || "",
            vehicleMake: vehicleInfo.make || null,
            vehicleModel: vehicleInfo.model || null,
            vehicleYear: vehicleInfo.year || null,
            vehicleVin:  vehicleInfo.vin || null,
            vehicleColor: vehicleInfo.color || null,
            name:        name || "",
            email:       email || "",
            phone:       phone || "",
            pickup:      pickupDate || "",
            pickupTime:  pickupTime || "",
            returnDate:  returnDate || "",
            returnTime:  returnTime || "",
            total:       amountPaid != null ? String(amountPaid) : (totalPrice != null ? String(totalPrice) : ""),
            deposit:     vehicleInfo.deposit || 0,
            days:        (pickupDate && returnDate) ? computeRentalDays(pickupDate, returnDate) : 0,
            protectionPlan:          hasProtectionPlan,
            protectionPlanTier:      protectionPlanTier,
            signature:               storedDocs.signature,
            fullRentalCost:          booking.fullRentalCost || null,
            balanceAtPickup:         booking.balanceAtPickup || null,
            insuranceCoverageChoice: storedDocs.insurance_coverage_choice || (hasProtectionPlan ? "no" : null),
          };
          const pdfBuffer = await generateRentalAgreementPdf(pdfBody);
          const safeName = (name || "renter").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
          const safeDate = (pickupDate || new Date().toISOString().split("T")[0]).replace(/[^0-9-]/g, "");
          attachments.push({
            filename: `rental-agreement-${safeName}-${safeDate}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          });
        } catch (pdfErr) {
          console.warn("v2-bookings resend_confirmation: PDF generation failed (non-fatal):", pdfErr.message);
        }
      }
      if (storedDocs && storedDocs.id_base64 && storedDocs.id_filename) {
        try {
          attachments.push({
            filename: storedDocs.id_filename,
            content: Buffer.from(storedDocs.id_base64, "base64"),
            contentType: storedDocs.id_mimetype || "application/octet-stream",
          });
        } catch (idErr) {
          console.warn("v2-bookings resend_confirmation: ID attachment failed (non-fatal):", idErr.message);
        }
      }
      if (storedDocs && storedDocs.insurance_base64 && storedDocs.insurance_filename) {
        try {
          attachments.push({
            filename: storedDocs.insurance_filename,
            content: Buffer.from(storedDocs.insurance_base64, "base64"),
            contentType: storedDocs.insurance_mimetype || "application/octet-stream",
          });
        } catch (insErr) {
          console.warn("v2-bookings resend_confirmation: insurance attachment failed (non-fatal):", insErr.message);
        }
      }

      const hasProtectionPlan = !!(storedDocs?.protection_plan_tier || booking.protectionPlanTier || booking.protectionPlan);
      const protectionPlanTier = storedDocs?.protection_plan_tier || booking.protectionPlanTier || null;
      let breakdownLines = null;
      try {
        const isHourly = !!(bVid && CARS[bVid] && CARS[bVid].hourlyTiers);
        if (!isHourly && bVid && pickupDate && returnDate) {
          const pricingSettings = await loadPricingSettings();
          breakdownLines = computeBreakdownLinesFromSettings(
            bVid,
            pickupDate,
            returnDate,
            pricingSettings,
            hasProtectionPlan,
            protectionPlanTier
          );
        }
      } catch (err) {
        console.warn("v2-bookings resend_confirmation: pricing breakdown generation failed (non-fatal):", err.message);
      }

      const insuranceStatus = storedDocs?.insurance_coverage_choice === "no"
        ? "No personal insurance provided (Damage Protection Plan or renter liability applies)"
        : (storedDocs?.insurance_coverage_choice === "yes"
            ? (storedDocs?.insurance_filename ? "Own insurance provided (document attached)" : "Own insurance selected (proof not uploaded)")
            : (hasProtectionPlan
                ? `Protection plan selected (${protectionPlanTier || "tier not specified"})`
                : "Not selected / No protection plan"));

      const missingItemNotes = buildDocumentNotes({
        idUploaded:        !!storedDocs?.id_base64,
        signatureUploaded: !!storedDocs?.signature,
        insuranceUploaded: !!storedDocs?.insurance_base64,
        insuranceExpected: storedDocs?.insurance_coverage_choice === "yes",
      });
      const additionalNotes = [
        ...(booking.notes ? [`Booking notes: ${booking.notes}`] : []),
        ...(attachments.length ? [`Attachments: ${attachments.map(a => a.filename).join(", ")}`] : []),
      ];

      const isWebsitePayment = isWebsitePaymentMethod(paymentIntentId);
      const paymentMethodLabel = isWebsitePayment ? "Website (Stripe)" : "Cash / Manual";
      const ownerTemplate = buildUnifiedConfirmationEmail({
        audience:           "owner",
        bookingId,
        vehicleName,
        vehicleId:          bVid,
        vehicleMake:        CARS[bVid]?.make || null,
        vehicleModel:       CARS[bVid]?.model || null,
        vehicleYear:        CARS[bVid]?.year || null,
        vehicleVin:         CARS[bVid]?.vin || null,
        vehicleColor:       CARS[bVid]?.color || null,
        renterName:         name,
        renterEmail:        email,
        renterPhone:        phone,
        pickupDate,
        pickupTime,
        returnDate,
        returnTime,
        amountPaid,
        totalPrice,
        fullRentalCost:     booking.fullRentalCost || null,
        balanceAtPickup:    booking.balanceAtPickup || null,
        status:             status || "booked_paid",
        paymentMethodLabel: `${paymentMethodLabel}${isWebsitePayment ? ` (${paymentIntentId})` : ""}`,
        insuranceStatus,
        pricingBreakdownLines: breakdownLines || [],
        missingItemNotes: [...missingItemNotes, ...additionalNotes],
      });

      // Owner email
      await transporter.sendMail({
        from:    `"SLY RIDES Bookings" <${process.env.SMTP_USER}>`,
        to:      ownerEmail,
        ...(email ? { replyTo: email } : {}),
        subject: ownerTemplate.subject,
        attachments,
        html: ownerTemplate.html,
        text: ownerTemplate.text,
      });

      // Customer email
      let customerSent = false;
      if (email) {
        const customerTemplate = buildUnifiedConfirmationEmail({
          audience:           "customer",
          bookingId,
          vehicleName,
          vehicleId:          bVid,
          vehicleMake:        CARS[bVid]?.make || null,
          vehicleModel:       CARS[bVid]?.model || null,
          vehicleYear:        CARS[bVid]?.year || null,
          vehicleVin:         CARS[bVid]?.vin || null,
          vehicleColor:       CARS[bVid]?.color || null,
          renterName:         name,
          renterEmail:        email,
          renterPhone:        phone,
          pickupDate,
          pickupTime,
          returnDate,
          returnTime,
          amountPaid,
          totalPrice,
          fullRentalCost:     booking.fullRentalCost || null,
          balanceAtPickup:    booking.balanceAtPickup || null,
          status:             status || "booked_paid",
          paymentMethodLabel: `${paymentMethodLabel}${isWebsitePayment ? ` (${paymentIntentId})` : ""}`,
          insuranceStatus,
          pricingBreakdownLines: breakdownLines || [],
          missingItemNotes: [...missingItemNotes, ...additionalNotes],
          firstName,
        });
        try {
          await transporter.sendMail({
            from:    `"Sly Transportation Services LLC" <${process.env.SMTP_USER}>`,
            to:      email,
            subject: customerTemplate.subject,
            html: customerTemplate.html,
            text: customerTemplate.text,
          });
          customerSent = true;
        } catch (custErr) {
          console.error("v2-bookings resend_confirmation: customer email failed:", custErr.message);
        }
      }

      return res.status(200).json({
        success: true, bookingId,
        ownerNotified: true,
        customerEmail: email || null,
        customerSent,
        note: customerSent
          ? "Confirmation sent to owner and customer with standardized template."
          : "Confirmation sent to owner with standardized template. No customer email on file — customer not notified.",
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-bookings error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
