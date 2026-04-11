// api/_v2-revenue.test.js
// Tests for POST /api/v2-revenue.
//
// Validates:
//  1. list action: returns empty array when no records exist anywhere
//  2. list action: derives records from bookings.json when Supabase and GitHub are both empty
//  3. list action: returns Supabase records when available (non-empty)
//  4. list action: falls back to GitHub records (revenue-records.json) when Supabase is absent
//  5. create action: inserts to GitHub fallback when Supabase absent
//  6. sync action: populates records from bookings.json paid bookings
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ────────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-admin-secret";
process.env.GITHUB_TOKEN = "test-github-token";

// ─── Shared mutable state ─────────────────────────────────────────────────────

// Simulated GitHub revenue-records.json content
let ghRecords = [];
let ghSha     = null;

// Simulated bookings.json
let bookingsStore = {};

// Supabase mock state
let supabaseRecords = null; // null = "not configured"; [] = "configured but empty"; [...] = "has data"

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module("./_supabase.js", {
  namedExports: {
    getSupabaseAdmin: () => {
      if (supabaseRecords === null) return null;

      // Build a fluent query object that supports all chaining methods used in
      // v2-revenue.js (select → order → eq → gte → lte → limit) and resolves
      // to { data, error } when awaited.
      function makeQuery() {
        const q = {
          _data:  supabaseRecords,
          _error: null,
          // All chainable methods return the same query object
          select()  { return this; },
          order()   { return this; },
          eq()      { return this; },
          gte()     { return this; },
          lte()     { return this; },
          limit(n)  { this._data = (this._data || []).slice(0, n); return this; },
          single()  { this._data = (this._data || [])[0] || null; return this; },
          maybeSingle() { this._data = (this._data || [])[0] || null; return this; },
          // Make it thenable so `await q` works
          then(onFulfilled) {
            return Promise.resolve({ data: this._data, error: this._error }).then(onFulfilled);
          },
          catch(onRejected) {
            return Promise.resolve({ data: this._data, error: this._error }).catch(onRejected);
          },
        };
        return q;
      }

      return {
        from: (_table) => ({
          select:  (...args) => makeQuery().select(...args),
          insert:  async (_row) => ({ data: [{ id: "sb-id-1" }], error: null }),
          upsert:  async (_rows, _opts) => ({ error: null }),
          delete:  () => ({ eq: async () => ({ error: null }) }),
          update:  (_u) => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: "sb-id-1" }, error: null }) }) }) }),
        }),
      };
    },
  },
});

mock.module("./_bookings.js", {
  namedExports: {
    loadBookings: async () => ({ data: JSON.parse(JSON.stringify(bookingsStore)), sha: "sha1" }),
    saveBookings: async (data) => { Object.assign(bookingsStore, JSON.parse(JSON.stringify(data))); },
  },
});

mock.module("./_error-helpers.js", {
  namedExports: {
    adminErrorMessage: (e) => (e && e.message) ? e.message : String(e),
    isSchemaError:     () => false,
  },
});

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha, message);
    },
  },
});

// GitHub revenue-records.json mock — simulates the file read/write
mock.module("node:crypto", {
  defaultExport: {
    randomBytes: (n) => ({ toString: () => "deadbeef".slice(0, n * 2) }),
    randomUUID:  () => "00000000-0000-0000-0000-000000000001",
  },
  namedExports: {
    default: {
      randomBytes: (n) => ({ toString: () => "deadbeef".slice(0, n * 2) }),
      randomUUID:  () => "00000000-0000-0000-0000-000000000001",
    },
  },
});

// We override the GitHub fetch by patching global.fetch before each test.
function setupGitHubFetch() {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("revenue-records.json")) {
      if (opts && opts.method === "PUT") {
        const body = JSON.parse(opts.body || "{}");
        const decoded = Buffer.from(body.content, "base64").toString("utf-8");
        ghRecords = JSON.parse(decoded);
        ghSha = "sha-updated";
        return { ok: true, json: async () => ({}) };
      }
      // GET
      if (!ghSha) {
        return { ok: false, status: 404, text: async () => "Not Found" };
      }
      const content = Buffer.from(JSON.stringify(ghRecords)).toString("base64");
      return { ok: true, json: async () => ({ content, sha: ghSha }) };
    }
    return { ok: false, status: 500, text: async () => "Unexpected fetch" };
  };
}

function makeRes() {
  return {
    _status:  200,
    _body:    null,
    setHeader() {},
    status(c) { this._status = c; return this; },
    json(b)   { this._body = b;  return this; },
    send(b)   { this._body = b;  return this; },
    end()     { return this; },
  };
}

function makeReq(body) {
  return { method: "POST", headers: { origin: "https://www.slytrans.com" }, body };
}

function resetState() {
  ghRecords      = [];
  ghSha          = null;
  bookingsStore  = {};
  supabaseRecords = null;
  setupGitHubFetch();
}

