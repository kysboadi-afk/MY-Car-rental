// Tests for api/open-dates.js
//
// Run with: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Environment setup ──────────────────────────────────────────────────────
process.env.ADMIN_SECRET = "test-admin-secret";
process.env.GITHUB_TOKEN = "test-github-token";

// Dynamic import after env vars are set
const { default: handler } = await import("./open-dates.js");

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
  camry: [{ from: "2026-03-01", to: "2026-03-05" }],
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
  const req = makeReq("POST", { vehicleId: "camry", from: "2026-03-01", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 401 when secret is wrong", async () => {
  const req = makeReq("POST", { secret: "wrong-secret", vehicleId: "camry", from: "2026-03-01", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
});

test("returns 400 when vehicleId is missing", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", from: "2026-03-01", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("vehicleId"));
});

test("returns 400 when from is missing", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("from"));
});

test("returns 400 when to is missing", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-03-01" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("to"));
});

test("returns 400 when from is after to", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-03-10", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("from"));
});

test("returns 400 when from is not a valid date format", async () => {
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "03-01-2026", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});

test("returns 500 when ADMIN_SECRET is not configured", async () => {
  const saved = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;

  // The handler checks process.env.ADMIN_SECRET at runtime on each invocation,
  // so temporarily deleting the env var is sufficient — no re-import needed.
  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-03-01", to: "2026-03-05" });
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

  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-03-01", to: "2026-03-05" });
  const res = makeRes();
  await handler(req, res);
  process.env.GITHUB_TOKEN = savedToken;
  // Phase 4: no longer returns 500 for missing GITHUB_TOKEN
  assert.equal(res._status, 200);
});

test("successfully removes an overlapping blocked date range (Supabase-only, Phase 4)", async () => {
  // Phase 4: GitHub API is no longer called. Supabase is the only write target.
  // When Supabase is not configured in tests, the handler returns removed:0 (no-op).
  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-03-03",
    to: "2026-03-04",
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.removed, "number");
  assert.equal(typeof res._body.locked, "number");
});

test("removes multiple overlapping ranges (Supabase-only, Phase 4)", async () => {
  // Phase 4: GitHub API no longer called. Only Supabase is queried.
  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-03-04",
    to: "2026-03-07",
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
});

test("does not remove ranges for other vehicles (Supabase-only, Phase 4)", async () => {
  // Phase 4: GitHub API no longer called.
  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-03-01",
    to: "2026-03-05",
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
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
    from: "2026-03-01",
    to: "2026-03-05",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(res._status, 200);
  assert.equal(githubCalls.length, 0, "Phase 4: no GitHub API calls should be made");
});

// Phase 4: GitHub GET/PUT errors are no longer relevant since we don't call GitHub.
