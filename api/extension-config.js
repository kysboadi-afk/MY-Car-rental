// api/extension-config.js
// Vercel serverless function — retrieves Stripe PaymentIntent details for a
// rental extension, so balance.html can display the amount and context to the
// customer before they pay.
//
// Called via GET by balance.html when ext=1 is present in the URL.
//
// Query parameters:
//   piId — Stripe PaymentIntent ID (e.g. pi_3xxxxxxxxxxxxx)
//
// Returns JSON:
//   { publishableKey, amount, extensionLabel, vehicleName, vehicleId, renterName }
//
// Required environment variables:
//   STRIPE_SECRET_KEY      — used server-side to retrieve the PaymentIntent
//   STRIPE_PUBLISHABLE_KEY — returned to the client so Stripe.js can be initialized

import Stripe from "stripe";
import { getSupabaseAdmin } from "./_supabase.js";
import { getLedgerSummary } from "./_renter-balance-ledger.js";
import { computePaymentPlanProgress } from "./_payment-plan-reconcile.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com", "https://slyslingshotrentals.com", "https://www.slyslingshotrentals.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("extension-config: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("extension-config: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  const { piId } = req.query;
  if (!piId || !piId.startsWith("pi_")) {
    return res.status(400).json({ error: "Invalid or missing payment intent ID." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const pi = await stripe.paymentIntents.retrieve(piId);

    if ((pi.metadata || {}).payment_type !== "rental_extension" && (pi.metadata || {}).type !== "rental_extension") {
      return res.status(400).json({ error: "This link is not valid for a rental extension." });
    }

    if (pi.status === "succeeded") {
      return res.status(400).json({ error: "This extension has already been paid. Your rental time has been updated." });
    }

    if (pi.status === "canceled") {
      return res.status(400).json({ error: "This extension request has expired. Please reply EXTEND to start a new one." });
    }

    const extensionTotalAmount = Number((pi.metadata || {}).extension_total_amount);
    const extensionAmountPaid = Number((pi.metadata || {}).extension_amount_paid);
    const resolvedAmountPaid = Number.isFinite(extensionAmountPaid) && extensionAmountPaid > 0
      ? extensionAmountPaid
      : (pi.amount / 100);
    const resolvedExtensionTotal = Number.isFinite(extensionTotalAmount) && extensionTotalAmount > 0
      ? extensionTotalAmount
      : resolvedAmountPaid;
    const metadataRemaining = Number((pi.metadata || {}).extension_remaining_balance);
    const resolvedRemaining = Number.isFinite(metadataRemaining) && metadataRemaining >= 0
      ? metadataRemaining
      : Math.max(0, resolvedExtensionTotal - resolvedAmountPaid);
    const resolvedStatus = ((pi.metadata || {}).extension_payment_status || (resolvedRemaining > 0 ? "partially_paid" : "paid")).toLowerCase();
    const bookingRef = String((pi.metadata || {}).original_booking_id || (pi.metadata || {}).booking_id || "").trim();

    let currentOutstandingBalance = 0;
    let overdueAmount = 0;
    let paymentPlanRemainingBalance = 0;
    let paymentPlanOverdueAmount = 0;
    let paymentPlanNextDueDate = null;
    let hasActivePaymentPlan = false;

    if (bookingRef) {
      const sb = getSupabaseAdmin();
      if (sb) {
        try {
          const summary = await getLedgerSummary(sb, { bookingId: bookingRef });
          currentOutstandingBalance = Number(summary?.remaining_balance || 0);
        } catch (_) {
          currentOutstandingBalance = 0;
        }
        try {
          const progress = await computePaymentPlanProgress(sb, { bookingId: bookingRef });
          hasActivePaymentPlan = !!progress?.has_active_plan;
          paymentPlanRemainingBalance = Number(progress?.remaining_balance || 0);
          paymentPlanOverdueAmount = Number(progress?.overdue_amount || 0);
          paymentPlanNextDueDate = progress?.next_due_date || null;
          overdueAmount = paymentPlanOverdueAmount;
        } catch (_) {
          hasActivePaymentPlan = false;
        }
      }
    }

    const totalOwedBeforeExtension = Math.max(
      0,
      Number(currentOutstandingBalance || 0)
    );

    return res.status(200).json({
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      amount:         resolvedAmountPaid.toFixed(2),
      extensionTotal: resolvedExtensionTotal.toFixed(2),
      amountPaid:     resolvedAmountPaid.toFixed(2),
      remainingBalance: resolvedRemaining.toFixed(2),
      extensionPaymentStatus: resolvedStatus,
      extensionLabel: pi.metadata.extension_label || "",
      vehicleName:    pi.metadata.vehicle_name    || pi.metadata.vehicle_id || "",
      vehicleId:      pi.metadata.vehicle_id      || "",
      renterName:     pi.metadata.renter_name     || "",
      bookingId:      bookingRef || "",
      currentOutstandingBalance: Number(currentOutstandingBalance || 0).toFixed(2),
      overdueAmount: Number(overdueAmount || 0).toFixed(2),
      paymentPlanRemainingBalance: Number(paymentPlanRemainingBalance || 0).toFixed(2),
      paymentPlanOverdueAmount: Number(paymentPlanOverdueAmount || 0).toFixed(2),
      paymentPlanNextDueDate: paymentPlanNextDueDate || null,
      hasActivePaymentPlan,
      totalOwedBeforeExtension: Number(totalOwedBeforeExtension || 0).toFixed(2),
    });
  } catch (err) {
    console.error("extension-config: Stripe error:", err.message);
    return res.status(500).json({ error: "Failed to load extension details. Please try again or call us at (844) 511-4059." });
  }
}
