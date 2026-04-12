// api/v2-customers.js
// SLYTRANS Fleet Control v2 — Customer management endpoint.
// Customers are derived from booking history and stored additively in Supabase.
// Falls back to GitHub (customers.json) when Supabase is unavailable or tables missing.
//
// POST /api/v2-customers
// Actions:
//   list    — { secret, action:"list", banned?, flagged?, search? }
//   get     — { secret, action:"get", id }
//   upsert  — { secret, action:"upsert", phone, name, email?, ...fields } (create or update by phone)
//   update  — { secret, action:"update", id, updates:{flagged?, banned?, flag_reason?, ban_reason?, notes?} }
//   sync    — { secret, action:"sync" } — build/refresh customer table from bookings.json
//
// Error contract:
//   • READ actions (list, get) return empty state when Supabase is not configured
//     or the table does not yet exist, so the admin panel never crashes.
//   • WRITE actions (upsert, update, sync) fall back to GitHub when Supabase is
//     unavailable or the customers table is missing.

import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "./_supabase.js";
import { loadBookings, normalizePhone } from "./_bookings.js";
import { adminErrorMessage, isSchemaError } from "./_error-helpers.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const GITHUB_REPO     = process.env.GITHUB_REPO || "kysboadi-afk/SLY-RIDES";
const CUSTOMERS_FILE  = "customers.json";

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

