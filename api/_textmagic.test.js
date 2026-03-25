// Tests for api/_textmagic.js
// Verifies that sendSms POSTs to the TextMagic API with the correct payload,
// including the registered sender number in the `from` field so that OTP codes
// and other messages are delivered to US phone numbers.
//
// Run with: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";

// ─── Environment variables ────────────────────────────────────────────────────
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY  = "test-api-key-00000000000000000000000";

// ─── Patch globalThis.fetch before the module is loaded ──────────────────────
// _textmagic.js calls the global `fetch` at runtime (not imported), so
// replacing globalThis.fetch is the correct interception point.
const sentRequests = [];
const originalFetch = globalThis.fetch;

function makeMockFetch(ok = true, status = 200) {
  return async function mockFetch(url, options) {
    sentRequests.push({
      url,
      body:    JSON.parse(options.body),
      headers: options.headers,
    });
    return {
      ok,
      status,
      json: async () => ({ id: "1" }),
      text: async () => (ok ? "" : "Insufficient funds"),
    };
  };
}

globalThis.fetch = makeMockFetch();

const { sendSms } = await import("./_textmagic.js");

// Restore the original fetch after all tests complete.
after(() => { globalThis.fetch = originalFetch; });

// ─── Tests ────────────────────────────────────────────────────────────────────

test("sendSms POSTs to the TextMagic API endpoint", async () => {
  sentRequests.length = 0;
  await sendSms("+12135550100", "Hello");
  assert.equal(sentRequests.length, 1);
  assert.match(sentRequests[0].url, /rest\.textmagic\.com\/api\/v2\/messages/);
});

test("sendSms sets the recipient in the `phones` field", async () => {
  sentRequests.length = 0;
  await sendSms("+12135550199", "Test message");
  assert.equal(sentRequests[0].body.phones, "+12135550199");
});

test("sendSms sets the message text in the `text` field", async () => {
  sentRequests.length = 0;
  await sendSms("+12135550100", "Your code is: 123456");
  assert.equal(sentRequests[0].body.text, "Your code is: 123456");
});

test("sendSms uses +18332521093 as default `from` sender", async () => {
  sentRequests.length = 0;
  await sendSms("+12135550100", "OTP code");
  assert.equal(
    sentRequests[0].body.from,
    "+18332521093",
    "from must be the registered TextMagic sender so US carriers deliver the message"
  );
});

test("sendSms uses TEXTMAGIC_FROM env var when set", async () => {
  sentRequests.length = 0;
  process.env.TEXTMAGIC_FROM = "+18005550000";
  try {
    await sendSms("+12135550100", "OTP code");
    assert.equal(sentRequests[0].body.from, "+18005550000");
  } finally {
    delete process.env.TEXTMAGIC_FROM;
  }
});

test("sendSms sends X-TM-Username and X-TM-Key auth headers", async () => {
  sentRequests.length = 0;
  await sendSms("+12135550100", "Hello");
  assert.equal(sentRequests[0].headers["X-TM-Username"], "testuser");
  assert.equal(sentRequests[0].headers["X-TM-Key"], "test-api-key-00000000000000000000000");
});

test("sendSms throws when TextMagic returns a non-OK response", async () => {
  sentRequests.length = 0;
  globalThis.fetch = makeMockFetch(false, 402);
  try {
    await assert.rejects(
      () => sendSms("+12135550100", "Hello"),
      /TextMagic API error 402/
    );
  } finally {
    globalThis.fetch = makeMockFetch(); // restore
  }
});

test("sendSms throws when credentials are missing", async () => {
  const savedUser = process.env.TEXTMAGIC_USERNAME;
  const savedKey  = process.env.TEXTMAGIC_API_KEY;
  delete process.env.TEXTMAGIC_USERNAME;
  delete process.env.TEXTMAGIC_API_KEY;

  try {
    await assert.rejects(
      () => sendSms("+12135550100", "Hello"),
      /Missing TextMagic environment variables/
    );
  } finally {
    process.env.TEXTMAGIC_USERNAME = savedUser;
    process.env.TEXTMAGIC_API_KEY  = savedKey;
  }
});
