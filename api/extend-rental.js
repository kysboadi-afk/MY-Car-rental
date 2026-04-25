// api/extend-rental.js
// Vercel serverless function — creates a Stripe PaymentIntent for a web-initiated
// rental extension.  Called from car.html when the current renter wants to
// extend their rental via the "Extend Rental" form.
//
// POST /api/extend-rental
// Body: { vehicleId, email, phone, newReturnDate }
//
// Returns: { clientSecret, publishableKey, extensionAmount, extensionLabel,
//            newReturnDate, newReturnTime, vehicleName, renterName }
//
// Required environment variables:
//   STRIPE_SECRET_KEY
//   STRIPE_PUBLISHABLE_KEY
//   GITHUB_TOKEN   (to read/write bookings.json)
//   GITHUB_REPO    (defaults to kysboadi-afk/SLY-RIDES)

import Stripe from "stripe";
import { getVehicleById } from "./_vehicles.js";
import { loadPricingSettings, applyTax } from "./_settings.js";
import { loadBookings, updateBooking, normalizePhone } from "./_bookings.js";
import { hasDateTimeOverlap, parseDateTimeMs } from "./_availability.js";
import { normalizeClockTime, DEFAULT_RETURN_TIME } from "./_time.js";
import { getSupabaseAdmin } from "./_supabase.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

