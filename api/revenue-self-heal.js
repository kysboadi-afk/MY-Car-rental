import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import { persistBooking } from "./_booking-pipeline.js";

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
    paymentIntent: pi,
  };
}

function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

function normalizePhone(phone) {
  if (typeof phone !== "string") return "";
  return phone.trim();
}

function resolveBookingStatus(paymentType) {
  return (paymentType === "reservation_deposit" || paymentType === "slingshot_security_deposit")
    ? "reserved_unpaid"
    : "booked_paid";
}

async function ensureBookingForRevenueRow(sb, stripe, row) {
  const bookingRef = row.booking_id || "";
  if (!bookingRef) throw new Error(`missing booking_id for revenue row ${row.id}`);

  // Caller has already verified the booking is missing; skip the redundant re-lookup
  // and proceed straight to reconstruction.

  const paymentIntentId = row.payment_intent_id || null;
  if (!paymentIntentId) {
    throw new Error(`missing payment_intent_id for missing booking_id=${bookingRef}`);
  }

  const stripeFields = await resolveStripeFinancials(stripe, paymentIntentId);
  const pi = stripeFields.paymentIntent;
  const meta = pi?.metadata || {};
  const amountPaid = stripeFields.grossAmount;
  const fullRentalAmount = Number.parseFloat(meta.full_rental_amount || "");
  const totalPrice = Number.isFinite(fullRentalAmount) && fullRentalAmount > 0
    ? Math.round(fullRentalAmount * 100) / 100
    : Math.max(amountPaid, Number(row.gross_amount || 0));

  const persistResult = await persistBooking({
    bookingId: bookingRef,
    name: meta.renter_name || row.customer_name || "Unknown",
    phone: normalizePhone(meta.renter_phone || row.customer_phone || ""),
    email: normalizeEmail(meta.email || row.customer_email || ""),
    vehicleId: meta.vehicle_id || row.vehicle_id || null,
    vehicleName: meta.vehicle_name || meta.vehicle_id || row.vehicle_id || "unknown",
    pickupDate: meta.pickup_date || row.pickup_date || null,
    pickupTime: meta.pickup_time || "",
    returnDate: meta.return_date || row.return_date || null,
    returnTime: meta.return_time || "",
    status: resolveBookingStatus(meta.payment_type || ""),
    amountPaid,
    totalPrice,
    paymentIntentId,
    paymentMethod: "stripe",
    source: "revenue_self_heal",
    strictPersistence: true,
    stripeCustomerId: pi?.customer || null,
    stripePaymentMethodId: pi?.payment_method || null,
    stripeFee: stripeFields.stripeFee,
    requireStripeFee: true,
    ...(meta.protection_plan_tier ? { protectionPlanTier: meta.protection_plan_tier } : {}),
  });

  if (!persistResult?.ok) {
    throw new Error(`booking reconstruction failed for booking_id=${bookingRef}`);
  }

  const { data: rebuiltBooking, error: rebuiltLookupErr } = await sb
    .from("bookings")
    .select("id, payment_intent_id")
    .eq("booking_ref", bookingRef)
    .maybeSingle();
  if (rebuiltLookupErr) {
    throw new Error(`booking verify failed: ${formatSupabaseError(rebuiltLookupErr)}`);
  }
  if (!rebuiltBooking?.id) {
    throw new Error(`booking still missing after reconstruction for booking_id=${bookingRef}`);
  }

  return rebuiltBooking;
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
    // Fetch rows that need attention:
    //   • Stripe-incomplete: stripe_fee IS NULL or payment_intent_id IS NULL
    //     (need to pull fee data from the Stripe API).
    //   • Booking-unlinked: is_orphan = false but no matching bookings row
    //     (pre-migration 0060 legacy gap; migration pre-flight covers this on
    //     first run, but self-heal acts as an ongoing safety net).
    // Only target non-orphan, non-excluded rows to avoid touching rows that are
    // already flagged as having no real booking.
    const { data: rows, error: queryErr } = await sb
      .from("revenue_records")
      .select("id, booking_id, payment_intent_id, stripe_fee, refund_amount, gross_amount, customer_name, customer_phone, customer_email, vehicle_id, pickup_date, return_date")
      .eq("is_orphan", false)
      .eq("sync_excluded", false)
      .or("stripe_fee.is.null,payment_intent_id.is.null");

    if (queryErr) {
      console.error("revenue-self-heal: query error:", formatSupabaseError(queryErr));
      return res.status(500).json({ error: "Failed to query incomplete revenue rows" });
    }

    for (const row of rows || []) {
      const payloadContext = {
        revenue_id: row.id,
        booking_id: row.booking_id,
        payment_intent_id: row.payment_intent_id || null,
      };

      try {
        if (!row.booking_id) {
          scanned += 1;
          throw new Error(`missing booking_id for revenue row ${row.id}`);
        }

        const { data: bookingByRef, error: bookingLookupErr } = await sb
          .from("bookings")
          .select("id, payment_intent_id")
          .eq("booking_ref", row.booking_id)
          .maybeSingle();
        if (bookingLookupErr) {
          throw new Error(`booking lookup failed: ${formatSupabaseError(bookingLookupErr)}`);
        }

        const bookingMissing = !bookingByRef?.id;
        const revenueIncomplete = row.stripe_fee == null || !row.payment_intent_id;
        if (!bookingMissing && !revenueIncomplete) continue;

        scanned += 1;
        const booking = bookingMissing
          ? await ensureBookingForRevenueRow(sb, stripe, row)
          : bookingByRef;

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
