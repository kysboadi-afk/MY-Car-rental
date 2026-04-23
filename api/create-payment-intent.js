// api/create-payment-intent.js
// Vercel serverless function — creates a Stripe PaymentIntent so the
// embedded Stripe Payment Element can be mounted on the booking page.
//
// Required environment variables (set in Vercel dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
//   STRIPE_PUBLISHABLE_KEY  — starts with pk_live_ or pk_test_
import crypto from "crypto";
import Stripe from "stripe";
import { computeRentalDays, SLINGSHOT_DEPOSIT_WITH_INSURANCE, SLINGSHOT_DEPOSIT_WITHOUT_INSURANCE } from "./_pricing.js";
import { loadPricingSettings, computeCarAmountFromVehicleData, computeSlingshotAmountFromSettings, computeDppCostFromSettings, applyTax } from "./_settings.js";
import { isDatesAndTimesAvailable, isVehicleAvailable, findAvailableSlingshotUnit } from "./_availability.js";
import { getVehicleById } from "./_vehicles.js";
import { normalizeClockTime, deriveReturnTime } from "./_time.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];

/**
 * Derive the canonical vehicle_id to embed in Stripe PaymentIntent metadata.
 *
 * Uses the raw vehicle ID from the booking flow whenever present so UI and DB
 * IDs stay exactly aligned. Only falls back to a name-derived ID when no
 * vehicle_id was provided.
 *
 * Examples:
 *   ("camry", "Camry 2012") → "camry"
 *   ("camry2013", "Camry 2013 SE") → "camry2013"
 *   ("", "Slingshot R") → "slingshot"
 *   ("slingshot2","Slingshot R")   → "slingshot2"  (id already specific)
 *
 * @param {string} vehicleIdRaw  - internal vehicle key (e.g. "camry")
 * @param {string} vehicleNameRaw - human-readable name (e.g. "Camry 2012")
 * @returns {string} canonical vehicle_id
 */
