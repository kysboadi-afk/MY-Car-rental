// api/_booking-automation.js
// Shared helpers that run automatically whenever a booking is created or
// transitions to a paid state — regardless of whether the trigger is a public
// payment (send-reservation-email.js), a Stripe webhook, or an admin action
// (v2-bookings.js, add-manual-booking.js).
//
// All helpers are:
//   • Non-fatal  — errors are logged but never propagate to the caller.
//   • Idempotent — safe to call multiple times for the same booking.
//   • Silent     — return immediately when Supabase is not configured.
//
// Exported helpers:
//   autoCreateRevenueRecord  — writes to legacy revenue_records table
//   autoUpsertCustomer       — upserts customer row (keyed by phone)
//   autoUpsertBooking        — syncs booking to normalised bookings table
//   autoCreateBlockedDate    — inserts a blocked_dates row for a booking

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
 * @param {boolean} isNoShow    - when true, increments no_show_count.  Only used on
 *                                completion transitions for no-show bookings.
 */
export async function autoUpsertCustomer(booking, countStats = false, isNoShow = false) {
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
      .select("total_bookings, total_spent, first_booking_date, no_show_count")
      .eq("phone", phone)
      .maybeSingle();

    /**
     * Fetches revenue-record stats for a phone number.
     * Returns { totalBookings, totalSpent, firstDate, lastDate } or null on failure.
     */
    async function fetchRrStats(ph) {
      const { data: rr } = await sb
        .from("revenue_records")
        .select("gross_amount, refund_amount, is_cancelled, pickup_date")
        .eq("customer_phone", ph);
      if (!rr) return null;
      const valid  = rr.filter((r) => !r.is_cancelled);
      const dates  = rr.map((r) => r.pickup_date).filter(Boolean).sort();
      return {
        totalBookings: valid.length,
        totalSpent:    Math.round(valid.reduce((s, r) => s + Number(r.gross_amount || 0) - Number(r.refund_amount || 0), 0) * 100) / 100,
        firstDate:     dates[0] || null,
        lastDate:      dates[dates.length - 1] || null,
      };
    }

    if (existing) {
      const updates = { name: record.name, email: record.email, updated_at: record.updated_at };
      if (countStats) {
        // Use SET semantics: recompute totals from revenue_records so this
        // function is idempotent even when called multiple times for the same
        // customer (e.g. repeated scheduler runs or status re-transitions).
        const stats = await fetchRrStats(phone);
        if (stats) {
          updates.total_bookings     = stats.totalBookings;
          updates.total_spent        = stats.totalSpent;
          updates.first_booking_date = stats.firstDate || existing.first_booking_date || null;
          updates.last_booking_date  = stats.lastDate  || booking.pickupDate || null;
        } else {
          // Fallback: increment if revenue_records is unavailable
          updates.total_bookings = (existing.total_bookings || 0) + 1;
          updates.total_spent    = Math.round(((existing.total_spent || 0) + Number(booking.amountPaid || 0)) * 100) / 100;
          updates.last_booking_date = booking.pickupDate || null;
        }
      }
      if (isNoShow) {
        updates.no_show_count = (existing.no_show_count || 0) + 1;
      }
      await sb.from("customers").update(updates).eq("phone", phone);
    } else {
      let totalBookings = 0, totalSpent = 0, firstDate = booking.pickupDate || null, lastDate = booking.pickupDate || null;
      if (countStats) {
        const stats = await fetchRrStats(phone);
        if (stats) {
          totalBookings = stats.totalBookings;
          totalSpent    = stats.totalSpent;
          firstDate     = stats.firstDate || firstDate;
          lastDate      = stats.lastDate  || lastDate;
        } else {
          totalBookings = 1;
          totalSpent    = Math.round(Number(booking.amountPaid || 0) * 100) / 100;
        }
      }
      await sb.from("customers").insert({
        ...record,
        total_bookings:     totalBookings,
        total_spent:        totalSpent,
        no_show_count:      isNoShow ? 1 : 0,
        first_booking_date: firstDate,
        last_booking_date:  lastDate,
      });
    }
    console.log(`_booking-automation: upserted customer ${phone} (${record.name})`);
  } catch (err) {
    console.error("_booking-automation autoUpsertCustomer error (non-fatal):", err.message);
  }
}

// ── Status mapping: old bookings.json values → new bookings table enum ────────
const BOOKING_STATUS_MAP = {
  reserved_unpaid:  "pending",
  booked_paid:      "approved",
  active_rental:    "active",
  completed_rental: "completed",
  cancelled_rental: "cancelled",
};

/**
 * Converts a pickup/return time string in "H:MM AM/PM" format to "HH:MM:SS"
 * PostgreSQL time format.  Returns null for unparseable input.
 */
