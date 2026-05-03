// api/backfill-stripe-card.js
// SLYTRANS Fleet Control v2 — Stripe card backfill endpoint.
//
// Recovers stripe_customer_id + stripe_payment_method_id for bookings where
// those columns were wiped to NULL by a bug in the upsert_booking_revenue_atomic
// Postgres RPC (fixed by migration 0117).
//
// The approach:
//   1. Query bookings where payment_method='stripe' AND payment_intent_id IS NOT NULL
//      AND (stripe_customer_id IS NULL OR stripe_payment_method_id IS NULL)
//   2. For each, retrieve the PaymentIntent from Stripe
//   3. Extract customer + payment_method from the PI
//   4. UPDATE the booking row using COALESCE semantics (never overwrite existing values)
//
// POST /api/backfill-stripe-card
// Body: { secret, action: "preview" | "backfill" }
//   "preview"  — returns a list of affected bookings + what would be written (dry-run)
//   "backfill" — executes the updates
//
// Auth: ADMIN_SECRET env var (same as all other admin endpoints).

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

// Bookings in these statuses are still "live" — prioritise them but process all.
const ACTIVE_STATUSES = new Set(["reserved", "pending", "active_rental", "overdue"]);

/**
 * Core backfill logic — shared by the HTTP endpoint and the AI tool.
 *
 * @param {"preview"|"backfill"} action
 * @returns {Promise<object>} result summary
 */
export async function executeBackfillStripeCards(action = "preview") {
  if (action !== "preview" && action !== "backfill") {
    throw new Error("action must be 'preview' or 'backfill'");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured");

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // ── Step 1: Find bookings with missing card fields ──────────────────────────
  const { data: rows, error: fetchErr } = await sb
    .from("bookings")
    .select("id, booking_ref, payment_intent_id, status, stripe_customer_id, stripe_payment_method_id")
    .eq("payment_method", "stripe")
    .not("payment_intent_id", "is", null)
    .or("stripe_customer_id.is.null,stripe_payment_method_id.is.null")
    .order("created_at", { ascending: false });

  if (fetchErr) {
    throw new Error(`Supabase query failed: ${fetchErr.message}`);
  }

  if (!rows || rows.length === 0) {
    return {
      action,
      total: 0,
      recovered: 0,
      skipped: 0,
      unchanged: 0,
      message: "No bookings found with missing Stripe card fields — nothing to backfill.",
      rows: [],
    };
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
      booking_ref:               row.booking_ref,
      payment_intent_id:         piId,
      status:                    row.status,
      existing_stripe_customer_id:       row.stripe_customer_id || null,
      existing_stripe_payment_method_id: row.stripe_payment_method_id || null,
      new_stripe_customer_id:       null,
      new_stripe_payment_method_id: null,
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

    const newCustomerId = pi.customer || null;
    const newPaymentMethodId = pi.payment_method || null;

    result.new_stripe_customer_id = newCustomerId;
    result.new_stripe_payment_method_id = newPaymentMethodId;

    // If Stripe doesn't have these either, nothing to recover.
    if (!newCustomerId && !newPaymentMethodId) {
      result.outcome = "stripe_has_no_card";
      skipped++;
      results.push(result);
      continue;
    }

    // COALESCE: only write a field if the current DB value is NULL/empty.
    const patchCustomerId =
      !row.stripe_customer_id ? (newCustomerId || null) : null;          // null = no change
    const patchPaymentMethodId =
      !row.stripe_payment_method_id ? (newPaymentMethodId || null) : null;

    if (!patchCustomerId && !patchPaymentMethodId) {
      result.outcome = "already_has_both";
      unchanged++;
      results.push(result);
      continue;
    }

    if (action === "preview") {
      result.outcome = "would_patch";
      recovered++;
      results.push(result);
      continue;
    }

    // action === "backfill" — apply the patch.
    const patch = {};
    if (patchCustomerId) patch.stripe_customer_id = patchCustomerId;
    if (patchPaymentMethodId) patch.stripe_payment_method_id = patchPaymentMethodId;

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

  return {
    action,
    total: rows.length,
    recovered,
    skipped,
    unchanged,
    message: action === "preview"
      ? `${recovered} of ${rows.length} bookings would be patched (run with action='backfill' to apply).`
      : `${recovered} of ${rows.length} bookings patched. ${skipped} skipped (Stripe had no card or fetch failed). ${unchanged} already complete.`,
    rows: results,
  };
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
  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is not set." });

  const body = req.body || {};
  const { secret, action = "preview" } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  if (action !== "preview" && action !== "backfill")
    return res.status(400).json({ error: "action must be 'preview' or 'backfill'" });

  try {
    const result = await executeBackfillStripeCards(action);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