async function loadCustomersFromGitHub() {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CUSTOMERS_FILE}`;
  const resp   = await fetch(apiUrl, { headers: ghHeaders() });
  if (!resp.ok) {
    if (resp.status === 404) return { data: [], sha: null };
    return { data: [], sha: null };
  }
  const file = await resp.json();
  let data = [];
  try {
    const parsed = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8"));
    if (Array.isArray(parsed)) data = parsed;
  } catch { data = []; }
  return { data, sha: file.sha };
}

async function saveCustomersToGitHub(data, sha, message) {
  if (!process.env.GITHUB_TOKEN) {
    console.warn("v2-customers: GITHUB_TOKEN not set — customers.json will not be updated");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${CUSTOMERS_FILE}`;
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
    throw new Error(`GitHub PUT customers.json failed: ${resp.status} ${text}`);
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
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });

  const body = req.body || {};
  const { secret, action } = body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const sb = getSupabase();

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      if (sb) {
        try {
          let q = sb.from("customers").select("*").order("last_booking_date", { ascending: false, nullsFirst: false });
          if (body.banned  === true  || body.banned  === "true")  q = q.eq("banned",  true);
          if (body.flagged === true  || body.flagged === "true")   q = q.eq("flagged", true);
          if (body.search) {
            q = q.or(`name.ilike.%${body.search}%,phone.ilike.%${body.search}%,email.ilike.%${body.search}%`);
          }
          const { data, error } = await q;
          if (!error) return res.status(200).json({ customers: data || [] });
          console.error("v2-customers list error:", error.message);
        } catch (qErr) {
          console.error("v2-customers list query error:", qErr);
        }
      }
      // GitHub fallback
      const { data: ghCustomers } = await loadCustomersFromGitHub();
      let customers = ghCustomers;
      if (body.banned  === true  || body.banned  === "true")  customers = customers.filter((c) => c.banned);
      if (body.flagged === true  || body.flagged === "true")  customers = customers.filter((c) => c.flagged);
      if (body.search) {
        const s = String(body.search).toLowerCase();
        customers = customers.filter((c) =>
          (c.name  || "").toLowerCase().includes(s) ||
          (c.phone || "").toLowerCase().includes(s) ||
          (c.email || "").toLowerCase().includes(s)
        );
      }
      return res.status(200).json({ customers });
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (sb) {
        const { data, error } = await sb.from("customers").select("*").eq("id", body.id).single();
        if (!error) return res.status(200).json({ customer: data });
        if (!isSchemaError(error)) throw error;
      }
      // GitHub fallback
      const { data: ghCustomers } = await loadCustomersFromGitHub();
      const found = ghCustomers.find((c) => c.id === body.id);
      if (!found) return res.status(404).json({ error: "Customer not found" });
      return res.status(200).json({ customer: found });
    }

    // ── UPSERT ──────────────────────────────────────────────────────────────
    if (action === "upsert") {
      const { name, phone, email } = body;
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!phone || !String(phone).trim()) return res.status(400).json({ error: "phone is required for upsert" });

      const record = {
        name: String(name).trim(),
        phone:      normalizePhone(String(phone).trim()),
        email:      email ? String(email).trim() : null,
        notes:      body.notes || null,
        updated_at: new Date().toISOString(),
      };

      if (sb) {
        try {
          const { error: upsertErr } = await sb.from("customers")
            .upsert(record, { onConflict: "phone", ignoreDuplicates: false });
          if (upsertErr) {
            if (!isSchemaError(upsertErr)) throw upsertErr;
            console.warn("v2-customers upsert: customers table missing, falling back to GitHub");
          } else {
            const { data, error: fetchErr } = await sb.from("customers")
              .select("*").eq("phone", record.phone).single();
            if (!fetchErr) return res.status(200).json({ customer: data });
            if (!isSchemaError(fetchErr)) throw fetchErr;
          }
        } catch (sbErr) {
          if (!isSchemaError(sbErr)) throw sbErr;
          console.warn("v2-customers upsert: customers table missing, falling back to GitHub");
        }
      }
      // GitHub fallback
      let upserted;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((c) => c.phone === record.phone);
          if (idx !== -1) {
            Object.assign(data[idx], record);
            upserted = data[idx];
          } else {
            const newCustomer = { id: randomUUID(), ...record, created_at: new Date().toISOString() };
            data.push(newCustomer);
            upserted = newCustomer;
          }
        },
        save:    saveCustomersToGitHub,
        message: `v2: Upsert customer ${record.phone}`,
      });
      return res.status(200).json({ customer: upserted });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const allowed = ["flagged","banned","flag_reason","ban_reason","notes","name","full_name","phone","email","driver_license","risk_flag"];
      const updates = { updated_at: new Date().toISOString() };
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      if (updates.risk_flag !== undefined && updates.risk_flag !== null &&
          !["low","medium","high"].includes(updates.risk_flag)) {
        return res.status(400).json({ error: "risk_flag must be low, medium, or high" });
      }

      if (sb) {
        const { data, error } = await sb.from("customers").update(updates).eq("id", body.id).select().single();
        if (!error) return res.status(200).json({ customer: data });
        if (!isSchemaError(error)) throw error;
        console.warn("v2-customers update: customers table missing, falling back to GitHub");
      }
      // GitHub fallback
      let updated;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          const idx = data.findIndex((c) => c.id === body.id);
          if (idx === -1) throw new Error("Customer not found");
          Object.assign(data[idx], updates);
          updated = data[idx];
        },
        save:    saveCustomersToGitHub,
        message: `v2: Update customer ${body.id}`,
      });
      return res.status(200).json({ customer: updated });
    }

    // ── SYNC — rebuild customer table from revenue_records (Supabase) or bookings.json ───────────────────
    if (action === "sync") {
      // When Supabase is available, compute accurate customer stats directly from
      // revenue_records (the authoritative financial ledger) rather than bookings.json.
      // This prevents the double-counting bug where incremental autoUpsertCustomer
      // calls accumulate incorrect totals over time.
      if (sb) {
        try {
          const { data: rrData, error: rrError } = await sb
            .from("revenue_records")
            .select("customer_phone, customer_name, customer_email, gross_amount, refund_amount, is_cancelled, pickup_date");

          if (!rrError && Array.isArray(rrData) && rrData.length > 0) {
            // Group revenue records by normalized customer_phone to prevent
            // duplicate customer rows caused by inconsistent phone formatting
            // (e.g. "3463814616" vs "+13463814616").
            const byPhone = {};
            for (const r of rrData) {
              if (!r.customer_phone) continue;
              const normPhone = normalizePhone(r.customer_phone);
              if (!byPhone[normPhone]) {
                byPhone[normPhone] = { name: r.customer_name || "Unknown", email: r.customer_email || null, records: [] };
              }
              if (r.customer_name) byPhone[normPhone].name  = r.customer_name;
              if (r.customer_email) byPhone[normPhone].email = r.customer_email;
              byPhone[normPhone].records.push(r);
            }

            const upserts = [];
            for (const [phone, cust] of Object.entries(byPhone)) {
              const valid       = cust.records.filter((r) => !r.is_cancelled);
              const totalSpent  = Math.round(valid.reduce((s, r) => s + Number(r.gross_amount || 0) - Number(r.refund_amount || 0), 0) * 100) / 100;
              const pickupDates = cust.records.map((r) => r.pickup_date).filter(Boolean).sort();
              upserts.push({
                name:               cust.name,
                phone,
                email:              cust.email,
                total_bookings:     valid.length,
                total_spent:        totalSpent,
                first_booking_date: pickupDates[0] || null,
                last_booking_date:  pickupDates[pickupDates.length - 1] || null,
                updated_at:         new Date().toISOString(),
              });
            }

            if (upserts.length > 0) {
              const { error: upsertErr } = await sb.from("customers")
                .upsert(upserts, { onConflict: "phone", ignoreDuplicates: false });
              if (upsertErr) {
                if (!isSchemaError(upsertErr)) throw upsertErr;
                console.warn("v2-customers sync: customers table missing");
              } else {
                // Clean up stale duplicate records whose phone was not already
                // in normalized form (e.g. "3463814616" now that "+13463814616"
                // is the canonical record). Only query customers with non-normalized
                // phones (those not already in E.164 / "+1…" format) to keep the
                // query small.
                const normalizedPhones = new Set(upserts.map((u) => u.phone));
                const { data: nonNormCustomers } = await sb
                  .from("customers")
                  .select("id, phone")
                  .not("phone", "is", null)
                  .not("phone", "like", "+%");
                if (nonNormCustomers) {
                  const staleIds = nonNormCustomers
                    .filter((c) => normalizedPhones.has(normalizePhone(c.phone)))
                    .map((c) => c.id);
                  if (staleIds.length > 0) {
                    await sb.from("customers").delete().in("id", staleIds);
                    console.log(`v2-customers sync: removed ${staleIds.length} non-normalized duplicate customer(s)`);
                  }
                }
                return res.status(200).json({ synced: upserts.length, message: `Synced ${upserts.length} customers from revenue records` });
              }
            }
          } else if (rrError) {
            console.warn("v2-customers sync: revenue_records query failed:", rrError.message);
          }
        } catch (sbSyncErr) {
          console.warn("v2-customers sync: Supabase sync error, falling back to bookings.json:", sbSyncErr.message);
        }
      }

      // Fallback: compute stats from bookings.json
      const { data: bookingsData } = await loadBookings();
      const allBookingsList = Object.values(bookingsData).flat();

      // Group bookings by phone or name
      const byKey = {};
      for (const b of allBookingsList) {
        const rawPhone = (b.phone || "").trim();
        const phone    = rawPhone ? normalizePhone(rawPhone) : "";
        const name     = (b.name  || "").trim();
        if (!phone && !name) continue;
        const key = phone || `name:${name.toLowerCase()}`;
        if (!byKey[key]) byKey[key] = { name, phone: phone || null, email: b.email || null, bookings: [] };
        if (b.name)  byKey[key].name  = b.name;
        if (b.email) byKey[key].email = b.email;
        byKey[key].bookings.push(b);
      }

      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

      const phoneUpserts  = [];
      const nameFallbacks = [];

      for (const [, c] of Object.entries(byKey)) {
        const paidBookings   = c.bookings.filter((b) => paidStatuses.has(b.status));
        const noShowBookings = c.bookings.filter((b) => b.isNoShow === true || b.no_show === true);
        const pickupDates    = c.bookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const spent = paidBookings.reduce((s, b) => s + (Number(b.amountPaid || 0)), 0);
        const record = {
          name:               c.name  || "Unknown",
          email:              c.email || null,
          total_bookings:     paidBookings.length,
          total_spent:        Math.round(spent * 100) / 100,
          no_show_count:      noShowBookings.length,
          first_booking_date: pickupDates[0]  || null,
          last_booking_date:  pickupDates[pickupDates.length - 1] || null,
          updated_at:         new Date().toISOString(),
        };
        if (c.phone) {
          phoneUpserts.push({ ...record, phone: c.phone });
        } else {
          nameFallbacks.push(record);
        }
      }

      if (sb) {
        let schemaError = false;
        let synced = 0;

        if (phoneUpserts.length > 0) {
          const { error } = await sb.from("customers")
            .upsert(phoneUpserts, { onConflict: "phone", ignoreDuplicates: false });
          if (error) {
            if (!isSchemaError(error)) throw error;
            schemaError = true;
          } else {
            synced += phoneUpserts.length;
          }
        }

        if (!schemaError) {
          for (const record of nameFallbacks) {
            try {
              const { data: existing } = await sb.from("customers")
                .select("id").eq("name", record.name).is("phone", null).maybeSingle();
              if (existing) {
                const { error } = await sb.from("customers").update(record).eq("id", existing.id);
                if (error) { console.error("v2-customers sync name-update error:", error.message); continue; }
              } else {
                const { error } = await sb.from("customers").insert({ ...record, phone: null });
                if (error) { console.error("v2-customers sync name-insert error:", error.message); continue; }
              }
              synced++;
            } catch (nameErr) {
              console.error("v2-customers sync name-fallback error:", nameErr.message);
            }
          }
          return res.status(200).json({ synced, message: `Synced ${synced} customers from bookings` });
        }
        console.warn("v2-customers sync: customers table missing, falling back to GitHub");
      }

      // GitHub fallback for sync
      const allRecords = [...phoneUpserts, ...nameFallbacks.map((r) => ({ ...r, phone: null }))];
      let synced = 0;
      await updateJsonFileWithRetry({
        load:    loadCustomersFromGitHub,
        apply:   (data) => {
          synced = 0;
          for (const r of allRecords) {
            const idx = r.phone
              ? data.findIndex((c) => c.phone === r.phone)
              : data.findIndex((c) => c.name === r.name && !c.phone);
            if (idx !== -1) {
              Object.assign(data[idx], r);
            } else {
              data.push({ id: randomUUID(), ...r, created_at: new Date().toISOString() });
            }
            synced++;
          }
        },
        save:    saveCustomersToGitHub,
        message: `v2: Sync ${allRecords.length} customers from bookings`,
      });
      return res.status(200).json({ synced, message: `Synced ${synced} customers from bookings` });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-customers error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