export default async function handler(req, res) {
  // CORS — allow requests from the production frontend only
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("extend-rental: STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("extend-rental: STRIPE_PUBLISHABLE_KEY not set");
    return res.status(500).json({ error: "Server configuration error." });
  }

  const { vehicleId, email, phone, newReturnDate } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────────
  const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
  if (!vehicleData) {
    return res.status(400).json({ error: "Invalid vehicle." });
  }

  const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";

  if (!trimmedEmail && !trimmedPhone) {
    return res.status(400).json({ error: "Email or phone number is required to verify your rental." });
  }

  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  if (!newReturnDate || !/^\d{4}-\d{2}-\d{2}$/.test(newReturnDate)) {
    return res.status(400).json({ error: "New return date is required (YYYY-MM-DD)." });
  }

  try {
    // ── Load bookings and find the active rental ────────────────────────────
    const { data: allBookings } = await loadBookings();
    const vehicleBookings = allBookings[vehicleId] || [];

    const normalizedPhone = trimmedPhone ? normalizePhone(trimmedPhone) : null;

    let activeBooking = null;

    for (let i = 0; i < vehicleBookings.length; i++) {
      const b = vehicleBookings[i];
      const isActive = b.status === "active_rental" || b.status === "active";
      if (!isActive) continue;

      const emailMatch = trimmedEmail && b.email &&
        b.email.trim().toLowerCase() === trimmedEmail;
      const phoneMatch = normalizedPhone && b.phone &&
        normalizePhone(b.phone) === normalizedPhone;

      if (emailMatch || phoneMatch) {
        activeBooking = b;
        break;
      }
    }

    // ── Supabase enrichment: get the most-current return date and find
    //    active bookings that may have been activated without updating bookings.json ──
    // The return date in bookings.json can become stale when a rental is extended
    // via admin actions that only update Supabase.  Supabase is the authoritative
    // source for the live return date; bookings.json is the fallback.
    const sb = getSupabaseAdmin();
    let sbReturnDate = null;       // YYYY-MM-DD from Supabase (may be more recent than bookings.json)
    let sbReturnTime = null;       // HH:MM from Supabase
    let sbActiveBookingRef = null; // canonical booking_ref from Supabase (used for conflict-skip)

    if (sb) {
      try {
        if (activeBooking) {
          // Found in bookings.json — fetch fresh return date from Supabase so pricing
          // reflects any admin-applied extensions that updated Supabase but not bookings.json.
          const bookingRef = activeBooking.bookingId || activeBooking.paymentIntentId;
          if (bookingRef) {
            const { data: sbRow } = await sb
              .from("bookings")
              .select("booking_ref, return_date, return_time, status")
              .eq("booking_ref", bookingRef)
              .maybeSingle();
            if (sbRow && (sbRow.status === "active" || sbRow.status === "active_rental" || sbRow.status === "overdue")) {
              // Capture the canonical Supabase booking_ref so the conflict-check
              // loop can skip this booking even when activeBooking.bookingId is a
              // legacy Stripe PI ID that does not match booking_ref.
              if (sbRow.booking_ref) {
                sbActiveBookingRef = sbRow.booking_ref;
              }
              const sbDate = sbRow.return_date ? String(sbRow.return_date).split("T")[0] : null;
              // Only use Supabase date when it is strictly later (guards against stale Supabase rows).
              if (sbDate && sbDate > (activeBooking.returnDate || "")) {
                sbReturnDate = sbDate;
              }
              // Supabase stores time as "HH:MM:SS"; normalise to "HH:MM" for parseDateTimeMs.
              if (sbRow.return_time && !activeBooking.returnTime) {
                sbReturnTime = String(sbRow.return_time).substring(0, 5);
              }
            }
          }
        } else {
          // Not found in bookings.json (booking may have been created or activated via
          // the admin panel without fully syncing to bookings.json).  Try Supabase
          // directly, matching by vehicle_id + email or phone + active status.
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
                // Try to locate this booking in bookings.json by ref so we can
                // write extensionPendingPayment back to it later.
                const sbRef = row.booking_ref;
                const jsonMatch = vehicleBookings.find(
                  (b) => b.bookingId === sbRef || b.paymentIntentId === sbRef
                );
                if (jsonMatch) {
                  activeBooking = jsonMatch;
                } else {
                  // Build a minimal booking object from Supabase data so the rest
                  // of the flow can proceed; the extensionPendingPayment write will
                  // be a no-op since no bookingId will match in bookings.json.
                  // Fields not present in the Supabase query (pickupDate, status,
                  // paymentIntentId) are set to safe empty defaults.
                  activeBooking = {
                    bookingId:        sbRef,
                    paymentIntentId:  "",
                    name:             row.customer_name  || "",
                    email:            row.customer_email || "",
                    phone:            row.customer_phone || "",
                    returnDate:       row.return_date ? String(row.return_date).split("T")[0] : "",
                    returnTime:       row.return_time ? String(row.return_time).substring(0, 5) : "",
                    pickupDate:       "",
                    status:           "active_rental",
                  };
                }
                sbActiveBookingRef = row.booking_ref || null;
                sbReturnDate = row.return_date ? String(row.return_date).split("T")[0] : null;
                sbReturnTime = row.return_time  ? String(row.return_time).substring(0, 5) : null;
                break;
              }
            }
          }
        }
      } catch (sbErr) {
        console.warn("extend-rental: Supabase booking lookup failed (non-fatal):", sbErr.message);
      }
    }

    if (!activeBooking) {
      return res.status(404).json({
        error: "No active rental found for this vehicle with the provided contact info. " +
               "Please check your email or phone number, or call us at (213) 916-6606.",
      });
    }

    // If sbActiveBookingRef is still null after the enrichment block (e.g. the booking
    // was in bookings.json but its bookingId is a legacy Stripe PI ID that does not match
    // any booking_ref in Supabase), resolve it now via renter contact info.
    // This guarantees the conflict-check loop can always skip the active booking.
    // Also fetches return_date/return_time so effectiveReturnDate reflects the live
    // Supabase value even when the primary lookup failed due to a PI-ID mismatch.
    if (sb && !sbActiveBookingRef) {
      try {
        let refQuery = sb
          .from("bookings")
          .select("booking_ref, return_date, return_time")
          .eq("vehicle_id", vehicleId)
          .in("status", ["active", "active_rental", "overdue"]);
        if (trimmedEmail) {
          refQuery = refQuery.eq("customer_email", trimmedEmail);
        } else if (normalizedPhone) {
          refQuery = refQuery.eq("customer_phone", normalizedPhone);
        }
        const { data: refRow } = await refQuery.maybeSingle();
        if (refRow && refRow.booking_ref) {
          sbActiveBookingRef = refRow.booking_ref;
          // Populate sbReturnDate/sbReturnTime if they weren't resolved by the
          // primary lookup — this fixes stale bookings.json return dates for
          // bookings whose bookingId is a legacy Stripe PI ID.
          if (!sbReturnDate && refRow.return_date) {
            sbReturnDate = String(refRow.return_date).split("T")[0];
          }
          if (!sbReturnTime && refRow.return_time) {
            sbReturnTime = String(refRow.return_time).substring(0, 5);
          }
        }
      } catch (refFallbackErr) {
        console.warn("extend-rental: canonical ref fallback lookup failed (non-fatal):", refFallbackErr.message);
      }
    }

    // Effective return date: prefer Supabase when it is more recent.  This corrects
    // stale bookings.json return dates caused by admin-driven extensions.
    const effectiveReturnDate = (sbReturnDate && sbReturnDate > (activeBooking.returnDate || ""))
      ? sbReturnDate
      : (activeBooking.returnDate || "");

    // Keep extension return_time fixed to the booking's existing return_time.
    // Legacy bookings without a return_time are normalized to the system
    // default so every booking has a valid HH:MM return time.
    const existingReturnTime = normalizeClockTime(sbReturnTime || activeBooking.returnTime);
    const resolvedReturnTime = existingReturnTime || DEFAULT_RETURN_TIME;
    const needsReturnTimePersist = !activeBooking.returnTime || activeBooking.returnTime !== resolvedReturnTime;

    // ── Validate new return date is after current return date ───────────────
    const currentReturnMs = parseDateTimeMs(effectiveReturnDate, resolvedReturnTime);
    const newReturnMs     = parseDateTimeMs(newReturnDate, resolvedReturnTime);

    if (isNaN(newReturnMs)) {
      return res.status(400).json({ error: "Invalid new return date/time." });
    }

    if (newReturnMs <= currentReturnMs) {
      return res.status(400).json({
        error: "New return date/time must be after your current return date/time " +
               `(${effectiveReturnDate}${resolvedReturnTime ? " " + resolvedReturnTime : ""}).`,
      });
    }

    // ── Check for conflicts with future bookings ────────────────────────────
    // Use the same overlap helper as the booking flow so extension conflict
    // checks honor the same time parsing and buffer behavior.
    const extensionRange = [{
      from: effectiveReturnDate || newReturnDate,
      to: newReturnDate,
      fromTime: resolvedReturnTime,
      toTime: resolvedReturnTime,
    }];

    for (const b of vehicleBookings) {
      if (b === activeBooking) continue;
      if (b.bookingId === activeBooking.bookingId) continue;
      // Also skip when the JSON entry's ID matches the Supabase canonical ref —
      // covers legacy entries where b.bookingId is a Stripe PI ID and the
      // activeBooking was resolved via Supabase with a bk-... booking_ref.
      if (sbActiveBookingRef && (b.bookingId === sbActiveBookingRef || b.paymentIntentId === sbActiveBookingRef)) continue;
      if (b.status === "cancelled" || b.status === "completed_rental") continue;
      // Safety guard: skip bookings that end on or before the current effective
      // return date — they cannot conflict with the extension window.  Mirrors
      // the identical guard in the Supabase conflict loop below and acts as the
      // last line of defence when ID matching fails to exclude the active booking
      // (e.g. its returnDate equals effectiveReturnDate but lacks a returnTime,
      // causing the date-only midnight boundary to spill into the extension window).
      if (b.returnDate && b.returnDate <= effectiveReturnDate) continue;

      const hasConflict = hasDateTimeOverlap(
        extensionRange,
        b.pickupDate,
        b.returnDate || b.pickupDate,
        b.pickupTime || "",
        b.returnTime || ""
      );
      if (hasConflict) {
        const fmtDate = new Date(b.pickupDate + "T00:00:00")
          .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        return res.status(409).json({
          error: `The new return date conflicts with another booking starting on ${fmtDate}. ` +
                 "Please choose an earlier return date.",
        });
      }
    }

    // ── Also check Supabase for future booking conflicts ────────────────────
    // bookings.json may not contain all future reservations (e.g. admin-created
    // bookings that are only in Supabase), so run a second conflict pass.
    if (sb) {
      try {
        const activeBookingRef = activeBooking.bookingId || activeBooking.paymentIntentId || "";
        // Floor the pickup_date filter at the effective return date so we catch
        // all bookings that could overlap with the extension window.  Fall back
        // to today if effectiveReturnDate is not set rather than newReturnDate,
        // which is the end of the extension range and would miss earlier pickups.
        const conflictFloorDate = effectiveReturnDate || new Date().toISOString().split("T")[0];
        // Exclude the current renter's own booking at the query level when the
        // canonical booking_ref is known.  This is the first line of defence;
        // the in-loop skip below is a secondary guard for any edge cases.
        let futureQuery = sb
          .from("bookings")
          .select("booking_ref, pickup_date, return_date, pickup_time, return_time")
          .eq("vehicle_id", vehicleId)
          .not("status", "in", "(cancelled,completed_rental)")
          .gte("pickup_date", conflictFloorDate);
        if (sbActiveBookingRef) {
          futureQuery = futureQuery.neq("booking_ref", sbActiveBookingRef);
        }
        const { data: sbFuture } = await futureQuery;

        // Batch-fetch paid, non-cancelled extension revenue_records for this
        // vehicle so we can compute the true finalReturnDate for each
        // conflicting booking.  This guards against stale return_date values
        // in the bookings table (e.g. extension recorded in revenue_records but
        // not yet reflected in bookings.return_date).
        // Only paid extensions with is_cancelled=false are counted — unpaid or
        // cancelled extensions do NOT extend a booking's blocking window.
        let extensionMaxReturnByRef = {};
        if (sbFuture && sbFuture.length > 0) {
          try {
            const { data: extRecords } = await sb
              .from("revenue_records")
              .select("original_booking_id, return_date")
              .eq("vehicle_id", vehicleId)
              .eq("type", "extension")
              .eq("payment_status", "paid")
              .eq("is_cancelled", false)
              .gte("return_date", conflictFloorDate);
            for (const rec of (extRecords || [])) {
              if (!rec.original_booking_id || !rec.return_date) continue;
              const rd = String(rec.return_date).split("T")[0];
              const key = rec.original_booking_id;
              if (!extensionMaxReturnByRef[key] || rd > extensionMaxReturnByRef[key]) {
                extensionMaxReturnByRef[key] = rd;
              }
            }
          } catch (extErr) {
            console.warn("extend-rental: revenue_records extension lookup failed (non-fatal):", extErr.message);
          }
        }

        for (const fbk of (sbFuture || [])) {
          // Skip the current renter's own booking.  activeBookingRef may be a
          // legacy Stripe PI ID that doesn't match booking_ref, so also compare
          // against sbActiveBookingRef (the canonical bk-... ref from Supabase).
          if (
            fbk.booking_ref === activeBookingRef ||
            (sbActiveBookingRef && fbk.booking_ref === sbActiveBookingRef)
          ) continue;

          const fbkPickupDate = String(fbk.pickup_date || "").split("T")[0];
          // Skip bookings without a pickup date or without a return date.
          if (!fbkPickupDate || !fbk.return_date) continue;

          // Compute finalReturnDate: take the maximum of the booking's own
          // return_date and the latest paid extension return_date from
          // revenue_records.  This ensures a booking that has been genuinely
          // extended (and has a paid revenue_record) is not under-counted as a
          // blocking future booking.
          const bookingReturnDate = String(fbk.return_date).split("T")[0];
          const extReturnDate = extensionMaxReturnByRef[fbk.booking_ref] || null;
          const fbkReturnDate = (extReturnDate && extReturnDate > bookingReturnDate)
            ? extReturnDate
            : bookingReturnDate;

          // Safety guard: skip any booking whose effective end date is on or
          // before our current effective return date — such a booking cannot
          // block the extension window.  This is the final line of defence
          // against self-conflict in edge cases (e.g. same-day rentals) where
          // sbActiveBookingRef was not resolved and the active booking appears
          // in the query results.
          if (fbkReturnDate <= effectiveReturnDate) continue;

          // Supabase stores times as "HH:MM:SS"; take first 5 chars → "HH:MM".
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
            const fmtDate = new Date(fbkPickupDate + "T00:00:00")
              .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
            return res.status(409).json({
              error: `The new return date conflicts with another booking starting on ${fmtDate}. ` +
                     "Please choose an earlier return date.",
            });
          }
        }
      } catch (sbConflictErr) {
        console.warn("extend-rental: Supabase conflict check failed (non-fatal):", sbConflictErr.message);
      }
    }
    // ── Compute extension price ────────────────────────────────────────────
    const settings = await loadPricingSettings();
    const isSlingshot = vehicleData.isSlingshot;

    let extensionAmountPreTax;
    let extensionLabel;
    // Hoisted for debug logging below; only populated for economy vehicles.
    let extensionDays = null;
    let pricePerDay   = null;

    if (isSlingshot) {
      // Slingshot: bill by extra hours at daily rate ÷ 24
      const extraMs    = newReturnMs - currentReturnMs;
      const extraHours = Math.max(1, Math.ceil(extraMs / 3600000));
      const dailyRate  = settings.slingshot_daily_rate || 350;
      const hourlyRate = dailyRate / 24;
      extensionAmountPreTax = Math.ceil(extraHours * hourlyRate);
      extensionLabel = `+${extraHours} hour${extraHours !== 1 ? "s" : ""}`;
    } else {
      // Economy/car vehicles: bill by extra days using the same tiered pricing as
      // the main booking flow (monthly → bi-weekly → weekly → daily).
      // Extension days are counted from effectiveReturnDate (the authoritative
      // current return date, preferring Supabase over bookings.json) to
      // newReturnDate — never from today or pickup_date.
      const extraMs   = newReturnMs - currentReturnMs;
      const extraDays = Math.max(1, Math.ceil(extraMs / (24 * 3600000)));
      extensionLabel  = `+${extraDays} day${extraDays !== 1 ? "s" : ""}`;

      const dailyRate   = vehicleData.pricePerDay    || settings.camry_daily_rate    || 55;
      const weeklyRate  = vehicleData.weekly         || settings.camry_weekly_rate   || null;
      const biweekRate  = vehicleData.biweekly       || settings.camry_biweekly_rate || null;
      const monthlyRate = vehicleData.monthly        || settings.camry_monthly_rate  || null;

      let cost      = 0;
      let remaining = extraDays;

      if (monthlyRate && remaining >= 30) {
        const months = Math.floor(remaining / 30);
        cost      += months * monthlyRate;
        remaining  = remaining % 30;
      }
      if (biweekRate && remaining >= 14) {
        const periods = Math.floor(remaining / 14);
        cost      += periods * biweekRate;
        remaining  = remaining % 14;
      }
      if (weeklyRate && remaining >= 7) {
        const weeks = Math.floor(remaining / 7);
        cost      += weeks * weeklyRate;
        remaining  = remaining % 7;
      }
      cost += remaining * dailyRate;

      extensionAmountPreTax = cost;
      extensionDays = extraDays;
      pricePerDay   = dailyRate;
    }

    // Slingshot: no tax — consistent with the main booking flow which also charges no tax.
    // Economy vehicles: apply LA sales tax (same as the main booking flow).
    const extensionAmount = isSlingshot
      ? extensionAmountPreTax
      : applyTax(extensionAmountPreTax, settings);

    // Temporary debug log — compare Camry 2012 vs Camry 2013 outputs to
    // identify stale returnDate or rate mismatch.
    console.log({
      vehicle_id:      vehicleId,
      booking_ref:     activeBooking?.bookingId,
      current_return:  activeBooking?.returnDate,
      effective_return: effectiveReturnDate,
      requested_return: newReturnDate,
      extension_days:  extensionDays,
      daily_rate:      pricePerDay,
      total_amount:    extensionAmount,
    });

    // ── Create Stripe PaymentIntent ─────────────────────────────────────────
    const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);

    const pi = await stripe.paymentIntents.create({
      amount:   Math.round(extensionAmount * 100),
      currency: "usd",
      description: `Rental extension — ${vehicleData.name} — ${extensionLabel} — ${activeBooking.name || ""}`,
      automatic_payment_methods: { enabled: true },
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      receipt_email: activeBooking.email || undefined,
      metadata: {
        payment_type: "rental_extension",
        booking_id:   activeBooking.bookingId || activeBooking.paymentIntentId || "",
        vehicle_id:   vehicleId,
        vehicle_name:        vehicleData.name,
        renter_name:         activeBooking.name  || "",
        renter_email:        activeBooking.email || "",
        renter_phone:        activeBooking.phone || "",
        extension_label:     extensionLabel,
        new_return_date:     newReturnDate,
        new_return_time:     resolvedReturnTime,
      },
    });

    // ── Store extensionPendingPayment on the booking ────────────────────────
    // updateBooking() uses updateJsonFileWithRetry internally and handles SHA
    // conflicts gracefully.
    const bookingId = activeBooking.bookingId || activeBooking.paymentIntentId;
    if (bookingId) {
      try {
        await updateBooking(vehicleId, bookingId, {
          ...(needsReturnTimePersist ? { returnTime: resolvedReturnTime } : {}),
          extensionPendingPayment: {
            label:           extensionLabel,
            price:           extensionAmount,
            newReturnDate,
            newReturnTime:   resolvedReturnTime,
            paymentIntentId: pi.id,
            createdAt:       new Date().toISOString(),
          },
        });
      } catch (updateErr) {
        // Non-fatal: the webhook can fall back to PI metadata if the booking
        // record was not updated.
        console.warn("extend-rental: could not update extensionPendingPayment (non-fatal):", updateErr.message);
      }
    }

    return res.status(200).json({
      clientSecret:    pi.client_secret,
      publishableKey:  process.env.STRIPE_PUBLISHABLE_KEY,
      extensionAmount: extensionAmount.toFixed(2),
      extensionLabel,
      newReturnDate,
      newReturnTime:   resolvedReturnTime,
      vehicleName:     vehicleData.name,
      renterName:      activeBooking.name || "",
    });
  } catch (err) {
    console.error("extend-rental error:", err);
    return res.status(500).json({ error: "Failed to create extension payment. Please try again or call (213) 916-6606." });
  }
}
