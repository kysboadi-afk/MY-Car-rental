// api/extend-slingshot.js
// Vercel serverless function — extends an active slingshot rental using a
// fixed hourly package (2hr / 3hr / 6hr / 24hr).
//
// POST /api/extend-slingshot
// Body: { vehicleId, email, phone, slingshotPackage }
// Returns: { clientSecret, publishableKey, extensionAmount, extensionLabel,
//            newReturnDate, newReturnTime, vehicleName, renterName }

import Stripe from "stripe";
import { getVehicleById } from "./_vehicles.js";
import {
  getSlingshotPackage,
  computeSlingshotReturn,
  isReturnWithinBusinessHours,
  splitDatetimeLA,
} from "./_slingshot-packages.js";
import { buildDateTimeLA, normalizeClockTime, formatTime12h, DEFAULT_RETURN_TIME } from "./_time.js";
import { loadBookings, updateBooking, normalizePhone } from "./_bookings.js";
import { hasDateTimeOverlap } from "./_availability.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { computeFinalReturnDate } from "./_final-return-date.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("extend-slingshot: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("extend-slingshot: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  const { vehicleId, email, phone, slingshotPackage, name } = req.body || {};

  // ── Validate vehicle ────────────────────────────────────────────────────────
  const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
  if (!vehicleData) {
    return res.status(400).json({ error: "Invalid vehicle." });
  }

  // ── Validate package ────────────────────────────────────────────────────────
  const pkg = getSlingshotPackage(slingshotPackage);
  if (!pkg) {
    return res.status(400).json({ error: "Invalid package. Please choose from 2hr, 3hr, 6hr, or 24hr." });
  }

  const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
  if (!trimmedEmail && !trimmedPhone) {
    return res.status(400).json({ error: "Email or phone number is required to verify your rental." });
  }
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  try {
    // ── Find active booking ─────────────────────────────────────────────────
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicleId] || [];
    const normalizedPhone = trimmedPhone ? normalizePhone(trimmedPhone) : null;

    let activeBooking = null;
    for (const b of vehicleBookings) {
      const isActive = b.status === "active_rental" || b.status === "active";
      if (!isActive) continue;
      const emailMatch = trimmedEmail && b.email && b.email.trim().toLowerCase() === trimmedEmail;
      const phoneMatch = normalizedPhone && b.phone && normalizePhone(b.phone) === normalizedPhone;
      if (emailMatch || phoneMatch) { activeBooking = b; break; }
    }

    // ── Supabase enrichment ─────────────────────────────────────────────────
    const sb = getSupabaseAdmin();
    let sbReturnDate      = null;
    let sbReturnTime      = null;
    let sbActiveBookingRef = null;

    if (sb) {
      try {
        if (activeBooking) {
          const bookingRef = activeBooking.bookingId || activeBooking.paymentIntentId;
          if (bookingRef) {
            const { data: sbRow } = await sb
              .from("bookings")
              .select("booking_ref, return_date, return_time, status")
              .eq("booking_ref", bookingRef)
              .maybeSingle();
            if (sbRow && ["active", "active_rental", "overdue"].includes(sbRow.status)) {
              if (sbRow.booking_ref) sbActiveBookingRef = sbRow.booking_ref;
              if (sbRow.return_date) sbReturnDate = String(sbRow.return_date).split("T")[0];
              if (sbRow.return_time) sbReturnTime = String(sbRow.return_time).substring(0, 5);
            }
          }
        } else {
          const { data: sbActive } = await sb
            .from("bookings")
            .select("booking_ref, return_date, return_time, customer_name, customer_email, customer_phone")
            .eq("vehicle_id", vehicleId)
            .in("status", ["active", "active_rental", "overdue"]);

          if (sbActive) {
            for (const row of sbActive) {
              const rowEmail = (row.customer_email || "").trim().toLowerCase();
              const rowPhone = row.customer_phone ? normalizePhone(row.customer_phone) : null;
              const emailMatch = trimmedEmail && rowEmail === trimmedEmail;
              const phoneMatch = normalizedPhone && rowPhone && rowPhone === normalizedPhone;
              if (emailMatch || phoneMatch) {
                const sbRef = row.booking_ref;
                const jsonMatch = vehicleBookings.find(
                  (b) => b.bookingId === sbRef || b.paymentIntentId === sbRef
                );
                activeBooking = jsonMatch || {
                  bookingId:       sbRef,
                  paymentIntentId: "",
                  name:            row.customer_name  || "",
                  email:           row.customer_email || "",
                  phone:           row.customer_phone || "",
                  returnDate:      row.return_date ? String(row.return_date).split("T")[0] : "",
                  returnTime:      row.return_time  ? String(row.return_time).substring(0, 5) : "",
                  pickupDate:      "",
                  status:          "active_rental",
                };
                sbActiveBookingRef = row.booking_ref || null;
                sbReturnDate = row.return_date ? String(row.return_date).split("T")[0] : null;
                sbReturnTime = row.return_time  ? String(row.return_time).substring(0, 5) : null;
                break;
              }
            }
          }
        }
      } catch (sbErr) {
        console.warn("extend-slingshot: Supabase lookup failed (non-fatal):", sbErr.message);
      }
    }

    if (!activeBooking) {
      return res.status(404).json({
        error: "No active rental found for this vehicle with the provided contact info. " +
               "Please check your email or phone number, or call us at (844) 511-4059.",
      });
    }

    // ── Resolve effective return datetime ───────────────────────────────────
    let effectiveReturnDate = (sbReturnDate && sbReturnDate > (activeBooking.returnDate || ""))
      ? sbReturnDate
      : (activeBooking.returnDate || "");

    const existingReturnTime = normalizeClockTime(sbReturnTime || activeBooking.returnTime);
    const resolvedReturnTime = existingReturnTime || DEFAULT_RETURN_TIME;

    // Incorporate paid extensions from revenue_records so the true finalReturnDate
    // is used (guards against stale return dates in bookings table).
    if (sb) {
      const extBookingRef = sbActiveBookingRef || activeBooking.bookingId || activeBooking.paymentIntentId;
      try {
        const { date: finalDate } = await computeFinalReturnDate(
          sb, extBookingRef, effectiveReturnDate, resolvedReturnTime
        );
        if (finalDate > effectiveReturnDate) effectiveReturnDate = finalDate;
      } catch (frdErr) {
        console.warn("extend-slingshot: computeFinalReturnDate failed (non-fatal):", frdErr.message);
      }
    }

    if (!effectiveReturnDate) {
      return res.status(400).json({ error: "Could not determine current return date. Please call (844) 511-4059." });
    }

    // ── Compute new return datetime ─────────────────────────────────────────
    const currentReturnDatetimeLA = buildDateTimeLA(effectiveReturnDate, resolvedReturnTime);
    if (isNaN(currentReturnDatetimeLA.getTime())) {
      return res.status(400).json({ error: "Could not parse current return date/time." });
    }

    const newReturnDatetimeLA = computeSlingshotReturn(currentReturnDatetimeLA, slingshotPackage);
    if (!newReturnDatetimeLA) {
      return res.status(400).json({ error: "Could not compute new return datetime." });
    }

    // ── Business hours check ────────────────────────────────────────────────
    if (!isReturnWithinBusinessHours(slingshotPackage, newReturnDatetimeLA)) {
      return res.status(400).json({
        error: `Extending by ${pkg.label} would return the vehicle after 8:00 PM Los Angeles time. ` +
               "Only 24-hour extensions may end after business hours. " +
               "Please choose a shorter extension or call (844) 511-4059.",
      });
    }

    const { date: newReturnDate, time: newReturnTime } = splitDatetimeLA(newReturnDatetimeLA);

    // ── Conflict check (bookings.json) ──────────────────────────────────────
    const extensionRange = [{
      from:     effectiveReturnDate,
      to:       newReturnDate,
      fromTime: resolvedReturnTime,
      toTime:   newReturnTime,
    }];

    for (const b of vehicleBookings) {
      if (b === activeBooking) continue;
      if (b.bookingId === activeBooking.bookingId) continue;
      if (sbActiveBookingRef && (b.bookingId === sbActiveBookingRef || b.paymentIntentId === sbActiveBookingRef)) continue;
      if (b.status === "cancelled" || b.status === "completed_rental") continue;
      if (b.returnDate && b.returnDate <= effectiveReturnDate) continue;
      const hasConflict = hasDateTimeOverlap(
        extensionRange,
        b.pickupDate,
        b.returnDate || b.pickupDate,
        b.pickupTime || "",
        b.returnTime || ""
      );
      if (hasConflict) {
        return res.status(409).json({
          error: "This extension conflicts with another booking. Please choose a shorter package or call (844) 511-4059.",
        });
      }
    }

    // ── Conflict check (Supabase) ───────────────────────────────────────────
    if (sb) {
      try {
        const activeBookingRef = activeBooking.bookingId || activeBooking.paymentIntentId || "";
        const conflictFloorDate = effectiveReturnDate || new Date().toISOString().split("T")[0];
        let futureQuery = sb
          .from("bookings")
          .select("booking_ref, pickup_date, return_date, pickup_time, return_time")
          .eq("vehicle_id", vehicleId)
          .not("status", "in", "(cancelled,completed_rental)")
          .gte("pickup_date", conflictFloorDate);
        if (sbActiveBookingRef) futureQuery = futureQuery.neq("booking_ref", sbActiveBookingRef);
        const { data: sbFuture } = await futureQuery;

        for (const fbk of (sbFuture || [])) {
          if (
            fbk.booking_ref === activeBookingRef ||
            (sbActiveBookingRef && fbk.booking_ref === sbActiveBookingRef)
          ) continue;
          const fbkPickupDate = String(fbk.pickup_date || "").split("T")[0];
          const fbkReturnDate = String(fbk.return_date || "").split("T")[0];
          if (!fbkPickupDate || !fbkReturnDate) continue;
          if (fbkReturnDate <= effectiveReturnDate) continue;
          const fbkPickupTime = fbk.pickup_time ? String(fbk.pickup_time).substring(0, 5) : "";
          const fbkReturnTime = fbk.return_time ? String(fbk.return_time).substring(0, 5) : "";
          const hasConflict = hasDateTimeOverlap(
            extensionRange,
            fbkPickupDate,
            fbkReturnDate,
            fbkPickupTime,
            fbkReturnTime
          );
          if (hasConflict) {
            return res.status(409).json({
              error: "This extension conflicts with another booking. Please choose a shorter package or call (844) 511-4059.",
            });
          }
        }
      } catch (sbConflictErr) {
        console.warn("extend-slingshot: Supabase conflict check failed (non-fatal):", sbConflictErr.message);
      }
    }

    // ── Extension price (no deposit, no tax for extensions) ─────────────────
    const extensionAmount = pkg.price;
    const extensionLabel  = `+${pkg.label}`;

    // ── Create Stripe PaymentIntent ─────────────────────────────────────────
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.create({
      amount:   Math.round(extensionAmount * 100),
      currency: "usd",
      description: `Slingshot Extension — ${vehicleData.name} — ${extensionLabel} — ${activeBooking.name || ""}`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: { card: { request_three_d_secure: "automatic" } },
      receipt_email: activeBooking.email || undefined,
      metadata: {
        type:                 "rental_extension",
        payment_type:         "rental_extension",
        booking_type:         "slingshot",
        booking_id:           sbActiveBookingRef ||
          (activeBooking.bookingId && !String(activeBooking.bookingId).startsWith("pi_")
            ? activeBooking.bookingId
            : null) || "",
        vehicle_id:           vehicleId,
        vehicle_name:         vehicleData.name  || "",
        renter_name:          activeBooking.name || (typeof name === "string" ? name.trim() : "") || "",
        renter_email:         activeBooking.email || "",
        renter_phone:         activeBooking.phone || "",
        package_key:          slingshotPackage,
        package_label:        pkg.label,
        extension_label:      extensionLabel,
        new_return_date:      newReturnDate,
        new_return_time:      formatTime12h(newReturnTime) || "",
        previous_return_date: effectiveReturnDate || "",
        late_fee_included:    "0",
        late_fee_waived:      "0",
        deferred_late_fee:    "0",
      },
    });

    // ── Store extensionPendingPayment on the booking ────────────────────────
    const bookingId = activeBooking.bookingId || activeBooking.paymentIntentId;
    if (bookingId) {
      try {
        await updateBooking(vehicleId, bookingId, {
          extensionPendingPayment: {
            label:           extensionLabel,
            price:           extensionAmount,
            lateFeeIncluded: 0,
            deferredLateFee: 0,
            newReturnDate,
            newReturnTime,
            paymentIntentId: pi.id,
            createdAt:       new Date().toISOString(),
          },
        });
      } catch (updateErr) {
        console.warn("extend-slingshot: could not write extensionPendingPayment (non-fatal):", updateErr.message);
      }
    }

    return res.status(200).json({
      clientSecret:    pi.client_secret,
      publishableKey:  process.env.STRIPE_PUBLISHABLE_KEY,
      extensionAmount: extensionAmount.toFixed(2),
      extensionLabel,
      newReturnDate,
      newReturnTime,
      vehicleName:     vehicleData.name,
      renterName:      activeBooking.name || "",
    });
  } catch (err) {
    console.error("extend-slingshot error:", err);
    return res.status(500).json({ error: "Failed to create extension payment. Please try again or call (844) 511-4059." });
  }
}
