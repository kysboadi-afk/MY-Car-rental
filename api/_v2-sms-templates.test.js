// api/_v2-sms-templates.test.js
// Unit tests for the POST /api/v2-sms-templates endpoint.
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES } from "./_sms-templates.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeReq({ body = {}, method = "POST", origin = "https://www.slytrans.com" } = {}) {
  return { body, method, headers: { origin } };
}

// ── Mock _github-retry.js so no real network calls are made ───────────────────

// Shared state: each test configures what loadOverrides / saveOverrides should do.
const mockGithubState = {
  overrides: {},
  sha: null,
  saveError: null,
  saveCalls: [],
};

mock.module("./_github-retry.js", {
  namedExports: {
    updateJsonFileWithRetry: async ({ load, apply, save, message }) => {
      const { data, sha } = await load();
      apply(data);
      await save(data, sha, message);
      return data;
    },
  },
});

mock.module("./_admin-auth.js", {
  namedExports: {
    isAdminAuthorized: (supplied) => {
      const expected = process.env.ADMIN_SECRET || "";
      return Boolean(expected && supplied === expected);
    },
    isAdminConfigured: () => Boolean(process.env.ADMIN_SECRET),
  },
});

// Override loadOverrides / saveOverrides by mocking fetch for GitHub API calls.
// Since the handler imports them internally, we use a simpler approach:
// mock the module-level fetch used by loadOverrides / saveOverrides via
// replacing global.fetch for the duration of the test.

function mockFetch(overrides = {}, sha = null, saveError = null) {
  global.fetch = async (url, opts) => {
    if (!opts || opts.method !== "PUT") {
      // GET — return overrides
      if (Object.keys(overrides).length === 0) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: Buffer.from(JSON.stringify(overrides)).toString("base64"),
          sha: sha || "abc123",
        }),
      };
    }
    // PUT
    if (saveError) {
      return { ok: false, status: 409, text: async () => saveError };
    }
    mockGithubState.saveCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
}

function restoreFetch() {
  global.fetch = undefined;
}

const { default: handler } = await import("./v2-sms-templates.js");

// ── Environment setup ─────────────────────────────────────────────────────────

const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET;

function setSecret(val) {
  if (val == null) {
    delete process.env.ADMIN_SECRET;
  } else {
    process.env.ADMIN_SECRET = val;
  }
}

// ── Method guard ──────────────────────────────────────────────────────────────