function parseTime12h(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hours   = parseInt(m[1], 10);
  const mins  = m[2];
  const secs  = m[3] || "00";
  const ampm  = (m[4] || "").toUpperCase();
  if (ampm === "PM" && hours < 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours  = 0;
  return `${String(hours).padStart(2, "0")}:${mins}:${secs}`;
}

/**
 * Converts a date string to an ISO-8601 string, or undefined if the input is
 * absent or cannot be parsed.  Used to safely pass optional timestamp fields
 * to Supabase without risking 'Invalid Date' strings in the payload.
 */
function safeIso(value) {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Syncs a booking record into the normalised Supabase `bookings` table.
 * Does an INSERT for new booking_refs and an UPDATE for existing ones.
 * Skipped silently when Supabase is not configured.
 *
 * @param {object} booking  - booking record from bookings.json / admin forms
 */
export async function autoUpsertBooking(booking) {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  if (!booking.bookingId) return;

  try {
    // Resolve customer_id by phone
    let customerId = null;
    if (booking.phone) {
      const phone = String(booking.phone).trim();
      const { data: cust } = await sb
        .from("customers")
        .select("id")
        .eq("phone", phone)
        .maybeSingle();
      customerId = cust?.id ?? null;
    }

    const status = BOOKING_STATUS_MAP[booking.status] || booking.status || "pending";
    const amountPaid  = Number(booking.amountPaid  || 0);
    // Prefer an explicit totalPrice field if provided; fall back to amountPaid so
    // that existing bookings.json records (which only store amountPaid) still sync
    // correctly.  Callers that know the full rental price should pass totalPrice.
    const totalPrice  = Number(booking.totalPrice  || booking.total_price  || amountPaid);
    const remaining   = Math.max(0, totalPrice - amountPaid);

    let paymentStatus = "unpaid";
    if (amountPaid > 0) {
      paymentStatus = remaining > 0 ? "partial" : "paid";
    }

    const record = {
      customer_id:               customerId,
      vehicle_id:                booking.vehicleId   || null,
      pickup_date:               booking.pickupDate  || null,
      return_date:               booking.returnDate  || null,
      pickup_time:               parseTime12h(booking.pickupTime),
      return_time:               parseTime12h(booking.returnTime),
      status,
      total_price:               totalPrice,
      deposit_paid:              amountPaid,
      remaining_balance:         remaining,
      payment_status:            paymentStatus,
      notes:                     booking.notes             || null,
      payment_method:            booking.paymentMethod     || null,
      payment_intent_id:         booking.paymentIntentId   || null,
      stripe_customer_id:        booking.stripeCustomerId       || null,
      stripe_payment_method_id:  booking.stripePaymentMethodId  || null,
      // Mirror the JS-side auto-stamps so the Supabase row is consistent with
      // the bookings.json record.  The DB trigger on_booking_status_timestamps
      // will also stamp these automatically, but passing the JS value ensures
      // idempotent re-syncs preserve the original timestamp.
      activated_at:              safeIso(booking.activatedAt),
      completed_at:              safeIso(booking.completedAt),
    };

    // Check whether the booking already exists in Supabase
    const { data: existing } = await sb
      .from("bookings")
      .select("id")
      .eq("booking_ref", booking.bookingId)
      .maybeSingle();

    if (existing) {
      // UPDATE — no conflict-check trigger fires on plain UPDATE
      const { error } = await sb
        .from("bookings")
        .update({ ...record, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) {
        console.error("_booking-automation autoUpsertBooking update error (non-fatal):", error.message);
      }
    } else {
      // INSERT — conflict-check trigger fires; will reject overlapping dates
      const { error } = await sb
        .from("bookings")
        .insert({ ...record, booking_ref: booking.bookingId });
      if (error) {
        console.error("_booking-automation autoUpsertBooking insert error (non-fatal):", error.message);
      } else {
        console.log(`_booking-automation: synced booking ${booking.bookingId} → Supabase bookings table`);
      }
    }
  } catch (err) {
    console.error("_booking-automation autoUpsertBooking error (non-fatal):", err.message);
  }
}

/**
 * Inserts a blocked_dates row for a booking period.
 * Skipped silently when Supabase is not configured.
 *
 * @param {string} vehicleId  - vehicle_id text key
 * @param {string} startDate  - YYYY-MM-DD
 * @param {string} endDate    - YYYY-MM-DD
 * @param {string} reason     - 'booking' | 'maintenance' | 'manual'
 */
export async function autoCreateBlockedDate(vehicleId, startDate, endDate, reason = "booking") {
  const sb = getSupabaseAdmin();
  if (!sb) return;
  if (!vehicleId || !startDate || !endDate) return;

  try {
    const { error } = await sb
      .from("blocked_dates")
      .upsert(
        { vehicle_id: vehicleId, start_date: startDate, end_date: endDate, reason },
        { onConflict: "vehicle_id,start_date,end_date,reason", ignoreDuplicates: true }
      );
    if (error) {
      console.error("_booking-automation autoCreateBlockedDate error (non-fatal):", error.message);
    }
  } catch (err) {
    console.error("_booking-automation autoCreateBlockedDate error (non-fatal):", err.message);
  }
}
