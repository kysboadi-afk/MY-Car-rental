// api/_customer-identity.test.js
// Unit tests for Phase B customer identity resolution helpers.
//
// Tests:
//   1. normalizeEmailForLinking
//   2. normalizePhoneForLinking
//   3. isBookingAlreadyMigrated (mocked Supabase)
//   4. findCustomerMatch — tier 1: exact_stripe_id
//   5. findCustomerMatch — tier 2: exact_email
//   6. findCustomerMatch — tier 3: exact_phone
//   7. findCustomerMatch — no match (null result)
//   8. findCustomerMatch — skips tier when booking field is null
//   9. writeMigrationLog — happy path
//  10. writeMigrationLog — idempotent on unique_violation (23505)
//  11. linkBookingToCustomer — writes bookings + customers + log
//  12. linkBookingToCustomer — non-destructive (skips customer_id update when already set)
//  13. createIdentityConflict — writes conflict + log
//  14. logSkippedBooking — writes log with action=skipped
//  15. normalizeAllCustomers — processes all customers in chunks

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmailForLinking,
  normalizePhoneForLinking,
  isBookingAlreadyMigrated,
  findCustomerMatch,
  writeMigrationLog,
  linkBookingToCustomer,
  createIdentityConflict,
  logSkippedBooking,
  normalizeAllCustomers,
} from "./_customer-identity.js";

// ── Test 1: normalizeEmailForLinking ─────────────────────────────────────────

test("normalizeEmailForLinking — lower-cases and trims", () => {
  assert.equal(normalizeEmailForLinking("  User@Example.COM  "), "user@example.com");
});

test("normalizeEmailForLinking — already normalized", () => {
  assert.equal(normalizeEmailForLinking("user@example.com"), "user@example.com");
});

test("normalizeEmailForLinking — null input returns null", () => {
  assert.equal(normalizeEmailForLinking(null), null);
});

test("normalizeEmailForLinking — empty string returns null", () => {
  assert.equal(normalizeEmailForLinking(""), null);
});

test("normalizeEmailForLinking — whitespace-only returns null", () => {
  assert.equal(normalizeEmailForLinking("   "), null);
});

// ── Test 2: normalizePhoneForLinking ─────────────────────────────────────────

test("normalizePhoneForLinking — US 10-digit becomes E.164", () => {
  assert.equal(normalizePhoneForLinking("3105551234"), "+13105551234");
});

test("normalizePhoneForLinking — formatted US phone normalizes", () => {
  assert.equal(normalizePhoneForLinking("(310) 555-1234"), "+13105551234");
});

test("normalizePhoneForLinking — already E.164 passes through", () => {
  assert.equal(normalizePhoneForLinking("+13105551234"), "+13105551234");
});

test("normalizePhoneForLinking — null returns null", () => {
  assert.equal(normalizePhoneForLinking(null), null);
});

test("normalizePhoneForLinking — empty string returns null", () => {
  assert.equal(normalizePhoneForLinking(""), null);
});

test("normalizePhoneForLinking — 11-digit US starting with 1", () => {
  assert.equal(normalizePhoneForLinking("13105551234"), "+13105551234");
});

// ── Supabase mock helpers ─────────────────────────────────────────────────────

/**
 * Build a minimal Supabase mock that lets test code specify what each
 * from(table).method(...) call returns.
 *
 * Usage:
 *   const sb = makeSupabase({ migration_log_result: { data: null } });
 *
 * The mock is intentionally simple: the last call to .eq()/.is()/.in()
 * accumulates filters, and the terminal method (.maybeSingle, .single,
 * then, insert, update, delete) resolves the preset.
 */
function makeChainMock(resolve) {
  const proxy = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") {
          // Thenable — resolve as Promise
          return (onFulfilled) => Promise.resolve(resolve).then(onFulfilled);
        }
        if (typeof prop === "string" && ["maybeSingle", "single"].includes(prop)) {
          return () => Promise.resolve(resolve);
        }
        // Any other method — return self for chaining
        return () => proxy;
      },
    }
  );
  return proxy;
}

// ── Test 3: isBookingAlreadyMigrated ─────────────────────────────────────────

