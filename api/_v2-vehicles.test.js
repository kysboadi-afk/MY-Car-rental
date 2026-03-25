// api/_v2-vehicles.test.js
// Unit tests for the POST /api/v2-vehicles endpoint.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Supabase query builder that resolves to `result`.
 * Supports: .from().select().eq().maybeSingle(), .upsert().select().single()
 */
function makeSupabase({ selectResult, upsertResult } = {}) {
  const builder = () => {
    const chain = {
      select:      () => chain,
      eq:          () => chain,
      maybeSingle: () => Promise.resolve(selectResult  ?? { data: null, error: null }),
      single:      () => Promise.resolve(upsertResult  ?? { data: null, error: null }),
      upsert:      () => chain,
    };
    return chain;
  };
  return { from: () => builder() };
}

/**
 * Build a minimal mock res object for Vercel / Express-style handlers.
 */
function makeRes() {
  const res = {
    _status: 200,
    _body:   null,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    send(body)   { this._body = body; return this; },
    end()        { return this; },
  };
  return res;
}

/**
 * Build a minimal mock req object.
 */
function makeReq({ body = {}, method = "POST", origin = "https://www.slytrans.com" } = {}) {
  return { body, method, headers: { origin } };
}

// ── Import handler with mocked _supabase.js ───────────────────────────────────

// We use node:test module mocking to replace the Supabase client import.
// The mock state is shared across tests; each test sets supabaseMockState.client
// before calling the handler.

const supabaseMockState = { client: null };

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => supabaseMockState.client,
  },
});

const { default: handler } = await import("./v2-vehicles.js");

// ── Environment setup ─────────────────────────────────────────────────────────

const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET;

function setSecret(val) {
  if (val == null) {
    delete process.env.ADMIN_SECRET;
  } else {
    process.env.ADMIN_SECRET = val;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ─── Auth ─────────────────────────────────────────────────────────────────────

test("401 when secret is missing", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { action: "list" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Unauthorized");
  setSecret(REAL_ADMIN_SECRET);
});

test("401 when secret is wrong", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "wrong", action: "list" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Unauthorized");
  setSecret(REAL_ADMIN_SECRET);
});

test("500 when ADMIN_SECRET env var is not set", async () => {
  setSecret(null);
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "anything", action: "list" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("ADMIN_SECRET"));
  setSecret(REAL_ADMIN_SECRET);
});

test("500 when Supabase env vars are missing", async () => {
  setSecret("testSecret");
  supabaseMockState.client = null; // getSupabaseAdmin() returns null

  const req = makeReq({ body: { secret: "testSecret", action: "list" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("SUPABASE_URL"));
  setSecret(REAL_ADMIN_SECRET);
});

// ─── list ─────────────────────────────────────────────────────────────────────

test("list: returns empty object when table is empty", async () => {
  setSecret("testSecret");
  const selectResult = { data: [], error: null };
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve(selectResult),
    }),
  };

  const req = makeReq({ body: { secret: "testSecret", action: "list" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body.vehicles, {});
  setSecret(REAL_ADMIN_SECRET);
});

test("list: returns object keyed by vehicle_id", async () => {
  setSecret("testSecret");
  const rows = [
    { vehicle_id: "slingshot",  data: { vehicle_id: "slingshot",  status: "active" } },
    { vehicle_id: "camry",      data: { vehicle_id: "camry",      status: "maintenance" } },
  ];
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve({ data: rows, error: null }),
    }),
  };

  const req = makeReq({ body: { secret: "testSecret" } }); // no action → defaults to list
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body.vehicles, {
    slingshot: { vehicle_id: "slingshot",  status: "active" },
    camry:     { vehicle_id: "camry",      status: "maintenance" },
  });
  setSecret(REAL_ADMIN_SECRET);
});

test("list: 500 when Supabase select returns an error", async () => {
  setSecret("testSecret");
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
    }),
  };

  const req = makeReq({ body: { secret: "testSecret", action: "list" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("connection refused"));
  setSecret(REAL_ADMIN_SECRET);
});

// ─── update ───────────────────────────────────────────────────────────────────

test("update: 400 on missing vehicleId", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "update", updates: { status: "active" } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
  setSecret(REAL_ADMIN_SECRET);
});

test("update: 400 on invalid vehicleId format", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "update", vehicleId: "INVALID VEHICLE!", updates: { status: "active" } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
  setSecret(REAL_ADMIN_SECRET);
});

test("update: 400 on invalid status value", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "update", vehicleId: "slingshot", updates: { status: "retired" } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("status"));
  setSecret(REAL_ADMIN_SECRET);
});

test("update: 400 on negative purchase_price", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "update", vehicleId: "camry", updates: { purchase_price: -100 } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("purchase_price"));
  setSecret(REAL_ADMIN_SECRET);
});

test("update: 400 on non-numeric vehicle_year", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "update", vehicleId: "camry", updates: { vehicle_year: "abc" } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicle_year"));
  setSecret(REAL_ADMIN_SECRET);
});

