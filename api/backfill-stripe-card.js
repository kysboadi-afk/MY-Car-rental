// api/backfill-stripe-card.js
// SLYTRANS Fleet Control v2 — Stripe card backfill endpoint.
//
// Phase 1 — Main payment cards:
//   Recovers stripe_customer_id + stripe_payment_method_id for bookings where
//   those columns were wiped to NULL by a bug in the upsert_booking_revenue_atomic
//   Postgres RPC (fixed by migration 0117).
//
//   Approach:
//     1. Query bookings where payment_method='stripe' AND payment_intent_id IS NOT NULL
//        AND (stripe_customer_id IS NULL OR stripe_payment_method_id IS NULL)
//     2. For each, retrieve the PaymentIntent from Stripe
//     3. Extract customer + payment_method from the PI
//     4. UPDATE the booking row using COALESCE semantics (never overwrite existing values)
//
// Phase 2 — Extension payment cards:
//   Recovers extension_stripe_customer_id + extension_stripe_payment_method_id for
//   bookings that have at least one paid extension (booking_extensions rows) but
//   were booked before migration 0127 added these columns (so the webhook never
//   had a chance to write them).
//
//   Approach:
//     1. Query bookings with null extension card fields that have booking_extensions rows
//     2. For each, pick the most-recent extension PI from booking_extensions
//     3. Retrieve that PaymentIntent from Stripe
//     4. UPDATE using COALESCE semantics
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
 * @param {string|null} [bookingRef]  Optional: limit backfill to a single booking ref.
 * @returns {Promise<object>} result summary
 */
export async function executeBackfillStripeCards(action = "preview", bookingRef = null) {
  if (action !== "preview" && action !== "backfill") {
    throw new Error("action must be 'preview' or 'backfill'");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Supabase is not configured");

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // ── Phase 1: Recover main payment card fields ────────────────────────────────
  const phase1 = await _backfillMainCards(sb, stripe, action, bookingRef);

  // ── Phase 2: Recover extension payment card fields ───────────────────────────
  const phase2 = await _backfillExtensionCards(sb, stripe, action, bookingRef);

  const totalRows   = phase1.total   + phase2.total;
  const totalRecov  = phase1.recovered + phase2.recovered;
  const totalSkip   = phase1.skipped  + phase2.skipped;
  const totalUnch   = phase1.unchanged + phase2.unchanged;

  return {
    action,
    total:     totalRows,
    recovered: totalRecov,
    skipped:   totalSkip,
    unchanged: totalUnch,
    message: action === "preview"
      ? `${totalRecov} of ${totalRows} bookings would be patched (run with action='backfill' to apply). ` +
        `Phase 1 (main card): ${phase1.recovered}/${phase1.total}. ` +
        `Phase 2 (extension card): ${phase2.recovered}/${phase2.total}.`
      : `${totalRecov} of ${totalRows} bookings patched. ${totalSkip} skipped. ${totalUnch} already complete. ` +
        `Phase 1 (main card): ${phase1.recovered}/${phase1.total}. ` +
        `Phase 2 (extension card): ${phase2.recovered}/${phase2.total}.`,
    phase1,
    phase2,
  };
}

// ── Phase 1 helper ────────────────────────────────────────────────────────────

async function _backfillMainCards(sb, stripe, action, bookingRef = null) {
  let q = sb
    .from("bookings")
    .select("id, booking_ref, payment_intent_id, status, stripe_customer_id, stripe_payment_method_id")
    .eq("payment_method", "stripe")
    .not("payment_intent_id", "is", null)
    .or("stripe_customer_id.is.null,stripe_payment_method_id.is.null")
    .order("created_at", { ascending: false });

  if (bookingRef) q = q.eq("booking_ref", bookingRef);

  const { data: rows, error: fetchErr } = await q;

  if (fetchErr) {
    throw new Error(`Phase 1 Supabase query failed: ${fetchErr.message}`);
  }

  if (!rows || rows.length === 0) {
    return { total: 0, recovered: 0, skipped: 0, unchanged: 0, rows: [] };
  }

  // Sort: active bookings first.
  const sorted = [...rows].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    return aActive - bActive;
  });

  const results = [];
  let recovered = 0, skipped = 0, unchanged = 0;

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

    if (!newCustomerId && !newPaymentMethodId) {
      result.outcome = "stripe_has_no_card";
      skipped++;
      results.push(result);
      continue;
    }

    const patchCustomerId      = !row.stripe_customer_id      ? (newCustomerId || null) : null;
    const patchPaymentMethodId = !row.stripe_payment_method_id ? (newPaymentMethodId || null) : null;

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

    const patch = {};
    if (patchCustomerId)      patch.stripe_customer_id      = patchCustomerId;
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
    total: rows.length,
    recovered,
    skipped,
    unchanged,
    message: action === "preview"
      ? `${recovered} of ${rows.length} bookings would be patched.`
      : `${recovered} of ${rows.length} bookings patched. ${skipped} skipped. ${unchanged} already complete.`,
    rows: results,
  };
}

// ── Phase 2 helper ────────────────────────────────────────────────────────────
// Recover extension_stripe_customer_id + extension_stripe_payment_method_id by
// looking up each booking's most-recent extension PaymentIntent from the
// booking_extensions table and retrieving card info from Stripe.

