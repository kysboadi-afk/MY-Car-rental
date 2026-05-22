// api/customer-identity-backfill.js
// Phase B — Customer identity backfill endpoint.
//
// Resumable, idempotent, chunk-safe backfill that links bookings to customer
// records using 3-tier deterministic matching. All writes are non-destructive.
//
// POST /api/customer-identity-backfill
// Protected by ADMIN_SECRET.
//
// Actions:
//   normalize_customers  — Pass 1: populate customers.normalized_phone / normalized_email.
//                          Must run before 'run' for phone/email tier matching to use indexes.
//   run                  — Pass 2: process a chunk of bookings.
//                          Params: { chunk_size?, cursor? }
//                          cursor = last booking_ref processed (for resume).
//   status               — Return migration progress counts.
//   rollback             — Revert Phase B linkages.
//                          Params: { scope: 'booking'|'customer', scope_id }
//
// Idempotency / replay safety:
//   • customer_migration_log is checked for each booking_ref before processing.
//   • Cursor-based paging means re-runs from the same cursor re-skip already-migrated bookings.
//   • bookings.customer_id is only updated if currently NULL (DB-level guard).
//   • Rollback reverts customer_id to NULL and resets ledger_migration_status to 'pending'.
//
// Enforcement guardrails:
//   • No booking blocking / payment gating / release enforcement is modified.
//   • No existing booking identity fields (customer_name, customer_phone, etc.) are modified.
//   • customer_ledger_mode remains 'shadow' — this backfill does NOT advance it.

