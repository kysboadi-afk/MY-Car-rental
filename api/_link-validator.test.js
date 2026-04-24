// api/_link-validator.test.js
// Unit tests for _link-validator.js
//
// Run with: npm test

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Mock global fetch ─────────────────────────────────────────────────────────

let mockFetchImpl = null;

// Replace global fetch before importing the module
global.fetch = async (url, opts) => {
  if (typeof mockFetchImpl === "function") return mockFetchImpl(url, opts);
  throw new Error("fetch not mocked");
};

const { validateLink, BASE_URL, PAGE_URLS } = await import("./_link-validator.js");

// Helper: build a minimal Response-like object
function fakeResp(status) {
  return { status, ok: status >= 200 && status < 300 };
}

function setFetch(impl) {
  mockFetchImpl = impl;
}

// ── Constants ─────────────────────────────────────────────────────────────────

test("BASE_URL is https://www.slytrans.com", () => {
  assert.equal(BASE_URL, "https://www.slytrans.com");
});

test("PAGE_URLS.balance ends with balance.html", () => {
  assert.ok(PAGE_URLS.balance.endsWith("/balance.html"));
});

test("PAGE_URLS.cars ends with cars.html", () => {
  assert.ok(PAGE_URLS.cars.endsWith("/cars.html"));
});

test("PAGE_URLS.managebooking ends with manage-booking.html", () => {
  assert.ok(PAGE_URLS.managebooking.endsWith("/manage-booking.html"));
});

// ── validateLink — success path ───────────────────────────────────────────────

test("validateLink: returns ok=true when HEAD returns 200", async () => {
  setFetch(async () => fakeResp(200));
  const r = await validateLink("https://www.slytrans.com/balance.html");
  assert.equal(r.ok,           true);
  assert.equal(r.status,       200);
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.url, "https://www.slytrans.com/balance.html");
});

test("validateLink: url is preserved in result when page is reachable", async () => {
  setFetch(async () => fakeResp(200));
  const original = "https://www.slytrans.com/balance.html?ext=1&cs=secret";
  const r = await validateLink(original);
  assert.equal(r.url, original);
});

test("validateLink: 301 redirect counts as ok", async () => {
  setFetch(async () => fakeResp(301));
  const r = await validateLink("https://www.slytrans.com/balance.html");
  assert.equal(r.ok, true);
});

// ── validateLink — failure path ───────────────────────────────────────────────

test("validateLink: returns ok=false when HEAD returns 404", async () => {
  setFetch(async () => fakeResp(404));
  const r = await validateLink("https://www.slytrans.com/missing.html");
  assert.equal(r.ok,           false);
  assert.equal(r.status,       404);
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.url, PAGE_URLS.cars); // default fallback
});

test("validateLink: returns ok=false when HEAD returns 500", async () => {
  setFetch(async () => fakeResp(500));
  const r = await validateLink("https://www.slytrans.com/balance.html");
  assert.equal(r.ok,           false);
  assert.equal(r.fallbackUsed, true);
});

test("validateLink: returns ok=false on network error", async () => {
  setFetch(async () => { throw new Error("ECONNREFUSED"); });
  const r = await validateLink("https://www.slytrans.com/balance.html");
  assert.equal(r.ok,           false);
  assert.equal(r.status,       null);
  assert.equal(r.fallbackUsed, true);
});

// ── validateLink — 405 HEAD → GET fallback ────────────────────────────────────

test("validateLink: retries with GET when HEAD returns 405", async () => {
  let callCount = 0;
  setFetch(async (_url, opts) => {
    callCount++;
    if (opts && opts.method === "HEAD") return fakeResp(405);
    return fakeResp(200); // GET succeeds
  });
  const r = await validateLink("https://www.slytrans.com/balance.html");
  assert.equal(r.ok, true);
  assert.ok(callCount >= 2, "should have retried with GET");
});

// ── validateLink — baseUrlForValidation ───────────────────────────────────────

test("validateLink: validates baseUrlForValidation but returns original url on success", async () => {
  const validated = [];
  setFetch(async (url) => {
    validated.push(url);
    return fakeResp(200);
  });
  const fullLink = "https://www.slytrans.com/balance.html?cs=secret123";
  const r = await validateLink(fullLink, {
    baseUrlForValidation: PAGE_URLS.balance,
    fallback:             PAGE_URLS.cars,
  });
  assert.ok(validated.some((u) => u === PAGE_URLS.balance), "should validate base page");
  assert.equal(r.url, fullLink, "should return original full link when page is ok");
  assert.equal(r.ok,           true);
  assert.equal(r.fallbackUsed, false);
});

test("validateLink: returns custom fallback when base page is unreachable", async () => {
  setFetch(async () => fakeResp(503));
  const r = await validateLink("https://www.slytrans.com/balance.html?cs=s", {
    baseUrlForValidation: PAGE_URLS.balance,
    fallback:             PAGE_URLS.managebooking,
  });
  assert.equal(r.ok,           false);
  assert.equal(r.url,          PAGE_URLS.managebooking);
  assert.equal(r.fallbackUsed, true);
});

// ── validateLink — default fallback ───────────────────────────────────────────

test("validateLink: fallback defaults to cars.html", async () => {
  setFetch(async () => fakeResp(404));
  const r = await validateLink("https://www.slytrans.com/balance.html");
  assert.equal(r.url, PAGE_URLS.cars);
});

test("validateLink: custom fallback is used when provided", async () => {
  setFetch(async () => fakeResp(404));
  const r = await validateLink("https://www.slytrans.com/balance.html", {
    fallback: "https://www.slytrans.com/manage-booking.html",
  });
  assert.equal(r.url, "https://www.slytrans.com/manage-booking.html");
});
