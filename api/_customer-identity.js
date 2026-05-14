// api/_customer-identity.js
// Phase B — Customer identity resolution helpers.
//
// Provides 3-tier deterministic matching for linking bookings to customer records:
//   Tier 1: exact_stripe_id  — booking.stripe_customer_id === customers.stripe_customer_id
//   Tier 2: exact_email      — normalizeEmailForLinking(booking.customer_email) === customers.normalized_email
//   Tier 3: exact_phone      — normalizePhoneForLinking(booking.customer_phone) === customers.normalized_phone
//   Fallback: ambiguous      — routed to customer_identity_conflicts for manual review
//
// OPERATIONAL CONSTRAINTS (Phase B):
//   • Non-destructive: booking identity fields are never modified.
//   • bookings.customer_id is only set when currently NULL.
//   • Idempotent: customer_migration_log is checked before any write.
//   • No enforcement logic is modified.
//   • All writes are non-fatal (try/catch at call-sites).

import { normalizePhone } from "./_bookings.js";

// ── Normalization helpers ─────────────────────────────────────────────────────

/**
 * Normalize an email for identity matching: lower-case + trim.
 * Returns null for empty/non-string input.
 *
 * @param {string|null|undefined} email
 * @returns {string|null}
 */
export function normalizeEmailForLinking(email) {
  if (!email || typeof email !== "string") return null;
  const n = email.trim().toLowerCase();
  return n || null;
}

/**
 * Normalize a phone for identity matching (E.164 for US numbers).
 * Delegates to the shared normalizePhone helper from _bookings.js.
 * Returns null for empty/non-string input.
 *
 * @param {string|null|undefined} phone
 * @returns {string|null}
 */
