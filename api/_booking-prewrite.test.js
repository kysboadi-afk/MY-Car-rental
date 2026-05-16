import test from "node:test";
import assert from "node:assert/strict";

import { upsertBookingPrewrite } from "./_booking-prewrite.js";

function makeSupabaseStub(steps) {
  const calls = [];
  return {
    calls,
    client: {
      from(table) {
        assert.equal(table, "bookings");
        return {
          upsert(payload, options) {
            calls.push({ payload: { ...payload }, options });
            const step = steps[calls.length - 1] || {};
            const response = step.response || { data: [{ booking_ref: payload.booking_ref }], error: null };
            const query = Promise.resolve(response);
            query.select = function select() {
              return Promise.resolve(response);
            };
            return query;
          },
        };
      },
    },
  };
}

test("upsertBookingPrewrite retries without category on schema error", async () => {
  const stub = makeSupabaseStub([
    { response: { data: null, error: { code: "42703", message: 'column "category" does not exist' } } },
    { response: { data: [{ booking_ref: "bk-123" }], error: null } },
  ]);

  const result = await upsertBookingPrewrite(stub.client, {
    booking_ref: "bk-123",
    status: "pending_checkout",
    category: "slingshot",
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.fallbacksApplied, ["drop_category"]);
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].payload.category, "slingshot");
  assert.equal("category" in stub.calls[1].payload, false);
});

test("upsertBookingPrewrite retries with legacy pending when pending_checkout is rejected", async () => {
  const stub = makeSupabaseStub([
    { response: { data: null, error: { code: "23514", message: 'new row violates check constraint "bookings_status_check"' } } },
    { response: { data: [{ booking_ref: "bk-456" }], error: null } },
  ]);

  const result = await upsertBookingPrewrite(stub.client, {
    booking_ref: "bk-456",
    status: "pending_checkout",
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.fallbacksApplied, ["legacy_pending_status"]);
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].payload.status, "pending_checkout");
  assert.equal(stub.calls[1].payload.status, "pending");
});

test("upsertBookingPrewrite can apply both compatibility fallbacks in sequence", async () => {
  const stub = makeSupabaseStub([
    { response: { data: null, error: { code: "42703", message: 'column "category" does not exist' } } },
    { response: { data: null, error: { code: "23514", message: 'new row violates check constraint "bookings_status_check"' } } },
    { response: { data: [{ booking_ref: "bk-789" }], error: null } },
  ]);

  const result = await upsertBookingPrewrite(stub.client, {
    booking_ref: "bk-789",
    status: "pending_checkout",
    category: "slingshot",
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.fallbacksApplied, ["drop_category", "legacy_pending_status"]);
  assert.equal(stub.calls.length, 3);
  assert.equal(stub.calls[2].payload.status, "pending");
  assert.equal("category" in stub.calls[2].payload, false);
});

test("upsertBookingPrewrite drops identity_session_id on schema error after category already dropped", async () => {
  const stub = makeSupabaseStub([
    { response: { data: null, error: { code: "42703", message: 'column "category" does not exist' } } },
    { response: { data: null, error: { code: "42703", message: 'column "identity_session_id" does not exist' } } },
    { response: { data: [{ booking_ref: "bk-idsess" }], error: null } },
  ]);

  const result = await upsertBookingPrewrite(stub.client, {
    booking_ref: "bk-idsess",
    status: "agreement_pending",
    category: "slingshot",
    identity_session_id: "is_abc123",
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.fallbacksApplied, ["drop_category", "drop_identity_session_id"]);
  assert.equal(stub.calls.length, 3);
  assert.equal("category" in stub.calls[2].payload, false);
  assert.equal("identity_session_id" in stub.calls[2].payload, false);
});

test("upsertBookingPrewrite falls back from slingshot status to pending_checkout when constraint rejects it", async () => {
  const stub = makeSupabaseStub([
    { response: { data: null, error: { code: "23514", message: 'new row violates check constraint "bookings_status_check"' } } },
    { response: { data: [{ booking_ref: "bk-sling" }], error: null } },
  ]);

  const result = await upsertBookingPrewrite(stub.client, {
    booking_ref: "bk-sling",
    status: "agreement_pending",
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.fallbacksApplied, ["slingshot_status_to_pending_checkout"]);
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].payload.status, "agreement_pending");
  assert.equal(stub.calls[1].payload.status, "pending_checkout");
});

test("upsertBookingPrewrite chains all fallbacks: category schema + identity schema + slingshot status + legacy pending", async () => {
  const constraintErr = { code: "23514", message: 'new row violates check constraint "bookings_status_check"' };
  const stub = makeSupabaseStub([
    { response: { data: null, error: { code: "42703", message: 'column "category" does not exist' } } },
    { response: { data: null, error: { code: "42703", message: 'column "identity_session_id" does not exist' } } },
    { response: { data: null, error: constraintErr } },
    { response: { data: null, error: constraintErr } },
    { response: { data: [{ booking_ref: "bk-all" }], error: null } },
  ]);

  const result = await upsertBookingPrewrite(stub.client, {
    booking_ref: "bk-all",
    status: "agreement_pending",
    category: "slingshot",
    identity_session_id: "is_xyz",
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.fallbacksApplied, [
    "drop_category",
    "drop_identity_session_id",
    "slingshot_status_to_pending_checkout",
    "legacy_pending_status",
  ]);
  assert.equal(stub.calls.length, 5);
  assert.equal(stub.calls[4].payload.status, "pending");
});
