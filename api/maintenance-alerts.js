// api/maintenance-alerts.js
// Fleet maintenance alert cron — driver notifications + escalation system.
//
// GET  /api/maintenance-alerts  — Vercel cron trigger (no auth required from Vercel)
// POST /api/maintenance-alerts  — Manual trigger; requires Authorization: Bearer <ADMIN_SECRET|CRON_SECRET>
//
// Applies ONLY to Bouncie-tracked vehicles (bouncie_device_id IS NOT NULL, non-slingshot).
// Only sends alerts when the vehicle has an ACTIVE booking (status = "active_rental").
//
// Flow per vehicle × service type (oil | brakes | tires):
//   ≥80%  (warn):     Send driver SMS warning — once per booking per service type
//   ≥100% (urgent):   Send driver SMS urgent   — once per booking per service type
//   ≥100% + 48 h after urgent, no service recorded → escalate:
//     • Driver SMS final notice
//     • Owner SMS  → OWNER_PHONE (env var, default +12139166606)
//     • Owner email → OWNER_EMAIL (env var, default slyservices@supports-info.com)
//     • booking.maintenance_status = "non_compliant" persisted to bookings.json
//     • vehicle.data.service_required = true persisted to Supabase
//
// Deduplication: uses booking.smsSentAt[key] (ISO timestamp) — same pattern as
// scheduled-reminders.js. Keys: maint_<type>_warn | maint_<type>_urgent | maint_<type>_escalate

import nodemailer from "nodemailer";
import { getSupabaseAdmin } from "./_supabase.js";
import { sendSms } from "./_textmagic.js";
import { loadBookings, saveBookings, normalizePhone } from "./_bookings.js";
import { updateJsonFileWithRetry } from "./_github-retry.js";
import { adminErrorMessage } from "./_error-helpers.js";
import { buildServiceUrl } from "./_quick-service-token.js";
import {
  render,
  MAINTENANCE_AVAILABILITY_REQUEST,
  MAINTENANCE_AVAILABILITY_FOLLOWUP,
  MAINTENANCE_AVAILABILITY_URGENT,
  MAINTENANCE_AVAILABILITY_ESCALATION,
} from "./_sms-templates.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const OWNER_PHONE = process.env.OWNER_PHONE || "+12139166606";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "slyservices@supports-info.com";

const ESCALATION_DELAY_MS = 48 * 60 * 60 * 1000; // 48 hours

// Hours after warn SMS before a "please schedule" follow-up is sent.
// Configurable via MAINT_SCHEDULE_HOURS env var (default: 24 h).
const SCHEDULE_REMINDER_HOURS = Math.max(1, Number(process.env.MAINT_SCHEDULE_HOURS) || 24);
const SCHEDULE_REMINDER_MS    = SCHEDULE_REMINDER_HOURS * 60 * 60 * 1000;

// Base URL for owner/admin quick-service links (NOT sent to customers)
const SITE_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://www.slytrans.com";

// Service definitions — intervals match lib/ai/mileage.js
const SERVICES = [
  {
    type:     "oil",
    col:      "last_oil_change_mileage",
    interval: 3000,
    label:    "oil change",
    warnPct:  0.8,
  },
  {
    type:     "brakes",
    col:      "last_brake_check_mileage",
    interval: 10000,
    label:    "brake inspection",
    warnPct:  0.8,
  },
  {
    type:     "tires",
    col:      "last_tire_change_mileage",
    interval: 20000,
    label:    "tire replacement",
    warnPct:  0.8,
  },
];

// Deduplication key helpers (stored in booking.smsSentAt)
const keyWarn        = (type) => `maint_${type}_warn`;
const keyUrgent      = (type) => `maint_${type}_urgent`;
const keyEscalate    = (type) => `maint_${type}_escalate`;
const keySchedRemind = (type) => `maint_${type}_sched_remind`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function alreadySent(booking, key) {
  return !!(booking.smsSentAt && booking.smsSentAt[key]);
}

async function safeSendSms(phone, body) {
  try {
    const normalized = normalizePhone(phone);
    if (!normalized) return false;
    await sendSms(normalized, body);
    return true;
  } catch (err) {
    console.warn(`maintenance-alerts: SMS to ${phone} failed:`, err.message);
    return false;
  }
}

