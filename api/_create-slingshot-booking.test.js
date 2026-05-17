import { test, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
process.env.SLINGSHOT_NO_PAYMENT = "true";

const calls = {
  retrieveSessions: [],
  prewrites: [],
  timeouts: [],
};

let retrieveStatuses = ["verified"];

mock.module("./_vehicles.js", {
  namedExports: {
    getVehicleById: async () => ({
      id: "slingshot",
      type: "slingshot",
      name: "Slingshot R",
      vin: "VIN123",
      licensePlate: "7TEST123",
    }),
  },
});

mock.module("./_slingshot-packages.js", {
  namedExports: {
    getSlingshotPackage: () => ({ label: "2 Hours", hours: 2, price: 150 }),
    SLINGSHOT_DEPOSIT: 500,
    MS_PER_HOUR: 60 * 60 * 1000,
    computeSlingshotReturn: () => new Date("2030-01-01T18:00:00.000Z"),
    isReturnWithinBusinessHours: () => true,
    splitDatetimeLA: () => ({ date: "2030-01-01", time: "10:00" }),
  },
});

mock.module("./_time.js", {
  namedExports: {
    buildDateTimeLA: () => new Date("2030-01-01T16:00:00.000Z"),
    normalizeClockTime: (value) => value,
    formatTime12h: (value) => value,
  },
});

mock.module("./_availability.js", {
  namedExports: {
    isDatesAndTimesAvailable: async () => true,
    isVehicleAvailable: async () => true,
  },
});

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => ({
      from(table) {
        if (table !== "bookings") throw new Error(`Unexpected table ${table}`);
        return {
          select() {
            return {
              eq() {
                return {
                  gt() {
                    return {
                      limit: async () => ({ data: [], error: null }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    }),
  },
});

mock.module("./_booking-status.js", {
  namedExports: {
    toDbBookingStatus: (status) => status,
  },
});

mock.module("./_booking-prewrite.js", {
  namedExports: {
    upsertBookingPrewrite: async (_sb, row) => {
      calls.prewrites.push(row);
      return { error: null, attemptedRow: row };
    },
  },
});

mock.module("./_vehicle-id.js", {
  namedExports: {
    normalizeVehicleId: (value) => value,
  },
});

mock.module("./_manage-booking-token.js", {
  namedExports: {
    createManageToken: () => "manage-token-123",
  },
});

class StripeMock {
  constructor() {
    this.identity = {
      verificationSessions: {
        retrieve: async (id) => {
          calls.retrieveSessions.push(id);
          const nextStatus = retrieveStatuses[Math.min(calls.retrieveSessions.length - 1, retrieveStatuses.length - 1)];
          return { id, status: nextStatus };
        },
      },
    };
  }
}

mock.module("stripe", {
  defaultExport: StripeMock,
});

const timeoutMock = mock.method(globalThis, "setTimeout", (fn, delay) => {
  calls.timeouts.push(delay);
  fn();
  return 0;
});

after(() => {
  timeoutMock.mock.restore();
});

const { default: handler } = await import("./create-slingshot-booking.js");

function makeReq(overrides = {}) {
  return {
    method: "POST",
    headers: { origin: "https://www.slytrans.com" },
    body: {
      vehicleId: "slingshot",
      slingshotPackage: "2hr",
      pickupDate: "2030-01-01",
      pickupTime: "10:00",
      name: "Jane Driver",
      email: "jane@example.com",
      phone: "3105550199",
      paymentOption: "deposit",
      identitySessionId: "vs_test_123",
      ...overrides,
    },
  };
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

beforeEach(() => {
  calls.retrieveSessions.length = 0;
  calls.prewrites.length = 0;
  calls.timeouts.length = 0;
  retrieveStatuses = ["verified"];
});

test("create-slingshot-booking waits for Stripe Identity processing to finish before creating a manual booking", async () => {
  retrieveStatuses = ["processing", "processing", "verified"];
  const res = makeRes();

  await handler(makeReq(), res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.identityStatus, "verified");
  assert.equal(calls.retrieveSessions.length, 3);
  assert.deepEqual(calls.timeouts, [1500, 1500]);
  assert.equal(calls.prewrites.length, 1);
});

test("create-slingshot-booking returns a retryable response when Stripe Identity is still processing after polling", async () => {
  retrieveStatuses = ["processing", "processing", "processing", "processing", "processing"];
  const res = makeRes();

  await handler(makeReq(), res);

  assert.equal(res._status, 409);
  assert.match(res._body.error, /still processing/i);
  assert.equal(calls.retrieveSessions.length, 5);
  assert.deepEqual(calls.timeouts, [1500, 1500, 1500, 1500]);
  assert.equal(calls.prewrites.length, 0);
});
