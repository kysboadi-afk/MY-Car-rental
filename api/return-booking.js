// api/return-booking.js
// Vercel serverless function — atomically marks a booking as returned.
//
// Calls the return_booking_atomic Supabase RPC which, in a single
// transaction:
//   1. Locks the bookings row and validates the booking is active.
//   2. Sets status → completed_rental, stamps completed_at and
//      actual_return_time to now().
//   3. Deletes the blocked_dates row so fleet-status.js immediately
//      reports the vehicle as available.
//
// POST /api/return-booking
//   Headers:  x-admin-secret: <ADMIN_SECRET>  (or body.secret)
//   Body:     { "booking_ref": "<ref>" }
//
// Responses:
//   200  { success: true, data: { booking_ref, vehicle_id, status, completed_at } }
//   400  booking_ref missing
//   401  Unauthorized
//   404  Booking not found
//   409  Booking already completed or not in a returnable state
//   500  Supabase not configured / unexpected error

import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.ADMIN_SECRET) {
    console.error("return-booking: ADMIN_SECRET environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const secret =
    req.headers["x-admin-secret"] ||
    req.body?.secret ||
    "";
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { booking_ref } = req.body || {};
  if (!booking_ref || typeof booking_ref !== "string" || !booking_ref.trim()) {
    return res.status(400).json({ error: "booking_ref is required" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(500).json({ error: "Supabase is not configured." });
  }

  try {
    const { data, error } = await sb.rpc("return_booking_atomic", {
      booking_ref_input: booking_ref.trim(),
    });

    if (error) {
      const msg = error.message || "";

      if (msg.toLowerCase().includes("not found")) {
        return res.status(404).json({ error: `Booking not found: ${booking_ref}` });
      }

      if (msg === "already_completed" || msg.includes("already_completed")) {
        return res.status(409).json({ error: "Booking has already been marked as returned." });
      }

      if (msg.includes("Cannot return booking")) {
        return res.status(409).json({ error: msg });
      }

      console.error("return-booking: RPC error:", error);
      return res.status(500).json({ error: "Failed to return booking." });
    }

    console.log("[BOOKING_RETURNED_ATOMIC]", {
      booking_ref: data?.booking_ref,
      vehicle_id:  data?.vehicle_id,
      completed_at: data?.completed_at,
    });

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("return-booking: unexpected error:", err);
    return res.status(500).json({ error: "Unexpected error." });
  }
}
