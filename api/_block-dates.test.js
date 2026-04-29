// Tests for api/block-dates.js
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ──────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-admin-secret";
process.env.GITHUB_TOKEN = "test-github-token";

// Dynamic import after env vars are set
const { default: handler } = await import("./block-dates.js");

// ─── Helpers ────────────────────────────────────────────────────────────────
function makeRes() {
  return {
    _headers: {},
    _status: 200,
    _body: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(code) { this._status = code; return this; },
    end() { return this; },
    send(text) { this._body = text; return this; },
    json(obj) { this._body = obj; return this; },
  };
}

function makeReq(method, body = {}, origin = "https://www.slytrans.com") {
  return { method, headers: { origin }, body };
}

const MOCK_FILE_CONTENT = (data) =>
  Buffer.from(JSON.stringify(data, null, 2) + "\n").toString("base64");

const INITIAL_DATES = {
  camry: [],
};

function mockFetch(initial = INITIAL_DATES) {
  let stored = JSON.parse(JSON.stringify(initial));
  let sha = "abc123";
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, method: opts && opts.method, body: opts && opts.body });
    if (opts && opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      stored = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
      sha = body.sha + "_updated";
      return { ok: true, json: async () => ({ content: MOCK_FILE_CONTENT(stored), sha }) };
    }
    // GET
    return {
      ok: true,
      json: async () => ({ content: MOCK_FILE_CONTENT(stored), sha }),
    };
  };
  fetchFn.calls = calls;
  fetchFn.getStored = () => stored;
  return fetchFn;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("OPTIONS request returns 200", async () => {
  const req = makeReq("OPTIONS");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
});

test("non-POST request returns 405", async () => {
  const req = makeReq("GET");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
});

test("CORS header is set for allowed origin www.slytrans.com", async () => {
  const req = makeReq("OPTIONS", {}, "https://www.slytrans.com");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://www.slytrans.com");
});

test("CORS header is set for allowed origin slytrans.com", async () => {
  const req = makeReq("OPTIONS", {}, "https://slytrans.com");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "https://slytrans.com");
});

test("CORS header is NOT set for unknown origin", async () => {
  const req = makeReq("OPTIONS", {}, "https://evil.example.com");
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._headers["Access-Control-Allow-Origin"], undefined);
});

test("returns 401 when secret is missing", async () => {
  const req = makeReq("POST", { vehicleId: "camry", from: "2026-04-01", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 401 when secret is wrong", async () => {
  const req = makeReq("POST", { secret: "wrong-secret", vehicleId: "camry", from: "2026-04-01", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 400 when vehicleId is missing", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", from: "2026-04-01", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
});

test("returns 400 when from is missing", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("from"));
});

test("returns 400 when to is missing", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-04-01" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("to"));
});

test("returns 400 when from is after to", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-04-10", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("from"));
});

test("returns 400 when from is not a valid date format", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "04-01-2026", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});

test("returns 500 when ADMIN_SECRET is not configured", async () => {
  const saved = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;

  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-04-01", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  process.env.ADMIN_SECRET = saved;
  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("ADMIN_SECRET"));
});

// Phase 4: GITHUB_TOKEN is no longer required — booked-dates.json writes are disabled.
// The endpoint now writes directly to Supabase (or silently skips when Supabase is not configured).
test("succeeds even when GITHUB_TOKEN is not configured (Phase 4)", async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-04-01", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  process.env.GITHUB_TOKEN = savedToken;
  // Phase 4: no longer returns 500 for missing GITHUB_TOKEN
  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true, added: 1 });
});

test("successfully adds a new blocked date range (Supabase-only, Phase 4)", async () => {
  // Phase 4: GitHub API is no longer called; Supabase is the only write target.
  // When Supabase is not configured in tests, autoCreateBlockedDate silently succeeds.
  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-01",
    to: "2026-04-05",
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { success: true, added: 1 });
});

// Phase 4: overlap detection was done in the JSON file; now Supabase handles idempotency.
// The endpoint always reports added:1 on Supabase success (no pre-check for overlaps).
test("returns 200 when range would overlap (idempotent Supabase upsert, Phase 4)", async () => {
  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-03",
    to: "2026-04-07",
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(typeof res._body.added, "number");
});

test("does not make GitHub API calls (Phase 4: GitHub writes disabled)", async () => {
  const githubCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (typeof url === "string" && url.includes("api.github.com")) {
      githubCalls.push({ url, method: (opts && opts.method) || "GET" });
    }
    return { ok: true, json: async () => ({}) };
  };

  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-01",
    to: "2026-04-05",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(res._status, 200);
  assert.equal(githubCalls.length, 0, "Phase 4: no GitHub API calls should be made");
});
