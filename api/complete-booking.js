// api/complete-booking.js
// Vercel serverless function — handles the complete-booking flow for
// Slingshot reservations that were paid with a security deposit only.
//
// GET  /api/complete-booking?token=<payment_link_token>
//   → Returns booking info (name, email, phone, remaining_balance, payment_status, dates, vehicle).
//
// POST /api/complete-booking
//   → { action: "create_payment_intent", token }
//      Creates a Stripe PaymentIntent for the remaining balance.
//   → { action: "finalize", token, paymentIntentId }
//      Marks the booking as fully paid (called after Stripe confirms success).
//
// Required environment variables:
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_

import Stripe from "stripe";
import crypto from "crypto";
import { loadBookings, updateBooking } from "./_bookings.js";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
const FRONTEND_BASE   = "https://www.slytrans.com";

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── GET: look up booking by token ─────────────────────────────────────────
  if (req.method === "GET") {
    const token = req.query.token;
    if (!token || typeof token !== "string" || token.trim().length < 8) {
      return res.status(400).json({ error: "Invalid or missing token." });
    }
    const booking = await findBookingByToken(token.trim());
    if (!booking) {
      return res.status(404).json({ error: "Booking not found. The link may have expired or already been used." });
    }
    return res.status(200).json(sanitizeBooking(booking));
  }

  // ── POST: create payment intent or finalize ───────────────────────────────
  if (req.method === "POST") {
    const { action, token } = req.body || {};
    if (!token || typeof token !== "string" || token.trim().length < 8) {
      return res.status(400).json({ error: "Invalid or missing token." });
    }
    const cleanToken = token.trim();

    if (action === "create_payment_intent") {
      return handleCreatePaymentIntent(req, res, cleanToken);
    }
    if (action === "finalize") {
      return handleFinalize(req, res, cleanToken);
    }
    return res.status(400).json({ error: "Unknown action." });
  }

  return res.status(405).send("Method Not Allowed");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Search bookings.json (all vehicle keys) for a booking whose
 * payment_link_token matches the given token.
 */
async function findBookingByToken(token) {
  try {
    const { data } = await loadBookings();
    for (const vehicleId of Object.keys(data)) {
      const list = Array.isArray(data[vehicleId]) ? data[vehicleId] : [];
      const found = list.find((b) => b.paymentLinkToken === token);
      if (found) return found;
    }
  } catch (err) {
    console.error("complete-booking: findBookingByToken error:", err.message);
  }

  // Fallback: try Supabase
  try {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const { data: rows } = await supabase
        .from("bookings")
        .select("*")
        .eq("payment_link_token", token)
        .limit(1);
      if (rows && rows.length > 0) {
        return supabaseRowToBooking(rows[0]);
      }
    }
  } catch (err) {
    console.error("complete-booking: Supabase token lookup error:", err.message);
  }
  return null;
}

/**
 * Strip sensitive fields before sending booking data to the browser.
 */
function sanitizeBooking(booking) {
  return {
    bookingId:        booking.bookingId,
    vehicleId:        booking.vehicleId,
    vehicleName:      booking.vehicleName,
    name:             booking.name || "",
    email:            booking.email || "",
    phone:            booking.phone || "",
    pickupDate:       booking.pickupDate,
    pickupTime:       booking.pickupTime || "",
    returnDate:       booking.returnDate,
    returnTime:       booking.returnTime || "",
    rentalPrice:      booking.rentalPrice  || booking.rental_price  || 0,
    securityDeposit:  booking.securityDeposit || booking.security_deposit || 0,
    amountPaid:       booking.amountPaid   || booking.amount_paid   || 0,
    remainingBalance: booking.remainingBalance || booking.remaining_balance || 0,
    paymentStatus:    booking.paymentStatus    || booking.slingshot_payment_status || "deposit_paid",
    bookingStatus:    booking.bookingStatus    || booking.slingshot_booking_status || "reserved",
  };
}

/**
 * Map a Supabase bookings row back to the internal booking shape.
 */