test("update: 404 when vehicle row not found in Supabase", async () => {
  setSecret("testSecret");
  // maybeSingle returns null data (row not found)
  const chain = {
    select:      () => chain,
    eq:          () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  supabaseMockState.client = { from: () => chain };

  const req = makeReq({ body: { secret: "testSecret", action: "update", vehicleId: "slingshot", updates: { status: "maintenance" } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 404);
  assert.ok(res._body.error.includes("not found"));
  setSecret(REAL_ADMIN_SECRET);
});

test("update: writes merged data to Supabase and returns updated vehicle", async () => {
  setSecret("testSecret");

  const existingData = { vehicle_id: "slingshot", status: "active", purchase_price: 10000 };
  let upsertPayload = null;

  const upsertChain = {
    select: () => upsertChain,
    single: () => Promise.resolve({
      data: { data: { ...existingData, status: "maintenance" } },
      error: null,
    }),
  };
  const selectChain = {
    select:      () => selectChain,
    eq:          () => selectChain,
    maybeSingle: () => Promise.resolve({ data: { data: existingData }, error: null }),
  };

  supabaseMockState.client = {
    from: (table) => {
      return {
        select:      () => selectChain,
        eq:          () => selectChain,
        maybeSingle: () => selectChain.maybeSingle(),
        upsert:      (payload) => { upsertPayload = payload; return upsertChain; },
      };
    },
  };

  const req = makeReq({ body: { secret: "testSecret", action: "update", vehicleId: "slingshot", updates: { status: "maintenance" } } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.vehicle);
  assert.equal(res._body.vehicle.status, "maintenance");
  // Verify upsert was called with merged data
  assert.ok(upsertPayload);
  assert.equal(upsertPayload.vehicle_id, "slingshot");
  assert.equal(upsertPayload.data.status, "maintenance");
  assert.equal(upsertPayload.data.purchase_price, 10000); // existing field preserved
  setSecret(REAL_ADMIN_SECRET);
});

test("update: strips unknown fields from updates", async () => {
  setSecret("testSecret");

  const existingData = { vehicle_id: "camry", status: "active" };
  let upsertPayload = null;

  const selectChain = {
    select:      () => selectChain,
    eq:          () => selectChain,
    maybeSingle: () => Promise.resolve({ data: { data: existingData }, error: null }),
  };
  const upsertChain = {
    select: () => upsertChain,
    single: () => Promise.resolve({
      data: { data: { ...existingData, vehicle_name: "Camry Updated" } },
      error: null,
    }),
  };
  supabaseMockState.client = {
    from: () => ({
      select:      () => selectChain,
      eq:          () => selectChain,
      maybeSingle: () => selectChain.maybeSingle(),
      upsert:      (payload) => { upsertPayload = payload; return upsertChain; },
    }),
  };

  const req = makeReq({ body: {
    secret:    "testSecret",
    action:    "update",
    vehicleId: "camry",
    updates:   { vehicle_name: "Camry Updated", injected_field: "evil" },
  }});
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  // injected_field must NOT appear in the upserted data
  assert.ok(!Object.prototype.hasOwnProperty.call(upsertPayload.data, "injected_field"));
  assert.equal(upsertPayload.data.vehicle_name, "Camry Updated");
  setSecret(REAL_ADMIN_SECRET);
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────────

test("OPTIONS returns 200", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ method: "OPTIONS" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  setSecret(REAL_ADMIN_SECRET);
});

test("non-POST/GET returns 405", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ method: "DELETE" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 405);
  assert.equal(res._headers["Allow"], "GET, POST, OPTIONS");
  setSecret(REAL_ADMIN_SECRET);
});

// ─── GET ──────────────────────────────────────────────────────────────────────

test("GET: returns empty array when table is empty", async () => {
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve({ data: [], error: null }),
    }),
  };

  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, []);
});

test("GET: returns array of flattened vehicle objects", async () => {
  const rows = [
    { vehicle_id: "slingshot",  data: { vehicle_id: "slingshot",  vehicle_name: "Slingshot R", cover_image: "../images/car2.jpg", status: "active" } },
    { vehicle_id: "camry",      data: { vehicle_id: "camry",      vehicle_name: "Camry 2012",  cover_image: "images/car1.jpg",   status: "active" } },
  ];
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve({ data: rows, error: null }),
    }),
  };

  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body));
  assert.equal(res._body.length, 2);
  assert.equal(res._body[0].vehicle_id, "slingshot");
  assert.equal(res._body[0].vehicle_name, "Slingshot R");
  // "../images/car2.jpg" normalizes to "/images/car2.jpg"
  assert.equal(res._body[0].cover_image, "/images/car2.jpg");
  // "images/car1.jpg" normalizes to "/images/car1.jpg"
  assert.equal(res._body[1].cover_image, "/images/car1.jpg");
});