async function _backfillExtensionCards(sb, stripe, action, bookingRef = null) {
  // First, find all booking_refs that have at least one extension in booking_extensions.
  let extRefQuery = sb
    .from("booking_extensions")
    .select("booking_id")
    .not("payment_intent_id", "is", null);

  if (bookingRef) extRefQuery = extRefQuery.eq("booking_id", bookingRef);

  const { data: extRefRows, error: extRefErr } = await extRefQuery;
  if (extRefErr) {
    // If the table doesn't exist yet (migration not yet applied), skip Phase 2 gracefully.
    const msg = extRefErr.message || "";
    if (msg.includes("schema cache") || msg.includes("does not exist") || msg.includes("relation") || msg.includes("booking_extensions")) {
      return {
        total: 0, recovered: 0, skipped: 0, unchanged: 0, rows: [],
        message: "Phase 2 skipped: booking_extensions table not yet available in this environment.",
      };
    }
    throw new Error(`Phase 2 booking_extensions pre-query failed: ${msg}`);
  }

  const refsWithExtensions = [...new Set((extRefRows || []).map((r) => r.booking_id))];
  if (refsWithExtensions.length === 0) {
    return { total: 0, recovered: 0, skipped: 0, unchanged: 0, rows: [] };
  }

  // Find bookings that have at least one extension but are missing extension card fields.
  let q = sb
    .from("bookings")
    .select("id, booking_ref, status, extension_stripe_customer_id, extension_stripe_payment_method_id")
    .eq("payment_method", "stripe")
    .in("booking_ref", refsWithExtensions)
    .or("extension_stripe_customer_id.is.null,extension_stripe_payment_method_id.is.null")
    .order("created_at", { ascending: false });

  if (bookingRef) q = q.eq("booking_ref", bookingRef);

  const { data: rows, error: fetchErr } = await q;

  if (fetchErr) {
    throw new Error(`Phase 2 Supabase query failed: ${fetchErr.message}`);
  }

  if (!rows || rows.length === 0) {
    return { total: 0, recovered: 0, skipped: 0, unchanged: 0, rows: [] };
  }

  // For each booking, fetch the most-recent extension PI from booking_extensions.
  const bookingRefs = rows.map((r) => r.booking_ref);
  const { data: extRows, error: extErr } = await sb
    .from("booking_extensions")
    .select("booking_id, payment_intent_id, created_at")
    .in("booking_id", bookingRefs)
    .not("payment_intent_id", "is", null)
    .order("created_at", { ascending: false });

  if (extErr) {
    throw new Error(`Phase 2 booking_extensions query failed: ${extErr.message}`);
  }

  // Build a map: booking_ref → most-recent extension PI ID.
  const latestExtPi = new Map();
  for (const ext of extRows || []) {
    if (!latestExtPi.has(ext.booking_id)) {
      latestExtPi.set(ext.booking_id, ext.payment_intent_id);
    }
  }

  // Sort: active bookings first.
  const sorted = [...rows].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    return aActive - bActive;
  });

  const results = [];
  let recovered = 0, skipped = 0, unchanged = 0;

  for (const row of sorted) {
    const piId = latestExtPi.get(row.booking_ref) || null;
    const result = {
      booking_ref:                            row.booking_ref,
      extension_payment_intent_id:            piId,
      status:                                 row.status,
      existing_extension_stripe_customer_id:       row.extension_stripe_customer_id || null,
      existing_extension_stripe_payment_method_id: row.extension_stripe_payment_method_id || null,
      new_extension_stripe_customer_id:       null,
      new_extension_stripe_payment_method_id: null,
      outcome: "pending",
      error: null,
    };

    if (!piId || piId.startsWith("wh-")) {
      result.outcome = "skipped_no_extension_pi";
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

    result.new_extension_stripe_customer_id = newCustomerId;
    result.new_extension_stripe_payment_method_id = newPaymentMethodId;

    if (!newCustomerId && !newPaymentMethodId) {
      result.outcome = "stripe_has_no_card";
      skipped++;
      results.push(result);
      continue;
    }

    const patchCustomerId      = !row.extension_stripe_customer_id      ? (newCustomerId || null) : null;
    const patchPaymentMethodId = !row.extension_stripe_payment_method_id ? (newPaymentMethodId || null) : null;

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

    const patch = {};
    if (patchCustomerId)      patch.extension_stripe_customer_id      = patchCustomerId;
    if (patchPaymentMethodId) patch.extension_stripe_payment_method_id = patchPaymentMethodId;

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
    total: rows.length,
    recovered,
    skipped,
    unchanged,
    message: action === "preview"
      ? `${recovered} of ${rows.length} bookings would be patched.`
      : `${recovered} of ${rows.length} bookings patched. ${skipped} skipped. ${unchanged} already complete.`,
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
  const { secret, action = "preview", bookingRef = null } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  if (action !== "preview" && action !== "backfill")
    return res.status(400).json({ error: "action must be 'preview' or 'backfill'" });

  try {
    const result = await executeBackfillStripeCards(action, bookingRef || null);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
