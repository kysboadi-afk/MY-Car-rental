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
          let q = sb.from("revenue_records_effective").select("*").order("created_at", { ascending: false });
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
      let records = ghRecords.filter((r) => !r.sync_excluded);
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
        const { data, error } = await sb.from("revenue_records_effective").select("*").eq("id", body.id).single();
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
        "vehicle_id",
        "gross_amount","deposit_amount","refund_amount","payment_method","payment_status",
        "protection_plan_id","notes","is_no_show","is_cancelled","override_by_admin",
        "customer_name","customer_phone","customer_email","pickup_date","return_date",
        "stripe_fee","stripe_net","stripe_charge_id","payment_intent_id",
      ];
      const updates = {};
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      if (!Object.keys(updates).length)
        return res.status(400).json({ error: "No valid update fields provided" });
      if ("vehicle_id" in updates && !updates.vehicle_id) {
        console.warn(`v2-revenue update [${body.id}]: vehicle_id was provided but is empty — record will have no vehicle assigned`);
      }

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
    // Soft-delete: mark sync_excluded=true so the record is hidden from the
    // revenue list but its booking_id remains in the table.  This prevents
    // "Sync from Bookings" from recreating the record on the next run.
    if (action === "delete") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { error } = await sb.from("revenue_records")
          .update({ sync_excluded: true, updated_at: new Date().toISOString() })
          .eq("id", body.id);
        if (!error) return res.status(200).json({ success: true });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue delete: revenue_records table missing, falling back to GitHub");
      }
      // GitHub fallback — mark sync_excluded instead of splicing
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((r) => r.id === body.id);
          if (idx !== -1) data[idx] = { ...data[idx], sync_excluded: true, updated_at: new Date().toISOString() };
        },
        save:    saveRecordsToGitHub,
        message: `v2: Exclude revenue record ${body.id} from sync`,
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
          const { data: recs, error: err2 } = await sb.from("revenue_records_effective").select("*");
          if (!err2) return res.status(200).json(aggregateRecords(recs));
          console.error("v2-revenue summary error:", err2.message);
        } catch (sumErr) {
          console.error("v2-revenue summary error:", sumErr);
        }
      }
      // GitHub fallback
      const { data: ghRecords } = await loadRecordsFromGitHub();
      return res.status(200).json(aggregateRecords(ghRecords.filter((r) => !r.sync_excluded)));
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
        vehicle_id:        b.vehicleId || null,
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
        payment_intent_id: b.paymentIntentId || null,
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
          const { data: existing, error: existErr } = await sb.from("revenue_records_effective").select("booking_id");
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

          let synced = 0;
          const BATCH = 100;
          let batchFailed = false;

          if (newRecords.length > 0) {
            for (let i = 0; i < newRecords.length; i += BATCH) {
              const batch = newRecords.slice(i, i + BATCH);
              const { error: insertErr } = await sb.from("revenue_records").insert(batch);
              if (insertErr) {
                if (isSchemaError(insertErr)) { batchFailed = true; useGithubFallback = true; break; }
                throw insertErr;
              }
              synced += batch.length;
            }
          }

          if (!batchFailed) {
            // Backfill payment_intent_id on existing records that are missing it.
            // This stamps Stripe PI IDs onto records created before migration 0043
            // so the Stripe reconciler can match them by PI ID.
            const toBackfill = toInsertBase.filter(
              (r) => existingIds.has(r.booking_id) && r.payment_intent_id
            );
            if (toBackfill.length > 0) {
              const updatedAt = new Date().toISOString();
              const CONC = 10;
              for (let i = 0; i < toBackfill.length; i += CONC) {
                const batch = toBackfill.slice(i, i + CONC);
                await Promise.all(batch.map((r) =>
                  sb.from("revenue_records")
                    .update({ payment_intent_id: r.payment_intent_id, updated_at: updatedAt })
                    .eq("booking_id", r.booking_id)
                    .is("payment_intent_id", null)
                ));
              }
            }

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

    // ── RECORD EXTENSION FEE ────────────────────────────────────────────────
    // Convenience action for recording an external or manual extension fee that
    // was NOT processed through the Stripe rental-extension flow (e.g. cash,
    // Zelle, or a phone-agreed payment).  Generates a unique synthetic booking_id
    // (prefix "ext-") so it is picked up by the dashboard as supplemental revenue
    // without conflicting with the original booking's record.
    if (action === "record_extension_fee") {
      const { original_booking_id, vehicle_id, amount, extension_label, payment_method, notes } = body;
      if (!original_booking_id || !vehicle_id || amount == null)
        return res.status(400).json({ error: "original_booking_id, vehicle_id, and amount are required" });

      const resolvedAmount = Number(amount);
      if (isNaN(resolvedAmount) || resolvedAmount <= 0)
        return res.status(400).json({ error: "amount must be a positive number" });

      const syntheticBookingId = `ext-${original_booking_id}-${Date.now()}`;
      const label   = extension_label ? ` (${extension_label})` : "";
      const noteText = notes || `Extension${label} for booking ${original_booking_id} — external payment`;

      const commonFields = {
        booking_id:          syntheticBookingId,
        original_booking_id: original_booking_id,
        vehicle_id,
        gross_amount:        resolvedAmount,
        deposit_amount:      0,
        refund_amount:       0,
        payment_method:      payment_method || "external",
        payment_status:      "paid",
        notes:               noteText,
        is_no_show:          false,
        is_cancelled:        false,
        override_by_admin:   true,
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      };

      if (sb) {
        const { data, error } = await sb.from("revenue_records").insert(commonFields).select().single();
        if (!error) return res.status(201).json({ record: data, booking_id: syntheticBookingId });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-revenue record_extension_fee: Supabase unavailable, falling back to GitHub");
      }
      // GitHub fallback
      const ghRecord = { id: crypto.randomUUID(), ...commonFields };
      let created;
      await updateJsonFileWithRetry({
        load:    loadRecordsFromGitHub,
        apply:   (data) => {
          if (!data.some((r) => r.booking_id === ghRecord.booking_id)) data.push(ghRecord);
          created = ghRecord;
        },
        save:    saveRecordsToGitHub,
        message: `v2: Record extension fee for booking ${original_booking_id}`,
      });
      return res.status(201).json({ record: created, booking_id: syntheticBookingId });
    }

    // ── REBUILD ANALYTICS ───────────────────────────────────────────────────
    // Recomputes total gross / stripe fees / net revenue and per-vehicle profit
    // from the revenue_records table.  Requires Supabase.
    if (action === "rebuild_analytics") {
      if (!sb) return res.status(503).json({ error: "Supabase is not configured." });
      const { data: rows, error: rowsErr } = await sb
        .from("revenue_records_effective")
        .select("vehicle_id, gross_amount, stripe_fee, stripe_net, refund_amount, is_cancelled, is_no_show, payment_status");
      if (rowsErr) throw rowsErr;

      let totalGross = 0;
      let totalFees  = 0;
      let totalNet   = 0;
      let totalRefunds = 0;
      const byVehicle  = {};

      for (const r of (rows || [])) {
        if (r.is_cancelled || r.is_no_show) continue;
        const gross   = Number(r.gross_amount  || 0);
        const fee     = r.stripe_fee != null ? Number(r.stripe_fee) : 0;
        const net     = r.stripe_net != null ? Number(r.stripe_net) : gross - fee;
        const refund  = Number(r.refund_amount || 0);

        totalGross   += gross;
        totalFees    += fee;
        totalNet     += net;
        totalRefunds += refund;

        const vid = r.vehicle_id || "unknown";
        if (!byVehicle[vid]) byVehicle[vid] = { vehicle_id: vid, gross: 0, fees: 0, net: 0, refunds: 0, count: 0 };
        byVehicle[vid].gross   += gross;
        byVehicle[vid].fees    += fee;
        byVehicle[vid].net     += net;
        byVehicle[vid].refunds += refund;
        byVehicle[vid].count   += 1;
      }

      const round = (n) => Math.round(n * 100) / 100;
      return res.status(200).json({
        total_gross:   round(totalGross),
        total_fees:    round(totalFees),
        total_net:     round(totalNet),
        total_refunds: round(totalRefunds),
        net_after_refunds: round(totalNet - totalRefunds),
        by_vehicle: Object.values(byVehicle)
          .map((v) => ({ ...v, gross: round(v.gross), fees: round(v.fees), net: round(v.net), refunds: round(v.refunds) }))
          .sort((a, b) => b.net - a.net),
        record_count: (rows || []).length,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-revenue error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
