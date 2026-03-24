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
  slingshot: [],
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

test("returns 500 when GITHUB_TOKEN is not configured", async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const req = makeReq("POST", { secret: "test-admin-secret", vehicleId: "camry", from: "2026-04-01", to: "2026-04-05" });
  const res = makeRes();
  await handler(req, res);
  process.env.GITHUB_TOKEN = savedToken;
  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("GITHUB_TOKEN"));
});

test("successfully adds a new blocked date range", async () => {
  const fetchFn = mockFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

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
  assert.deepEqual(res._body, { success: true, added: 1 });
  assert.equal(fetchFn.getStored().camry.length, 1, "Blocked range should be added");
  assert.deepEqual(fetchFn.getStored().camry[0], { from: "2026-04-01", to: "2026-04-05" });
});

test("returns added:0 when range overlaps an existing booking", async () => {
  const fetchFn = mockFetch({
    slingshot: [],
    camry: [{ from: "2026-04-01", to: "2026-04-05" }],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-03",
    to: "2026-04-07",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(res._status, 200);
  assert.equal(res._body.added, 0, "Should not add when overlap exists");
  assert.equal(fetchFn.getStored().camry.length, 1, "Original range should remain unchanged");
});

test("does not affect other vehicles when blocking dates", async () => {
  const fetchFn = mockFetch({
    slingshot: [{ from: "2026-04-01", to: "2026-04-05" }],
    camry: [],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-10",
    to: "2026-04-15",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(res._status, 200);
  assert.equal(fetchFn.getStored().camry.length, 1, "camry range should be added");
  assert.equal(fetchFn.getStored().slingshot.length, 1, "slingshot range should be untouched");
});

test("creates vehicle key if it does not exist in the file", async () => {
  const fetchFn = mockFetch({ slingshot: [] }); // no camry key
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-10",
    to: "2026-04-15",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(res._status, 200);
  assert.ok(Array.isArray(fetchFn.getStored().camry), "camry key should be created");
  assert.equal(fetchFn.getStored().camry.length, 1);
});

test("makes a GET then a PUT to GitHub API", async () => {
  const fetchFn = mockFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-01",
    to: "2026-04-05",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(fetchFn.calls.length, 2, "Should make exactly 2 GitHub API calls");
  assert.ok(fetchFn.calls[0].url.includes("booked-dates.json"));
  assert.equal(fetchFn.calls[0].method, undefined); // GET (no method = default GET)
  assert.equal(fetchFn.calls[1].method, "PUT");
});

test("returns 500 when GitHub GET fails", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "error" });

  const req = makeReq("POST", {
    secret: "test-admin-secret",
    vehicleId: "camry",
    from: "2026-04-01",
    to: "2026-04-05",
  });
  const res = makeRes();
  await handler(req, res);
  globalThis.fetch = origFetch;

  assert.equal(res._status, 500);
});

test("returns 500 when GitHub PUT fails", async () => {
  const origFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url, opts) => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({ content: MOCK_FILE_CONTENT(INITIAL_DATES), sha: "abc" }),
      };
    }
    return { ok: false, status: 409, text: async () => "conflict" };
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

  assert.equal(res._status, 500);
});
