import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

function formatSupabaseError(err) {
  if (!err) return "unknown Supabase error";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(`message=${err.message}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(err);
}

async function resolveStripeFinancials(stripe, paymentIntentId) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge.balance_transaction"],
  });
  const bt = pi?.latest_charge && typeof pi.latest_charge === "object"
    ? pi.latest_charge.balance_transaction
    : null;
  if (!bt || typeof bt !== "object") {
    throw new Error(`missing latest_charge.balance_transaction for PI ${paymentIntentId}`);
  }
  const grossAmount = Number(pi.amount_received || pi.amount || 0) / 100;
  const stripeFee = bt.fee != null ? Number(bt.fee) / 100 : null;
  if (!Number.isFinite(stripeFee)) {
    throw new Error(`invalid stripe fee for PI ${paymentIntentId}`);
  }
  return {
    grossAmount: Math.round(grossAmount * 100) / 100,
    stripeFee: Math.round(stripeFee * 100) / 100,
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "STRIPE_SECRET_KEY is not configured." });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Supabase is not configured." });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

  let scanned = 0;
  let repaired = 0;
  let failed = 0;
  const failures = [];

  try {
    const { data: rows, error: queryErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, stripe_fee, refund_amount")
      .or("stripe_fee.is.null,payment_intent_id.is.null");

    if (queryErr) {
      console.error("revenue-self-heal: query error:", formatSupabaseError(queryErr));
      return res.status(500).json({ error: "Failed to query incomplete revenue rows" });
    }

    for (const row of rows || []) {
      scanned += 1;
      const payloadContext = {
        revenue_id: row.id,
        booking_id: row.booking_id,
        payment_intent_id: row.payment_intent_id || null,
      };

      try {
        const { data: booking, error: bookingErr } = await sb
          .from("bookings")
          .select("id, payment_intent_id")
          .eq("booking_ref", row.booking_id)
          .maybeSingle();
        if (bookingErr) {
          throw new Error(`booking lookup failed: ${formatSupabaseError(bookingErr)}`);
        }
        if (!booking?.id) {
          throw new Error(`missing booking for booking_id=${row.booking_id}`);
        }

        const paymentIntentId = row.payment_intent_id || booking.payment_intent_id || null;
        if (!paymentIntentId) {
          throw new Error(`missing payment_intent_id for booking_id=${row.booking_id}`);
        }

        const stripeFields = await resolveStripeFinancials(stripe, paymentIntentId);
        const updatePayload = {
          gross_amount: stripeFields.grossAmount,
          stripe_fee: stripeFields.stripeFee,
          payment_intent_id: paymentIntentId,
          refund_amount: Number(row.refund_amount || 0),
          updated_at: new Date().toISOString(),
        };

        const { error: updateErr } = await sb
          .from("revenue_records")
          .update(updatePayload)
          .eq("id", row.id);
        if (updateErr) {
          throw new Error(`revenue repair update failed: ${formatSupabaseError(updateErr)}`);
        }

        const { data: verified, error: verifyErr } = await sb
          .from("revenue_records")
          .select("stripe_fee, payment_intent_id")
          .eq("id", row.id)
          .maybeSingle();
        if (verifyErr) {
          throw new Error(`revenue verify failed: ${formatSupabaseError(verifyErr)}`);
        }
        if (!verified || verified.stripe_fee == null || !verified.payment_intent_id) {
          throw new Error(`revenue record incomplete after repair for booking_id=${row.booking_id}`);
        }

        repaired += 1;
      } catch (err) {
        failed += 1;
        console.error("revenue-self-heal: repair failure", {
          error: err?.message || String(err),
          ...payloadContext,
        });
        failures.push({
          ...payloadContext,
          error: err?.message || String(err),
        });
      }
    }

    return res.status(200).json({
      ok: failed === 0,
      scanned,
      repaired,
      failed,
      failures,
    });
  } catch (err) {
    console.error("revenue-self-heal: fatal error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown self-heal failure",
      scanned,
      repaired,
      failed,
      failures,
    });
  }
}
