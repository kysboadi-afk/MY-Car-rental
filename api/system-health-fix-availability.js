// api/system-health-fix-availability.js
// Repairs blocked_dates rows for active/overdue bookings so that vehicles are
// never incorrectly available while actively rented.
//
// For each booking with status IN ("active_rental", "overdue"):
//   1. Compute the correct end_date/end_time using buildBufferedEnd().
//   2. If no blocked_dates row exists for that vehicle+booking_ref → INSERT.
//   3. If a row exists but the stored end is earlier than the correct end → UPDATE.
//
// Safe to call multiple times (idempotent).  Never deletes valid future blocks.
//
// ── Auth ───────────────────────────────────────────────────────────────────────
//   Admin POST: { secret: ADMIN_SECRET }
//   Cron POST:  Authorization: Bearer CRON_SECRET
//
// ── Response ───────────────────────────────────────────────────────────────────
// {
//   ok:       true,
//   inserted: number,   — new blocked_dates rows created
//   updated:  number,   — existing rows corrected
//   skipped:  number,   — rows already correct
//   failed:   number,   — rows that could not be repaired
//   message:  string,
// }

import { getSupabaseAdmin }                     from "./_supabase.js";
import { isAdminAuthorized, isAdminConfigured } from "./_admin-auth.js";
import { buildBufferedEnd }                     from "./_booking-automation.js";
import { normalizeVehicleId }                   from "./_vehicle-id.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com"];
// All statuses that represent a vehicle being held for a renter — must match
// ACTIVE_BOOKING_STATUSES in fleet-status.js so the health fix covers every
// booking state that prevents a vehicle from being available.
const ACTIVE_STATUSES = [
  "pending", "booked_paid", "approved", "active",
  "reserved", "reserved_unpaid", "pending_verification",
  "active_rental", "overdue",
];

/**
 * Core repair logic for availability sync.
 * Exported so that v2-system-health can call it during cron auto-repair.
 *
 * @param {object} sb - Supabase admin client
 * @returns {{ inserted: number, updated: number, skipped: number, failed: number, message: string }}
 */
