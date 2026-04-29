// Tests for api/_contacts.js
// Validates TextMagic contact upsert and tag management logic.
//
// Run with: npm test

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── TextMagic env vars ───────────────────────────────────────────────────────
process.env.TEXTMAGIC_USERNAME = "testuser";
process.env.TEXTMAGIC_API_KEY  = "test-key";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock fetch function that records calls and returns preset responses.
 * responses: Array of { url?, method?, status, body } matched in order.
 */
function buildFetch(responses) {
  let callIndex = 0;
  const calls = [];

  const fetchMock = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ url, method, body: opts.body });

    const preset = responses[callIndex++];
    if (!preset) throw new Error(`Unexpected fetch call #${callIndex}: ${method} ${url}`);

    const status = preset.status ?? 200;
    const body   = preset.body ?? {};
    return {
      ok:     status >= 200 && status < 300,
      status,
      json:   async () => body,
      text:   async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };

  fetchMock.calls = calls;
  return fetchMock;
}

const MOCK_LISTS = [
  { id: 1, name: "application" },
  { id: 2, name: "approved" },
  { id: 3, name: "waitlist" },
  { id: 4, name: "booked" },
  { id: 6, name: "economy" },
  { id: 7, name: "past_customer" },
];
const MOCK_LISTS_RESPONSE = { resources: MOCK_LISTS };

// Import the module under test once (env vars already set above)
const { upsertContact, vehicleTag } = await import("./_contacts.js");

// ─── vehicleTag ────────────────────────────────────────────────────────────────

test("vehicleTag returns 'economy' for camry", () => {
  assert.equal(vehicleTag("camry"), "economy");
});

test("vehicleTag returns 'economy' for camry2013", () => {
  assert.equal(vehicleTag("camry2013"), "economy");
});

test("vehicleTag returns null for unknown vehicleId", () => {
  assert.equal(vehicleTag("unknown"), null);
});

// ─── upsertContact: skips when credentials missing ────────────────────────────

test("upsertContact does nothing when TEXTMAGIC_USERNAME is absent", async () => {
  const saved = process.env.TEXTMAGIC_USERNAME;
  delete process.env.TEXTMAGIC_USERNAME;

  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };

  await upsertContact("+13105550001", "Test User", { addTags: ["application"] });
  assert.equal(fetched, false, "fetch should not be called without credentials");

  process.env.TEXTMAGIC_USERNAME = saved;
  globalThis.fetch = originalFetch;
});

test("upsertContact does nothing when phone is absent", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };

  await upsertContact("", "Test User", { addTags: ["application"] });
  assert.equal(fetched, false, "fetch should not be called without phone");

  globalThis.fetch = originalFetch;
});

// ─── upsertContact: new contact creation ──────────────────────────────────────

test("upsertContact creates a new contact when phone is not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetch([
    // 1. fetchAllLists
    { status: 200, body: MOCK_LISTS_RESPONSE },
    // 2. findContactByPhone → 404 (not found)
    { status: 404, body: {} },
    // 3. createContact
    { status: 201, body: { id: 999 } },
  ]);

  await upsertContact("+13105550100", "Jane Doe", { addTags: ["application"] });

  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 3);
  // Third call should be POST to /contacts
  assert.ok(calls[2].url.includes("/contacts"), "Third call should create contact");
  assert.equal(calls[2].method, "POST");

  // Verify the contact body includes the correct lists
  const body = JSON.parse(calls[2].body);
  assert.equal(body.firstName, "Jane");
  assert.equal(body.lastName, "Doe");
  assert.equal(body.lists, "1"); // list ID 1 = "application"

  globalThis.fetch = originalFetch;
});

test("upsertContact passes multiple list IDs when multiple tags are given", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 404, body: {} },    // contact not found
    { status: 201, body: { id: 101 } },  // create contact
  ]);

  await upsertContact("+13105550101", "Bob Smith", { addTags: ["waitlist", "booked"] });

  const calls = globalThis.fetch.calls;
  const body = JSON.parse(calls[2].body);
  // lists should contain IDs for "waitlist" (3) and "booked" (4)
  const listIds = body.lists.split(",").map(Number).sort((a, b) => a - b);
  assert.deepEqual(listIds, [3, 4]);

  globalThis.fetch = originalFetch;
});

test("upsertContact creates missing lists before creating the contact", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetch([
    // fetchAllLists — returns no existing lists
    { status: 200, body: { resources: [] } },
    // createList("newTag")
    { status: 201, body: { id: 50 } },
    // findContactByPhone → 404
    { status: 404, body: {} },
    // createContact
    { status: 201, body: { id: 200 } },
  ]);

  await upsertContact("+13105550102", "Alice New", { addTags: ["newTag"] });

  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 4);
  // Second call should create the list
  assert.ok(calls[1].url.includes("/lists"), "Should create missing list");
  assert.equal(calls[1].method, "POST");
  const listBody = JSON.parse(calls[1].body);
  assert.equal(listBody.name, "newTag");

  globalThis.fetch = originalFetch;
});

// ─── upsertContact: existing contact update ───────────────────────────────────