// ─── Import handler (must come after mocks) ───────────────────────────────────
const { default: handler } = await import("./v2-revenue.js");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. LIST — empty everywhere
// ═══════════════════════════════════════════════════════════════════════════════
test("list: returns empty array when Supabase not configured and no GitHub file", async () => {
  resetState();
  // supabaseRecords = null → Supabase not configured
  // ghSha = null → 404 on GitHub → empty []
  // bookingsStore = {} → no bookings
  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.records, []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LIST — derived from bookings.json when both Supabase and GitHub are empty
// ═══════════════════════════════════════════════════════════════════════════════
test("list: derives records from bookings.json when Supabase+GitHub both empty", async () => {
  resetState();
  // Supabase not configured
  // GitHub 404 → empty
  bookingsStore = {
    camry: [
      {
        bookingId:     "bk-001",
        vehicleId:     "camry",
        name:          "Alice Smith",
        phone:         "+13105550001",
        email:         "alice@example.com",
        pickupDate:    "2026-05-01",
        returnDate:    "2026-05-03",
        amountPaid:    100,
        paymentMethod: "stripe",
        status:        "booked_paid",
        createdAt:     "2026-04-20T10:00:00.000Z",
      },
    ],
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.records.length, 1, "should derive 1 record from bookings.json");
  const r = res._body.records[0];
  assert.equal(r.booking_id,    "bk-001");
  assert.equal(r.vehicle_id,    "camry");
  assert.equal(r.customer_name, "Alice Smith");
  assert.equal(r.gross_amount,  100);
  assert.equal(r.payment_status,"paid");
  assert.equal(r._derived,      true, "should mark records as derived");
  assert.equal(res._body._source, "bookings_derived");
});

test("list: skips non-paid bookings when deriving from bookings.json", async () => {
  resetState();
  bookingsStore = {
    camry: [
      { bookingId:"bk-paid", vehicleId:"camry", name:"Bob", amountPaid:50, status:"booked_paid",  createdAt:"2026-05-01T00:00:00.000Z" },
      { bookingId:"bk-unpaid", vehicleId:"camry", name:"Carol", amountPaid:0, status:"reserved_unpaid", createdAt:"2026-05-02T00:00:00.000Z" },
      { bookingId:"bk-cancelled", vehicleId:"camry", name:"Dave", amountPaid:75, status:"cancelled_rental", createdAt:"2026-05-03T00:00:00.000Z" },
    ],
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  const ids = res._body.records.map((r) => r.booking_id);
  assert.ok(ids.includes("bk-paid"),   "paid booking should be included");
  assert.ok(!ids.includes("bk-unpaid"),"unpaid booking should be excluded (amountPaid=0)");
  // cancelled_rental is intentionally excluded from the derived revenue view
  // (same behaviour as the sync action — only active/completed paid bookings count as revenue)
  assert.ok(!ids.includes("bk-cancelled"), "cancelled booking should be excluded from revenue view");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. LIST — Supabase has records → returns them directly
// ═══════════════════════════════════════════════════════════════════════════════
test("list: returns Supabase records when available and non-empty", async () => {
  resetState();
  supabaseRecords = [
    { id: "sb-1", booking_id: "bk-sb", vehicle_id: "slingshot", gross_amount: 350, payment_status: "paid" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.records.length, 1);
  assert.equal(res._body.records[0].id, "sb-1");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LIST — Supabase empty, GitHub has records
// ═══════════════════════════════════════════════════════════════════════════════
test("list: returns GitHub records when Supabase is empty but GitHub file exists", async () => {
  resetState();
  supabaseRecords = []; // configured but empty
  ghSha     = "sha-existing";
  ghRecords = [
    { id: "gh-1", booking_id: "bk-gh", vehicle_id: "camry", gross_amount: 50, payment_status: "paid", created_at: "2026-03-01T00:00:00.000Z" },
  ];

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "list" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.records.length, 1);
  assert.equal(res._body.records[0].id, "gh-1");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CREATE — GitHub fallback when Supabase not configured
// ═══════════════════════════════════════════════════════════════════════════════
test("create: saves to GitHub when Supabase not configured", async () => {
  resetState();
  // supabaseRecords = null → Supabase not configured
  ghSha     = "sha-existing";
  ghRecords = [];

  const res = makeRes();
  await handler(makeReq({
    secret:         "test-admin-secret",
    action:         "create",
    vehicle_id:     "camry",
    gross_amount:   75,
    customer_name:  "Test User",
    payment_method: "cash",
    payment_status: "paid",
  }), res);
  assert.equal(res._status, 201);
  assert.ok(res._body.record, "should return the created record");
  assert.equal(res._body.record.vehicle_id, "camry");
  assert.equal(ghRecords.length, 1, "record should be saved to GitHub");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SYNC — builds records from bookings.json
// ═══════════════════════════════════════════════════════════════════════════════
test("sync: creates GitHub records from paid bookings when Supabase not configured", async () => {
  resetState();
  ghSha     = "sha-existing";
  ghRecords = [];
  bookingsStore = {
    camry: [
      { bookingId:"bk-s1", vehicleId:"camry", name:"Sync User", amountPaid:100, paymentMethod:"cash", status:"completed_rental" },
      { bookingId:"bk-s2", vehicleId:"camry", name:"No Pay",    amountPaid:0,   paymentMethod:"cash", status:"booked_paid" },
    ],
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "sync" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.synced, 1, "only the paid booking should be synced");
  assert.equal(res._body.skipped, 0);
  assert.equal(ghRecords.length, 1, "one record written to GitHub");
  assert.equal(ghRecords[0].booking_id, "bk-s1");
});

test("sync: skips already-synced bookings (idempotent)", async () => {
  resetState();
  ghSha     = "sha-existing";
  ghRecords = [
    { id: "existing", booking_id: "bk-s1", vehicle_id: "camry", gross_amount: 100 },
  ];
  bookingsStore = {
    camry: [
      { bookingId:"bk-s1", vehicleId:"camry", name:"Sync User", amountPaid:100, status:"completed_rental" },
    ],
  };

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "sync" }), res);
  assert.equal(res._status, 200);
  assert.equal(res._body.synced,  0, "already-synced booking should be skipped");
  assert.equal(res._body.skipped, 1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. RECORD EXTENSION FEE
// ═══════════════════════════════════════════════════════════════════════════════
test("record_extension_fee: 400 when required fields are missing", async () => {
  resetState();
  ghSha = "sha-existing";

  const res = makeRes();
  await handler(makeReq({ secret: "test-admin-secret", action: "record_extension_fee", vehicle_id: "camry", amount: 181.91 }), res);
  assert.equal(res._status, 400, "should reject missing original_booking_id");
});

test("record_extension_fee: 400 when amount is zero or negative", async () => {
  resetState();
  ghSha = "sha-existing";

  const res = makeRes();
  await handler(makeReq({
    secret:              "test-admin-secret",
    action:              "record_extension_fee",
    original_booking_id: "d95643b10c87a02f1a510f7466b2bedf",
    vehicle_id:          "camry",
    amount:              -10,
  }), res);
  assert.equal(res._status, 400, "should reject non-positive amount");
});

test("record_extension_fee: saves to GitHub with synthetic booking_id when Supabase not configured", async () => {
  resetState();
  ghSha     = "sha-existing";
  ghRecords = [];
  // supabaseRecords = null → Supabase not configured

  const res = makeRes();
  await handler(makeReq({
    secret:              "test-admin-secret",
    action:              "record_extension_fee",
    original_booking_id: "d95643b10c87a02f1a510f7466b2bedf",
    vehicle_id:          "camry",
    amount:              181.91,
    extension_label:     "+3 days",
    payment_method:      "cash",
  }), res);

  assert.equal(res._status, 201, "should return 201 Created");
  assert.ok(res._body.record, "should return the created record");
  assert.ok(res._body.booking_id.startsWith("ext-d95643b10c87a02f1a510f7466b2bedf-"), "booking_id should use ext- prefix");
  assert.equal(res._body.record.vehicle_id,     "camry");
  assert.equal(res._body.record.gross_amount,   181.91);
  assert.equal(res._body.record.payment_method, "cash");
  assert.equal(res._body.record.payment_status, "paid");
  assert.ok(res._body.record.notes.includes("d95643b10c87a02f1a510f7466b2bedf"), "notes should reference original booking");
  assert.ok(res._body.record.notes.includes("+3 days"), "notes should include extension label");
  assert.equal(ghRecords.length, 1, "record should be saved to GitHub");
  assert.ok(ghRecords[0].booking_id.startsWith("ext-"), "GitHub record should use ext- prefix");
});

test("record_extension_fee: auto-generates notes when not provided", async () => {
  resetState();
  ghSha     = "sha-existing";
  ghRecords = [];

  const res = makeRes();
  await handler(makeReq({
    secret:              "test-admin-secret",
    action:              "record_extension_fee",
    original_booking_id: "abc123",
    vehicle_id:          "slingshot",
    amount:              75,
  }), res);

  assert.equal(res._status, 201);
  assert.ok(res._body.record.notes.includes("abc123"), "auto-generated notes should reference original booking");
  assert.ok(res._body.record.notes.toLowerCase().includes("extension"), "notes should mention extension");
  assert.equal(res._body.record.payment_method, "external", "default payment_method should be 'external'");
});

test("auth: rejects wrong secret with 401", async () => {
  resetState();
  const res = makeRes();
  await handler(makeReq({ secret: "wrong-secret", action: "list" }), res);
  assert.equal(res._status, 401);
});

test("auth: rejects missing secret with 401", async () => {
  resetState();
  const res = makeRes();
  await handler(makeReq({ action: "list" }), res);
  assert.equal(res._status, 401);
});