function canonicalVehicleIdForStripe(vehicleIdRaw, vehicleNameRaw) {
  const normId = String(vehicleIdRaw || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  let nameId = "";
  if (vehicleNameRaw) {
    const allTokens = String(vehicleNameRaw).toLowerCase().replace(/[^a-z0-9]/g, " ").trim().split(/\s+/);
    const parts = [];
    for (const t of allTokens) {
      if (/^[a-z]$/.test(t)) continue; // skip single-letter tokens (e.g. "r")
      parts.push(t);
      if (/\d/.test(t)) break;         // stop after first numeric token (year)
    }
    if (parts.length > 0) nameId = parts.join("");
  }

  return normId || nameId;
}

export default async function handler(req, res) {
  // CORS — allow requests from the production frontend
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Guard: fail fast if Stripe keys are missing (common setup mistake)
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_SECRET_KEY is missing. Add it in your Vercel project → Settings → Environment Variables." });
  }
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error("STRIPE_PUBLISHABLE_KEY environment variable is not set");
    return res.status(500).json({ error: "Server configuration error: STRIPE_PUBLISHABLE_KEY is missing. Add it in your Vercel project → Settings → Environment Variables." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vehicleId, name, email, phone, pickup, returnDate, protectionPlan, protectionPlanTier, slingshotDuration, paymentMode, insuranceCoverageChoice, pickupTime, returnTime, adminOverride, testMode } = req.body;
    const adminOverrideEnabled = adminOverride === true || /^(true|1)$/i.test(String(adminOverride || ""));
    const testModeEnabled = testMode === true || /^(true|1)$/i.test(String(testMode || ""));
    const testAvailabilityOverride = adminOverrideEnabled && testModeEnabled;

    // Validate vehicleId against the live vehicle database (CARS → Supabase → vehicles.json)
    const vehicleData = vehicleId ? await getVehicleById(vehicleId) : null;
    if (!vehicleData) {
      return res.status(400).json({ error: "Invalid vehicle" });
    }

    const isSlingshotVehicle = vehicleData.isSlingshot;

    // Pickup time is required for all vehicles — it anchors the rental window and
    // is enforced as the return time for economy cars (return_time = pickup_time).
    const trimmedPickupTime = normalizeClockTime(pickupTime);
    if (!trimmedPickupTime) {
      return res.status(400).json({ error: "Pickup time is required. Please select a pickup time before proceeding." });
    }
    const trimmedReturnTime = normalizeClockTime(returnTime);
    if (!trimmedReturnTime) {
      return res.status(400).json({ error: "Return time is required. Please select a return time before proceeding." });
    }

    // For hourly-tier vehicles (Slingshot), validate the hourly duration selection
    if (isSlingshotVehicle) {
      if (!slingshotDuration || ![3, 6, 24, 48, 72].includes(Number(slingshotDuration))) {
        return res.status(400).json({ error: "Invalid rental duration for Slingshot. Please select 3 hours, 6 hours, 24 hours, 2 days, or 3 days." });
      }
    }

    // For economy (non-Slingshot) vehicles: enforce that the renter declared either
    // personal auto insurance (verified at pickup) OR selected a valid DPP tier.
    // This is a server-side guard that cannot be bypassed via browser DevTools.
    if (!isSlingshotVehicle) {
      if (insuranceCoverageChoice !== "yes" && insuranceCoverageChoice !== "no") {
        return res.status(400).json({ error: "Please indicate whether you have personal auto insurance or would like to add a Damage Protection Plan." });
      }
      if (insuranceCoverageChoice === "no") {
        if (protectionPlan !== true || !["basic", "standard", "premium"].includes(protectionPlanTier)) {
          return res.status(400).json({ error: "A valid Damage Protection Plan (Basic, Standard, or Premium) is required when you do not have personal auto insurance." });
        }
      }
    }

    // Validate dates
    const pickupD = new Date(pickup + "T00:00:00");
    const returnD = new Date(returnDate + "T00:00:00");
    if (isNaN(pickupD.getTime()) || isNaN(returnD.getTime()) || returnD < pickupD) {
      return res.status(400).json({ error: "Invalid dates" });
    }

    const derivedReturnTime = isSlingshotVehicle
      ? deriveReturnTime(pickup, trimmedPickupTime, trimmedReturnTime, slingshotDuration)
      : trimmedPickupTime;

    // ── Availability check ──────────────────────────────────────────────────
    // For Slingshot: auto-assign the first available unit — customers book a
    // generic "Slingshot" and we give them whichever unit is free.
    // For economy cars: check only the specific requested vehicle.
    // Both checks are time-aware: a booking from 9 AM to 9 AM does not block
    // a subsequent booking starting at 9 AM on the same return date.
    let assignedVehicleId = vehicleId;
    console.log("[VEHICLE_ID_INPUT]", JSON.stringify({
      vehicleId_raw:  vehicleId,
      vehicle_name:   vehicleData?.name || null,
    }));
    if (!testAvailabilityOverride) {
      if (isSlingshotVehicle) {
        // Compute the Slingshot return time from pickup time + duration so the
        // overlap check is precise at the hour level.
        const unit = await findAvailableSlingshotUnit(pickup, returnDate, trimmedPickupTime, derivedReturnTime);
        if (!unit) {
          return res.status(409).json({ error: "No Slingshot units are available for these dates. Please select different dates or call us at (213) 916-6606." });
        }
        assignedVehicleId = unit;
      } else {
        // For economy cars the return time always equals the pickup time.
        // Use the same time for both bounds so the check is symmetric.
        const available = await isDatesAndTimesAvailable(vehicleId, pickup, returnDate, trimmedPickupTime, trimmedPickupTime);
        if (!available) {
          return res.status(409).json({ error: "These dates are no longer available. Please select different dates." });
        }

        // Check vehicle-level availability — reject if the vehicle is globally marked unavailable
        const vehicleAvailable = await isVehicleAvailable(vehicleId);
        if (!vehicleAvailable) {
          return res.status(409).json({ error: "This vehicle is currently unavailable for booking. Please browse other available vehicles." });
        }
      }
    }

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Validate name
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }
    const trimmedName = name.trim();

    // Validate phone — required so we can contact the renter and link them to a customer record
    const trimmedPhone = phone && typeof phone === "string" ? phone.trim() : "";
    if (!trimmedPhone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Load live pricing from Supabase system_settings (admin-configurable).
    // Falls back to hardcoded _pricing.js defaults when Supabase is unavailable.
    const settings = await loadPricingSettings();

    // Compute amount server-side — never trust a client-supplied amount.
    const computedFullRental = isSlingshotVehicle
      ? computeSlingshotAmountFromSettings(Number(slingshotDuration), settings)
      : computeCarAmountFromVehicleData(vehicleData, pickup, returnDate, settings);

    // Slingshot: no Damage Protection Plan — DPP has been removed for Slingshot.
    // Economy cars: add DPP cost when the renter opted in.
    const days = isSlingshotVehicle ? Math.max(1, Math.ceil(Number(slingshotDuration) / 24)) : computeRentalDays(pickup, returnDate);
    const tier = isSlingshotVehicle ? null : (protectionPlanTier || null);
    const protectionCost = (!isSlingshotVehicle && protectionPlan) ? computeDppCostFromSettings(days, tier) : 0;

    // For Slingshot: no tax — total is rental fee + security deposit only.
    // Security deposit = rental fee (computedFullRental is already rental × 2 from _settings).
    // For Slingshot deposit-only mode: charge only the security deposit (= rental fee) now.
    // For Camry with paymentMode:'deposit': charge only the booking deposit now; rest at pickup.
    // For all other Camry modes: charge the after-tax total.
    const preTaxFullRental = computedFullRental + protectionCost;
    const afterTaxFullRental = applyTax(preTaxFullRental, settings);

    // Slingshot-specific amounts (no tax applied).
    // computeSlingshotAmountFromSettings() returns tier.price × 2 (rental + security deposit),
    // where the security deposit equals the rental fee. So dividing by 2 gives each component.
    const slingshotRentalFee = isSlingshotVehicle ? computedFullRental / 2 : 0;
    const slingshotSecurityDeposit = slingshotRentalFee; // security deposit = rental fee
    const slingshotFullTotal = computedFullRental; // rental + deposit, no tax

    let totalAmount;

    if (isSlingshotVehicle) {
      if (paymentMode === "deposit") {
        // Deposit-only: charge security deposit now, remaining rental fee paid later
        totalAmount = slingshotSecurityDeposit;
      } else {
        // Full payment: rental + security deposit, no tax
        totalAmount = slingshotFullTotal;
      }
    } else if (paymentMode === "deposit") {
      totalAmount = settings.camry_booking_deposit;
    } else {
      totalAmount = afterTaxFullRental;
    }

    const isCamryDepositMode = !isSlingshotVehicle && paymentMode === "deposit";
    const isSlingshotDepositMode = isSlingshotVehicle && paymentMode === "deposit";

    // Find or create a Stripe Customer so the card can be saved for future
    // off-session charges (e.g., damages, late fees).
    let stripeCustomerId;
    try {
      const existingCustomers = await stripe.customers.list({ email, limit: 1 });
      if (existingCustomers.data.length > 0) {
        stripeCustomerId = existingCustomers.data[0].id;
      } else {
        const newCustomer = await stripe.customers.create({
          email,
          name: trimmedName,
          ...(trimmedPhone ? { phone: trimmedPhone } : {}),
        });
        stripeCustomerId = newCustomer.id;
      }
    } catch (custErr) {
      console.error("Stripe Customer create/lookup error:", custErr.message);
      return res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }

    // Generate a stable booking ID that links the PaymentIntent to the booking record.
    const bookingId = "bk-" + crypto.randomBytes(6).toString("hex");

    const paymentIntentParams = {
      amount: Math.round(totalAmount * 100), // Stripe expects whole cents
      currency: "usd",
      customer: stripeCustomerId,
      // Save the card for future off-session charges (damages, late fees, etc.).
      setup_future_usage: "off_session",
      receipt_email: email,
      description: isSlingshotVehicle
        ? (isSlingshotDepositMode
            ? `Sly Transportation Services LLC – ${vehicleData.name} Reservation (Security Deposit)`
            : `Sly Transportation Services LLC – ${vehicleData.name} Rental`)
        : (isCamryDepositMode
            ? `Sly Transportation Services LLC – ${vehicleData.name} Reservation Deposit (Non-Refundable)`
            : `Sly Transportation Services LLC – ${vehicleData.name}`),
      // Automatic payment methods lets Stripe surface Apple Pay, Google Pay, and
      // other wallets in addition to cards — without maintaining an explicit list.
      automatic_payment_methods: { enabled: true },
      // Request 3D Secure authentication automatically for high-risk card payments.
      // Stripe Radar decides when to trigger it; low-risk transactions flow through
      // without extra friction.
      payment_method_options: {
        card: { request_three_d_secure: "automatic" },
      },
      // Store full booking context so every payment is auditable from the
      // Stripe dashboard and can be reconciled with booked-dates.json if needed.
      // Stripe stores metadata as plain text (not HTML) so no HTML escaping is
      // needed here — values are only rendered in the Stripe dashboard.
      metadata: (() => {
        const canonicalVehicleId = canonicalVehicleIdForStripe(assignedVehicleId, vehicleData.name);
        console.log("[VEHICLE_ID_STRIPE]", JSON.stringify({
          vehicleId_raw:       vehicleId,
          vehicleId_assigned:  assignedVehicleId,
          vehicleId_canonical: canonicalVehicleId,
          vehicle_name:        vehicleData.name,
        }));
        return {
        booking_id:         bookingId,
        stripe_customer_id: stripeCustomerId,
        renter_name:  trimmedName,
        renter_phone: trimmedPhone,
        vehicle_id:   canonicalVehicleId,
        vehicle_name: vehicleData.name,
        pickup_date:  pickup,
        return_date:  returnDate,
        pickup_time:  trimmedPickupTime,
        return_time:  derivedReturnTime,
        email,
        ...(isSlingshotVehicle ? {
          rental_duration: Number(slingshotDuration) >= 48
            ? `${Number(slingshotDuration) / 24} days`
            : `${slingshotDuration} hours`,
        } : {}),
        ...(isSlingshotVehicle && !isSlingshotDepositMode ? {
          payment_type:         "full_payment",
          slingshot_payment_status: "fully_paid",
          slingshot_booking_status: "reserved",
          rental_price:         slingshotRentalFee.toFixed(2),
          security_deposit:     slingshotSecurityDeposit.toFixed(2),
          amount_paid:          slingshotFullTotal.toFixed(2),
          remaining_balance:    "0.00",
          full_rental_amount:   slingshotFullTotal.toFixed(2),
          insurance_status:     insuranceCoverageChoice === "yes" ? "own_insurance_provided" : "no_insurance_no_dpp",
        } : {}),
        ...(isSlingshotDepositMode ? {
          payment_type:              "slingshot_security_deposit",
          slingshot_payment_status:  "deposit_paid",
          slingshot_booking_status:  "reserved",
          rental_price:              slingshotRentalFee.toFixed(2),
          security_deposit:          slingshotSecurityDeposit.toFixed(2),
          amount_paid:               slingshotSecurityDeposit.toFixed(2),
          remaining_balance:         slingshotRentalFee.toFixed(2),
          full_rental_amount:        slingshotFullTotal.toFixed(2),
          insurance_status:          insuranceCoverageChoice === "yes" ? "own_insurance_provided" : "no_insurance_no_dpp",
        } : {}),
        ...(!isSlingshotVehicle && !isCamryDepositMode ? {
          payment_type:        "full_payment",
          full_rental_amount:  afterTaxFullRental.toFixed(2),
          ...( protectionPlan && tier ? { protection_plan_tier: tier } : {} ),
        } : {}),
        ...(isCamryDepositMode ? {
          payment_type:        "reservation_deposit",
          deposit_refundable:  "false",
          full_rental_amount:  afterTaxFullRental.toFixed(2),
          balance_at_pickup:   (afterTaxFullRental - settings.camry_booking_deposit).toFixed(2),
          ...( protectionPlan && tier ? { protection_plan_tier: tier } : {} ),
        } : {}),
      };
      })(),
    };

    // All payments use automatic capture
    const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      bookingId,
      stripeCustomerId,
    });
  } catch (err) {
    console.error("Stripe PaymentIntent error:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
}
