// api/_github-retry.test.js
// Unit tests for the shared GitHub read-modify-write retry helper.
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { is409Conflict, updateJsonFileWithRetry } from "./_github-retry.js";

// ── is409Conflict ──────────────────────────────────────────────────────────

test("is409Conflict: returns true for message containing '409'", () => {
  assert.equal(is409Conflict(new Error("GitHub PUT vehicles.json failed: 409 Conflict")), true);
});

test("is409Conflict: returns true for sha/conflict message", () => {
  assert.equal(is409Conflict(new Error("sha conflict detected")), true);
});

test("is409Conflict: returns false for non-409 error", () => {
  assert.equal(is409Conflict(new Error("GitHub PUT failed: 500 Internal Server Error")), false);
});

test("is409Conflict: returns false for null/undefined", () => {
  assert.equal(is409Conflict(null), false);
  assert.equal(is409Conflict(undefined), false);
});

test("is409Conflict: returns false for empty error", () => {
  assert.equal(is409Conflict(new Error()), false);
});

// ── updateJsonFileWithRetry ────────────────────────────────────────────────

test("updateJsonFileWithRetry: succeeds on first attempt", async () => {
  let loadCalls = 0;
  let saveCalls = 0;

  const load  = async () => { loadCalls++; return { data: { count: 0 }, sha: "abc" }; };
  const apply = (data)  => { data.count += 1; };
  const save  = async (data, sha) => { saveCalls++; assert.equal(sha, "abc"); };

  const result = await updateJsonFileWithRetry({ load, apply, save, message: "test" });
  assert.equal(result.count, 1);
  assert.equal(loadCalls, 1);
  assert.equal(saveCalls, 1);
});

test("updateJsonFileWithRetry: retries once on 409, succeeds on second attempt", async () => {
  let attempt = 0;

  const load  = async () => ({ data: { count: 0 }, sha: `sha-${attempt}` });
  const apply = (data)  => { data.count += 1; };
  const save  = async () => {
    attempt++;
    if (attempt === 1) throw new Error("GitHub PUT failed: 409 Conflict");
  };

  const result = await updateJsonFileWithRetry({ load, apply, save, message: "test", backoffMs: 1 });
  assert.equal(result.count, 1);
  assert.equal(attempt, 2); // one 409 + one success
});

test("updateJsonFileWithRetry: retries up to maxRetries on persistent 409, then throws", async () => {
  let saveCalls = 0;
  const conflictError = new Error("GitHub PUT failed: 409 Conflict");

  const load  = async () => ({ data: {}, sha: "old-sha" });
  const apply = ()     => {};
  const save  = async () => { saveCalls++; throw conflictError; };

  await assert.rejects(
    () => updateJsonFileWithRetry({ load, apply, save, message: "test", maxRetries: 3, backoffMs: 1 }),
    conflictError
  );
  assert.equal(saveCalls, 3);
});

test("updateJsonFileWithRetry: does NOT retry on non-409 error", async () => {
  let saveCalls = 0;
  const fatalError = new Error("GitHub PUT failed: 500 Internal Server Error");

  const load  = async () => ({ data: {}, sha: "sha" });
  const apply = ()     => {};
  const save  = async () => { saveCalls++; throw fatalError; };

  await assert.rejects(
    () => updateJsonFileWithRetry({ load, apply, save, message: "test", maxRetries: 3, backoffMs: 1 }),
    fatalError
  );
  assert.equal(saveCalls, 1); // no retry for non-409
});

test("updateJsonFileWithRetry: apply is called fresh on each retry (idempotency)", async () => {
  let applyCalls = 0;
  let saveCalls  = 0;

  const load  = async () => ({ data: { items: [] }, sha: "sha" });
  const apply = (data) => {
    applyCalls++;
    // Idempotent: only push if not already present
    if (!data.items.includes("item")) data.items.push("item");
  };
  const save  = async () => {
    saveCalls++;
    if (saveCalls < 3) throw new Error("409 Conflict");
  };

  const result = await updateJsonFileWithRetry({ load, apply, save, message: "test", maxRetries: 3, backoffMs: 1 });
  assert.equal(result.items.length, 1); // exactly one "item" — not duplicated
  assert.equal(applyCalls, 3);
  assert.equal(saveCalls, 3);
});