test("OPTIONS returns 200", async () => {
  setSecret("testSecret");
  const req = makeReq({ method: "OPTIONS" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  setSecret(REAL_ADMIN_SECRET);
});

test("GET returns 405", async () => {
  setSecret("testSecret");
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
  setSecret(REAL_ADMIN_SECRET);
});

test("DELETE returns 405", async () => {
  setSecret("testSecret");
  const req = makeReq({ method: "DELETE" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 405);
  setSecret(REAL_ADMIN_SECRET);
});

// ── Auth ──────────────────────────────────────────────────────────────────────

test("500 when ADMIN_SECRET env var is not set", async () => {
  setSecret(null);
  mockFetch();
  const req = makeReq({ body: { secret: "anything", action: "list" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 500);
  assert.ok(res._body.error.includes("ADMIN_SECRET"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("401 when secret is missing", async () => {
  setSecret("testSecret");
  mockFetch();
  const req = makeReq({ body: { action: "list" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Unauthorized");
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("401 when secret is wrong", async () => {
  setSecret("testSecret");
  mockFetch();
  const req = makeReq({ body: { secret: "wrong", action: "list" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
  assert.equal(res._body.error, "Unauthorized");
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

// ── list ──────────────────────────────────────────────────────────────────────

test("list: returns all templates with defaults when no overrides exist", async () => {
  setSecret("testSecret");
  mockFetch({}); // 404 → no overrides
  const req = makeReq({ body: { secret: "testSecret", action: "list" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body.templates));
  assert.equal(res._body.templates.length, Object.keys(TEMPLATES).length);
  const t = res._body.templates.find((x) => x.key === "booking_confirmed");
  assert.ok(t);
  assert.equal(t.isCustomized, false);
  assert.equal(t.enabled, true);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("list: merges overrides with defaults", async () => {
  setSecret("testSecret");
  const overrides = { booking_confirmed: { message: "Custom msg", enabled: false } };
  mockFetch(overrides, "sha1");
  const req = makeReq({ body: { secret: "testSecret", action: "list" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  const t = res._body.templates.find((x) => x.key === "booking_confirmed");
  assert.equal(t.message, "Custom msg");
  assert.equal(t.enabled, false);
  assert.equal(t.isCustomized, true);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("list: no action defaults to list", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret" } }); // no action
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body.templates));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("list: each template includes triggerEvent derived from key", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "list" } });
  const res = makeRes();
  await handler(req, res);
  const t = res._body.templates.find((x) => x.key === "pickup_reminder_24h");
  assert.equal(t.triggerEvent, "pickup_reminder");
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

// ── update ────────────────────────────────────────────────────────────────────

test("update: 400 when templateKey is missing", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "update", updates: { enabled: false } } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("templateKey"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: 400 when templateKey is unknown", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "update", templateKey: "nonexistent_key", updates: { enabled: false } } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("unknown") || res._body.error.toLowerCase().includes("template"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: 400 when updates is missing", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "update", templateKey: "booking_confirmed" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("updates"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: 400 when updates contains no valid fields", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "update", templateKey: "booking_confirmed", updates: { unknownField: "x" } } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("message") || res._body.error.includes("enabled"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: 400 when updates is an empty object", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "update", templateKey: "booking_confirmed", updates: {} } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: 200 and returns updated template on valid message update", async () => {
  setSecret("testSecret");
  mockGithubState.saveCalls = [];
  mockFetch({}, null, null);
  const req = makeReq({ body: {
    secret:      "testSecret",
    action:      "update",
    templateKey: "booking_confirmed",
    updates:     { message: "New custom message" },
  }});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.template.key, "booking_confirmed");
  assert.equal(res._body.template.message, "New custom message");
  assert.equal(res._body.template.isCustomized, true);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: 200 and returns updated template on valid enabled update", async () => {
  setSecret("testSecret");
  mockFetch({}, null, null);
  const req = makeReq({ body: {
    secret:      "testSecret",
    action:      "update",
    templateKey: "booking_confirmed",
    updates:     { enabled: false },
  }});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.template.enabled, false);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: truncates message to 1000 characters", async () => {
  setSecret("testSecret");
  mockFetch({}, null, null);
  const longMsg = "x".repeat(1500);
  const req = makeReq({ body: {
    secret:      "testSecret",
    action:      "update",
    templateKey: "booking_confirmed",
    updates:     { message: longMsg },
  }});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.template.message.length, 1000);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("update: ignores extra unknown fields in updates (only message/enabled accepted)", async () => {
  setSecret("testSecret");
  mockFetch({}, null, null);
  // Use Object.defineProperty so '__proto__' is an actual enumerable string key,
  // mirroring how JSON.parse (i.e. a real HTTP body) would deliver the field.
  const updates = { message: "Valid", injected: "evil" };
  Object.defineProperty(updates, "__proto__", { value: { polluted: true }, enumerable: true });
  const req = makeReq({ body: {
    secret:      "testSecret",
    action:      "update",
    templateKey: "booking_confirmed",
    updates,
  }});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  // The injected field should NOT appear in the response
  assert.ok(!Object.prototype.hasOwnProperty.call(res._body.template, "injected"));
  assert.equal(res._body.template.message, "Valid");
  // prototype must not have been polluted
  assert.equal(({}).polluted, undefined);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

// ── reset ─────────────────────────────────────────────────────────────────────

test("reset: 400 when templateKey is missing", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "reset" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.toLowerCase().includes("templatekey") || res._body.error.toLowerCase().includes("invalid"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("reset: 400 when templateKey is unknown", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "reset", templateKey: "nonexistent" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

test("reset: 200 and returns default template", async () => {
  setSecret("testSecret");
  const overrides = { booking_confirmed: { message: "Old custom", enabled: false } };
  mockFetch(overrides, "sha1", null);
  const req = makeReq({ body: { secret: "testSecret", action: "reset", templateKey: "booking_confirmed" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.template.key, "booking_confirmed");
  assert.equal(res._body.template.message, TEMPLATES.booking_confirmed);
  assert.equal(res._body.template.enabled, true);
  assert.equal(res._body.template.isCustomized, false);
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});

// ── unknown action ────────────────────────────────────────────────────────────

test("unknown action returns 400", async () => {
  setSecret("testSecret");
  mockFetch({});
  const req = makeReq({ body: { secret: "testSecret", action: "destroy" } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.ok(res._body.error.includes("destroy"));
  setSecret(REAL_ADMIN_SECRET);
  restoreFetch();
});