export function normalizePhoneForLinking(phone) {
  if (!phone || typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  return normalizePhone(trimmed) || null;
}

// ── Idempotency check ─────────────────────────────────────────────────────────

/**
 * Returns true if booking_ref already has a terminal migration log entry
 * (action = 'linked', 'conflict_created', or 'skipped').
 * Used to skip already-processed bookings on resume.
 *
 * @param {object} supabase  - Supabase admin client
 * @param {string} bookingRef
 * @returns {Promise<boolean>}
 */
export async function isBookingAlreadyMigrated(supabase, bookingRef) {
  if (!bookingRef) return false;
  const { data } = await supabase
    .from("customer_migration_log")
    .select("id")
    .eq("booking_ref", bookingRef)
    .in("action", ["linked", "conflict_created", "skipped"])
    .maybeSingle();
  return data !== null;
}

// ── Customer normalization pass ───────────────────────────────────────────────

/**
 * Populate normalized_phone and normalized_email on customers that have not
 * yet been normalized. Also copies stripe_customer_id from booking data when
 * the customer record lacks one (this part runs implicitly during linkBookingToCustomer).
 *
 * This is the "Pass 1" step that must run before the booking-linking pass so
 * that the normalized_phone / normalized_email indexes are usable.
 *
 * Processes customers in chunks to avoid memory pressure.
 * Returns { processed, errors }.
 *
 * @param {object} supabase  - Supabase admin client
 * @param {object} [opts]
 * @param {number} [opts.chunkSize=200]
 * @returns {Promise<{processed: number, errors: number}>}
 */
export async function normalizeAllCustomers(supabase, { chunkSize = 200 } = {}) {
  let processed = 0;
  let errors = 0;
  let cursor = null; // last processed id (uuid)

  for (;;) {
    // Fetch a chunk of customers that still need normalization
    let q = supabase
      .from("customers")
      .select("id, email, phone, normalized_phone, normalized_email")
      .or("normalized_phone.is.null,normalized_email.is.null")
      .order("id")
      .limit(chunkSize);
    if (cursor) q = q.gt("id", cursor);

    const { data: customers, error } = await q;
    if (error) {
      console.error("[customer-identity] normalizeAllCustomers fetch error:", error.message);
      errors++;
      break;
    }
    if (!customers || customers.length === 0) break;

    for (const c of customers) {
      const updates = {};
      if (!c.normalized_email) {
        const ne = normalizeEmailForLinking(c.email);
        if (ne) updates.normalized_email = ne;
      }
      if (!c.normalized_phone) {
        const np = normalizePhoneForLinking(c.phone);
        if (np) updates.normalized_phone = np;
      }

      if (Object.keys(updates).length > 0) {
        const { error: upErr } = await supabase
          .from("customers")
          .update(updates)
          .eq("id", c.id);
        if (upErr) {
          console.error(`[customer-identity] normalizeAllCustomers update error for ${c.id}:`, upErr.message);
          errors++;
        } else {
          processed++;
        }
      }
    }

    cursor = customers[customers.length - 1].id;
    if (customers.length < chunkSize) break;
  }

  return { processed, errors };
}

// ── Customer matching ─────────────────────────────────────────────────────────

/**
 * Attempt to find a single unambiguous customer record for a booking using
 * the 3-tier deterministic matching hierarchy.
 *
 * Returns:
 *   { customer: {...}, confidenceTier: 'exact_stripe_id'|'exact_email'|'exact_phone' }
 *   OR { ambiguous: true, reason: string, candidates: [{id,...}] } when a tier
 *      returns multiple rows (e.g. PGRST116 / multi-match collision)
 *   OR null if no deterministic match was found.
 *
 * Does NOT write to any table.
 *
 * @param {object} supabase
 * @param {object} booking  - must include: booking_ref, customer_email, customer_phone, stripe_customer_id
 * @returns {Promise<{customer: object, confidenceTier: string}|{ambiguous: true, reason: string, candidates: object[]}|null>}
 */
export async function findCustomerMatch(supabase, booking) {
  const isMultiMatchError = (err) => {
    if (!err) return false;
    const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
    const details = typeof err.details === "string" ? err.details.toLowerCase() : "";
    return code === "PGRST116" || details.includes("more than 1 row");
  };

  const buildAmbiguousResult = async (queryFactory, reason) => {
    const { data: candidates = [] } = await queryFactory().limit(25);
    return {
      ambiguous: true,
      reason,
      candidates: candidates.filter((c) => c?.id),
    };
  };

  // ── Tier 1: exact Stripe customer ID ──────────────────────────────────────
  if (booking.stripe_customer_id) {
    const stripeQuery = supabase
      .from("customers")
      .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
      .eq("stripe_customer_id", booking.stripe_customer_id);

    const { data: byStripe, error: byStripeErr } = await stripeQuery.maybeSingle();

    if (byStripe) {
      return { customer: byStripe, confidenceTier: "exact_stripe_id" };
    }
    if (isMultiMatchError(byStripeErr)) {
      return buildAmbiguousResult(
        () => supabase
          .from("customers")
          .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
          .eq("stripe_customer_id", booking.stripe_customer_id),
        "multi_match_stripe_customer_id: multiple customers share the same stripe_customer_id"
      );
    }
  }

  // ── Tier 2: exact normalized email ────────────────────────────────────────
  const normEmail = normalizeEmailForLinking(booking.customer_email);
  if (normEmail) {
    const byEmailQuery = supabase
      .from("customers")
      .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
      .eq("normalized_email", normEmail);

    const { data: byEmail, error: byEmailErr } = await byEmailQuery.maybeSingle();

    if (byEmail) {
      return { customer: byEmail, confidenceTier: "exact_email" };
    }
    if (isMultiMatchError(byEmailErr)) {
      return buildAmbiguousResult(
        () => supabase
          .from("customers")
          .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
          .eq("normalized_email", normEmail),
        "multi_match_normalized_email: multiple customers share the same normalized_email"
      );
    }

    // Also try customers.email directly (for records not yet normalized)
    const byEmailRawQuery = supabase
      .from("customers")
      .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
      .eq("email", normEmail)
      .is("normalized_email", null);

    const { data: byEmailRaw, error: byEmailRawErr } = await byEmailRawQuery.maybeSingle();

    if (byEmailRaw) {
      return { customer: byEmailRaw, confidenceTier: "exact_email" };
    }
    if (isMultiMatchError(byEmailRawErr)) {
      return buildAmbiguousResult(
        () => supabase
          .from("customers")
          .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
          .eq("email", normEmail)
          .is("normalized_email", null),
        "multi_match_email_raw: multiple unnormalized customers share the same email"
      );
    }
  }

  // ── Tier 3: exact normalized phone ────────────────────────────────────────
  const normPhone = normalizePhoneForLinking(booking.customer_phone);
  if (normPhone) {
    const byPhoneQuery = supabase
      .from("customers")
      .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
      .eq("normalized_phone", normPhone);

    const { data: byPhone, error: byPhoneErr } = await byPhoneQuery.maybeSingle();

    if (byPhone) {
      return { customer: byPhone, confidenceTier: "exact_phone" };
    }
    if (isMultiMatchError(byPhoneErr)) {
      return buildAmbiguousResult(
        () => supabase
          .from("customers")
          .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
          .eq("normalized_phone", normPhone),
        "multi_match_normalized_phone: multiple customers share the same normalized_phone"
      );
    }

    // Also try customers.phone directly (for records not yet normalized)
    const byPhoneRawQuery = supabase
      .from("customers")
      .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
      .eq("phone", normPhone)
      .is("normalized_phone", null);

    const { data: byPhoneRaw, error: byPhoneRawErr } = await byPhoneRawQuery.maybeSingle();

    if (byPhoneRaw) {
      return { customer: byPhoneRaw, confidenceTier: "exact_phone" };
    }
    if (isMultiMatchError(byPhoneRawErr)) {
      return buildAmbiguousResult(
        () => supabase
          .from("customers")
          .select("id, email, phone, normalized_email, normalized_phone, stripe_customer_id, ledger_migration_status")
          .eq("phone", normPhone)
          .is("normalized_phone", null),
        "multi_match_phone_raw: multiple unnormalized customers share the same phone"
      );
    }
  }

  // No deterministic match
  return null;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/**
 * Write a row to customer_migration_log.
 * Non-fatal: logs errors to console but does not throw.
 *
 * @param {object} supabase
 * @param {object} entry
 * @param {string} entry.booking_ref
 * @param {string|null} entry.customer_id
 * @param {string} entry.confidence_tier  - 'exact_stripe_id'|'exact_email'|'exact_phone'|'ambiguous'
 * @param {string} entry.action           - 'linked'|'conflict_created'|'skipped'
 * @param {object} [entry.match_details]
 * @param {string} [entry.migrated_by]
 * @param {string} [entry.notes]
 * @returns {Promise<void>}
 */
export async function writeMigrationLog(supabase, entry) {
  const { error } = await supabase.from("customer_migration_log").insert({
    booking_ref:     entry.booking_ref,
    customer_id:     entry.customer_id ?? null,
    confidence_tier: entry.confidence_tier,
    action:          entry.action,
    match_details:   entry.match_details ?? {},
    migrated_by:     entry.migrated_by ?? "backfill_script",
    notes:           entry.notes ?? null,
  });
  if (error && error.code !== "23505") {
    // 23505 = unique_violation — already logged for this booking_ref+action
    console.error("[customer-identity] writeMigrationLog error:", error.message);
  }
}

/**
 * Link a booking to a customer (Phase B non-destructive write path).
 *
 * Writes performed:
 *   1. bookings.customer_id = customer.id  (only if currently NULL)
 *   2. customers.normalized_email / normalized_phone / stripe_customer_id  (only if NULL)
 *   3. customers.ledger_migration_status = 'migrated' / ledger_migrated_at = now()
 *   4. customer_migration_log entry
 *
 * Returns { linked: true } on success, { linked: false, reason } on failure.
 *
 * @param {object} supabase
 * @param {object} booking          - full booking row
 * @param {object} customer         - matched customer row
 * @param {string} confidenceTier
 * @param {object} [matchDetails]   - source fields used for matching
 * @returns {Promise<{linked: boolean, reason?: string}>}
 */
export async function linkBookingToCustomer(supabase, booking, customer, confidenceTier, matchDetails = {}) {
  // 1. Link booking → customer (only if unlinked)
  if (!booking.customer_id) {
    const { error: linkErr } = await supabase
      .from("bookings")
      .update({ customer_id: customer.id })
      .eq("booking_ref", booking.booking_ref)
      .is("customer_id", null); // safety guard — only update if still null
    if (linkErr) {
      return { linked: false, reason: `bookings update failed: ${linkErr.message}` };
    }
  }

  // 2. Populate normalized fields on customer (non-destructive: only if NULL)
  const customerUpdates = {};
  if (!customer.normalized_email) {
    const ne = normalizeEmailForLinking(customer.email ?? booking.customer_email);
    if (ne) customerUpdates.normalized_email = ne;
  }
  if (!customer.normalized_phone) {
    const np = normalizePhoneForLinking(customer.phone ?? booking.customer_phone);
    if (np) customerUpdates.normalized_phone = np;
  }
  if (!customer.stripe_customer_id && booking.stripe_customer_id) {
    customerUpdates.stripe_customer_id = booking.stripe_customer_id;
  }
  customerUpdates.ledger_migration_status = "migrated";
  customerUpdates.ledger_migrated_at = new Date().toISOString();

  const { error: custErr } = await supabase
    .from("customers")
    .update(customerUpdates)
    .eq("id", customer.id);
  if (custErr) {
    console.error(`[customer-identity] customer update error for ${customer.id}:`, custErr.message);
    // non-fatal — booking link already written
  }

  // 3. Migration log
  await writeMigrationLog(supabase, {
    booking_ref:     booking.booking_ref,
    customer_id:     customer.id,
    confidence_tier: confidenceTier,
    action:          "linked",
    match_details: {
      ...matchDetails,
      booking_customer_email:    booking.customer_email   ?? null,
      booking_customer_phone:    booking.customer_phone   ?? null,
      booking_stripe_customer_id: booking.stripe_customer_id ?? null,
      customer_email:            customer.email           ?? null,
      customer_phone:            customer.phone           ?? null,
      customer_stripe_customer_id: customer.stripe_customer_id ?? null,
      booking_had_customer_id:   booking.customer_id      ?? null,
    },
    migrated_by: "backfill_script",
  });

  return { linked: true };
}

/**
 * Create or update a customer_identity_conflicts row for a booking whose
 * identity could not be deterministically resolved.
 *
 * Idempotent: uses UPSERT so re-running the backfill on the same booking
 * does not create duplicate conflict rows.
 *
 * @param {object} supabase
 * @param {object} booking          - full booking row
 * @param {object[]} candidates     - array of partial customer records that were found
 * @param {string} reason           - human-readable explanation of the conflict
 * @returns {Promise<void>}
 */
export async function createIdentityConflict(supabase, booking, candidates, reason) {
  const candidateIds = candidates.map((c) => c.id);

  const { error } = await supabase
    .from("customer_identity_conflicts")
    .upsert(
      {
        booking_ref:            booking.booking_ref,
        candidate_customer_ids: candidateIds,
        conflict_reason:        reason,
        raw_booking_data: {
          customer_name:       booking.customer_name       ?? null,
          customer_email:      booking.customer_email      ?? null,
          customer_phone:      booking.customer_phone      ?? null,
          stripe_customer_id:  booking.stripe_customer_id  ?? null,
          booking_ref:         booking.booking_ref,
          status:              booking.status,
          pickup_date:         booking.pickup_date,
          total_price:         booking.total_price,
        },
        status:     "pending",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "booking_ref", ignoreDuplicates: false }
    );

  if (error) {
    console.error(`[customer-identity] createIdentityConflict error for ${booking.booking_ref}:`, error.message);
    return;
  }

  // Migration log
  await writeMigrationLog(supabase, {
    booking_ref:     booking.booking_ref,
    customer_id:     null,
    confidence_tier: "ambiguous",
    action:          "conflict_created",
    match_details: {
      candidate_count:  candidates.length,
      candidate_ids:    candidateIds,
      conflict_reason:  reason,
    },
    migrated_by: "backfill_script",
  });
}

/**
 * Log a skipped booking (no customer record found at all, no conflict).
 *
 * @param {object} supabase
 * @param {string} bookingRef
 * @param {string} reason
 * @returns {Promise<void>}
 */
export async function logSkippedBooking(supabase, bookingRef, reason) {
  await writeMigrationLog(supabase, {
    booking_ref:     bookingRef,
    customer_id:     null,
    confidence_tier: "ambiguous",
    action:          "skipped",
    match_details:   { reason },
    migrated_by:     "backfill_script",
  });
}