test("upsertContact adds tags to existing contact without re-creating", async () => {
  const originalFetch = globalThis.fetch;
  const existingContact = {
    id: 42,
    phone: "+13105550200",
    firstName: "Existing",
    lastName: "Person",
  };
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 200, body: existingContact },  // findContactByPhone
    { status: 200, body: {} },               // addContactToLists
  ]);

  await upsertContact("+13105550200", "Existing Person", { addTags: ["booked"] });

  const calls = globalThis.fetch.calls;
  // Should NOT create a new contact — only add to list
  assert.equal(calls.length, 3);
  // Third call: POST to /contacts/{id}/lists
  assert.ok(calls[2].url.includes(`/contacts/${existingContact.id}/lists`));
  assert.equal(calls[2].method, "POST");
  const body = JSON.parse(calls[2].body);
  assert.equal(body.ids, "4"); // list ID 4 = "booked"

  globalThis.fetch = originalFetch;
});

test("upsertContact removes tags from existing contact", async () => {
  const originalFetch = globalThis.fetch;
  const existingContact = { id: 43, phone: "+13105550201", firstName: "Old", lastName: "Renter" };
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 200, body: existingContact },   // findContactByPhone
    { status: 200, body: {} },                // removeContactFromLists (booked list ID=4)
  ]);

  await upsertContact("+13105550201", "Old Renter", { removeTags: ["booked"] });

  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 3);
  // Third call: DELETE /contacts/{id}/lists/{listId}
  assert.ok(calls[2].url.includes(`/contacts/${existingContact.id}/lists/4`));
  assert.equal(calls[2].method, "DELETE");

  globalThis.fetch = originalFetch;
});

test("upsertContact adds and removes tags in the same call", async () => {
  const originalFetch = globalThis.fetch;
  const existingContact = { id: 44, phone: "+13105550202", firstName: "Active", lastName: "Renter" };
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 200, body: existingContact },
    { status: 200, body: {} },  // addContactToLists (past_customer)
    { status: 200, body: {} },  // removeContactFromLists (booked)
  ]);

  await upsertContact("+13105550202", "Active Renter", {
    addTags:    ["past_customer"],
    removeTags: ["booked"],
  });

  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 4);
  // Add call
  assert.ok(calls[2].url.includes(`/contacts/${existingContact.id}/lists`));
  assert.equal(calls[2].method, "POST");
  // Remove call
  assert.ok(calls[3].url.includes(`/contacts/${existingContact.id}/lists/4`));
  assert.equal(calls[3].method, "DELETE");

  globalThis.fetch = originalFetch;
});

test("upsertContact updates contact name when it differs", async () => {
  const originalFetch = globalThis.fetch;
  const existingContact = { id: 45, phone: "+13105550203", firstName: "Old", lastName: "Name" };
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 200, body: existingContact },
    { status: 200, body: {} },  // PUT update name
    { status: 200, body: {} },  // addContactToLists
  ]);

  await upsertContact("+13105550203", "New Name", { addTags: ["approved"] });

  const calls = globalThis.fetch.calls;
  // Third call should be PUT to update the contact
  assert.equal(calls[2].method, "PUT");
  assert.ok(calls[2].url.includes(`/contacts/${existingContact.id}`));
  const body = JSON.parse(calls[2].body);
  assert.equal(body.firstName, "New");
  assert.equal(body.lastName, "Name");

  globalThis.fetch = originalFetch;
});

test("upsertContact does not send PUT when name is unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const existingContact = { id: 46, phone: "+13105550204", firstName: "Same", lastName: "Name" };
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 200, body: existingContact },
    { status: 200, body: {} },  // addContactToLists
  ]);

  await upsertContact("+13105550204", "Same Name", { addTags: ["application"] });

  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 3);
  // No PUT update — only list assignment
  assert.equal(calls[2].method, "POST");

  globalThis.fetch = originalFetch;
});

// ─── upsertContact: remove silently handles 404 from list deletion ─────────────

test("upsertContact silently ignores 404 on list removal", async () => {
  const originalFetch = globalThis.fetch;
  const existingContact = { id: 47, phone: "+13105550205", firstName: "Already", lastName: "Gone" };
  globalThis.fetch = buildFetch([
    { status: 200, body: MOCK_LISTS_RESPONSE },
    { status: 200, body: existingContact },
    { status: 404, body: {} },  // DELETE returns 404 — should not throw
  ]);

  // Should not throw
  await assert.doesNotReject(async () => {
    await upsertContact("+13105550205", "Already Gone", { removeTags: ["booked"] });
  });

  globalThis.fetch = originalFetch;
});

// ─── upsertContact: no calls when no tags to manage ──────────────────────────

test("upsertContact with no tags still creates contact with empty lists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetch([
    // No fetchAllLists call when allTags is empty
    { status: 404, body: {} },          // contact not found
    { status: 201, body: { id: 300 } }, // create contact
  ]);

  await upsertContact("+13105550206", "No Tags");

  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].body);
  // lists should not be present (no list IDs to assign)
  assert.equal(body.lists, undefined);

  globalThis.fetch = originalFetch;
});
