// api/v2-revenue.js
// SLYTRANS Fleet Control v2 — Revenue records management endpoint.
// All operations are additive; existing booking and payment flows are unaffected.
//
// POST /api/v2-revenue
// Actions:
//   list        — { secret, action:"list", vehicleId?, startDate?, endDate?, status? }
//   get         — { secret, action:"get", id }
//   create      — { secret, action:"create", ...fields }
//   update      — { secret, action:"update", id, updates:{...} }
//   delete      — { secret, action:"delete", id }
//   summary     — { secret, action:"summary" } — per-vehicle aggregated stats
//   sync        — { secret, action:"sync" } — populate records from bookings.json
//
// Error contract:
//   • READ actions (list, get, summary) return empty state when Supabase is not
//     configured or the table does not yet exist, so the admin panel never crashes.
//   • WRITE actions fall back to GitHub (revenue-records.json) when Supabase is
//     unavailable or the table does not yet exist, so saves never fail silently.

import { getSupabaseAdmin } from "./_supabase.js";
import { loadBookings } from "./_bookings.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import crypto from "crypto";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO     = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const RECORDS_FILE    = "revenue-records.json";

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
}

// ── GitHub fallback helpers ───────────────────────────────────────────────────

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept:                 "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function loadRecordsFromGitHub() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${RECORDS_FILE}`;
  const resp   = await fetch(apiUrl, { headers: ghHeaders() });
  if (!resp.ok) {
    if (resp.status === 404) return { data: [], sha: null };
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub GET revenue-records.json failed: ${resp.status} ${text}`);
  }
  const file = await resp.json();
  let data = [];
  try {
    const parsed = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (Array.isArray(parsed)) data = parsed;
  } catch { data = []; }
  return { data, sha: file.sha };
}

async function saveRecordsToGitHub(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("v2-revenue: GITHUB_TOKEN not set — revenue-records.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${RECORDS_FILE}`;
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
    throw new Error(`GitHub PUT revenue-records.json failed: ${resp.status} ${text}`);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });

  const body = req.body || {};
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const sb = getSupabase();

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      // Try Supabase first; fall back to GitHub when not configured or table missing.
      if (sb) {
        try {
          let q = sb.from("revenue_records").select("*").order("created_at", { ascending: false });
          if (body.vehicleId)  q = q.eq("vehicle_id",    body.vehicleId);
          if (body.status)     q = q.eq("payment_status", body.status);
          if (body.startDate)  q = q.gte("pickup_date",   body.startDate);
          if (body.endDate)    q = q.lte("return_date",   body.endDate);
          if (body.limit)      q = q.limit(Number(body.limit));
          const { data, error } = await q;
          if (!error) {
            // If Supabase has records, return them directly.
            if ((data || []).length > 0) return res.status(200).json({ records: data });
            // Supabase table exists but is empty — fall through to bookings-derived view below.
          } else {
            console.error("v2-revenue list error:", error.message);
          }
        } catch (qErr) {
          console.error("v2-revenue list query error:", qErr);
        }
      }
      // GitHub fallback
      const { data: ghRecords } = await loadRecordsFromGitHub();
      let records = ghRecords;
      if (body.vehicleId)  records = records.filter((r) => r.vehicle_id    === body.vehicleId);
      if (body.status)     records = records.filter((r) => r.payment_status === body.status);
      if (body.startDate)  records = records.filter((r) => r.pickup_date   >= body.startDate);
      if (body.endDate)    records = records.filter((r) => r.return_date   <= body.endDate);
      records.sort((a, b) => (b.created_at || "") > (a.created_at || "") ? 1 : -1);
      if (body.limit) records = records.slice(0, Number(body.limit));
      if (records.length > 0) return res.status(200).json({ records });

      // Both Supabase and revenue-records.json are empty.
      // Derive a live view directly from bookings.json so the Finance tab
      // is always populated without requiring a manual "Sync" step.
      try {
        const { data: bookingsData } = await loadBookings();
        const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
        let derived = Object.values(bookingsData).flat()
          .filter((b) => paidStatuses.has(b.status) && b.bookingId && Number(b.amountPaid || 0) > 0)
          .map((b) => ({
            id:             b.bookingId,
            booking_id:     b.bookingId,
            vehicle_id:     b.vehicleId   || null,
            customer_name:  b.name        || null,
            customer_phone: b.phone       || null,
            customer_email: b.email       || null,
            pickup_date:    b.pickupDate  || null,
            return_date:    b.returnDate  || null,
            gross_amount:   Number(b.amountPaid || 0),
            deposit_amount: 0,
            refund_amount:  0,
            payment_method: b.paymentMethod || "cash",
            payment_status: "paid",
            notes:          b.notes       || null,
            is_no_show:     false,
            is_cancelled:   false,
            override_by_admin: false,
            created_at:     b.createdAt   || null,
            updated_at:     b.updatedAt   || null,
            _derived:       true,
          }));
        if (body.vehicleId) derived = derived.filter((r) => r.vehicle_id    === body.vehicleId);
        if (body.status)    derived = derived.filter((r) => r.payment_status === body.status);
        if (body.startDate) derived = derived.filter((r) => r.pickup_date   >= body.startDate);
        if (body.endDate)   derived = derived.filter((r) => r.return_date   <= body.endDate);
        derived.sort((a, b) => (b.created_at || "") > (a.created_at || "") ? 1 : -1);
        if (body.limit) derived = derived.slice(0, Number(body.limit));
        return res.status(200).json({ records: derived, _source: "bookings_derived" });
      } catch (bookingsErr) {
        console.error("v2-revenue: bookings fallback error:", bookingsErr.message);
      }
      return res.status(200).json({ records: [] });
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { data, error } = await sb.from("revenue_records").select("*").eq("id", body.id).single();
        if (!error) return res.status(200).json({ record: data });
        if (!isSchemaError(error)) throw error;
      }
      // GitHub fallback
      const { data: ghRecords } = await loadRecordsFromGitHub();
      const found = ghRecords.find((r) => r.id === body.id);
      if (!found) return res.status(404).json({ error: "Record not found" });
      return res.status(200).json({ record: found });
    }

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === "create") {
      const { vehicle_id, gross_amount } = body;
      // booking_id is optional for manual entries; auto-generate a unique id if not supplied
      const booking_id = body.booking_id || ("manual-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
      if (!vehicle_id || gross_amount == null)
        return res.status(400).json({ error: "vehicle_id and gross_amount are required" });

      const commonFields = {
        booking_id,
        vehicle_id,
        customer_name:      body.customer_name   || null,
        customer_phone:     body.customer_phone  || null,
        customer_email:     body.customer_email  || null,
        pickup_date:        body.pickup_date      || null,
        return_date:        body.return_date      || null,
        gross_amount:       Number(gross_amount),
        deposit_amount:     Number(body.deposit_amount  || 0),
        refund_amount:      Number(body.refund_amount   || 0),
        payment_method:     body.payment_method   || "stripe",
        payment_status:     body.payment_status   || "paid",
        protection_plan_id: body.protection_plan_id || null,
        notes:              body.notes            || null,
        is_no_show:         Boolean(body.is_no_show),
        is_cancelled:       Boolean(body.is_cancelled),
        override_by_admin:  Boolean(body.override_by_admin),
        created_at:         new Date().toISOString(),
        updated_at:         new Date().toISOString(),
      };

      if (sb) {
        // Do NOT pass `id` — Supabase generates it via gen_random_uuid()
        const { data, error } = await sb.from("revenue_records").insert(commonFields).select().single();
        if (!error) return res.status(201).json({ record: data });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue create: revenue_records table missing, falling back to GitHub");
      }
      // GitHub fallback — include a client-generated UUID for the id field
      const ghRecord = { id: crypto.randomUUID(), ...commonFields };
      let created;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          if (!data.some((r) => r.booking_id === ghRecord.booking_id)) {
            data.push(ghRecord);
          }
          created = ghRecord;
        },
        save:    saveRecordsToGitHub,
        message: `v2: Add revenue record for ${vehicle_id}`,
      });
      return res.status(201).json({ record: created });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const allowed = [
        "gross_amount","deposit_amount","refund_amount","payment_method","payment_status",
        "protection_plan_id","notes","is_no_show","is_cancelled","override_by_admin",
        "customer_name","customer_phone","customer_email","pickup_date","return_date",
      ];
      const updates = {};
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      if (!Object.keys(updates).length)
        return res.status(400).json({ error: "No valid update fields provided" });

      if (sb) {
        const { data, error } = await sb.from("revenue_records").update(updates).eq("id", body.id).select().single();
        if (!error) return res.status(200).json({ record: data });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue update: revenue_records table missing, falling back to GitHub");
      }
      // GitHub fallback
      let updated;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((r) => r.id === body.id);
          if (idx === -1) throw new Error("Record not found");
          Object.assign(data[idx], updates, { updated_at: new Date().toISOString() });
          updated = data[idx];
        },
        save:    saveRecordsToGitHub,
        message: `v2: Update revenue record ${body.id}`,
      });
      return res.status(200).json({ record: updated });
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { error } = await sb.from("revenue_records").delete().eq("id", body.id);
        if (!error) return res.status(200).json({ success: true });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue delete: revenue_records table missing, falling back to GitHub");
      }
      // GitHub fallback
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((r) => r.id === body.id);
          if (idx !== -1) data.splice(idx, 1);
        },
        save:    saveRecordsToGitHub,
        message: `v2: Delete revenue record ${body.id}`,
      });
      return res.status(200).json({ success: true });
    }

    // ── SUMMARY (per-vehicle) ────────────────────────────────────────────────
    if (action === "summary") {
      // Helper to aggregate records manually
      function aggregateRecords(recs) {
        const summary = {};
        const totals = { gross: 0, refunds: 0, net: 0, deposits: 0, bookingCount: 0 };
        for (const r of (recs || [])) {
          if (!summary[r.vehicle_id]) {
            summary[r.vehicle_id] = { vehicle_id: r.vehicle_id, booking_count:0, cancelled_count:0, no_show_count:0, total_gross:0, total_refunds:0, total_net:0, total_deposits:0 };
          }
          const s = summary[r.vehicle_id];
          if (r.is_cancelled) { s.cancelled_count++; continue; }
          if (r.is_no_show)   { s.no_show_count++;   continue; }
          s.booking_count++;
          s.total_gross    += Number(r.gross_amount   || 0);
          s.total_refunds  += Number(r.refund_amount  || 0);
          s.total_net      += Number(r.gross_amount   || 0) - Number(r.refund_amount || 0);
          s.total_deposits += Number(r.deposit_amount || 0);
          totals.gross    += Number(r.gross_amount   || 0);
          totals.refunds  += Number(r.refund_amount  || 0);
          totals.net      += Number(r.gross_amount   || 0) - Number(r.refund_amount || 0);
          totals.deposits += Number(r.deposit_amount || 0);
          totals.bookingCount++;
        }
        return { summary: Object.values(summary), totals };
      }

      if (sb) {
        try {
          const { data, error } = await sb.from("vehicle_revenue_summary").select("*");
          if (!error) {
            const rows = data || [];
            const totals = rows.reduce((acc, r) => ({
              gross:        acc.gross        + Number(r.total_gross    || 0),
              refunds:      acc.refunds      + Number(r.total_refunds  || 0),
              net:          acc.net          + Number(r.total_net      || 0),
              deposits:     acc.deposits     + Number(r.total_deposits || 0),
              bookingCount: acc.bookingCount + Number(r.booking_count  || 0),
            }), { gross: 0, refunds: 0, net: 0, deposits: 0, bookingCount: 0 });
            return res.status(200).json({ summary: rows, totals });
          }
          // View may not exist — try raw table
          const { data: recs, error: err2 } = await sb.from("revenue_records").select("*");
          if (!err2) return res.status(200).json(aggregateRecords(recs));
          console.error("v2-revenue summary error:", err2.message);
        } catch (sumErr) {
          console.error("v2-revenue summary error:", sumErr);
        }
      }
      // GitHub fallback
      const { data: ghRecords } = await loadRecordsFromGitHub();
      return res.status(200).json(aggregateRecords(ghRecords));
    }

    // ── SYNC — build/refresh revenue_records from bookings.json ─────────────
    // Finds all paid bookings in bookings.json that don't yet have a revenue
    // record and creates them. Falls back to GitHub when Supabase table is missing.
    if (action === "sync") {
      const { data: bookingsData } = await loadBookings();
      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);
      const paidBookings = Object.values(bookingsData).flat()
        .filter((b) => paidStatuses.has(b.status) && b.bookingId && Number(b.amountPaid || 0) > 0);

      if (paidBookings.length === 0) {
        return res.status(200).json({ synced: 0, skipped: 0, message: "No paid bookings found to sync." });
      }

      // Build records without `id` so Supabase can generate it via gen_random_uuid()
      const toInsertBase = paidBookings.map((b) => ({
        booking_id:        b.bookingId,
        vehicle_id:        b.vehicleId || "unknown",
        customer_name:     b.name        || null,
        customer_phone:    b.phone       || null,
        customer_email:    b.email       || null,
        pickup_date:       b.pickupDate  || null,
        return_date:       b.returnDate  || null,
        gross_amount:      Number(b.amountPaid || 0),
        deposit_amount:    0,
        refund_amount:     0,
        payment_method:    b.paymentMethod || "cash",
        payment_status:    "paid",
        notes:             b.notes || null,
        is_no_show:        false,
        is_cancelled:      b.status === "cancelled_rental",
        override_by_admin: true,
        created_at:        new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      }));

      if (sb) {
        let useGithubFallback = false;
        // Pre-check existing booking_ids to compute accurate counts
        let existingIds = new Set();
        try {
          const { data: existing, error: existErr } = await sb.from("revenue_records").select("booking_id");
          if (existErr) {
            // Any error (schema or otherwise) on the pre-check: fall through to GitHub
            useGithubFallback = true;
          } else {
            existingIds = new Set((existing || []).map((r) => r.booking_id));
          }
        } catch (_) { useGithubFallback = true; /* if SELECT throws, fall through to GitHub */ }

        if (!useGithubFallback) {
          const newRecords = toInsertBase.filter((r) => !existingIds.has(r.booking_id));
          const skipped = toInsertBase.length - newRecords.length;

          if (newRecords.length === 0) {
            return res.status(200).json({ synced: 0, skipped, message: `All ${skipped} booking${skipped !== 1 ? "s" : ""} already have revenue records.` });
          }

          let synced = 0;
          const BATCH = 100;
          let batchFailed = false;
          for (let i = 0; i < newRecords.length; i += BATCH) {
            const batch = newRecords.slice(i, i + BATCH);
            const { error: upsertErr } = await sb.from("revenue_records")
              .upsert(batch, { onConflict: "booking_id", ignoreDuplicates: true });
            if (upsertErr) {
              if (isSchemaError(upsertErr)) { batchFailed = true; useGithubFallback = true; break; }
              const { error: insertErr } = await sb.from("revenue_records").insert(batch);
              if (insertErr) {
                if (isSchemaError(insertErr)) { batchFailed = true; useGithubFallback = true; break; }
                throw insertErr;
              }
            }
            synced += batch.length;
          }

          if (!batchFailed) {
            return res.status(200).json({
              synced,
              skipped,
              message: `Synced ${synced} revenue record${synced !== 1 ? "s" : ""} from bookings.${skipped > 0 ? ` ${skipped} already existed and were skipped.` : ""}`,
            });
          }
        }
        console.warn("v2-revenue sync: Supabase unavailable or error, falling back to GitHub");
      }

      // GitHub fallback for sync — include client-generated UUIDs
      const toInsert = toInsertBase.map((r) => ({ id: crypto.randomUUID(), ...r }));
      let synced = 0;
      let skipped = 0;
      let needsGithubWrite = false;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          const existingBookingIds = new Set(data.map((r) => r.booking_id));
          synced = 0; skipped = 0; needsGithubWrite = false;
          for (const r of toInsert) {
            if (existingBookingIds.has(r.booking_id)) { skipped++; continue; }
            data.push(r);
            existingBookingIds.add(r.booking_id);
            synced++;
          }
          needsGithubWrite = synced > 0;
        },
        save:    async (data, sha, message) => {
          if (!needsGithubWrite) return; // nothing changed — skip the commit
          return saveRecordsToGitHub(data, sha, message);
        },
        message: `v2: Sync ${toInsert.length} revenue records from bookings`,
      });

      return res.status(200).json({
        synced,
        skipped,
        message: `Synced ${synced} revenue record${synced !== 1 ? "s" : ""} from bookings.${skipped > 0 ? ` ${skipped} already existed and were skipped.` : ""}`,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-revenue error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
