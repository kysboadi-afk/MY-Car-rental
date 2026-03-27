// api/_contacts.js
// TextMagic Contact Management helper.
//
// Creates or updates contacts and manages tag (list) assignments so that
// every customer who interacts with SLY Rides ends up in a structured
// TextMagic contact database that can be used for SMS campaigns.
//
// Tag → TextMagic list name mapping:
//   application  — submitted a driver application
//   approved     — application was approved
//   waitlist     — joined the waitlist
//   booked       — confirmed booking paid
//   slingshot    — rented / applied for a Slingshot
//   economy      — rented / applied for a Camry
//   past_customer — rental has been completed and returned
//
// Required environment variables (set in Vercel dashboard):
//   TEXTMAGIC_USERNAME — TextMagic account username
//   TEXTMAGIC_API_KEY  — TextMagic API key

const TM_BASE = "https://rest.textmagic.com/api/v2";

/** Map vehicle IDs to tag names for contact categorization. */
const VEHICLE_TAG_MAP = {
  slingshot:  "slingshot",
  camry:      "economy",
  camry2013:  "economy",
};

/**
 * Return the vehicle-type tag for a given vehicleId.
 * @param {string} vehicleId
 * @returns {string|null}
 */
export function vehicleTag(vehicleId) {
  return VEHICLE_TAG_MAP[vehicleId] || null;
}

function tmHeaders() {
  return {
    "X-TM-Username": process.env.TEXTMAGIC_USERNAME || "",
    "X-TM-Key":      process.env.TEXTMAGIC_API_KEY  || "",
    "Content-Type":  "application/json",
  };
}

/**
 * Fetch a TextMagic contact by exact phone number.
 * @param {string} phone - E.164 format
 * @returns {Promise<object|null>} contact object or null if not found
 */
async function findContactByPhone(phone) {
  const url = `${TM_BASE}/contacts/phone/${encodeURIComponent(phone)}`;
  const resp = await fetch(url, { headers: tmHeaders() });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`TextMagic contacts lookup failed: ${resp.status} ${detail}`);
  }
  return resp.json();
}

/**
 * Fetch all existing TextMagic lists (tags).
 * @returns {Promise<Array<{id:number,name:string}>>}
 */
async function fetchAllLists() {
  const url = `${TM_BASE}/lists?limit=100`;
  const resp = await fetch(url, { headers: tmHeaders() });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`TextMagic lists fetch failed: ${resp.status} ${detail}`);
  }
  const data = await resp.json();
  return data.resources || [];
}

/**
 * Create a TextMagic list (tag) with the given name.
 * @param {string} name
 * @returns {Promise<number>} the new list ID
 */
async function createList(name) {
  const resp = await fetch(`${TM_BASE}/lists`, {
    method:  "POST",
    headers: tmHeaders(),
    body:    JSON.stringify({ name, shared: 0 }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`TextMagic create list "${name}" failed: ${resp.status} ${detail}`);
  }
  const data = await resp.json();
  return data.id;
}

/**
 * Resolve tag names to TextMagic list IDs.
 * Creates any lists that don't yet exist.
 * @param {string[]} tagNames
 * @returns {Promise<Map<string,number>>} tag name → list ID
 */
async function resolveTagIds(tagNames) {
  if (tagNames.length === 0) return new Map();

  const existing = await fetchAllLists();
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));

  const result = new Map();
  for (const tag of tagNames) {
    const lower = tag.toLowerCase();
    if (byName.has(lower)) {
      result.set(tag, byName.get(lower));
    } else {
      const id = await createList(tag);
      result.set(tag, id);
      byName.set(lower, id);
    }
  }
  return result;
}

/**
 * Create a new contact in TextMagic.
 * @param {string} phone
 * @param {string} firstName
 * @param {string} lastName
 * @param {number[]} listIds - list IDs to assign immediately
 * @returns {Promise<object>}
 */
async function createContact(phone, firstName, lastName, listIds) {
  const body = { phone, firstName, lastName };
  if (listIds.length > 0) body.lists = listIds.join(",");

  const resp = await fetch(`${TM_BASE}/contacts`, {
    method:  "POST",
    headers: tmHeaders(),
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`TextMagic create contact failed: ${resp.status} ${detail}`);
  }
  return resp.json();
}

/**
 * Add a contact to the given lists.
 * @param {number} contactId
 * @param {number[]} listIds
 */
async function addContactToLists(contactId, listIds) {
  if (listIds.length === 0) return;
  const resp = await fetch(`${TM_BASE}/contacts/${contactId}/lists`, {
    method:  "POST",
    headers: tmHeaders(),
    body:    JSON.stringify({ ids: listIds.join(",") }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`TextMagic add to lists failed: ${resp.status} ${detail}`);
  }
}

/**
 * Remove a contact from the given lists.
 * 404 responses are silently ignored (list membership already removed).
 * @param {number} contactId
 * @param {number[]} listIds
 */
async function removeContactFromLists(contactId, listIds) {
  for (const listId of listIds) {
    const resp = await fetch(`${TM_BASE}/contacts/${contactId}/lists/${listId}`, {
      method:  "DELETE",
      headers: tmHeaders(),
    });
    if (!resp.ok && resp.status !== 404) {
      const detail = await resp.text().catch(() => "");
      console.warn(`TextMagic remove from list ${listId} failed: ${resp.status} ${detail}`);
    }
  }
}

/**
 * Upsert a contact in TextMagic and manage their tag memberships.
 *
 * - Creates the contact if no match is found for the phone number.
 * - Updates name and list membership if the contact already exists.
 * - All failures are non-fatal: errors are logged but the calling function
 *   is not interrupted (callers should wrap this in try/catch).
 *
 * @param {string}   phone           - E.164 or raw phone number
 * @param {string}   name            - Full name ("Jane Doe")
 * @param {object}   [opts]
 * @param {string[]} [opts.addTags]    - Tag names to add
 * @param {string[]} [opts.removeTags] - Tag names to remove
 */
export async function upsertContact(phone, name, { addTags = [], removeTags = [] } = {}) {
  if (!process.env.TEXTMAGIC_USERNAME || !process.env.TEXTMAGIC_API_KEY) return;
  if (!phone) return;

  const parts     = (name || "").trim().split(/\s+/);
  const firstName = parts[0] || "";
  const lastName  = parts.slice(1).join(" ");

  // Resolve all needed tag names to list IDs in a single pass
  const allTags = [...new Set([...addTags, ...removeTags])];
  const tagIdMap = await resolveTagIds(allTags);

  const addIds    = addTags.map((t) => tagIdMap.get(t)).filter(Boolean);
  const removeIds = removeTags.map((t) => tagIdMap.get(t)).filter(Boolean);

  const existing = await findContactByPhone(phone);

  if (!existing) {
    // Create brand-new contact and assign all add-tags at once
    await createContact(phone, firstName, lastName, addIds);
  } else {
    // Update name if it changed, then manage list memberships
    if (existing.firstName !== firstName || existing.lastName !== lastName) {
      const resp = await fetch(`${TM_BASE}/contacts/${existing.id}`, {
        method:  "PUT",
        headers: tmHeaders(),
        body:    JSON.stringify({ phone, firstName, lastName }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        console.warn(`TextMagic update contact ${existing.id} failed: ${resp.status} ${detail}`);
      }
    }
    if (addIds.length    > 0) await addContactToLists(existing.id, addIds);
    if (removeIds.length > 0) await removeContactFromLists(existing.id, removeIds);
  }
}
