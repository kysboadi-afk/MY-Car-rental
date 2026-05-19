import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { dispatchSms } from "./_sms-dispatcher.js";
import { normalizePhone } from "./_bookings.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const ACTIVE_RENTER_STATUSES = ["active_rental", "active", "overdue"];
const CAMPAIGN_TEMPLATE_KEY = "active_renter_manage_booking_education_2026_05";
const CAMPAIGN_SOURCE = "admin_active_renters_manage_booking_sms";
const CAMPAIGN_MESSAGE =
  "SLY Rides update: To view or extend your current rental, use Manage Booking:\n" +
  "https://slycarrentals.com/manage-booking.html\n\n" +
  "Use the booking details from your confirmation if prompted. Reply STOP to opt out.";

function pickPhone(booking) {
  return normalizePhone(
    booking?.renter_phone ||
    booking?.customer_phone ||
    booking?.phone ||
    ""
  );
}

function pickPreferredBooking(existing, candidate) {
  if (!existing) return candidate;
  const existingRef = String(existing.booking_ref || "");
  const candidateRef = String(candidate.booking_ref || "");
  if (!candidateRef) return existing;
  if (!existingRef) return candidate;
  return candidateRef < existingRef ? candidate : existing;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!isAdminConfigured()) {
    return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
  }

  const body = req.body || {};
  const { secret, dryRun = false } = body;
  if (!isAdminAuthorized(secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: "Supabase not configured." });

  const { data: bookings, error } = await sb
    .from("bookings")
    .select("booking_ref, vehicle_id, status, renter_phone, customer_phone, phone")
    .in("status", ACTIVE_RENTER_STATUSES);

  if (error) {
    console.error("[admin-active-renters-manage-booking-sms] bookings query error:", error.message);
    return res.status(500).json({ error: "Could not load active renters: " + error.message });
  }

  const byPhone = new Map();
  let skippedNoPhone = 0;
  for (const booking of bookings || []) {
    const phone = pickPhone(booking);
    if (!phone) {
      skippedNoPhone += 1;
      continue;
    }
    const current = byPhone.get(phone) || null;
    byPhone.set(phone, pickPreferredBooking(current, booking));
  }

  const targets = Array.from(byPhone.entries()).map(([phone, booking]) => ({ phone, booking }));
  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dryRun: true,
      templateKey: CAMPAIGN_TEMPLATE_KEY,
      totalBookings: (bookings || []).length,
      uniqueRenters: targets.length,
      skippedNoPhone,
      sampleBookingRefs: targets.slice(0, 10).map((t) => t.booking.booking_ref || null),
    });
  }

  let sent = 0;
  let deduped = 0;
  let failed = 0;
  for (const target of targets) {
    const bookingRef = String(target.booking?.booking_ref || "").trim();
    if (!bookingRef) {
      failed += 1;
      continue;
    }
    const result = await dispatchSms({
      bookingId: bookingRef,
      vehicleId: target.booking?.vehicle_id || null,
      templateKey: CAMPAIGN_TEMPLATE_KEY,
      phone: target.phone,
      body: CAMPAIGN_MESSAGE,
      metadata: {
        campaign: CAMPAIGN_TEMPLATE_KEY,
        status: target.booking?.status || null,
      },
      dedupe: true,
      source: CAMPAIGN_SOURCE,
      throwOnError: false,
    });
    if (result?.sent) {
      sent += 1;
      continue;
    }
    if (result?.dedupSkipped || result?.skipped) {
      deduped += 1;
      continue;
    }
    failed += 1;
  }

  return res.status(200).json({
    ok: true,
    dryRun: false,
    templateKey: CAMPAIGN_TEMPLATE_KEY,
    message: CAMPAIGN_MESSAGE,
    totalBookings: (bookings || []).length,
    targetedRenters: targets.length,
    skippedNoPhone,
    sent,
    deduped,
    failed,
  });
}
