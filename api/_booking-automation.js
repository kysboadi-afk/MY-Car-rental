// api/_booking-automation.js
// Shared helpers that run automatically whenever a booking is created or
// transitions to a paid state — regardless of whether the trigger is a public
// payment (send-reservation-email.js), a Stripe webhook, or an admin action
// (v2-bookings.js, add-manual-booking.js).
//
// Both helpers are:
//   • Non-fatal  — errors are logged but never propagate to the caller.
//   • Idempotent — safe to call multiple times for the same booking.
//   • Silent     — return immediately when Supabase is not configured.

import { getSupabaseAdmin } from "./_supabase.js";

/**
 * Auto-creates a revenue record in Supabase for a booking that is paid.
 * Skipped silently when Supabase is not configured or the record already exists.
 *
 * @param {object} booking - booking record (bookingId, vehicleId, name, phone,
 *                           email, pickupDate, returnDate, amountPaid,
 *                           paymentMethod, notes, status)
 */
export async function autoCreateRevenueRecord(booking) {
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    // Idempotent: skip if a record already exists for this booking
    const { data: existing } = await sb
      .from("revenue_records")
      .select("id")
      .eq("booking_id", booking.bookingId)
      .maybeSingle();
    if (existing) return;

    const record = {
      booking_id:        booking.bookingId,
      vehicle_id:        booking.vehicleId,
      customer_name:     booking.name  || null,
      customer_phone:    booking.phone || null,
      customer_email:    booking.email || null,
      pickup_date:       booking.pickupDate  || null,
      return_date:       booking.returnDate  || null,
      gross_amount:      Number(booking.amountPaid || 0),
      deposit_amount:    0,
      refund_amount:     0,
      payment_method:    booking.paymentMethod || "stripe",
      payment_status:    "paid",
      notes:             booking.notes || null,
      is_no_show:        false,
      is_cancelled:      false,
      override_by_admin: false,
    };

    const { error } = await sb.from("revenue_records").insert(record);
    if (error) {
      console.error("_booking-automation autoCreateRevenueRecord error (non-fatal):", error.message);
    } else {
      console.log(`_booking-automation: created revenue record for booking ${booking.bookingId}`);
    }
  } catch (err) {
    console.error("_booking-automation autoCreateRevenueRecord error (non-fatal):", err.message);
  }
}

/**
 * Auto-upserts a customer record in Supabase from a booking.
 * Skipped silently when Supabase is not configured or the booking has no phone.
 *
 * @param {object}  booking     - booking record (phone is required as the upsert key)
 * @param {boolean} countStats  - when true, increments total_bookings and total_spent.
 *                                Pass true only for final completion transitions to
 *                                avoid double-counting (e.g. "completed_rental").
 *                                Leave false (default) for initial creation.
 */
export async function autoUpsertCustomer(booking, countStats = false) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  if (!booking.phone) return;

  try {
    const phone = String(booking.phone).trim();
    const record = {
      name:       booking.name || "Unknown",
      phone,
      email:      booking.email || null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await sb
      .from("customers")
      .select("total_bookings, total_spent, first_booking_date")
      .eq("phone", phone)
      .maybeSingle();

    if (existing) {
      const updates = { name: record.name, email: record.email, updated_at: record.updated_at };
      if (countStats) {
        updates.total_bookings = (existing.total_bookings || 0) + 1;
        updates.total_spent    = Math.round(((existing.total_spent || 0) + Number(booking.amountPaid || 0)) * 100) / 100;
        updates.last_booking_date = booking.pickupDate || null;
      }
      await sb.from("customers").update(updates).eq("phone", phone);
    } else {
      await sb.from("customers").insert({
        ...record,
        total_bookings:     countStats ? 1 : 0,
        total_spent:        countStats ? Math.round(Number(booking.amountPaid || 0) * 100) / 100 : 0,
        first_booking_date: booking.pickupDate || null,
        last_booking_date:  booking.pickupDate || null,
      });
    }
    console.log(`_booking-automation: upserted customer ${phone} (${record.name})`);
  } catch (err) {
    console.error("_booking-automation autoUpsertCustomer error (non-fatal):", err.message);
  }
}
