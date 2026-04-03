// api/quick-service.js
// One-click maintenance completion endpoint.
//
// GET /api/quick-service?vehicleId=...&serviceType=...&token=...
//
// Security:
//   • token must be a valid HMAC-signed quick-service token (see _quick-service-token.js)
//   • token encodes vehicleId + serviceType and has a 30-minute expiry
//   • query-param vehicleId + serviceType must match the token payload (double-check)
//   • no admin login required — the signed token IS the credential
//
// On success:
//   1. Updates last_<service>_mileage in vehicles table (same as toolMarkMaintenance)
//   2. Inserts a row into maintenance_history
//   3. Runs auto-resolve logic (action_status pending/in_progress → resolved when
//      no more overdue services remain), including resolution tracking columns
//   4. Returns a simple HTML confirmation page
//
// On error (bad/expired token, unknown vehicle, etc.):
//   Returns an HTML error page with an appropriate message (never JSON).

import { getSupabaseAdmin } from "./_supabase.js";
import { analyzeMileage }   from "../lib/ai/mileage.js";
import { hasNoOverdueMaintenance } from "../lib/ai/priority.js";
import { verifyServiceToken } from "./_quick-service-token.js";

// ── Service metadata (mirrors _admin-actions.js MAINTENANCE_SERVICE_COLUMNS) ──
const SERVICE_META = {
  oil:    { col: "last_oil_change_mileage",  jsonKey: "last_oil_change_mileage",  label: "Oil change" },
  brakes: { col: "last_brake_check_mileage", jsonKey: "last_brake_check_mileage", label: "Brake inspection" },
  tires:  { col: "last_tire_change_mileage", jsonKey: "last_tire_change_mileage", label: "Tire replacement" },
};

// ── HTML response helpers ─────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(title, color, heading, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — SLY Rides</title>
  <style>
    body { font-family: sans-serif; max-width: 560px; margin: 60px auto; padding: 24px; text-align: center; }
    h1   { color: ${color}; }
    p    { color: #555; line-height: 1.6; }
    a    { color: #1a73e8; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  ${body}
  <p style="margin-top:32px"><a href="https://www.slytrans.com">← Return to SLY Rides</a></p>
</body>
</html>`;
}

function successPage(serviceLabel, vehicleId, serviceMileage, autoResolved) {
  return htmlPage(
    "Service Recorded",
    "#2e7d32",
    "✅ Service recorded successfully",
    `<p><strong>${esc(serviceLabel)}</strong> has been logged for vehicle <strong>${esc(vehicleId)}</strong>
       at <strong>${Number(serviceMileage).toLocaleString()} mi</strong>.</p>
     ${autoResolved ? `<p>✅ All maintenance is now up to date — action status has been resolved.</p>` : ""}
     <p>No further action is needed.</p>`
  );
}

function errorPage(message) {
  return htmlPage(
    "Error",
    "#c62828",
    "❌ Unable to process request",
    `<p>${esc(message)}</p>`
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(405).send(errorPage("Method not allowed."));
  }

  const { vehicleId, serviceType, token } = req.query;

  // ── 1. Validate token ───────────────────────────────────────────────────────
  const decoded = verifyServiceToken(token);
  if (!decoded) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send(errorPage("This link is invalid or has expired. Please request a new maintenance alert."));
  }

  // Double-check that query params match the signed payload (prevents parameter
  // tampering even if a valid token is somehow reused against different params)
  if (decoded.vehicleId !== vehicleId || decoded.serviceType !== serviceType) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send(errorPage("Link parameters do not match the token. Please request a new maintenance alert."));
  }

  const meta = SERVICE_META[serviceType];
  if (!meta) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(errorPage(`Unknown service type "${esc(serviceType)}".`));
  }

  // ── 2. Connect to Supabase ──────────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (!sb) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(503).send(errorPage("Service temporarily unavailable. Please try again later."));
  }

  try {
    // ── 3. Fetch current vehicle row ──────────────────────────────────────────
    const { data: row, error: fetchErr } = await sb
      .from("vehicles")
      .select("mileage, data")
      .eq("vehicle_id", vehicleId)
      .maybeSingle();

    if (fetchErr) throw new Error(`Supabase fetch failed: ${fetchErr.message}`);
    if (!row) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(404).send(errorPage("Vehicle not found."));
    }

    const serviceMileage = Number(row.mileage) || 0;
    const updatedData    = { ...(row.data || {}), [meta.jsonKey]: serviceMileage };

    // ── 4. Record service mileage ─────────────────────────────────────────────
    const { error: updateErr } = await sb
      .from("vehicles")
      .update({
        [meta.col]: serviceMileage,
        data:       updatedData,
        updated_at: new Date().toISOString(),
      })
      .eq("vehicle_id", vehicleId);

    if (updateErr) throw new Error(`Supabase update failed: ${updateErr.message}`);

    // ── 5. Insert maintenance_history (non-fatal) ─────────────────────────────
    sb.from("maintenance_history")
      .insert({ vehicle_id: vehicleId, service_type: serviceType, mileage: serviceMileage })
      .then(() => {})
      .catch((err) => console.warn(`quick-service: maintenance_history insert failed:`, err.message));

    // ── 6. Auto-resolve action_status when no maintenance remains overdue ─────
    let autoResolved = false;
    try {
      const { data: freshRow } = await sb
        .from("vehicles")
        .select("mileage, last_oil_change_mileage, last_brake_check_mileage, last_tire_change_mileage, action_status, data, last_auto_action_at, last_auto_action_reason")
        .eq("vehicle_id", vehicleId)
        .maybeSingle();

      if (freshRow) {
        const freshMiles = Number(freshRow.mileage) || 0;
        const { stats: freshStats } = analyzeMileage([{
          vehicle_id:               vehicleId,
          total_mileage:            freshMiles,
          last_oil_change_mileage:  freshRow.last_oil_change_mileage  != null ? Number(freshRow.last_oil_change_mileage)  : null,
          last_brake_check_mileage: freshRow.last_brake_check_mileage != null ? Number(freshRow.last_brake_check_mileage) : null,
          last_tire_change_mileage: freshRow.last_tire_change_mileage != null ? Number(freshRow.last_tire_change_mileage) : null,
        }], []);

        if (
          freshStats.length > 0 &&
          hasNoOverdueMaintenance(freshStats[0]) &&
          (freshRow.action_status === "pending" || freshRow.action_status === "in_progress")
        ) {
          const autoResolvedAt = new Date().toISOString();
          await sb
            .from("vehicles")
            .update({
              action_status:           "resolved",
              last_resolved_at:        autoResolvedAt,
              last_resolved_reason:    freshRow.last_auto_action_reason || null,
              last_auto_action_at:     null,
              last_auto_action_reason: null,
              updated_at:              autoResolvedAt,
            })
            .eq("vehicle_id", vehicleId);
          autoResolved = true;
        }
      }
    } catch {
      // auto-resolve is best-effort — do not fail the service record
    }

    // ── 7. Return HTML success page ───────────────────────────────────────────
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(successPage(meta.label, vehicleId, serviceMileage, autoResolved));

  } catch (err) {
    console.error("quick-service error:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(errorPage("An error occurred while recording the service. Please try again or contact support."));
  }
}