import { getSupabaseAdmin } from "./_supabase.js";
import {
  normalizeAllCustomers,
  findCustomerMatch,
  linkBookingToCustomer,
  createIdentityConflict,
  logSkippedBooking,
  isBookingAlreadyMigrated,
} from "./_customer-identity.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com", "https://slyslingshotrentals.com", "https://www.slyslingshotrentals.com"];
const DEFAULT_CHUNK_SIZE = 50;
const MAX_CHUNK_SIZE = 200;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "ADMIN_SECRET not configured" });
  }

  const body = req.body ?? {};
  const { secret, action } = body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  // ── Action: normalize_customers ────────────────────────────────────────────
  if (action === "normalize_customers") {
    const chunkSize = Math.min(
      parseInt(body.chunk_size ?? DEFAULT_CHUNK_SIZE, 10) || DEFAULT_CHUNK_SIZE,
      MAX_CHUNK_SIZE
    );

    const result = await normalizeAllCustomers(supabase, { chunkSize });
    return res.status(200).json({
      action: "normalize_customers",
      ...result,
      message: `Normalization complete. ${result.processed} customers updated, ${result.errors} errors.`,
    });
  }

  // ── Action: run ────────────────────────────────────────────────────────────
  if (action === "run") {
    const chunkSize = Math.min(
      parseInt(body.chunk_size ?? DEFAULT_CHUNK_SIZE, 10) || DEFAULT_CHUNK_SIZE,
      MAX_CHUNK_SIZE
    );
    const cursor = body.cursor ?? null; // booking_ref of last processed record

    // Fetch chunk of bookings in booking_ref order, after cursor if provided.
    // We process ALL bookings (not just customer_id IS NULL) because some may
    // already have a customer_id from existing app logic but were never logged.
    let q = supabase
      .from("bookings")
      .select("booking_ref, customer_id, customer_name, customer_email, customer_phone, stripe_customer_id, status, pickup_date, total_price")
      .not("booking_ref", "is", null)
      .order("booking_ref")
      .limit(chunkSize);

    if (cursor) q = q.gt("booking_ref", cursor);

    const { data: bookings, error: fetchErr } = await q;
    if (fetchErr) {
      return res.status(500).json({ error: `Failed to fetch bookings: ${fetchErr.message}` });
    }

    const counters = {
      processed:        0,
      skipped_already:  0, // already in migration log
      linked:           0,
      conflicts:        0,
      skipped_no_match: 0,
      errors:           0,
    };
    let lastCursor = cursor;

    for (const booking of bookings ?? []) {
      try {
        // Idempotency: skip if already logged
        const alreadyMigrated = await isBookingAlreadyMigrated(supabase, booking.booking_ref);
        if (alreadyMigrated) {
          counters.skipped_already++;
          lastCursor = booking.booking_ref;
          continue;
        }

        counters.processed++;

        // If booking already has a customer_id (linked by existing app logic),
        // treat as already linked — log it and move on.
        if (booking.customer_id) {
          await linkBookingToCustomer(
            supabase,
            booking,
            { id: booking.customer_id, email: null, phone: null, normalized_email: null, normalized_phone: null, stripe_customer_id: null },
            "exact_stripe_id", // best guess for pre-existing links
            { pre_existing_link: true }
          );
          counters.linked++;
          lastCursor = booking.booking_ref;
          continue;
        }

        // 3-tier match
        const match = await findCustomerMatch(supabase, booking);

        if (match?.ambiguous) {
          await createIdentityConflict(
            supabase,
            booking,
            match.candidates ?? [],
            match.reason ?? "ambiguous_match_detected"
          );
          counters.conflicts++;
        } else if (match) {
          const { linked, reason } = await linkBookingToCustomer(
            supabase,
            booking,
            match.customer,
            match.confidenceTier,
            {}
          );
          if (linked) {
            counters.linked++;
          } else {
            console.error(`[customer-identity-backfill] link failed for ${booking.booking_ref}: ${reason}`);
            counters.errors++;
          }
        } else {
          // No deterministic match found and no multi-match ambiguity.
          await logSkippedBooking(
            supabase,
            booking.booking_ref,
            "no_deterministic_match: booking has no customer record matching stripe_id, email, or phone"
          );
          counters.skipped_no_match++;
        }
      } catch (err) {
        console.error(`[customer-identity-backfill] unexpected error for ${booking.booking_ref}:`, err);
        counters.errors++;
      }

      lastCursor = booking.booking_ref;
    }

    const hasMore = (bookings?.length ?? 0) === chunkSize;

    return res.status(200).json({
      action:     "run",
      counters,
      next_cursor: hasMore ? lastCursor : null,
      has_more:    hasMore,
      message:     hasMore
        ? `Chunk complete. Pass next_cursor to continue.`
        : `Backfill complete — no more bookings to process.`,
    });
  }

  // ── Action: status ─────────────────────────────────────────────────────────
  if (action === "status") {
    const [logCounts, conflictCounts, bookingCounts] = await Promise.all([
      supabase
        .from("customer_migration_log")
        .select("action", { count: "exact", head: false }),
      supabase
        .from("customer_identity_conflicts")
        .select("status", { count: "exact", head: false }),
      supabase
        .from("bookings")
        .select("customer_id", { count: "exact", head: false })
        .not("booking_ref", "is", null),
    ]);

    // Aggregate log by action
    const logByAction = {};
    for (const row of logCounts.data ?? []) {
      logByAction[row.action] = (logByAction[row.action] ?? 0) + 1;
    }

    // Aggregate conflicts by status
    const conflictByStatus = {};
    for (const row of conflictCounts.data ?? []) {
      conflictByStatus[row.status] = (conflictByStatus[row.status] ?? 0) + 1;
    }

    // Count unlinked bookings
    const unlinkedCount = (bookingCounts.data ?? []).filter((b) => !b.customer_id).length;
    const totalBookings = (bookingCounts.data ?? []).length;

    return res.status(200).json({
      action: "status",
      migration_log: {
        linked:           logByAction.linked           ?? 0,
        conflict_created: logByAction.conflict_created ?? 0,
        skipped:          logByAction.skipped          ?? 0,
        total:            (logCounts.data ?? []).length,
      },
      conflicts: {
        pending:   conflictByStatus.pending   ?? 0,
        resolved:  conflictByStatus.resolved  ?? 0,
        dismissed: conflictByStatus.dismissed ?? 0,
        total:     (conflictCounts.data ?? []).length,
      },
      bookings: {
        total:    totalBookings,
        unlinked: unlinkedCount,
        linked:   totalBookings - unlinkedCount,
      },
    });
  }

  // ── Action: rollback ───────────────────────────────────────────────────────
  if (action === "rollback") {
    const { scope, scope_id, reason } = body;

    if (!scope || !scope_id) {
      return res.status(400).json({ error: "scope and scope_id are required for rollback" });
    }
    if (!["booking", "customer"].includes(scope)) {
      return res.status(400).json({ error: "scope must be 'booking' or 'customer'" });
    }

    const rollbackResult = { reverted_bookings: 0, reverted_customers: 0, errors: 0 };

    if (scope === "booking") {
      // Revert a single booking's Phase B customer_id link
      const { error: rbErr } = await supabase
        .from("bookings")
        .update({ customer_id: null })
        .eq("booking_ref", scope_id);

      if (rbErr) {
        rollbackResult.errors++;
        console.error(`[customer-identity-backfill] rollback booking error:`, rbErr.message);
      } else {
        rollbackResult.reverted_bookings = 1;
      }

      // Remove migration log entries for this booking
      await supabase
        .from("customer_migration_log")
        .delete()
        .eq("booking_ref", scope_id);

      // Reset conflict status if one exists
      await supabase
        .from("customer_identity_conflicts")
        .update({ status: "pending", resolved_customer_id: null, resolved_by: null, resolved_at: null })
        .eq("booking_ref", scope_id)
        .eq("status", "resolved");

    } else {
      // scope === 'customer': revert all Phase B bookings linked to this customer
      const { data: linkedBookings } = await supabase
        .from("bookings")
        .select("booking_ref")
        .eq("customer_id", scope_id);

      for (const b of linkedBookings ?? []) {
        const { error: rbErr } = await supabase
          .from("bookings")
          .update({ customer_id: null })
          .eq("booking_ref", b.booking_ref);

        if (rbErr) {
          rollbackResult.errors++;
        } else {
          rollbackResult.reverted_bookings++;
        }

        await supabase
          .from("customer_migration_log")
          .delete()
          .eq("booking_ref", b.booking_ref);
      }

      // Reset customer migration status
      const { error: custRbErr } = await supabase
        .from("customers")
        .update({
          ledger_migration_status: "pending",
          ledger_migrated_at:      null,
        })
        .eq("id", scope_id);

      if (custRbErr) {
        rollbackResult.errors++;
      } else {
        rollbackResult.reverted_customers = 1;
      }
    }

    // Audit rollback event
    await supabase.from("ledger_rollback_events").insert({
      event_type:   "rollback",
      scope_type:   scope,
      scope_id:     scope_id,
      initiated_by: "admin_backfill_api",
      reason:       reason ?? "manual rollback via customer-identity-backfill",
      metadata:     { rollback_result: rollbackResult },
    });

    return res.status(200).json({
      action: "rollback",
      scope,
      scope_id,
      ...rollbackResult,
      message: `Rollback complete for ${scope} ${scope_id}.`,
    });
  }

  return res.status(400).json({
    error: `Unknown action '${action}'. Valid actions: normalize_customers, run, status, rollback`,
  });
}
