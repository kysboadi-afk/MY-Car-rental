// api/backfill-phone.js
// SLY RIDES Fleet Control v2 — renter phone backfill endpoint.
//
// Recovers renter_phone (and customer_phone) for bookings where those columns
// are NULL because the rental_extension webhook bug wrote null back to the DB.
//
// The approach:
//   1. Query bookings where renter_phone IS NULL AND payment_intent_id IS NOT NULL.
//   2. For each, retrieve the PaymentIntent from Stripe.
//   3. Extract metadata.renter_phone (written by both create-payment-intent.js and
//      extend-rental.js).
//   4. UPDATE the booking row using COALESCE semantics (never overwrite an
//      existing non-null value).
//
// POST /api/backfill-phone
// Body: { secret, action: "preview" | "backfill" }
//   "preview"  — returns a list of affected bookings + what would be written (dry-run)
//   "backfill" — executes the updates
//
// Auth: ADMIN_SECRET env var (same as all other admin endpoints).

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

const ACTIVE_STATUSES = new Set(["reserved", "pending", "active_rental", "overdue"]);

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is not set." });

  const body = req.body || {};
  const { secret, action = "preview" } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  if (action !== "preview" && action !== "backfill")
    return res.status(400).json({ error: "action must be 'preview' or 'backfill'" });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Supabase is not configured." });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // ── Step 1: Find bookings with null renter_phone ────────────────────────────
  const { data: rows, error: fetchErr } = await sb
    .from("bookings")
    .select("id, booking_ref, payment_intent_id, status, renter_phone, customer_phone")
    .is("renter_phone", null)
    .not("payment_intent_id", "is", null)
    .order("created_at", { ascending: false });

  if (fetchErr) {
    return res.status(500).json({ error: `Supabase query failed: ${fetchErr.message}` });
  }

  if (!rows || rows.length === 0) {
    return res.status(200).json({
      action,
      total: 0,
      recovered: 0,
      skipped: 0,
      unchanged: 0,
      message: "No bookings found with missing renter_phone — nothing to backfill.",
      rows: [],
    });
  }

  // Sort: active bookings first so they are patched even if rate limits hit.
  const sorted = [...rows].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    return aActive - bActive;
  });

  const results = [];
  let recovered = 0;
  let skipped = 0;
  let unchanged = 0;

  // ── Step 2: For each booking, retrieve PI from Stripe ──────────────────────
  for (const row of sorted) {
    const piId = row.payment_intent_id;
    const result = {
      booking_ref:            row.booking_ref,
      payment_intent_id:      piId,
      status:                 row.status,
      existing_renter_phone:  row.renter_phone  || null,
      existing_customer_phone: row.customer_phone || null,
      recovered_phone:        null,
      outcome: "pending",
      error: null,
    };

    // Skip PIs that look synthetic (created by saveWebhookBookingRecord fallback).
    if (!piId || piId.startsWith("wh-")) {
      result.outcome = "skipped_synthetic_pi";
      skipped++;
      results.push(result);
      continue;
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(piId);
    } catch (stripeErr) {
      result.outcome = "stripe_fetch_failed";
      result.error = stripeErr.message;
      skipped++;
      results.push(result);
      continue;
    }

    const metaPhone = (pi.metadata && pi.metadata.renter_phone) || null;

    result.recovered_phone = metaPhone;

    if (!metaPhone) {
      result.outcome = "stripe_has_no_phone";
      skipped++;
      results.push(result);
      continue;
    }

    if (action === "preview") {
      result.outcome = "would_patch";
      recovered++;
      results.push(result);
      continue;
    }

    // action === "backfill" — apply the patch using COALESCE semantics.
    // renter_phone is null (that's our filter). customer_phone may or may not
    // be present; only write it if it is also null.
    const patch = { renter_phone: metaPhone };
    if (!row.customer_phone) patch.customer_phone = metaPhone;

    const { error: updateErr } = await sb
      .from("bookings")
      .update(patch)
      .eq("booking_ref", row.booking_ref);

    if (updateErr) {
      result.outcome = "db_update_failed";
      result.error = updateErr.message;
      skipped++;
    } else {
      result.outcome = "patched";
      recovered++;
    }

    results.push(result);
  }

  return res.status(200).json({
    action,
    total: rows.length,
    recovered,
    skipped,
    unchanged,
    message: action === "preview"
      ? `${recovered} of ${rows.length} bookings would be patched (run with action='backfill' to apply).`
      : `${recovered} of ${rows.length} bookings patched. ${skipped} skipped (no phone in Stripe metadata or fetch failed).`,
    rows: results,
  });
}