function supabaseRowToBooking(row) {
  return {
    bookingId:        row.booking_ref,
    vehicleId:        row.vehicle_id,
    vehicleName:      row.vehicle_name || row.vehicle_id,
    name:             row.customer_name || "",
    email:            row.customer_email || "",
    phone:            row.customer_phone || "",
    pickupDate:       row.pickup_date,
    pickupTime:       row.pickup_time || "",
    returnDate:       row.return_date,
    returnTime:       row.return_time || "",
    rentalPrice:      Number(row.rental_price || 0),
    securityDeposit:  Number(row.security_deposit || 0),
    amountPaid:       Number(row.amount_paid || 0),
    remainingBalance: Number(row.remaining_balance || 0),
    paymentStatus:    row.slingshot_payment_status || row.payment_status || "deposit_paid",
    bookingStatus:    row.slingshot_booking_status || "reserved",
    paymentLinkToken: row.payment_link_token,
    paymentIntentId:  row.stripe_payment_intent_id,
  };
}

/**
 * Create a Stripe PaymentIntent for the remaining balance on a deposit-paid booking.
 */
async function handleCreatePaymentIntent(req, res, token) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is missing." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Server configuration error: STRIPE_PUBLISHABLE_KEY is missing." });
  }

  const booking = await findBookingByToken(token);
  if (!booking) {
    return res.status(404).json({ error: "Booking not found. The link may have expired or already been used." });
  }

  const paymentStatus = booking.paymentStatus || booking.slingshot_payment_status || "";
  if (paymentStatus === "fully_paid") {
    return res.status(409).json({ error: "This booking has already been fully paid.", alreadyPaid: true });
  }
  if (paymentStatus !== "deposit_paid") {
    return res.status(400).json({ error: "This booking is not in a state that requires completion." });
  }

  const remainingBalance = Number(booking.remainingBalance || booking.remaining_balance || 0);
  if (remainingBalance <= 0) {
    return res.status(409).json({ error: "No remaining balance on this booking.", alreadyPaid: true });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(remainingBalance * 100),
      currency: "usd",
      receipt_email: booking.email || undefined,
      description: `Sly Transportation Services LLC – ${booking.vehicleName || booking.vehicleId} Rental Balance`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      metadata: {
        payment_type:             "slingshot_balance_payment",
        original_booking_id:      booking.bookingId || "",
        payment_link_token:       token,
        vehicle_id:               booking.vehicleId || "",
        vehicle_name:             booking.vehicleName || booking.vehicleId || "",
        renter_name:              booking.name || "",
        renter_phone:             booking.phone || "",
        email:                    booking.email || "",
        pickup_date:              booking.pickupDate || "",
        return_date:              booking.returnDate || "",
        remaining_balance:        String(remainingBalance),
      },
    });

    return res.status(200).json({
      clientSecret:   paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error("complete-booking: Stripe PaymentIntent error:", err);
    return res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}

/**
 * Finalize: mark the booking as fully paid after Stripe confirms payment.
 * Called from the complete-booking.html success handler.
 */
async function handleFinalize(req, res, token) {
  const { paymentIntentId } = req.body || {};

  const booking = await findBookingByToken(token);
  if (!booking) {
    return res.status(404).json({ error: "Booking not found." });
  }

  // Optionally verify the PaymentIntent status with Stripe
  if (paymentIntentId && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== "succeeded") {
        return res.status(400).json({ error: "Payment has not succeeded yet." });
      }
    } catch (err) {
      console.error("complete-booking: Stripe verify error:", err.message);
      // Non-fatal — let the webhook handle the authoritative update
    }
  }

  const updates = {
    paymentStatus:    "fully_paid",
    slingshot_payment_status: "fully_paid",
    bookingStatus:    "reserved",
    slingshot_booking_status: "reserved",
    remainingBalance: 0,
    remaining_balance: 0,
    status:           "booked_paid",
    completionPaymentIntentId: paymentIntentId || null,
    completedAt:      new Date().toISOString(),
  };

  // Update bookings.json
  const vehicleId = booking.vehicleId;
  const bookingId = booking.bookingId || booking.paymentIntentId;
  if (vehicleId && bookingId) {
    try {
      await updateBooking(vehicleId, bookingId, updates);
    } catch (err) {
      console.error("complete-booking: updateBooking error:", err.message);
    }
  }

  // Update Supabase
  try {
    const supabase = getSupabaseAdmin();
    if (supabase && booking.bookingId) {
      await supabase
        .from("bookings")
        .update({
          payment_status:           "paid",
          slingshot_payment_status: "fully_paid",
          remaining_balance:        0,
          updated_at:               new Date().toISOString(),
        })
        .eq("booking_ref", booking.bookingId);
    }
  } catch (err) {
    console.error("complete-booking: Supabase update error:", err.message);
  }

  return res.status(200).json({ success: true });
}