test("isBookingAlreadyMigrated — returns true when log row exists", async () => {
  const sb = {
    from: () => ({
      select: () => ({
        eq:         () => ({
          in:       () => ({
            maybeSingle: () => Promise.resolve({ data: { id: "abc" } }),
          }),
        }),
      }),
    }),
  };
  const result = await isBookingAlreadyMigrated(sb, "bk-001");
  assert.equal(result, true);
});

test("isBookingAlreadyMigrated — returns false when no log row", async () => {
  const sb = {
    from: () => ({
      select: () => ({
        eq:   () => ({
          in: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
          }),
        }),
      }),
    }),
  };
  const result = await isBookingAlreadyMigrated(sb, "bk-002");
  assert.equal(result, false);
});

test("isBookingAlreadyMigrated — returns false for null bookingRef", async () => {
  const sb = { from: () => { throw new Error("should not be called"); } };
  const result = await isBookingAlreadyMigrated(sb, null);
  assert.equal(result, false);
});

// ── Test 4–8: findCustomerMatch ───────────────────────────────────────────────

/**
 * Build a Supabase mock for findCustomerMatch.
 * Each tier query hits:
 *   - customers WHERE stripe_customer_id = ...
 *   - customers WHERE normalized_email = ...  (then WHERE email = ... AND normalized_email IS NULL)
 *   - customers WHERE normalized_phone = ...  (then WHERE phone = ... AND normalized_phone IS NULL)
 *
 * We mock them in call order using a counter.
 */
function makeFindMatchSupabase(responses) {
  let callIdx = 0;
  return {
    from: (table) => {
      if (table !== "customers") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => makeChainableThat(() => {
          const resp = responses[callIdx] ?? { data: null };
          callIdx++;
          return Promise.resolve(resp);
        }),
      };
    },
  };
}

