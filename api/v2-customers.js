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

import { createClient } from "@supabase/supabase-js";
import { loadBookings } from "./_bookings.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return createClient(url, key);
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

  let sb;
  try { sb = getSupabase(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (!action || action === "list") {
      let q = sb.from("customers").select("*").order("last_booking_date", { ascending: false, nullsFirst: false });
      if (body.banned  === true  || body.banned  === "true")  q = q.eq("banned",  true);
      if (body.flagged === true  || body.flagged === "true")   q = q.eq("flagged", true);
      if (body.search) {
        q = q.or(`name.ilike.%${body.search}%,phone.ilike.%${body.search}%,email.ilike.%${body.search}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return res.status(200).json({ customers: data || [] });
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (action === "get") {
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const { data, error } = await sb.from("customers").select("*").eq("id", body.id).single();
      if (error) throw error;
      return res.status(200).json({ customer: data });
    }

    // ── UPSERT ──────────────────────────────────────────────────────────────
    if (action === "upsert") {
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
      const { data: bookingsData } = await loadBookings();
      const allBookings = Object.values(bookingsData).flat();

      // Group bookings by phone
      const byPhone = {};
      for (const b of allBookings) {
        const key = (b.phone || "").trim();
        if (!key) continue;
        if (!byPhone[key]) byPhone[key] = { name: b.name, phone: key, email: b.email || null, bookings: [] };
        byPhone[key].bookings.push(b);
      }

      const paidStatuses = new Set(["booked_paid","active_rental","completed_rental"]);
      const upserts = [];
      for (const [phone, c] of Object.entries(byPhone)) {
        const paidBookings = c.bookings.filter((b) => paidStatuses.has(b.status));
        const pickupDates  = c.bookings.map((b) => b.pickupDate).filter(Boolean).sort();
        const spent = paidBookings.reduce((s, b) => s + (b.amountPaid || 0), 0);
        upserts.push({
          name:               c.name || "Unknown",
          phone,
          email:              c.email,
          total_bookings:     c.bookings.length,
          total_spent:        Math.round(spent * 100) / 100,
          first_booking_date: pickupDates[0]  || null,
          last_booking_date:  pickupDates[pickupDates.length - 1] || null,
          updated_at:         new Date().toISOString(),
        });
      }

      if (upserts.length > 0) {
        const { error } = await sb.from("customers")
          .upsert(upserts, { onConflict: "phone", ignoreDuplicates: false });
        if (error) throw error;
      }

      return res.status(200).json({ synced: upserts.length, message: `Synced ${upserts.length} customers from bookings` });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("v2-customers error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
