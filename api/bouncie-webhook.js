// api/bouncie-webhook.js
// Bouncie GPS webhook receiver — handles real-time vehicle events pushed by Bouncie.
//
// Register this URL in the Bouncie Developer Portal:
//   https://www.slytrans.com/api/bouncie-webhook
//
// Webhook security: configure BOUNCIE_WEBHOOK_SECRET in Vercel to match the
// Authorization key you set in the Bouncie Developer Portal.
// Bouncie sends the key in both the Authorization header and the
// X-Bouncie-Authorization header on every request.
//
// Handled event types:
//   tripEnd     — odometer reading at trip end → upsert vehicle_mileage
//   tripMetrics — per-trip driving stats       → insert trip_log
//   mil         — check engine light ON        → log alert to ai_logs
//   battery     — low/critical battery         → log alert to ai_logs
//   (all others are accepted with 200 but not stored)
//
// POST /api/bouncie-webhook
//
// Required env vars:
//   BOUNCIE_WEBHOOK_SECRET  — your webhook key (set in Bouncie Developer Portal)
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

import { parseDeviceMap, resolveVehicleId, upsertMileage, insertTripLog } from "./_bouncie.js";
import { getSupabaseAdmin } from "./_supabase.js";
import { adminErrorMessage } from "./_error-helpers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ── Authenticate ─────────────────────────────────────────────────────────
  const webhookSecret = process.env.BOUNCIE_WEBHOOK_SECRET;
  if (webhookSecret) {
    // Bouncie sends the key in Authorization; some platforms strip it so they
    // also mirror it in X-Bouncie-Authorization.
    const authHeader =
      req.headers["authorization"] ||
      req.headers["x-bouncie-authorization"] ||
      "";
    if (authHeader !== webhookSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const body = req.body || {};
  const { eventType, imei } = body;

  if (!eventType || !imei) {
    return res.status(400).json({ error: "Missing eventType or imei" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) {
    // Accept with 200 to prevent Bouncie retries when Supabase is not configured
    return res.status(200).json({ received: true, stored: false, reason: "Supabase not configured" });
  }

  // ── Resolve IMEI → vehicle_id ─────────────────────────────────────────────
  const deviceMap = parseDeviceMap();
  let vehicleId   = resolveVehicleId(imei, body.nickName, deviceMap);

  // Fall back to a previously synced mapping in the vehicle_mileage table
  if (!vehicleId) {
    const { data: row } = await sb
      .from("vehicle_mileage")
      .select("vehicle_id")
      .eq("bouncie_imei", imei)
      .maybeSingle();
    vehicleId = row?.vehicle_id ?? null;
  }

  if (!vehicleId) {
    // Unknown device — accept to prevent retries, do not store
    return res.status(200).json({ received: true, stored: false, reason: "unknown IMEI" });
  }

  try {
    switch (eventType) {

      // ── Trip end — most reliable odometer source ────────────────────────
      case "tripEnd": {
        const { transactionId, end } = body;
        if (end?.odometer) {
          await upsertMileage(sb, vehicleId, imei, end.odometer, end.timestamp ?? null);
        }
        if (transactionId && end) {
          await insertTripLog(sb, {
            vehicleId,
            imei,
            transactionId,
            endOdometer: end.odometer   ?? null,
            tripAt:      end.timestamp  ?? new Date().toISOString(),
            source:      "webhook",
          });
        }
        break;
      }

      // ── Trip metrics — driving behaviour stats ──────────────────────────
      case "tripMetrics": {
        const { transactionId, metrics } = body;
        if (transactionId && metrics) {
          await insertTripLog(sb, {
            vehicleId,
            imei,
            transactionId,
            tripDistance: metrics.tripDistance         ?? null,
            tripTimeSecs: metrics.tripTime             ?? null,
            maxSpeedMph:  metrics.maxSpeed             ?? null,
            hardBraking:  metrics.hardBrakingCounts    ?? 0,
            hardAccel:    metrics.hardAccelerationCounts ?? 0,
            tripAt:       metrics.timestamp ?? new Date().toISOString(),
            source:       "webhook",
          });
        }
        break;
      }

      // ── Check engine light ──────────────────────────────────────────────
      case "mil": {
        const { mil } = body;
        if (mil?.value === "ON") {
          await sb.from("ai_logs").insert({
            action:   "mil_alert",
            input:    { imei, vehicleId, codes: mil.codes ?? "" },
            output:   {
              message:   `Check engine light ON for ${vehicleId}: ${mil.codes ?? "codes unavailable"}`,
              timestamp: mil.timestamp ?? new Date().toISOString(),
            },
            admin_id: "bouncie-webhook",
          }).catch((err) => console.warn("bouncie-webhook: mil ai_logs failed:", err.message));
        }
        break;
      }

      // ── Battery warning ─────────────────────────────────────────────────
      case "battery": {
        const { battery } = body;
        if (battery?.value === "low" || battery?.value === "critical") {
          await sb.from("ai_logs").insert({
            action:   "battery_alert",
            input:    { imei, vehicleId, level: battery.value },
            output:   {
              message:   `Vehicle ${vehicleId} battery is ${battery.value}`,
              timestamp: battery.timestamp ?? new Date().toISOString(),
            },
            admin_id: "bouncie-webhook",
          }).catch((err) => console.warn("bouncie-webhook: battery ai_logs failed:", err.message));
        }
        break;
      }

      // ── All other event types ────────────────────────────────────────────
      default:
        break;
    }

    return res.status(200).json({ received: true, stored: true, eventType, vehicleId });
  } catch (err) {
    console.error("bouncie-webhook error:", err);
    // Return 200 so Bouncie does not retry on our Supabase errors
    return res.status(200).json({ received: true, stored: false, error: adminErrorMessage(err) });
  }
}