function makeChainableThat(fn) {
  const handler = {
    get(_, prop) {
      if (["maybeSingle"].includes(prop)) return fn;
      return () => new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}

test("findCustomerMatch — tier 1 exact_stripe_id match", async () => {
  const customer = { id: "cust-1", email: "a@b.com", phone: null, normalized_email: null, normalized_phone: null, stripe_customer_id: "cus_abc", ledger_migration_status: "pending" };
  const booking  = { booking_ref: "bk-1", stripe_customer_id: "cus_abc", customer_email: "a@b.com", customer_phone: null };

  const sb = makeFindMatchSupabase([
    { data: customer }, // tier 1 stripe hit
  ]);

  const result = await findCustomerMatch(sb, booking);
  assert.ok(result);
  assert.equal(result.confidenceTier, "exact_stripe_id");
  assert.equal(result.customer.id, "cust-1");
});

test("findCustomerMatch — tier 2 exact_email match when stripe misses", async () => {
  const customer = { id: "cust-2", email: "a@b.com", phone: null, normalized_email: "a@b.com", normalized_phone: null, stripe_customer_id: null, ledger_migration_status: "pending" };
  const booking  = { booking_ref: "bk-2", stripe_customer_id: "cus_xyz", customer_email: "A@B.COM", customer_phone: null };

  const sb = makeFindMatchSupabase([
    { data: null },    // tier 1 stripe miss
    { data: customer }, // tier 2 normalized_email hit
  ]);

  const result = await findCustomerMatch(sb, booking);
  assert.ok(result);
  assert.equal(result.confidenceTier, "exact_email");
  assert.equal(result.customer.id, "cust-2");
});

test("findCustomerMatch — tier 3 exact_phone match when stripe+email miss", async () => {
  const customer = { id: "cust-3", email: null, phone: "+13105551234", normalized_email: null, normalized_phone: "+13105551234", stripe_customer_id: null, ledger_migration_status: "pending" };
  const booking  = { booking_ref: "bk-3", stripe_customer_id: null, customer_email: null, customer_phone: "(310) 555-1234" };

  const sb = makeFindMatchSupabase([
    // tier 2 skipped (no email), tier 3
    { data: customer }, // tier 3 normalized_phone hit
  ]);

  const result = await findCustomerMatch(sb, booking);
  assert.ok(result);
  assert.equal(result.confidenceTier, "exact_phone");
  assert.equal(result.customer.id, "cust-3");
});

test("findCustomerMatch — returns null when no match in any tier", async () => {
  const booking = { booking_ref: "bk-4", stripe_customer_id: "cus_unk", customer_email: "nobody@example.com", customer_phone: "+10000000000" };

  const sb = makeFindMatchSupabase([
    { data: null }, // stripe miss
    { data: null }, // normalized_email miss
    { data: null }, // email raw miss
    { data: null }, // normalized_phone miss
    { data: null }, // phone raw miss
  ]);

  const result = await findCustomerMatch(sb, booking);
  assert.equal(result, null);
});

test("findCustomerMatch — skips stripe tier when booking.stripe_customer_id is null", async () => {
  // Only email and phone queries should be made
  const customer = { id: "cust-5", email: "x@y.com", phone: null, normalized_email: "x@y.com", normalized_phone: null, stripe_customer_id: null, ledger_migration_status: "pending" };
  const booking  = { booking_ref: "bk-5", stripe_customer_id: null, customer_email: "x@y.com", customer_phone: null };

  const sb = makeFindMatchSupabase([
    // stripe tier skipped → first call is tier 2
    { data: customer },
  ]);

  const result = await findCustomerMatch(sb, booking);
  assert.ok(result);
  assert.equal(result.confidenceTier, "exact_email");
});

// ── Test 9–10: writeMigrationLog ──────────────────────────────────────────────

test("writeMigrationLog — inserts row successfully", async () => {
  const insertedRows = [];
  const sb = {
    from: () => ({
      insert: (row) => {
        insertedRows.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };

  await writeMigrationLog(sb, {
    booking_ref:     "bk-10",
    customer_id:     "cust-10",
    confidence_tier: "exact_email",
    action:          "linked",
    match_details:   { source: "test" },
  });

  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].booking_ref, "bk-10");
  assert.equal(insertedRows[0].action, "linked");
  assert.equal(insertedRows[0].confidence_tier, "exact_email");
});

test("writeMigrationLog — silently ignores unique_violation (23505)", async () => {
  const sb = {
    from: () => ({
      insert: () => Promise.resolve({ error: { code: "23505", message: "duplicate" } }),
    }),
  };

  // Should not throw
  await assert.doesNotReject(() =>
    writeMigrationLog(sb, {
      booking_ref:     "bk-dup",
      customer_id:     "c1",
      confidence_tier: "exact_email",
      action:          "linked",
    })
  );
});

// ── Test 11–12: linkBookingToCustomer ─────────────────────────────────────────

test("linkBookingToCustomer — links booking, updates customer, logs migration", async () => {
  const logged = [];

  // Build a chainable mock that eventually resolves { error: null } regardless
  // of how many chained calls are made, and captures insert rows.
  function makeResolvingChain(onInsert) {
    const resolved = Promise.resolve({ error: null });
    const proxy = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then")    return (fn) => resolved.then(fn);
          if (prop === "insert")  return (row) => { if (onInsert) onInsert(row); return resolved; };
          if (prop === "update")  return () => proxy;
          if (prop === "eq")      return () => proxy;
          if (prop === "is")      return () => resolved;
          if (prop === "maybeSingle") return () => resolved;
          return () => proxy;
        },
      }
    );
    return proxy;
  }

  const sb = {
    from: (table) => makeResolvingChain(table === "customer_migration_log" ? (row) => logged.push(row) : null),
  };

  const booking  = { booking_ref: "bk-11", customer_id: null, customer_email: "a@b.com", customer_phone: "+11234567890", stripe_customer_id: "cus_11" };
  const customer = { id: "cust-11", email: "a@b.com", phone: "+11234567890", normalized_email: null, normalized_phone: null, stripe_customer_id: null };

  const result = await linkBookingToCustomer(sb, booking, customer, "exact_email", {});
  assert.equal(result.linked, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "linked");
  assert.equal(logged[0].confidence_tier, "exact_email");
});

