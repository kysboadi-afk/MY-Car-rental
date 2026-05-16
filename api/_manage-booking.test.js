import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let supabaseClient = null;

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseClient,
  },
});

mock.module("./_manage-booking-token.js", {
  namedExports: {
    createManageToken: () => "mock-token",
    verifyManageToken: () => "bk-fallback-001",
  },
});

mock.module("./_vehicles.js", {
  namedExports: {
    getVehicleById: async () => ({ id: "camry", name: "Camry 2012" }),
    loadVehicles: async () => [],
    saveVehicles: async () => {},
  },
});

const { default: handler } = await import("./manage-booking.js");

function makeReq(body, origin = "https://www.slytrans.com") {
  return { method: "POST", headers: { origin }, body };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    setHeader(key, value) { this._headers[key] = value; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
}

function makeQueryResult(data, error = null) {
  return { data, error };
}

beforeEach(() => {
  supabaseClient = null;
});

test("manage-booking get falls back to legacy booking columns when newer columns are missing", async () => {
  const bookingRow = {
    id: 1,
    booking_ref: "bk-fallback-001",
    vehicle_id: "camry",
    pickup_date: "2026-05-20",
    return_date: "2026-05-24",
    pickup_time: "10:00 AM",
    return_time: "10:00 AM",
    status: "reserved",
    payment_status: "partial",
    total_price: 275,
    deposit_paid: 100,
    remaining_balance: 175,
    change_count: 0,
    customer_name: "Test Renter",
    customer_email: "test@example.com",
    customer_phone: "3105550100",
    created_at: "2026-05-15T00:00:00.000Z",
  };

  const selects = [];
  supabaseClient = {
    from(table) {
      if (table === "payment_plans") {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          limit() { return Promise.resolve(makeQueryResult([])); },
        };
      }
      assert.equal(table, "bookings");
      const ctx = { selectValue: "" };
      return {
        select(value) {
          ctx.selectValue = value;
          selects.push(value);
          return this;
        },
        eq(column, value) {
          ctx.eqColumn = column;
          ctx.eqValue = value;
          return this;
        },
        async maybeSingle() {
          assert.equal(ctx.eqColumn, "booking_ref");
          assert.equal(ctx.eqValue, "bk-fallback-001");
          if (ctx.selectValue.includes("pending_change")) {
            return makeQueryResult(null, {
              code: "42703",
              message: 'column "pending_change" does not exist',
            });
          }
          return makeQueryResult(bookingRow);
        },
      };
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "get", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.bookingId, "bk-fallback-001");
  assert.equal(res._body.vehicleName, "Camry 2012");
  assert.equal(res._body.hasProtectionPlan, false);
  assert.equal(res._body.protectionPlanTier, null);
  assert.equal(res._body.paymentPlan, null);
  assert.deepEqual(selects.length, 2);
});

test("manage-booking get_agreement_url returns a signed URL when agreement PDF exists", async () => {
  supabaseClient = {
    from(table) {
      assert.equal(table, "pending_booking_docs");
      return {
        select() { return this; },
        eq(column, value) {
          assert.equal(column, "booking_id");
          assert.equal(value, "bk-fallback-001");
          return this;
        },
        async maybeSingle() {
          return makeQueryResult({ agreement_pdf_url: "bk-fallback-001/rental-agreement.pdf" });
        },
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "rental-agreements");
        return {
          async createSignedUrl(path, expiresIn) {
            assert.equal(path, "bk-fallback-001/rental-agreement.pdf");
            assert.equal(expiresIn, 3600);
            return { data: { signedUrl: "https://files.example/agreement.pdf" }, error: null };
          },
        };
      },
    },
  };

  const res = makeRes();
  await handler(makeReq({ action: "get_agreement_url", token: "valid-token" }), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.url, "https://files.example/agreement.pdf");
  assert.equal(res._body.path, "bk-fallback-001/rental-agreement.pdf");
});