test("GET: normalizes various cover_image path formats", async () => {
  const rows = [
    { vehicle_id: "v1", data: { cover_image: "../images/a.jpg" } },
    { vehicle_id: "v2", data: { cover_image: "images/b.jpg" } },
    { vehicle_id: "v3", data: { cover_image: "/images/c.jpg" } },
    { vehicle_id: "v4", data: { cover_image: "https://cdn.example.com/d.jpg" } },
    { vehicle_id: "v5", data: {} },
  ];
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve({ data: rows, error: null }),
    }),
  };

  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body[0].cover_image, "/images/a.jpg");
  assert.equal(res._body[1].cover_image, "/images/b.jpg");
  assert.equal(res._body[2].cover_image, "/images/c.jpg");
  assert.equal(res._body[3].cover_image, "https://cdn.example.com/d.jpg");
  assert.equal(res._body[4].cover_image, undefined);
});

test("GET: 500 when Supabase select returns an error", async () => {
  supabaseMockState.client = {
    from: () => ({
      select: () => Promise.resolve({ data: null, error: { message: "db timeout" } }),
    }),
  };

  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("db timeout"));
});

test("GET: 500 when Supabase is not configured", async () => {
  supabaseMockState.client = null;

  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("SUPABASE_URL"));
});

// ─── create ───────────────────────────────────────────────────────────────────

test("create: 400 on missing vehicleId", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "create", vehicleName: "Test Car" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
  setSecret(REAL_ADMIN_SECRET);
});

test("create: 400 on invalid vehicleId format (uppercase / special chars)", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "create", vehicleId: "My Car!", vehicleName: "Test" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
  setSecret(REAL_ADMIN_SECRET);
});

test("create: 400 on missing vehicleName", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "create", vehicleId: "mynewcar" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleName"));
  setSecret(REAL_ADMIN_SECRET);
});

test("create: 400 on invalid type", async () => {
  setSecret("testSecret");
  supabaseMockState.client = makeSupabase();

  const req = makeReq({ body: { secret: "testSecret", action: "create", vehicleId: "mynewcar", vehicleName: "My New Car", type: "spaceship" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("type"));
  setSecret(REAL_ADMIN_SECRET);
});

test("create: 409 when vehicle already exists", async () => {
  setSecret("testSecret");
  supabaseMockState.client = {
    from: () => ({
      select:      () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { vehicle_id: "mynewcar" }, error: null }) }) }),
    }),
  };

  const req = makeReq({ body: { secret: "testSecret", action: "create", vehicleId: "mynewcar", vehicleName: "My New Car" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 409);
  assert.ok(res._body.error.includes("already exists"));
  setSecret(REAL_ADMIN_SECRET);
});

test("create: inserts new vehicle and returns 201", async () => {
  setSecret("testSecret");
  let insertedPayload = null;
  const insertChain = {
    select: () => insertChain,
    single: () => Promise.resolve({
      data: { data: { vehicle_id: "mynewcar", vehicle_name: "My New Car", type: "economy", status: "active" } },
      error: null,
    }),
  };
  supabaseMockState.client = {
    from: () => ({
      select:      () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      insert:      (payload) => { insertedPayload = payload; return insertChain; },
    }),
  };

  const req = makeReq({ body: {
    secret: "testSecret", action: "create",
    vehicleId: "mynewcar", vehicleName: "My New Car",
    type: "economy", vehicleYear: 2023, purchasePrice: 15000,
    purchaseDate: "2023-06-01", status: "active",
  } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 201);
  assert.equal(res._body.success, true);
  assert.ok(res._body.vehicle);
  assert.equal(res._body.vehicle.vehicle_name, "My New Car");
  assert.ok(insertedPayload);
  assert.equal(insertedPayload.vehicle_id, "mynewcar");
  assert.equal(insertedPayload.data.vehicle_name, "My New Car");
  assert.equal(insertedPayload.data.type, "economy");
  assert.equal(insertedPayload.data.vehicle_year, 2023);
  setSecret(REAL_ADMIN_SECRET);
});

test("create: defaults type to economy and status to active when omitted", async () => {
  setSecret("testSecret");
  let insertedPayload = null;
  const insertChain = {
    select: () => insertChain,
    single: () => Promise.resolve({
      data: { data: { vehicle_id: "testcar2", vehicle_name: "Test Car 2", type: "economy", status: "active" } },
      error: null,
    }),
  };
  supabaseMockState.client = {
    from: () => ({
      select:      () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      insert:      (payload) => { insertedPayload = payload; return insertChain; },
    }),
  };

  const req = makeReq({ body: { secret: "testSecret", action: "create", vehicleId: "testcar2", vehicleName: "Test Car 2" } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 201);
  assert.equal(insertedPayload.data.type, "economy");
  assert.equal(insertedPayload.data.status, "active");
  setSecret(REAL_ADMIN_SECRET);
});
