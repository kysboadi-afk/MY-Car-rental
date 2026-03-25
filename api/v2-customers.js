// api/v2-customers.js
// SLYTRANS Fleet Control v2 — Customer management endpoint.
// Customers are derived from booking history and stored additively in Supabase.
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
//   • WRITE actions (upsert, update, sync) return a clear 503 when Supabase is unavailable.

import { getSupabaseAdmin } from "./_supabase.js";
import { loadBookings } from "./_bookings.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/** Returns the Supabase client or null if not configured. */
function getSupabase() {
  return getSupabaseAdmin();
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
      // Return empty state immediately when Supabase is not configured
      if (!sb) return res.status(200).json({ customers: [] });
      try {
        let q = sb.from("customers").select("*").order("last_booking_date", { ascending: false, nullsFirst: false });
        if (body.banned  === true  || body.banned  === "true")  q = q.eq("banned",  true);
        if (body.flagged === true  || body.flagged === "true")   q = q.eq("flagged", true);
        if (body.search) {
          q = q.or(`name.ilike.%${body.search}%,phone.ilike.%${body.search}%,email.ilike.%${body.search}%`);
        }
        const { data, error } = await q;
        if (error) {
          console.error("v2-customers list error:", error.message);
          return res.status(200).json({ customers: [] });
        }
        return res.status(200).json({ customers: data || [] });
      } catch (qErr) {
        console.error("v2-customers list query error:", qErr);
        return res.status(200).json({ customers: [] });
      }
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured" });
      const { data, error } = await sb.from("customers").select("*").eq("id", body.id).single();
      if (error) throw error;
      return res.status(200).json({ customer: data });
    }

    // ── UPSERT ──────────────────────────────────────────────────────────────
    if (action === "upsert") {
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot upsert customer" });
      const { name, phone, email } = body;
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!phone || !String(phone).trim()) return res.status(400).json({ error: "phone is required for upsert" });

      const record = {
        name: String(name).trim(),
        phone:  phone ? String(phone).trim()  : null,
        email:  email ? String(email).trim()  : null,
        notes:  body.notes || null,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await sb.from("customers")
        .upsert(record, { onConflict: "phone", ignoreDuplicates: false })
        .select().single();
      if (error) throw error;
      return res.status(200).json({ customer: data });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === "update") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot update customer" });
      const allowed = ["flagged","banned","flag_reason","ban_reason","notes","name","phone","email"];
      const updates = { updated_at: new Date().toISOString() };
      for (const f of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.updates || {}, f)) updates[f] = (body.updates)[f];
      }
      const { data, error } = await sb.from("customers").update(updates).eq("id", body.id).select().single();
      if (error) throw error;
      return res.status(200).json({ customer: data });
    }

    // ── SYNC — rebuild customer table from bookings.json ───────────────────
    if (action === "sync") {
      if (!sb) return res.status(503).json({ error: "Supabase not configured — cannot sync customers" });
      const { data: bookingsData } = await loadBookings();
      const allBookings = Object.values(bookingsData).flat();

      // Group bookings by a stable key:
      //   • phone-bearing bookings → keyed by phone (exact dedup via unique index)
      //   • phone-less bookings    → keyed by "name:<lowercase name>" (best-effort dedup by name)
      const byKey = {};
      for (const b of allBookings) {
        const phone = (b.phone || "").trim();
        const name  = (b.name  || "").trim();
        if (!phone && !name) continue; // skip if no identity at all
        const key = phone || `name:${name.toLowerCase()}`;
        if (!byKey[key]) byKey[key] = { name, phone: phone || null, email: b.email || null, bookings: [] };
        // Keep the most recent name / email for this key
        if (b.name)  byKey[key].name  = b.name;
        if (b.email) byKey[key].email = b.email;
        byKey[key].bookings.push(b);
      }

      const paidStatuses = new Set(["booked_paid", "active_rental", "completed_rental"]);

      // Split into phone-bearing (batch-upsertable) and phone-less (sequential check-then-upsert)
      const phoneUpserts = [];
      const nameFallbacks = [];

      for (const [, c] of Object.entries(byKey)) {
        const paidBookings = c.bookings.filter((b) => paidStatuses.has(b.status));
        const pickupDates  = c.bookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const spent = paidBookings.reduce((s, b) => s + (Number(b.amountPaid || 0)), 0);
        const record = {
          name:               c.name  || "Unknown",
          email:              c.email || null,
          total_bookings:     c.bookings.length,
          total_spent:        Math.round(spent * 100) / 100,
          first_booking_date: pickupDates[0]  || null,
          last_booking_date:  pickupDates[pickupDates.length - 1] || null,
          updated_at:         new Date().toISOString(),
        };
        if (c.phone) {
          phoneUpserts.push({ ...record, phone: c.phone });
        } else {
          nameFallbacks.push(record); // will be inserted/updated below without phone
        }
      }

      let synced = 0;

      // Batch upsert customers that have a phone number (conflict-safe via unique index)
      if (phoneUpserts.length > 0) {
        const { error } = await sb.from("customers")
          .upsert(phoneUpserts, { onConflict: "phone", ignoreDuplicates: false });
        if (error) throw error;
        synced += phoneUpserts.length;
      }

      // For phone-less customers: check by name + null phone, then update-or-insert
      for (const record of nameFallbacks) {
        try {
          const { data: existing } = await sb
            .from("customers")
            .select("id")
            .eq("name", record.name)
            .is("phone", null)
            .maybeSingle();
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

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-customers error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