export async function runAvailabilitySyncFix(sb) {
  // ── Load active/overdue bookings ─────────────────────────────────────────
  const { data: activeRows, error: activeErr } = await sb
    .from("bookings")
    .select("booking_ref, vehicle_id, status, pickup_date, return_date, return_time")
    .in("status", ACTIVE_STATUSES)
    .limit(200);

  if (activeErr) {
    throw new Error("Could not load bookings: " + activeErr.message);
  }

  const bookings = activeRows || [];
  if (bookings.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, failed: 0, message: "No active or overdue rentals found." };
  }

  const refs = bookings.map((b) => b.booking_ref).filter(Boolean);

  // ── Fetch existing blocked_dates rows for these bookings ─────────────────
  const { data: blockRows, error: blockErr } = await sb
    .from("blocked_dates")
    .select("id, booking_ref, vehicle_id, end_date, end_time")
    .in("booking_ref", refs)
    .eq("reason", "booking");

  if (blockErr) {
    throw new Error("Could not load blocked_dates: " + blockErr.message);
  }

  // Index by booking_ref → keep the row with the latest end.
  const blockByRef = {};
  for (const b of blockRows || []) {
    if (!b.booking_ref) continue;
    const cur = blockByRef[b.booking_ref];
    if (!cur) {
      blockByRef[b.booking_ref] = b;
      continue;
    }
    const newIsLater =
      b.end_date > cur.end_date ||
      (b.end_date === cur.end_date &&
        (b.end_time || "00:00") > (cur.end_time || "00:00"));
    if (newIsLater) blockByRef[b.booking_ref] = b;
  }

  let inserted = 0;
  let updated  = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const booking of bookings) {
    const ref = booking.booking_ref;
    if (!ref) continue;

    const vehicleId = normalizeVehicleId(booking.vehicle_id);
    if (!vehicleId || !booking.return_date || !booking.pickup_date) {
      console.warn(
        `[system-health-fix-availability] skipping ${ref}: missing vehicle_id, pickup_date, or return_date`
      );
      skipped++;
      continue;
    }

    // Compute the correct buffered end.
    const { date: correctEndDate, time: correctEndTime } = buildBufferedEnd(
      booking.return_date,
      booking.return_time || null,
    );

    try {
      const existingBlock = blockByRef[ref];

      if (!existingBlock) {
        // ── INSERT missing row ────────────────────────────────────────────
        const row = {
          vehicle_id:  vehicleId,
          start_date:  booking.pickup_date,
          end_date:    correctEndDate,
          reason:      "booking",
          booking_ref: ref,
        };
        if (correctEndTime) row.end_time = correctEndTime;

        const { error: insertErr } = await sb
          .from("blocked_dates")
          .upsert(row, { onConflict: "vehicle_id,start_date,end_date,reason", ignoreDuplicates: true });

        if (insertErr) {
          console.error(
            `[system-health-fix-availability] INSERT failed for ${ref}:`, insertErr.message
          );
          failed++;
        } else {
          console.log(`[system-health-fix-availability] INSERTED blocked_dates for ${ref}`, {
            vehicle_id: vehicleId, end_date: correctEndDate, end_time: correctEndTime || null,
          });
          inserted++;
        }
        continue;
      }

      // ── Check whether existing row needs updating ─────────────────────
      const storedEnd     = String(existingBlock.end_date || "").split("T")[0];
      const storedEndTime = existingBlock.end_time ? String(existingBlock.end_time).substring(0, 5) : null;

      const needsUpdate = (() => {
        if (!storedEnd) return true;
        if (storedEnd < correctEndDate) return true;
        if (storedEnd > correctEndDate) return false;
        if (storedEndTime && correctEndTime) return storedEndTime < correctEndTime;
        return false;
      })();

      if (!needsUpdate) {
        skipped++;
        continue;
      }

      // ── UPDATE stale row ──────────────────────────────────────────────
      const updatePayload = { end_date: correctEndDate };
      if (correctEndTime) updatePayload.end_time = correctEndTime;

      const { error: updateErr } = await sb
        .from("blocked_dates")
        .update(updatePayload)
        .eq("id", existingBlock.id);

      if (updateErr) {
        console.error(
          `[system-health-fix-availability] UPDATE failed for ${ref}:`, updateErr.message
        );
        failed++;
      } else {
        console.log(`[system-health-fix-availability] UPDATED blocked_dates for ${ref}`, {
          vehicle_id: vehicleId,
          old_end: storedEnd, old_end_time: storedEndTime || null,
          new_end: correctEndDate, new_end_time: correctEndTime || null,
        });
        updated++;
      }
    } catch (err) {
      console.error(`[system-health-fix-availability] unexpected error for ${ref}:`, err.message);
      failed++;
    }
  }

  console.log(
    `[system-health-fix-availability] complete: inserted=${inserted} updated=${updated}` +
    ` skipped=${skipped} failed=${failed}`
  );

  const parts = [];
  if (inserted > 0) parts.push(`${inserted} block${inserted !== 1 ? "s" : ""} created`);
  if (updated  > 0) parts.push(`${updated} block${updated  !== 1 ? "s" : ""} corrected`);
  if (skipped  > 0) parts.push(`${skipped} already correct`);
  if (failed   > 0) parts.push(`${failed} failed`);

  return {
    inserted,
    updated,
    skipped,
    failed,
    message: parts.length ? parts.join(", ") + "." : "All blocked_dates entries are already correct.",
  };
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

  // ── Authentication ───────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  const isCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronAuth) {
    if (!isAdminConfigured()) {
      return res.status(500).json({ error: "Server configuration error: ADMIN_SECRET is not set." });
    }
    const { secret } = req.body || {};
    if (!isAdminAuthorized(secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // ── Dependencies check ───────────────────────────────────────────────────
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: "Supabase not configured." });

  try {
    const result = await runAvailabilitySyncFix(sb);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[system-health-fix-availability] handler error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