async function sendOwnerAlertEmail(subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("maintenance-alerts: SMTP not configured — owner email skipped");
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    process.env.SMTP_USER,
      to:      OWNER_EMAIL,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.warn("maintenance-alerts: owner email failed:", err.message);
    return false;
  }
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth: GET is implicitly trusted by Vercel cron; POST requires Bearer token.
  if (req.method === "POST") {
    const auth  = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (
      !token ||
      (token !== process.env.ADMIN_SECRET && token !== process.env.CRON_SECRET)
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  } else if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    return res.status(503).json({ error: "Supabase is not configured" });
  }

  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) {
    return res.status(200).json({ skipped: true, reason: "TextMagic not configured — set TEXTMAGIC_USERNAME and TEXTMAGIC_API_KEY" });
  }

  const startedAt = Date.now();

  try {
    // ── 1. Load tracked vehicles with per-service mileage ───────────────────
    const { data: vehicleRows, error: vehiclesErr } = await sb
      .from("vehicles")
      .select("vehicle_id, mileage, bouncie_device_id, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, data")
      .not("bouncie_device_id", "is", null);

    if (vehiclesErr) throw new Error(`Supabase vehicles fetch failed: ${vehiclesErr.message}`);

    const trackedVehicles = (vehicleRows || []).filter((r) => {
      const type = r.data?.type || r.data?.vehicle_type || "";
      return type !== "slingshot";
    });

    if (trackedVehicles.length === 0) {
      return res.status(200).json({
        ran_at:      new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        alerts_sent: 0,
        escalations: 0,
        detail:      "No Bouncie-tracked non-slingshot vehicles found",
      });
    }

    // ── 2. Load all bookings; build vehicle → active booking map ────────────
    const { data: allBookingsRaw } = await loadBookings();
    const activeBookingByVehicle = {};
    for (const [vid, bookings] of Object.entries(allBookingsRaw || {})) {
      const active = Array.isArray(bookings)
        ? bookings.find((b) => b.status === "active_rental")
        : null;
      if (active) activeBookingByVehicle[vid] = active;
    }

    // ── 3. Process each vehicle ──────────────────────────────────────────────
    const sentMarks      = [];   // { vehicleId, id, key } — dedup marks
    const bookingUpdates = [];   // { vehicleId, id, patch } — maintenance_status
    const escalations    = [];   // summary for response
    let   alertsSent     = 0;

    for (const row of trackedVehicles) {
      const vid     = row.vehicle_id;
      const miles   = Number(row.mileage) || 0;
      const name    = row.data?.vehicle_name || vid;
      const booking = activeBookingByVehicle[vid];

      if (!booking) continue; // No active rental — no driver to notify

      const bookingId = booking.bookingId || booking.paymentIntentId;
      const phone     = booking.phone;

      for (const svc of SERVICES) {
        // Resolve last-service mileage for this specific service type
        const lastMi  = row[svc.col] != null
          ? Number(row[svc.col])
          : Number(row.data?.last_service_mileage) || 0;
        const since   = Math.max(0, miles - lastMi);
        const pct     = since / svc.interval;

        if (pct < svc.warnPct) continue; // Below warning threshold

        const kWarn     = keyWarn(svc.type);
        const kUrgent   = keyUrgent(svc.type);
        const kEscalate = keyEscalate(svc.type);

        if (pct >= 1.0) {
          // ── Overdue (100%+) ──────────────────────────────────────────────
          if (!alreadySent(booking, kUrgent)) {
            // Send urgent notification — friendly tone, no technical details or links
            const customerName = booking.name || "there";
            const sent = await safeSendSms(phone,
              render(MAINTENANCE_AVAILABILITY_URGENT, { customer_name: customerName })
            );
            if (sent) {
              sentMarks.push({ vehicleId: vid, id: bookingId, key: kUrgent });
              alertsSent++;
            }
          } else if (!alreadySent(booking, kEscalate)) {
            // Check 48 h escalation window
            const urgentAt  = new Date(booking.smsSentAt[kUrgent]).getTime();
            const hoursWaited = (Date.now() - urgentAt) / 3600000;

            if (Date.now() - urgentAt >= ESCALATION_DELAY_MS) {
              // ── Escalation ───────────────────────────────────────────────
              const customerName = booking.name || "there";
              const driverSent = await safeSendSms(phone,
                render(MAINTENANCE_AVAILABILITY_ESCALATION, { customer_name: customerName })
              );
              const serviceUrl = buildServiceUrl(vid, svc.type);
              const ownerSmsSent = await safeSendSms(OWNER_PHONE,
                `🚨 ${name} driver has ignored ${svc.label} request for ${Math.floor(hoursWaited)}h. Booking: ${bookingId}. Driver: ${booking.name || "Unknown"} (${phone || "no phone"}). Mark done: ${serviceUrl}`
              );
              await sendOwnerAlertEmail(
                `🚨 Maintenance Non-Compliance — ${name}`,
                `<p>🚨 <strong>${name}</strong> driver has ignored a maintenance request for ${Math.floor(hoursWaited)} hours.</p>
<p><strong>Service required:</strong> ${svc.label}</p>
<p><strong>Miles since last service:</strong> ${Math.round(since).toLocaleString()} mi (interval: ${svc.interval.toLocaleString()} mi)</p>
<p><strong>Booking ID:</strong> ${bookingId}</p>
<p><strong>Driver:</strong> ${booking.name || "Unknown"}</p>
<p><strong>Driver phone:</strong> ${phone || "N/A"}</p>
<p><strong>Current odometer:</strong> ${miles.toLocaleString()} mi</p>
<p>Please review and take action immediately.</p>
<p><a href="${serviceUrl}" style="display:inline-block;padding:10px 20px;background:#2e7d32;color:#fff;border-radius:4px;text-decoration:none">✅ Mark ${svc.label} as complete</a></p>
<p style="font-size:12px;color:#888">This link expires in 30 minutes. Open a new alert to get a fresh link.</p>`
              );

              if (driverSent || ownerSmsSent) {
                sentMarks.push({ vehicleId: vid, id: bookingId, key: kEscalate });
                alertsSent++;
                escalations.push({ vehicleId: vid, bookingId, serviceType: svc.type, name });

                // Mark booking as non_compliant
                bookingUpdates.push({
                  vehicleId: vid,
                  id:        bookingId,
                  patch:     { maintenance_status: "non_compliant" },
                });

                // Flag vehicle as service_required in Supabase JSONB (non-fatal)
                sb.from("vehicles")
                  .update({
                    data:       { ...(row.data || {}), service_required: true },
                    updated_at: new Date().toISOString(),
                  })
                  .eq("vehicle_id", vid)
                  .then(() => {})
                  .catch((err) =>
                    console.warn(`maintenance-alerts: vehicle flag failed for ${vid}:`, err.message)
                  );
              }
            }
          }
        } else {
          // ── Due Soon (80%–100%) ──────────────────────────────────────────
          const kSchedRemind = keySchedRemind(svc.type);
          if (!alreadySent(booking, kWarn)) {
            // Friendly first-contact message — no service type, no links
            const customerName = booking.name || "there";
            const sent = await safeSendSms(phone,
              render(MAINTENANCE_AVAILABILITY_REQUEST, { customer_name: customerName })
            );
            if (sent) {
              sentMarks.push({ vehicleId: vid, id: bookingId, key: kWarn });
              alertsSent++;
            }
          } else if (!alreadySent(booking, kSchedRemind)) {
            // ── Schedule follow-up — if no appointment was booked within X hours ──
            const warnAt = new Date(booking.smsSentAt[kWarn]).getTime();
            if (Date.now() - warnAt >= SCHEDULE_REMINDER_MS) {
              // Check whether an appointment already exists for this vehicle+service
              let hasAppointment = false;
              try {
                const { data: appts } = await sb
                  .from("maintenance_appointments")
                  .select("id")
                  .eq("vehicle_id", vid)
                  .eq("service_type", svc.type)
                  .in("status", ["pending_approval", "scheduled"])
                  .limit(1);
                hasAppointment = Array.isArray(appts) && appts.length > 0;
              } catch (err) {
                console.warn(`maintenance-alerts: appointment check failed for ${vid}:`, err.message);
              }

              if (!hasAppointment) {
                const customerName = booking.name || "there";
                const sent = await safeSendSms(phone,
                  render(MAINTENANCE_AVAILABILITY_FOLLOWUP, { customer_name: customerName })
                );
                if (sent) {
                  sentMarks.push({ vehicleId: vid, id: bookingId, key: kSchedRemind });
                  alertsSent++;
                }
              }
            }
          }
        }
      }
    }

    // ── 4. Persist dedup marks + booking patches atomically ─────────────────
    if ((sentMarks.length > 0 || bookingUpdates.length > 0) && process.env.GITHUB_TOKEN) {
      try {
        await updateJsonFileWithRetry({
          load:  loadBookings,
          apply: (data) => {
            // Apply dedup sentAt marks
            for (const { vehicleId, id, key } of sentMarks) {
              const bookings = data[vehicleId];
              if (!Array.isArray(bookings)) continue;
              const idx = bookings.findIndex(
                (b) => b.bookingId === id || b.paymentIntentId === id
              );
              if (idx === -1) continue;
              if (!bookings[idx].smsSentAt) bookings[idx].smsSentAt = {};
              bookings[idx].smsSentAt[key] = new Date().toISOString();
            }
            // Apply booking status patches
            for (const { vehicleId, id, patch } of bookingUpdates) {
              const bookings = data[vehicleId];
              if (!Array.isArray(bookings)) continue;
              const idx = bookings.findIndex(
                (b) => b.bookingId === id || b.paymentIntentId === id
              );
              if (idx === -1) continue;
              Object.assign(bookings[idx], patch);
            }
          },
          save:    saveBookings,
          message: `maintenance-alerts: ${sentMarks.length} alert marks, ${bookingUpdates.length} booking patches`,
        });
      } catch (err) {
        console.error("maintenance-alerts: failed to persist marks:", err.message);
      }
    }

    return res.status(200).json({
      ran_at:             new Date().toISOString(),
      duration_ms:        Date.now() - startedAt,
      vehicles_checked:   trackedVehicles.length,
      active_bookings:    Object.keys(activeBookingByVehicle).length,
      alerts_sent:        alertsSent,
      escalations:        escalations.length,
      escalation_details: escalations,
    });
  } catch (err) {
    console.error("maintenance-alerts error:", err);
    return res.status(500).json({ error: adminErrorMessage(err) });
  }
}