test("linkBookingToCustomer — non-destructive: skips booking update when customer_id already set", async () => {
  const bookingUpdateCalls = [];

  function makeChain(table) {
    const resolved = Promise.resolve({ error: null });
    const proxy = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then")    return (fn) => resolved.then(fn);
          if (prop === "insert")  return () => resolved;
          if (prop === "update")  return (data) => {
            if (table === "bookings") bookingUpdateCalls.push(data);
            return proxy;
          };
          if (prop === "eq")      return () => proxy;
          if (prop === "is")      return () => resolved;
          if (prop === "maybeSingle") return () => resolved;
          return () => proxy;
        },
      }
    );
    return proxy;
  }

  const sb = { from: (table) => makeChain(table) };

  const booking  = { booking_ref: "bk-12", customer_id: "existing-cust", customer_email: "a@b.com", customer_phone: null, stripe_customer_id: null };
  const customer = { id: "cust-12", email: "a@b.com", phone: null, normalized_email: "a@b.com", normalized_phone: null, stripe_customer_id: null };

  const result = await linkBookingToCustomer(sb, booking, customer, "exact_email", {});
  // booking.customer_id was already set, so the booking update path is skipped entirely
  assert.equal(result.linked, true);
  assert.equal(bookingUpdateCalls.length, 0, "should not update bookings when customer_id already set");
});

// ── Test 13: createIdentityConflict ───────────────────────────────────────────

test("createIdentityConflict — upserts conflict row and writes log", async () => {
  const upserted = [];
  const logged   = [];

  const sb = {
    from: (table) => {
      if (table === "customer_identity_conflicts") {
        return {
          upsert: (data) => {
            upserted.push(data);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "customer_migration_log") {
        return { insert: (row) => { logged.push(row); return Promise.resolve({ error: null }); } };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  const booking    = { booking_ref: "bk-13", customer_name: "Test User", customer_email: "t@u.com", customer_phone: "+10000000000", stripe_customer_id: null, status: "completed", pickup_date: "2025-01-01", total_price: 385 };
  const candidates = [{ id: "c-a" }, { id: "c-b" }];

  await createIdentityConflict(sb, booking, candidates, "multiple_email_matches");

  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].booking_ref, "bk-13");
  assert.equal(upserted[0].status, "pending");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "conflict_created");
  assert.equal(logged[0].confidence_tier, "ambiguous");
});

// ── Test 14: logSkippedBooking ────────────────────────────────────────────────

test("logSkippedBooking — writes log with action=skipped", async () => {
  const logged = [];
  const sb = {
    from: () => ({
      insert: (row) => { logged.push(row); return Promise.resolve({ error: null }); },
    }),
  };

  await logSkippedBooking(sb, "bk-14", "no customer record found");

  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "skipped");
  assert.equal(logged[0].booking_ref, "bk-14");
  assert.equal(logged[0].confidence_tier, "ambiguous");
});

// ── Test 15: normalizeAllCustomers ────────────────────────────────────────────

test("normalizeAllCustomers — populates normalized fields for matching customers", async () => {
  const customers = [
    { id: "c-1", email: "Hello@World.COM", phone: "(310) 555-9999", normalized_email: null, normalized_phone: null },
    { id: "c-2", email: "already@norm.com", phone: "+12135554444", normalized_email: "already@norm.com", normalized_phone: "+12135554444" },
  ];

  const updated = {};
  let fetchCall = 0;

  const sb = {
    from: (table) => {
      if (table !== "customers") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          or:    () => ({
            order: () => ({
              limit: () => {
                if (fetchCall === 0) {
                  fetchCall++;
                  return Promise.resolve({ data: customers, error: null });
                }
                return Promise.resolve({ data: [], error: null });
              },
            }),
          }),
        }),
        update: (data) => ({
          eq: (col, val) => {
            updated[val] = data;
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };

  const result = await normalizeAllCustomers(sb, { chunkSize: 200 });

  // c-1 should be updated (both null), c-2 should NOT be updated (both set)
  assert.ok(updated["c-1"], "c-1 should have been updated");
  assert.equal(updated["c-1"].normalized_email, "hello@world.com");
  assert.equal(updated["c-1"].normalized_phone, "+13105559999");
  assert.equal(updated["c-2"], undefined, "c-2 should NOT be updated");
  assert.equal(result.processed, 1);
  assert.equal(result.errors, 0);
});
